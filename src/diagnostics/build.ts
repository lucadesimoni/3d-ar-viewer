/**
 * Which build produced this session.
 *
 * Injected by Vite at build time (`__BUILD__` in `vite.config.ts`). A log
 * without it is a log you cannot act on: one arrived from a device
 * forty-seven minutes after a merge, missing the field that merge had added,
 * and there was no way to tell a refusing device from an older bundle.
 */
export interface BuildStamp {
  commit: string;
  at: string;
}

declare const __BUILD__: BuildStamp | undefined;

export function buildStamp(): BuildStamp {
  // `vitest` does not run the Vite define, so this is absent under test.
  return typeof __BUILD__ === 'undefined'
    ? { commit: 'dev', at: 'unbuilt' }
    : __BUILD__;
}
