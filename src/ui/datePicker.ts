// Small calendar popover for the date-jump control. The native <input type="date">
// picker is positioned by the browser and can open off the bottom of the screen, so
// this one is placed by hand: above the trigger when there is room, else below,
// and always clamped inside the viewport.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MIN_YEAR = 1000;
const MAX_YEAR = 2999;
const GAP = 8;

export interface DatePicker {
  /** Show this date on the trigger (ignored while the popover is open). */
  setValue(d: Date): void;
  isOpen(): boolean;
}

export function createDatePicker(
  trigger: HTMLButtonElement,
  onPick: (year: number, month: number, day: number) => void,
): DatePicker {
  let value = new Date();
  let viewYear = value.getFullYear();
  let viewMonth = value.getMonth();

  const pop = document.createElement('div');
  pop.id = 'date-pop';
  pop.className = 'panel';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Jump to date');
  pop.hidden = true;
  pop.innerHTML = `
    <div class="dp-head">
      <button type="button" class="dp-nav" data-step="-1" aria-label="Previous month">‹</button>
      <select class="dp-month" aria-label="Month">${MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('')}</select>
      <input class="dp-year" type="number" min="${MIN_YEAR}" max="${MAX_YEAR}" aria-label="Year" />
      <button type="button" class="dp-nav" data-step="1" aria-label="Next month">›</button>
    </div>
    <div class="dp-grid" role="grid"></div>`;
  document.body.appendChild(pop);

  const monthSel = pop.querySelector<HTMLSelectElement>('.dp-month')!;
  const yearIn = pop.querySelector<HTMLInputElement>('.dp-year')!;
  const grid = pop.querySelector<HTMLDivElement>('.dp-grid')!;

  const iso = (d: Date) =>
    `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;

  const render = () => {
    monthSel.value = String(viewMonth);
    if (document.activeElement !== yearIn) yearIn.value = String(viewYear);
    const first = new Date(viewYear, viewMonth, 1);
    first.setFullYear(viewYear); // guard against two-digit-year mapping
    const lead = first.getDay();
    const days = new Date(viewYear, viewMonth + 1, 0).getDate();
    let html = WEEKDAYS.map((w) => `<span class="dp-wd">${w}</span>`).join('');
    for (let i = 0; i < lead; i++) html += '<span></span>';
    for (let d = 1; d <= days; d++) {
      const sel = value.getFullYear() === viewYear && value.getMonth() === viewMonth && value.getDate() === d;
      html += `<button type="button" class="dp-day${sel ? ' sel' : ''}" data-day="${d}"${
        sel ? ' aria-current="date"' : ''
      }>${d}</button>`;
    }
    grid.innerHTML = html;
  };

  const place = () => {
    const r = trigger.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = innerWidth;
    const vh = innerHeight;
    let top = r.top - h - GAP;
    if (top < GAP && r.bottom + GAP + h <= vh - GAP) top = r.bottom + GAP;
    top = Math.max(GAP, Math.min(top, vh - h - GAP));
    const left = Math.max(GAP, Math.min(r.left + r.width / 2 - w / 2, vw - w - GAP));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  };

  const open = () => {
    viewYear = value.getFullYear();
    viewMonth = value.getMonth();
    render();
    pop.hidden = false;
    place();
    trigger.setAttribute('aria-expanded', 'true');
    pop.querySelector<HTMLButtonElement>('.dp-day.sel, .dp-day')?.focus();
  };

  const close = (refocus = false) => {
    if (pop.hidden) return;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (refocus) trigger.focus();
  };

  const shiftMonth = (step: number) => {
    const m = viewMonth + step;
    const y = viewYear + Math.floor(m / 12);
    if (y < MIN_YEAR || y > MAX_YEAR) return;
    viewYear = y;
    viewMonth = ((m % 12) + 12) % 12;
    render();
  };

  trigger.addEventListener('click', () => (pop.hidden ? open() : close()));

  pop.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!t) return;
    if (t.dataset.step) shiftMonth(Number(t.dataset.step));
    else if (t.dataset.day) {
      onPick(viewYear, viewMonth, Number(t.dataset.day));
      close(true);
    }
  });

  monthSel.addEventListener('change', () => {
    viewMonth = Number(monthSel.value);
    render();
  });
  yearIn.addEventListener('input', () => {
    const y = Number(yearIn.value);
    if (Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR) {
      viewYear = y;
      render();
    }
  });
  yearIn.addEventListener('blur', () => (yearIn.value = String(viewYear)));

  // Keep keystrokes (Space, arrows, Escape) away from the global shortcuts.
  pop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close(true);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node) && !trigger.contains(e.target as Node)) close();
  });
  addEventListener('resize', () => !pop.hidden && place());

  return {
    setValue(d) {
      if (!pop.hidden) return;
      const y = d.getFullYear();
      if (y < MIN_YEAR || y > MAX_YEAR) return;
      value = new Date(d);
      const text = iso(d);
      if (trigger.textContent !== text) trigger.textContent = text;
    },
    isOpen: () => !pop.hidden,
  };
}
