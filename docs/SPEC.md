# Orrery Clock — Spec

Browser-only, static TypeScript site. Interactive but primarily decorative 3D orrery with a time readout.

## Look

- 3D, rendered with three.js.
- Steampunk / retro-futuristic: polished wood base, brass arms and gears (PBR materials), combined with modern photo-textured planets.

## Bodies

- Sun, Mercury–Neptune, Pluto.
- Asteroid belt (instanced debris ring).
- Comet(s) on eccentric orbits.

## Astronomy

- Real heliocentric longitudes for the simulated date, computed from orbital elements (e.g. JPL approximate Keplerian elements).
- Stylised scale: distances and sizes compressed for legibility.

## Mechanism

- Visible gear train with meshing gears whose ratios drive each planet arm at the correct relative rate.
- Gears speed up / reverse with simulated time.

## Interaction

- Orbit / zoom camera (drag, scroll, pinch); slow auto-drift when idle.
- Time controls: speed multiplier, reverse, scrub/jump to date, "now".
- Click a planet: camera focuses, info card (name, distance from Sun, orbital period, current facts).

## Readout (subtle overlay)

- Local time and date.
- Simulated date when it differs from now.
- Astro extras: moon phase, sunrise/sunset, Julian date, local sidereal time.
- Location: estimated from the timezone by default (no permission prompt). Optional "Use my location" button requests geolocation only when clicked.

## Assets & caching

- Planet textures: tiny (~256px) placeholders load first, swap to 2K WebP/KTX2; 4K fetched only on planet focus.
- Wood/brass: small tiling maps or procedural.
- Service worker (vite-plugin-pwa / Workbox), cache-first for textures. No permissions, no backend.
- Target first visit ~2–3 MB, repeat visits ~0.

## Tech

- Vite + vanilla TypeScript + three.js. DOM overlays for UI (no UI framework).
- Dev env: Docker Compose + Dev Container (see README).

## Hosting

- GitHub Pages via Actions (free for public repos). Netlify free tier as fallback.

## Devices

- Desktop-first, full effects (shadows, bloom, high-res maps).
- Mobile OK: adaptive quality (lower pixel ratio, no/cheap shadows, smaller maps).
