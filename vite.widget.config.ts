import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import config from './vite.config';

/**
 * The Mendix widget bundle, for the `.mpk` (`scripts/package.mjs`).
 *
 * Laid out the way Mendix's own pluggable-widget tooling lays it out: the
 * widget `SpatialArViewer` of organisation `anthropic` lives in
 * `anthropic/spatialarviewer/`, as `SpatialArViewer.js` for the AMD loader and
 * `SpatialArViewer.mjs` for ES modules. React, React DOM, the JSX runtime,
 * `mendix` and `big.js` come from the Mendix client, as they do for every
 * pluggable widget: bundling a second React into the page breaks hooks.
 *
 * Vite's bundler has no plain AMD output; UMD is AMD when an AMD loader is
 * present (`define.amd`), which is what Mendix's is. Everything else, the
 * renderer included, is bundled into the one file each: a widget is loaded as
 * a single module, and a lazy chunk would be fetched from a path the Mendix
 * client does not serve.
 */
export const WIDGET_DIR = 'anthropic/spatialarviewer';
/**
 * ONNX Runtime's 28 MB wasm, left out.
 *
 * `onnxruntime-web` names its wasm as `new URL('…wasm', import.meta.url)`,
 * which a library build inlines as base64: the first widget build was 79 MB a
 * file. The app never fetches that file; `loadOrt` points the runtime at the
 * CDN copy of the same version. Resolved against the page instead, the URL is
 * no longer an asset to bundle and nothing at runtime changes.
 */
function leaveOrtWasmOut(): Plugin {
  return {
    name: 'leave-ort-wasm-out',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('onnxruntime-web')) return undefined;
      const out = code.replace(/new URL\((["'`])([^"'`]+\.wasm)\1,\s*import\.meta\.url\)/g, 'new URL($1$2$1, location.href)');
      return out === code ? undefined : { code: out, map: null };
    },
  };
}

const EXTERNAL = [/^mendix($|\/)/, 'react', 'react-dom', 'react/jsx-runtime', 'big.js'];

export default defineConfig({
  define: (config as { define?: Record<string, string> }).define,
  plugins: [leaveOrtWasmOut(), react()],
  publicDir: false,
  build: {
    outDir: process.env.WIDGET_OUT ?? 'release/widget',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // Library mode leaves the ES build unminified unless asked.
    minify: true,
    cssCodeSplit: false,
    // Library mode, so the entry keeps its exports: an app build drops them,
    // and the first build of this came out with no `SpatialArViewer` at all.
    lib: {
      entry: 'src/mendix/widget.ts',
      name: 'SpatialArViewer',
      formats: ['umd', 'es'],
      fileName: (format) => `${WIDGET_DIR}/SpatialArViewer.${format === 'es' ? 'mjs' : 'js'}`,
    },
    rollupOptions: {
      external: EXTERNAL,
      output: {
        exports: 'named',
        // One file per format: see above. (Also the reason for the warning that
        // `import.meta` becomes `{}` in the UMD build: only onnxruntime-web
        // reads `import.meta.url` there, as a fallback inside try/catch, and
        // its wasm comes from the CDN path `loadOrt` sets either way.)
        codeSplitting: false,
        globals: { react: 'React', 'react-dom': 'ReactDOM', 'react/jsx-runtime': 'ReactJSXRuntime', 'big.js': 'Big' },
      },
    },
  },
});
