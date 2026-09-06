import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// AR requires a secure context. `npm run dev` serves over http://<lan-ip>:5173 which
// iOS Safari treats as insecure, so camera + WebXR are blocked. Use `npm run dev -- --https`
// behind a trusted cert, or tunnel the port, when testing on a device.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    rollupOptions: {
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
