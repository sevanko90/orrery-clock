import { FICTION, nextOccurrence, type FictionEntry } from '../fiction/catalog';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const EYE =
  '<path d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-2.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>';
const SLASH = '<path d="M3.3 2 22 20.7 20.7 22 2 3.3z"/>';

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Fiction catalogue: every entry, with when the dated ones next happen.
 * Picking a dated event jumps the orrery to it; picking a place shows it.
 */
export class FictionPanel {
  private el = $('fiction');
  private when = new Map<string, HTMLElement>();
  private eyes = new Map<string, HTMLButtonElement>();
  /** Group headings' eyes, with the entries each one covers. */
  private groupEyes: { eye: HTMLButtonElement; name: string; entries: FictionEntry[] }[] = [];
  private lastRender = 0;

  /**
   * `onToggle` switches one of the always-on places on or off; `isShown`
   * reports whether it's on.
   */
  constructor(
    onPick: (entry: FictionEntry) => void,
    private onToggle: (entry: FictionEntry, shown: boolean) => void,
    private isShown: (id: string) => boolean,
  ) {
    const list = $('f-list');
    // Grouped entries go under one heading, in a list of their own.
    const groups = new Map<string, HTMLOListElement>();
    for (const entry of FICTION) {
      let into: HTMLElement = list;
      if (entry.group) {
        let sub = groups.get(entry.group);
        if (!sub) {
          sub = this.groupHeading(entry, list);
          groups.set(entry.group, sub);
        }
        into = sub;
      }
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'f-item';
      const title = document.createElement('span');
      title.className = 'f-title';
      title.textContent = entry.title;
      const source = document.createElement('span');
      source.className = 'f-source';
      source.textContent = entry.source;
      const when = document.createElement('span');
      when.className = 'f-when';
      this.when.set(entry.id, when);
      // Under a heading the source is already given.
      btn.append(...(entry.group ? [title, when] : [title, source, when]));
      btn.addEventListener('click', () => onPick(entry));
      li.append(btn);
      if (entry.kind === 'place') {
        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'f-eye';
        eye.addEventListener('click', () => {
          this.onToggle(entry, !this.isShown(entry.id));
          this.syncToggles();
        });
        this.eyes.set(entry.id, eye);
        li.append(eye);
      }
      into.append(li);
    }

    const toggle = $<HTMLButtonElement>('f-toggle');
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      list.hidden = !open;
    });
  }

  /** A group's heading row (name, source and an eye for the lot); returns the list its entries go in. */
  private groupHeading(first: FictionEntry, list: HTMLElement): HTMLOListElement {
    const name = first.group!;
    const li = document.createElement('li');
    li.className = 'f-group';
    const head = document.createElement('div');
    head.className = 'f-group-head';
    const label = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'f-title';
    title.textContent = name;
    const source = document.createElement('span');
    source.className = 'f-source';
    source.textContent = first.source.replace(`${name} · `, '');
    label.append(title, source);
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'f-eye';
    const entries = FICTION.filter((e) => e.group === name && e.kind === 'place');
    eye.addEventListener('click', () => {
      const show = !entries.every((e) => this.isShown(e.id));
      for (const e of entries) this.onToggle(e, show);
      this.syncToggles();
    });
    this.groupEyes.push({ eye, name, entries });
    head.append(label, eye);
    const sub = document.createElement('ol');
    sub.className = 'f-sublist';
    li.append(head, sub);
    list.append(li);
    return sub;
  }

  setVisible(on: boolean) {
    this.el.hidden = !on;
    if (on) this.syncToggles();
  }

  /** Bring the places' eye buttons in line with what's shown. */
  syncToggles() {
    for (const [id, eye] of this.eyes) {
      const shown = this.isShown(id);
      const title = FICTION.find((e) => e.id === id)!.title;
      eye.setAttribute('aria-pressed', String(shown));
      eye.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} ${title}`);
      eye.title = shown ? 'Hide' : 'Show';
      eye.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${EYE}${shown ? '' : SLASH}</svg>`;
    }
    for (const { eye, name, entries } of this.groupEyes) {
      const shown = entries.every((e) => this.isShown(e.id));
      eye.setAttribute('aria-pressed', String(shown));
      eye.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} all of ${name}`);
      eye.title = shown ? 'Hide all' : 'Show all';
      eye.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${EYE}${shown ? '' : SLASH}</svg>`;
    }
  }

  update(simMs: number) {
    if (this.el.hidden) return;
    const t = performance.now();
    if (t - this.lastRender < 500) return;
    this.lastRender = t;
    for (const entry of FICTION) {
      const start = nextOccurrence(entry, simMs);
      const now = start !== null && simMs >= start && simMs <= start + (entry.durationMs ?? 0);
      const label =
        start === null
          ? this.isShown(entry.id)
            ? 'Always on show · Show'
            : 'Hidden'
          : now
            ? 'Happening now · Replay'
            : `${fmtDate(start)} · Play`;
      const el = this.when.get(entry.id)!;
      if (el.textContent !== label) el.textContent = label;
    }
  }
}
