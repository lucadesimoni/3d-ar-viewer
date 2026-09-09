import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Which build is this?
 *
 * A diagnostics log without a build identity is a log you cannot act on. One
 * arrived from a device forty-seven minutes after a merge, missing the field
 * that merge had added — and there was no way to tell "the device refused the
 * feature" from "this page is an older bundle". That ambiguity cost a round
 * trip, which is exactly what the log exists to prevent.
 *
 * Resolved at build time and folded into the bundle, so it travels with the
 * report. A checkout without git (a tarball, some CI images) still builds; it
 * just says so.
 */
function buildStamp(): { commit: string; at: string } {
  const at = new Date().toISOString();
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return { commit: dirty ? `${commit}+` : commit, at };
  } catch {
    return { commit: 'unknown', at };
  }
}

// AR requires a secure context. `npm run dev` serves over http://<lan-ip>:5173 which
// iOS Safari treats as insecure, so camera + WebXR are blocked. Use `npm run dev -- --https`
// behind a trusted cert, or tunnel the port, when testing on a device.
export default defineConfig({
  define: { __BUILD__: JSON.stringify(buildStamp()) },
  plugins: [react()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    rollupOptions: {
      // The WebXR control page is a second entry, so Babylon comes from this
      // origin rather than a CDN — the network this is tested on blocks CDNs.
      input: { index: 'index.html', 'xr-check': 'xr-check.html' },
      output: {
        // three is by far the biggest dependency; splitting it lets the shell
        // and the HUD paint before the renderer is parsed on a cold cellular load.
        manualChunks(id: string) {
          // Babylon is deliberately NOT forced into one chunk: it ships its
          // shaders as separate modules that Rollup otherwise leaves as lazy
          // chunks, and grouping them turned a 1.6 MB entry plus on-demand
          // shaders into a 4 MB download before first paint. Measured, reverted.
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
