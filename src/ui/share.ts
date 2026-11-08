/**
 * "Star on GitHub" and "Share", in the corner by the credits.
 *
 * Starring needs the visitor signed in to GitHub (its API can't star for a
 * site without an OAuth app and a server), so the star button opens the
 * repository, where one click stars it; it shows the live count from the
 * public API (no sign-in; it simply stays blank if that fails). Share uses
 * the device's own share sheet where there is one (phones, some desktops),
 * and otherwise a small menu: copy the link, or post it to X, Bluesky,
 * Reddit or email.
 */
const REPO = 'sevanko90/orrery-clock';
const REPO_URL = `https://github.com/${REPO}`;
const TITLE = 'Orrery Clock';
const TEXT = 'A mechanical 3D orrery and clock: brass, walnut and the planets exactly where they are right now.';

export function setupShare() {
  const star = document.getElementById('star-btn') as HTMLAnchorElement | null;
  const count = document.getElementById('star-count');
  const share = document.getElementById('share-btn') as HTMLButtonElement | null;
  const menu = document.getElementById('share-menu');
  if (!star || !share || !menu) return;
  star.href = REPO_URL;

  // The live star count (cached for an hour: the public API allows 60 lookups an hour).
  const show = (n: number) => {
    if (count) {
      count.textContent = n.toLocaleString();
      count.hidden = false;
    }
  };
  try {
    const cached = JSON.parse(localStorage.getItem('stars') ?? 'null') as { n: number; at: number } | null;
    if (cached && Date.now() - cached.at < 3600_000) show(cached.n);
    else
      fetch(`https://api.github.com/repos/${REPO}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { stargazers_count?: number } | null) => {
          if (typeof j?.stargazers_count !== 'number') return;
          show(j.stargazers_count);
          localStorage.setItem('stars', JSON.stringify({ n: j.stargazers_count, at: Date.now() }));
        })
        .catch(() => undefined);
  } catch {
    /* no count: the button still works */
  }

  const url = () => location.origin + location.pathname;
  const enc = encodeURIComponent;
  const links: Record<string, () => string> = {
    x: () => `https://x.com/intent/post?text=${enc(TEXT)}&url=${enc(url())}`,
    bluesky: () => `https://bsky.app/intent/compose?text=${enc(`${TEXT} ${url()}`)}`,
    reddit: () => `https://www.reddit.com/submit?url=${enc(url())}&title=${enc(TITLE)}`,
    email: () => `mailto:?subject=${enc(TITLE)}&body=${enc(`${TEXT}\n\n${url()}`)}`,
  };
  for (const a of menu.querySelectorAll<HTMLAnchorElement>('a[data-to]')) {
    a.addEventListener('click', () => {
      a.href = links[a.dataset.to!]?.() ?? '#';
      close();
    });
  }
  const copy = menu.querySelector<HTMLButtonElement>('[data-copy]');
  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url());
      copy.textContent = 'Link copied';
    } catch {
      copy.textContent = url();
    }
    setTimeout(() => (copy.textContent = 'Copy link'), 1800);
  });

  const open = () => {
    menu.hidden = false;
    share.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    menu.hidden = true;
    share.setAttribute('aria-expanded', 'false');
  };
  share.addEventListener('click', async () => {
    // The device's own share sheet where there is one.
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: TITLE, text: TEXT, url: url() });
        return;
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
      }
    }
    if (menu.hidden) open();
    else close();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== share) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });
}
