import { createDatePicker } from './datePicker';
import { REAL_TIME_STEP, SPEED_STEPS, type SimClock } from '../sim/clock';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const PAUSE_ICON = '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>';
const PLAY_ICON = '<path d="M7 5v14l12-7z"/>';
const PAUSED_STEP = SPEED_STEPS.findIndex((s) => s.speed === 0);

export function bindControls(clock: SimClock, onEscape: () => void) {
  const slider = $<HTMLInputElement>('c-speed');
  const label = $<HTMLOutputElement>('c-speed-label');
  const pause = $<HTMLButtonElement>('c-pause');
  const pauseIcon = $('c-pause-icon');
  const now = $<HTMLButtonElement>('c-now');
  const date = $<HTMLButtonElement>('c-date');

  slider.max = String(SPEED_STEPS.length - 1);

  const sync = () => {
    slider.value = String(clock.step);
    label.textContent = SPEED_STEPS[clock.step].label;
    const paused = clock.step === PAUSED_STEP;
    pauseIcon.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
    pause.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  };
  clock.onChange(sync);
  sync();

  slider.addEventListener('input', () => clock.setStep(Number(slider.value)));
  $('c-slower').addEventListener('click', () => clock.setStep(clock.step - 1));
  $('c-faster').addEventListener('click', () => clock.setStep(clock.step + 1));
  pause.addEventListener('click', () => clock.togglePause());
  now.addEventListener('click', () => clock.resetToNow());

  const picker = createDatePicker(date, (y, m, d) => {
    // Keep the current time of day; jump to the chosen calendar date (local).
    const target = new Date(clock.nowMs());
    target.setFullYear(y, m, d);
    clock.jumpTo(target.getTime());
    if (clock.step === REAL_TIME_STEP) clock.setStep(PAUSED_STEP);
  });

  // Keep the date label in step with simulated time.
  const syncDate = () => {
    picker.setValue(new Date(clock.nowMs()));
    now.dataset.live = String(clock.isLive());
  };

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        clock.togglePause();
        break;
      case 'ArrowRight':
      case '.':
        clock.setStep(clock.step + 1);
        break;
      case 'ArrowLeft':
      case ',':
        clock.setStep(clock.step - 1);
        break;
      case 'n':
      case 'N':
        clock.resetToNow();
        break;
      case 'Escape':
        onEscape();
        break;
    }
  });

  return { syncDate };
}
