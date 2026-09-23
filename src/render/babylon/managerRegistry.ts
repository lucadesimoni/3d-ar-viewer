import type { SceneManager } from './SceneManager';

/**
 * The one live SceneManager, shared so sibling components (e.g. the recognition
 * overlay) can project a part's position to screen space without threading the
 * manager through React props. Set by the canvas hook, cleared on unmount.
 */
let active: SceneManager | undefined;
const waiting = new Set<(m: SceneManager) => void>();

export const setActiveManager = (m: SceneManager | undefined): void => {
  active = m;
  if (!m) return;
  for (const cb of [...waiting]) { waiting.delete(cb); cb(m); }
};
export const getActiveManager = (): SceneManager | undefined => active;

/**
 * Run `cb` with the live manager — now if there is one, otherwise as soon as it
 * exists. The renderer loads on demand, so work that used to find a manager
 * already in place at start-up (preparing WebXR ahead of the tap) must wait for
 * it instead of quietly doing nothing. Returns a cancel function.
 */
export function withActiveManager(cb: (m: SceneManager) => void): () => void {
  if (active) { cb(active); return () => undefined; }
  waiting.add(cb);
  return () => { waiting.delete(cb); };
}

/** The render backend the live manager actually created ('webgpu' | 'webgl'). */
export function getActiveRenderBackend(): 'webgpu' | 'webgl' | undefined {
  return active?.renderBackend;
}
