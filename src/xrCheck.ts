/**
 * A control for the app's WebXR path, sharing no code with it.
 *
 * Three ways into an immersive session, each one step closer to what the app
 * does. Whichever is the first to fail is where the fault is, and that is the
 * whole point of the page — this sandbox has no WebXR device and no WebXR Test
 * API, so the entry path cannot be covered by an automated check at all.
 *
 * Babylon is imported from the app's own dependencies, not a CDN: the first
 * version fetched it from jsdelivr, which is blocked on the network this is
 * used from, and the button read "CDN blocked" — the one comparison the page
 * exists to make could not be made.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { WebXRExperienceHelper } from '@babylonjs/core/XR/webXRExperienceHelper';
import { WebXRDefaultExperience } from '@babylonjs/core/XR/webXRDefaultExperience';
import { WebXRFeatureName } from '@babylonjs/core/XR/webXRFeaturesManager';
import '@babylonjs/core/XR/features/WebXRHitTest';
import '@babylonjs/core/XR/features/WebXRDOMOverlay';
import '@babylonjs/core/Materials/standardMaterial';

const el = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const log = (m: string): void => { el('log').textContent += '\n' + m; };
const verdict = (ok: boolean, m: string): void => {
  const box = el('verdict');
  box.textContent = (ok ? '✓ ' : '✕ ') + m;
  box.style.borderColor = ok ? '#2f6f4a' : '#7a3340';
  box.style.background = ok ? '#10261b' : '#25121a';
  log((ok ? '✓ ' : '✕ ') + m);
};

/**
 * What each refusal means, because the browser's own wording does not say what
 * to do about it and the names read like "no AR on this phone" when they are not.
 */
const MEANING: Record<string, string> = {
  NotAllowedError: 'AR was refused for this site, and Chrome remembers a refusal: tap the lock '
    + 'icon next to the address, reset the permissions, reload, and press again.',
  SecurityError: 'The request did not count as coming from your tap. That is a bug in the page, '
    + 'not in the phone.',
  NotSupportedError: 'This browser will not give an AR session at all. On Android that is usually '
    + '"Google Play Services for AR" missing or out of date; on iOS no browser has WebXR.',
  InvalidStateError: 'A session is already running, probably in another tab. Close it and press again.',
  AbortError: 'The request was cancelled before it started.',
};
const err = (stage: string, e: unknown): void => {
  const name = e instanceof Error ? e.name : '';
  const message = e instanceof Error ? e.message : String(e);
  verdict(false, `${stage}: ${name} ${message}`);
  if (MEANING[name]) log('→ ' + MEANING[name]);
};

el('log').textContent = 'ready';
void (async () => {
  const f = [`secure=${window.isSecureContext}`, `navigator.xr=${'xr' in navigator}`];
  if (navigator.xr) {
    try { f.push(`immersive-ar=${await navigator.xr.isSessionSupported('immersive-ar')}`); }
    catch (e) { f.push(`immersive-ar threw ${(e as Error).name}`); }
  }
  f.push(navigator.userAgent.slice(0, 60));
  el('facts').textContent = f.join(' · ');
})();

// --- 1. Raw WebXR: no Babylon, no app. --------------------------------------
// A red triangle over the camera image. The room and a triangle means the
// phone, the browser, ARCore and the passthrough compositing are all sound and
// the fault is above them.
el('raw').onclick = async (): Promise<void> => {
  const canvas = el('c') as HTMLCanvasElement;
  const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true });
  if (!gl) return err('getContext', new Error('no WebGL'));
  const prog = gl.createProgram() as WebGLProgram;
  const sh = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type) as WebGLShader;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) log('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, 'void main(){gl_FragColor=vec4(1.,.25,.2,1.);}'));
  gl.linkProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.3, -0.3, 0.3, -0.3, 0, 0.35]), gl.STATIC_DRAW);

  let session: XRSession;
  try {
    session = await navigator.xr!.requestSession('immersive-ar', { requiredFeatures: ['local-floor'] });
  } catch (e) {
    err('requestSession(local-floor)', e);
    try {
      session = await navigator.xr!.requestSession('immersive-ar');
      log('· entered with no required features');
    } catch (e2) { return err('requestSession(bare)', e2); }
  }
  verdict(true, 'raw session granted — look for a red triangle');
  try {
    await gl.makeXRCompatible();
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl, { alpha: true }) });
    const space = await session.requestReferenceSpace('local-floor')
      .catch(() => session.requestReferenceSpace('local'));
    log('✓ reference space');
    let frames = 0;
    const onFrame: XRFrameRequestCallback = (_t, frame) => {
      session.requestAnimationFrame(onFrame);
      const layer = session.renderState.baseLayer!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      // Transparent clear: the camera image is behind this layer, and an opaque
      // clear is exactly what hides it.
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const pose = frame.getViewerPose(space);
      if (pose) for (const view of pose.views) {
        const vp = layer.getViewport(view)!;
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        const loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (++frames === 60) log('✓ 60 frames submitted' + (pose ? ' · pose tracked' : ' · NO POSE'));
    };
    session.requestAnimationFrame(onFrame);
    session.addEventListener('end', () => log(`· session ended after ${frames} frames`));
  } catch (e) { err('setting up the session', e); }
};

