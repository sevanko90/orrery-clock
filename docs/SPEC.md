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

- Real kinematic simulation: time drives the escapement (at 1×) or a hand crank (any other speed); every arbor angle propagates gear-by-gear through the meshes to the planet arms.
- Movement stands in a central glass drum (glass top and sides between brass mullions) on a slim walnut table: going train + balance/anchor/escape wheel on the top plate, central drive arbor (1 rev / 6 sidereal years), and a two-stage compound train per planet (ratios within 25 ppm of sidereal periods).
- Gear tooth counts and layout are solved offline by `scripts/design-mechanism.ts`; `src/mechanism/mechanism.test.ts` checks for collisions and ratio accuracy.
- Arms show mean (uniform-circular) motion like a real geared orrery; faint markers show true Keplerian positions. Arms are re-set to mean longitude whenever time jumps.

## Backlog

- "Exploded view" button: animate the cabinet sides folding away to expose the whole mechanism.

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
