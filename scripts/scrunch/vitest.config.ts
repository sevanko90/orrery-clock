import { defineConfig } from 'vitest/config';
// Measurement scripts for the VR scrunch (not part of `npm test`).
export default defineConfig({
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  test: { include: ['scripts/scrunch/**/*.measure.ts'], root: '.', testTimeout: 600_000 },
});