/** One scene for the two Babylon buttons: a white box 1.5 m in front, on the floor plane. */
function babylonScene(): Scene {
  const engine = new Engine(el('c') as HTMLCanvasElement, true);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  new HemisphericLight('l', new Vector3(0, 1, 0), scene);
  const box = MeshBuilder.CreateBox('b', { size: 0.3 }, scene);
  box.position = new Vector3(0, 1, 1.5);
  new FreeCamera('cam', new Vector3(0, 1.6, 0), scene);
  engine.runRenderLoop(() => scene.render());
  return scene;
}

// --- 2. Babylon as its own documentation starts. ---------------------------
// The plain experience helper, nothing configured. If this shows the room and a
// box, Babylon and the device agree and the fault is in what the app asks for.
el('bjs').onclick = async (ev): Promise<void> => {
  (ev.target as HTMLButtonElement).disabled = true;
  try {
    const xr = await WebXRExperienceHelper.CreateAsync(babylonScene());
    log('✓ helper built — entering');
    xr.onStateChangedObservable.add((s) => log('state ' + s));
    await xr.enterXRAsync('immersive-ar', 'local-floor');
    verdict(true, 'Babylon entered — a white box is 1.5 m in front of you');
  } catch (e) {
    err('Babylon AR', e);
    (ev.target as HTMLButtonElement).disabled = false;
  }
};

// --- 3. Babylon with everything the app asks for. --------------------------
// The default experience, the required reference space, and a DOM overlay with
// a HUD in it. This is the app's request minus the app. If 2 works and this
// does not, the difference is one of these options and nothing else.
el('app').onclick = async (ev): Promise<void> => {
  (ev.target as HTMLButtonElement).disabled = true;
  const overlay = el('overlay');
  overlay.style.display = 'block';
  try {
    const xr = await WebXRDefaultExperience.CreateAsync(babylonScene(), {
      uiOptions: { sessionMode: 'immersive-ar', referenceSpaceType: 'local-floor' },
      disableDefaultUI: true,
      optionalFeatures: true,
      disableTeleportation: true,
      disablePointerSelection: true,
      disableNearInteraction: true,
      // As the app does: no controller-profile fetch from the open internet.
      inputOptions: { disableOnlineControllerRepository: true, doNotLoadControllerMeshes: true },
    });
    xr.baseExperience.featuresManager.enableFeature(
      WebXRFeatureName.HIT_TEST, 'latest', {}, true, false,
    );
    xr.baseExperience.featuresManager.enableFeature(
      WebXRFeatureName.DOM_OVERLAY, 'latest', { element: overlay }, false, false,
    );
    log('✓ default experience built — entering');
    xr.baseExperience.onStateChangedObservable.add((s) => log('state ' + s));
    await xr.baseExperience.enterXRAsync('immersive-ar', 'local-floor', xr.renderTarget, {
      requiredFeatures: ['local-floor'],
    });
    verdict(true, 'the app’s own request entered — box in front, HUD over the camera');
  } catch (e) {
    err('Babylon with the app’s options', e);
    (ev.target as HTMLButtonElement).disabled = false;
  }
};
