import type { SceneManager } from './SceneManager';

/**
 * The one live SceneManager, shared so sibling components (e.g. the recognition
 * overlay) can project a part's position to screen space without threading the
 * manager through React props. Set by the canvas hook, cleared on unmount.
 */
let active: SceneManager | undefined;

export const setActiveManager = (m: SceneManager | undefined): void => { active = m; };
export const getActiveManager = (): SceneManager | undefined => active;

/** The render backend the live manager actually created ('webgpu' | 'webgl'). */
export function getActiveRenderBackend(): 'webgpu' | 'webgl' | undefined {
  return active?.renderBackend;
}
