import '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Rendering/edgesRenderer';
// Side-effect import: tree-shaken builds ship Scene without ray casting, and
// `createPickingRay` then throws at the first tap. Floor placement is built on
// it, so it has to be pulled in explicitly.
import '@babylonjs/core/Culling/ray';
import { Engine } from '@babylonjs/core/Engines/engine';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Material } from '@babylonjs/core/Materials/material';

import type { AssemblyDef, PartDef, PlacementState, Pose } from '../../engine/types';
import type { Severity } from '../../engine/diagnostics';
import { assemblyCentroid, explodePose, pulseScale, sampleTimeline, type Timeline } from '../../engine/animation';
import { loadPartModel } from './gltf';
import {
  HardwareScalingOptimization,
  LensFlaresOptimization,
  ParticlesOptimization,
  RenderTargetsOptimization,
  SceneOptimizer,
  SceneOptimizerOptions,
  ShadowsOptimization,
} from '@babylonjs/core/Misc/sceneOptimizer';
import { detectPerfProfile, type PerfProfile } from '../perf';
import { createBestEngine, type RenderBackendKind } from './engineFactory';
import { STATUS_COLORS, type RecognitionStatus } from '../../vision/verdict';
import { ASSUMED_CAMERA_FOV_DEG } from '../../engine/tracking/markerTracking';
import {
  DIAGNOSTIC_COLORS,
  applyPose,
  buildMesh,
  makeMaterial,
  makeOverlayMaterial,
} from './meshFactory';

export interface SceneRenderState {
  placements: Map<string, PlacementState>;
  severityByPart: Map<string, Severity>;
  selectedPartId: string | undefined;
  activePartIds: Set<string>;
  explodeFactor: number;
  /** Non-null while a build animation is scrubbing. */
  timeline?: Timeline;
  timelineT?: number;
  showBackground: boolean;
  showGhosts: boolean;
  /** Per-part camera-recognition status, driving a localised discrepancy tint. */
  recognitionByPart?: Map<string, RecognitionStatus>;
}

interface PartVisual {
  root: TransformNode;
  /** Primitive placeholder; hidden once an external model loads. */
  mesh: Mesh;
  /** Meshes from a loaded glTF/GLB, when the part references one. */
  loadedMeshes?: AbstractMesh[];
  solidMat: Material;
  overlayMat: Material;
  outline: boolean;
}

/**
 * Owns the Babylon scene and reconciles it against the app's render state each
 * frame. It is intentionally imperative and framework-free: React tells it
 * *what* the world should look like via `update`, and this class does the
 * minimal mesh mutation to get there. That separation keeps React out of the
 * per-frame hot path — the 60 fps render loop never triggers a reconcile.
 */
export class SceneManager {
  readonly engine: AbstractEngine;
  readonly renderBackend: RenderBackendKind;
  readonly scene: Scene;
  camera: ArcRotateCamera;
  /** Head camera used in AR: sits at the origin and is rotated by the device. */
  arCamera: UniversalCamera | undefined;
  private arMode = false;
  readonly assemblyRoot: TransformNode;

  private parts = new Map<string, PartVisual>();
  private background: AbstractMesh[] = [];
  private centroid: ReturnType<typeof assemblyCentroid>;
  private state: SceneRenderState | undefined;
  private startMs = performance.now();
  private optimizer: SceneOptimizer | undefined;
  readonly perf: PerfProfile;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private assembly: AssemblyDef,
    opts: { transparent?: boolean } = {},
    injected?: { engine: AbstractEngine; kind: RenderBackendKind; perf: PerfProfile },
  ) {
    // Pick a device performance profile before creating the engine, so antialias
    // and pixel-ratio are set correctly from the start. `create()` supplies a
    // WebGPU engine when available; the direct constructor path is WebGL.
    this.perf = injected?.perf ?? detectPerfProfile();
    if (injected) {
      this.engine = injected.engine;
      this.renderBackend = injected.kind;
    } else {
      this.engine = new Engine(canvas, this.perf.antialias, {
        preserveDrawingBuffer: true,
        stencil: true,
        antialias: this.perf.antialias,
        powerPreference: 'high-performance',
        adaptToDeviceRatio: true,
      });
      this.renderBackend = 'webgl';
    }
    // Render resolution, capped at the profile's pixel-ratio ceiling.
    //
    // Babylon's hardware scaling level is CSS-pixels : rendered-pixels, so a
    // level BELOW 1 renders above CSS size (what a retina screen needs) and a
    // level above 1 renders below it. The previous `max(1, dpr / cap)` was
    // inverted: on a dpr-3 phone it produced 1.71, rendering at 0.58x CSS —
    // roughly a fifth of native — which is why parts looked soft.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.baseScalingLevel = 1 / Math.min(dpr, this.perf.maxPixelRatio);
    this.engine.setHardwareScalingLevel(this.baseScalingLevel);
    this.scene = new Scene(this.engine);
    // We only pick on explicit taps, so skip per-move picking entirely.
    this.scene.skipPointerMovePicking = true;
    // Transparent clear for AR passthrough; opaque slate for the desktop preview.
    this.scene.clearColor = opts.transparent
      ? new Color4(0, 0, 0, 0)
      : new Color4(0.05, 0.07, 0.1, 1);

    this.camera = new ArcRotateCamera('cam', -Math.PI / 2.2, Math.PI / 2.6, 0.7, new Vector3(0, 0.05, 0), this.scene);
    this.camera.attachControl(canvas, true);
    this.camera.wheelDeltaPercentage = 0.02;
    this.camera.minZ = 0.01;
    this.camera.lowerRadiusLimit = 0.15;
    this.camera.upperRadiusLimit = 4;

    // AR head camera: fixed at the origin (3-DoF), rotated by the device's
    // orientation. Kept alongside the orbit camera and swapped in for AR.
    this.arCamera = new UniversalCamera('arcam', Vector3.Zero(), this.scene);
    this.arCamera.rotationQuaternion = Quaternion.Identity();
    this.arCamera.minZ = 0.01;
    this.arCamera.fov = (this.visibleFovDeg * Math.PI) / 180;

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.75;
    const key = new DirectionalLight('key', new Vector3(-0.4, -1, -0.6), this.scene);
    key.intensity = 1.4;

    this.assemblyRoot = new TransformNode('assembly', this.scene);
    this.centroid = assemblyCentroid(assembly);

    this.buildParts();
    this.buildBackground();
    this.freezeStatic();
    this.startAdaptiveOptimizer();

    this.engine.runRenderLoop(() => this.scene.render());
    window.addEventListener('resize', this.onResize);
    // A `resize` event only fires when the *window* changes. The canvas changes
    // size for other reasons that matter more here: entering AR hides the side
    // panels, the mobile sheet opens and closes, the iOS URL bar collapses. Any
    // of those left the render buffer at its old size — the scene came out
    // stretched to the wrong aspect ratio and soft, and screen-space picking
    // (the placement reticle) aimed at the centre of a viewport that no longer
    // existed. Watch the element itself.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.canvas);
    }
  }

  /**
   * Preferred entry point: creates the best engine for the device (WebGPU with a
   * WebGL2 fallback) and returns a ready manager. Engine creation is async
   * because WebGPU initialises asynchronously.
   */
  static async create(
    canvas: HTMLCanvasElement,
    assembly: AssemblyDef,
    opts: { transparent?: boolean } = {},
  ): Promise<SceneManager> {
    const perf = detectPerfProfile();
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const { engine, kind } = await createBestEngine(canvas, { antialias: perf.antialias }, search);
    return new SceneManager(canvas, assembly, opts, { engine, kind, perf });
  }

  /**
   * Vertical field of view assumed for the *physical* camera, degrees.
   *
   * Browsers do not expose the real calibration, so this is the one number the
   * whole passthrough path is calibrated on. The store owns it (settable from
   * the AR settings sheet or `?camfov=52`) and pushes it in on AR entry; this
   * is only the fallback until then.
   */
  private cameraFovDeg = ASSUMED_CAMERA_FOV_DEG;
  /** Natural size of the passthrough video, once it is known. */
  private passthrough: { width: number; height: number } | undefined;
  /** Assumed height of the device above the floor during placement, metres. */
  private placementEyeHeight = 1.45;
  /** Vertical FOV actually visible on screen, degrees — see `applyPassthroughFov`. */
  private visibleFovDeg = ASSUMED_CAMERA_FOV_DEG;
  /** Hardware scaling the device should render at when it can keep up. */
  private baseScalingLevel = 1;
  private reticle: Mesh | undefined;
  /**
   * Whether the operator is currently placing the assembly.
   *
   * Placement is a mode, not a permanent state of the app. Left always-on, the
   * reticle sits over the work for the whole session and every stray tap picks
   * the assembly up and drops it somewhere else — which is precisely what you
   * do not want once it is where it belongs.
   */
  private placementActive = false;

  /**
   * Switch between the desktop orbit camera and the AR head camera.
   *
   * In AR the orbit controls must be detached, otherwise a drag rotates the
   * model instead of the world staying put, and the scene must clear to
   * transparent so the camera feed shows through.
   */
  setArMode(enabled: boolean): void {
    if (this.arMode === enabled) return;
    this.arMode = enabled;
    if (enabled && this.arCamera) {
      this.camera.detachControl();
      this.scene.activeCamera = this.arCamera;
    } else {
      this.scene.activeCamera = this.camera;
      this.camera.attachControl(true);
    }
    this.setTransparent(enabled);
  }

  /**
   * Feed the device's orientation to the AR camera.
   *
   * The tracker reports a camera that looks down -Z (the WebXR/three
   * convention); Babylon's cameras look down +Z, so the incoming rotation is
   * turned 180 degrees about Y to match.
   */
  setDeviceOrientation(q: [number, number, number, number]): void {
    if (!this.arCamera) return;
    const device = new Quaternion(q[0], q[1], q[2], q[3]);
    const toBabylon = Quaternion.RotationAxis(new Vector3(0, 1, 0), Math.PI);
    this.arCamera.rotationQuaternion = device.multiply(toBabylon);
  }

  /**
   * A pose `distanceM` in front of the operator and `dropM` below eye level —
   * roughly a workbench — so the assembly is inside the field of view the moment
   * AR starts, without any registration step. (A floor-height default would sit
   * ~42 degrees below the horizon and be invisible until the operator looked down.)
   *
   * The direction is read from the live camera's forward vector rather than
   * assumed from an axis convention, so it is correct either way.
   */
  computeAnchorInFront(): Pose {
    const cam = this.arCamera ?? this.camera;
    const forward = cam.getDirection(Vector3.Forward());
    // Flatten to horizontal so the assembly sits level, not tilted with the head.
    forward.y = 0;
    if (forward.lengthSquared() < 1e-6) forward.set(0, 0, 1);
    forward.normalize();

    // Auto-frame: derive the distance from the assembly's own size so a 0.2 m
    // gearbox and a 2.2 m rack both fill a similar share of the view. A fixed
    // distance made the small sample a speck at the bottom edge.
    const radius = this.assemblyBounds().radius;
    const halfFov = ((this.visibleFovDeg * Math.PI) / 180) / 2;
    const distance = Math.min(5, Math.max(0.5, (radius / Math.tan(halfFov)) * 1.7));
    const drop = Math.min(1.0, Math.max(0.1, radius * 0.5));

    // Target point for the assembly's CENTRE, then offset so the centre lands
    // there (the model's origin is a datum, not necessarily its middle).
    const target = cam.position.add(forward.scale(distance)).add(new Vector3(0, -drop, 0));
    const c = this.centroid;
    return {
      position: [target.x - c.x, target.y - c.y, target.z - c.z],
      rotation: [0, 0, 0, 1],
    };
  }

  /** Bounding radius of the assembly around its centroid, metres. */
  private assemblyRadius(): number {
    let r = 0.05;
    for (const p of this.assembly.parts) {
      const dx = p.targetPose.position[0] - this.centroid.x;
      const dy = p.targetPose.position[1] - this.centroid.y;
      const dz = p.targetPose.position[2] - this.centroid.z;
      r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    return r;
  }

  /**
   * Ground reticle — the "where will it land" marker the operator aims with.
   *
   * A flat ring lying on the surface reads as attached to the floor, unlike a
   * screen-space crosshair which floats.
   */
  private ensureReticle(): Mesh {
    if (this.reticle) return this.reticle;
    const r = MeshBuilder.CreateTorus(
      'ar-reticle', { diameter: 0.26, thickness: 0.012, tessellation: 48 }, this.scene,
    );
    r.rotation.x = Math.PI / 2;           // lie flat on the ground
    r.bakeCurrentTransformIntoVertices(); // so applyPose controls it cleanly
    r.material = makeOverlayMaterial(this.scene, DIAGNOSTIC_COLORS.active, 0.9, 'ar-reticle-mat');
    r.isPickable = false;
    r.setEnabled(false);
    this.reticle = r;
    return r;
  }

  /** Arm or disarm placement: the reticle and the tap-to-place gesture. */
  setPlacementActive(on: boolean): void {
    this.placementActive = on;
    if (!on) this.setReticle(undefined);
  }

  get placing(): boolean {
    return this.placementActive;
  }

  /** Show the reticle at a world pose, or hide it with `undefined`. */
  setReticle(pose: Pose | undefined): void {
    const r = this.ensureReticle();
    if (!pose) { r.setEnabled(false); return; }
    r.setEnabled(true);
    applyPose(r, pose);
  }

  /**
   * Where a screen point meets the ground plane, in world space.
   *
   * This is what turns "floating in front of your face" into a real placement:
   * the operator aims at the floor and the assembly is anchored where the ray
   * actually lands, at true distance. Uses the live camera, so the projection
   * matches what is on screen. Returns undefined at or above the horizon, where
   * a ground intersection would be meaningless.
   */
  pickGround(screenX: number, screenY: number, groundY: number): Pose | undefined {
    const cam = this.scene.activeCamera;
    if (!cam) return undefined;
    const ray = this.scene.createPickingRay(screenX, screenY, Matrix.Identity(), cam);
    if (Math.abs(ray.direction.y) < 1e-4) return undefined;
    const t = (groundY - ray.origin.y) / ray.direction.y;
    if (!Number.isFinite(t) || t <= 0 || t > 25) return undefined;
    const p = ray.origin.add(ray.direction.scale(t));
    return { position: [p.x, p.y, p.z], rotation: [0, 0, 0, 1] };
  }

  /**
   * Tell the scene how big the camera image is, so the overlay can be drawn
   * with the same field of view the operator is actually looking at.
   *
   * This is the difference between a virtual shelf that sits on the real one
   * and one that is a few percent too small. The video is painted with
   * `object-fit: cover`, so on a tablet in landscape a 4:3 camera frame is
   * cropped top and bottom — the visible vertical FOV is then *narrower* than
   * the camera's own, and rendering at the camera's FOV shrinks the overlay by
   * exactly that ratio. Recompute on every resize, because rotating an iPad
   * changes which axis gets cropped.
   */
  setPassthroughSource(width: number, height: number, fovDeg?: number): void {
    if (width < 1 || height < 1) return;
    this.passthrough = { width, height };
    if (fovDeg && fovDeg > 1 && fovDeg < 179) this.cameraFovDeg = fovDeg;
    this.applyPassthroughFov();
  }

  /** Vertical FOV currently on screen, degrees — use this for intrinsics too. */
  effectiveFovDeg(): number {
    return this.visibleFovDeg;
  }

  /** Recalibrate the assumed camera FOV live, from the AR settings sheet. */
  setCameraFov(fovDeg: number): void {
    if (!(fovDeg > 1 && fovDeg < 179)) return;
    this.cameraFovDeg = fovDeg;
    this.applyPassthroughFov();
  }

  /**
   * Move the assumed floor plane while the operator is still aiming at it.
   *
   * Applied to the live placement session rather than only to the next one, so
   * dragging the slider moves the reticle under the finger — you can see the
   * ring settle onto the real floor instead of guessing a number.
   */
  setEyeHeight(metres: number): void {
    this.placementEyeHeight = metres;
  }

  private applyPassthroughFov(): void {
    const src = this.passthrough;
    let visible = this.cameraFovDeg;
    if (src) {
      const rect = this.canvas.getBoundingClientRect();
      const cw = rect.width || this.canvas.clientWidth;
      const ch = rect.height || this.canvas.clientHeight;
      if (cw > 0 && ch > 0) {
        // `cover`: scale so the video covers the box, then crop the overflow.
        const scale = Math.max(cw / src.width, ch / src.height);
        const shownFraction = Math.min(1, ch / (src.height * scale));
        const halfTan = Math.tan((this.cameraFovDeg * Math.PI) / 360) * shownFraction;
        visible = (2 * Math.atan(halfTan) * 180) / Math.PI;
      }
    }
    this.visibleFovDeg = visible;
    if (this.arCamera) this.arCamera.fov = (visible * Math.PI) / 180;
  }

  /**
   * Screen centre in CSS pixels, for aiming the reticle.
   *
   * Babylon's picking takes CSS pixels and divides by the hardware scaling
   * level itself, so feeding it the render-buffer size would put the reticle at
   * twice the centre on any retina screen.
   */
  screenCentre(): { x: number; y: number } {
    const s = this.engine.getHardwareScalingLevel();
    return { x: (this.engine.getRenderWidth() * s) / 2, y: (this.engine.getRenderHeight() * s) / 2 };
  }

  /**
   * Turn a surface hit into the anchor pose for the whole assembly.
   *
   * Two corrections make the difference between "a model appeared somewhere"
   * and "the model is standing there": the assembly is centred on the point the
   * operator actually aimed at (its origin is a datum, which for a shelf is a
   * corner and for the gearbox is a locating pin — neither is the middle), and
   * it is turned to face the operator, so the front of a cabinet is not pointing
   * at the wall. Everything else is parented to this anchor, so one placement
   * carries the entire assembly with it.
   */
  placementPose(hit: Pose): Pose {
    const cam = this.scene.activeCamera;
    const c = this.centroid;
    let yaw = 0;
    if (cam) {
      const dx = cam.position.x - hit.position[0];
      const dz = cam.position.z - hit.position[2];
      // Left-handed: yaw about Y takes +Z to (sin, 0, cos), so this points the
      // assembly's own +Z (its front) back towards the viewer.
      if (dx * dx + dz * dz > 1e-6) yaw = Math.atan2(dx, dz);
    }
    const offset = Vector3.TransformCoordinates(new Vector3(c.x, 0, c.z), Matrix.RotationY(yaw));
    const q = Quaternion.RotationAxis(new Vector3(0, 1, 0), yaw);
    return {
      position: [hit.position[0] - offset.x, hit.position[1], hit.position[2] - offset.z],
      rotation: [q.x, q.y, q.z, q.w],
    };
  }

  /**
   * Aim-and-tap floor placement for the camera-passthrough fallback.
   *
   * iOS Safari has no WebXR and therefore no real plane detection, but it does
   * report gravity: the phone knows which way is down and roughly how high it is
   * being held, which is enough to define the floor plane. The operator aims the
   * reticle at where the assembly should stand and taps; the ray-plane
   * intersection gives a true metric position instead of the fixed standoff the
   * app used to guess. Returns a stop function.
   */
  startGroundPlacement(eyeHeightM: number, onPlace: (pose: Pose) => void): () => void {
    this.placementEyeHeight = eyeHeightM;
    this.placementActive = true;
    const groundY = (): number =>
      (this.scene.activeCamera ?? this.camera).position.y - this.placementEyeHeight;
    // Aim down the screen until the ray meets the floor. With the phone held
    // level the centre of the screen is the horizon and picks nothing, which
    // left the operator staring at an empty view with no ring to aim; walking
    // down the lower half finds the floor as soon as any of it is in shot.
    const aim = (): Pose | undefined => {
      const { x, y } = this.screenCentre();
      for (const f of [1, 1.3, 1.6, 1.8]) {
        const hit = this.pickGround(x, y * f, groundY());
        if (hit) return hit;
      }
      return undefined;
    };
    const observer = this.scene.onBeforeRenderObservable.add(() => this.setReticle(aim()));
    const stop = (): void => {
      this.scene.onBeforeRenderObservable.remove(observer);
      this.scene.onPointerDown = undefined;
      this.placementActive = false;
      this.setReticle(undefined);
    };
    this.scene.onPointerDown = () => {
      // Place where they tapped, falling back to the reticle if the tap missed
      // the floor plane (above the horizon).
      const hit = this.pickGround(this.scene.pointerX, this.scene.pointerY, groundY()) ?? aim();
      if (!hit) return;
      onPlace(this.placementPose(hit));
      stop();
    };
    return stop;
  }

  /**
   * Enter a real WebXR AR session with hit-testing (Android/Quest/Vision Pro).
   *
   * This is genuine plane detection: the device reports where the ray from the
   * screen actually meets a real surface, so the reticle sits on the true floor
   * and the anchor placed from it is world-locked — the assembly stays put when
   * the operator walks around it. iOS Safari has no WebXR, which is why the
   * camera-passthrough path with ground picking exists alongside this.
   *
   * Returns undefined when the session cannot start, so the caller falls back.
   */
  async startWebXr(
    onPlace: (pose: Pose) => void,
    onEnd?: () => void,
  ): Promise<{ end: () => Promise<void> } | undefined> {
    try {
      const { startImmersiveAr } = await import('./xr');
      // The DOM overlay has to be the app root, not the canvas: the canvas is
      // what WebXR replaces, while the HUD around it is the part that must stay
      // on screen and stay tappable inside the session.
      const overlayRoot = this.canvas.closest('.app') as HTMLElement | null;
      const controller = await startImmersiveAr(this.scene, overlayRoot ?? document.body, {
        onReticle: (pose) => this.setReticle(this.placementActive ? pose : undefined),
        onSelectAnchor: (pose) => {
          // Placed already: a tap is someone touching the screen, not a request
          // to pick the assembly up and put it somewhere else.
          if (!this.placementActive) return;
          onPlace(this.placementPose(pose));
          this.setPlacementActive(false);
        },
        onStateChange: (inXr) => {
          this.arMode = inXr;
          this.setTransparent(inXr);
          if (!inXr) { this.setReticle(undefined); onEnd?.(); }
        },
      });
      if (!controller) return undefined;
      this.arMode = true;
      this.setTransparent(true);
      return { end: () => controller.end() };
    } catch {
      return undefined;
    }
  }

  /**
   * Take a pose measured in the camera's own frame — as the vision pipeline
   * reports it — into world space.
   *
   * The axis conventions are already reconciled upstream (`cvPoseToRenderer`
   * in the tracking module), so this is a plain change of basis through the
   * live camera. Keeping the handedness fix next to the maths that creates the
   * problem, rather than here, means there is exactly one place where a sign
   * can be wrong.
   */
  cameraToWorld(poseInCamera: Pose): Pose {
    const cam = this.scene.activeCamera;
    if (!cam) return poseInCamera;
    const [px, py, pz] = poseInCamera.position;
    const [qx, qy, qz, qw] = poseInCamera.rotation;

    const world = cam.getWorldMatrix();
    const p = Vector3.TransformCoordinates(new Vector3(px, py, pz), world);
    const camRot = Quaternion.FromRotationMatrix(world.getRotationMatrix());
    const q = camRot.multiply(new Quaternion(qx, qy, qz, qw));
    return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
  }

  /** Clear to transparent (AR passthrough) or to the opaque studio background. */
  setTransparent(on: boolean): void {
    this.scene.clearColor = on ? new Color4(0, 0, 0, 0) : new Color4(0.05, 0.07, 0.1, 1);
    // The ground grid is a studio aid; it must not float over the real world.
    this.scene.getMeshByName('grid')?.setEnabled(!on);
  }

  private resizeObserver: ResizeObserver | undefined;

  private onResize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;   // hidden; resizing to 0 kills the depth buffer
    this.engine.resize();
    // Rotating the device changes which axis of the camera image is cropped.
    this.applyPassthroughFov();
  };

  private buildParts(): void {
    for (const part of this.assembly.parts) {
      const root = new TransformNode(`part-${part.id}`, this.scene);
      root.parent = this.assemblyRoot;
      const mesh = buildMesh(this.scene, part.mesh, `mesh-${part.id}`);
      mesh.parent = root;
      const solidMat = makeMaterial(this.scene, part.material, `mat-${part.id}`);
      const overlayMat = makeOverlayMaterial(this.scene, DIAGNOSTIC_COLORS.ghost, 0.28, `ghost-${part.id}`);
      mesh.material = overlayMat;
      applyPose(root, part.targetPose);
      const visual: PartVisual = { root, mesh, solidMat, overlayMat, outline: false };
      this.parts.set(part.id, visual);

      // Real geometry (glTF/GLB) loads asynchronously; the primitive above holds
      // the pose slot until it arrives, and remains as a fallback if it fails.
      if (part.mesh.type === 'url') {
        void loadPartModel(this.scene, part.mesh.url, root, {
          scale: part.mesh.scale,
          draco: part.mesh.draco,
        }).then((model) => {
          if (!model) return; // load failed — keep the placeholder primitive
          visual.mesh.isVisible = false;
          visual.loadedMeshes = model.meshes;
          // Name the loaded meshes so tap-to-select resolves back to this part.
          for (const m of model.meshes) m.name = `mesh-${part.id}`;
          if (this.state) this.update(this.state);
        });
      }
    }
  }

  private buildBackground(): void {
    for (const bg of this.assembly.background) {
      const mesh = buildMesh(this.scene, bg.mesh, `bg-${bg.id}`);
      mesh.parent = this.assemblyRoot;
      applyPose(mesh, bg.pose);
      if (bg.role === 'occluder') {
        // Depth-only: writes the depth buffer so virtual parts hide behind real
        // geometry, but paints nothing — the camera feed shows through.
        const occluder = makeOverlayMaterial(this.scene, '#000000', 0.001, `occ-${bg.id}`);
        occluder.disableColorWrite = true;
        mesh.material = occluder;
        mesh.renderingGroupId = 0;
      } else if (bg.role === 'keepOut') {
        mesh.material = makeOverlayMaterial(this.scene, '#f43f5e', 0.12, `keepout-${bg.id}`);
      } else {
        mesh.material = makeOverlayMaterial(this.scene, '#334155', 0.25, `fixture-${bg.id}`);
      }
      this.background.push(mesh);
    }
  }

  /** Re-point the whole scene at a new assembly. */
  loadAssembly(assembly: AssemblyDef): void {
    for (const v of this.parts.values()) v.root.dispose(false, true);
    for (const m of this.background) m.dispose();
    this.parts.clear();
    this.background = [];
    this.assembly = assembly;
    this.centroid = assemblyCentroid(assembly);
    this.buildParts();
    this.buildBackground();
    this.freezeStatic();
  }

  /** Place the whole assembly at a world anchor pose (AR registration). */
  setAnchor(pose: Pose | undefined): void {
    if (!pose) {
      this.assemblyRoot.position.setAll(0);
      this.assemblyRoot.rotationQuaternion = Quaternion.Identity();
      return;
    }
    this.assemblyRoot.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.assemblyRoot.rotationQuaternion = new Quaternion(...pose.rotation);
  }

  /**
   * Reconcile the visible scene with `state`. Called on every store change and,
   * while an animation or explode is active, once per frame via `tick`.
   */
  update(state: SceneRenderState): void {
    this.state = state;
    const animated = state.timeline ? sampleTimeline(state.timeline, state.timelineT ?? 0) : undefined;

    for (const part of this.assembly.parts) {
      const visual = this.parts.get(part.id);
      if (!visual) continue;
      const placement = state.placements.get(part.id);
      const pose = this.resolvePose(part, placement, state, animated?.get(part.id));
      applyPose(visual.root, pose);
      this.styleVisual(part.id, visual, placement, state);
    }
  }

  /** Where a part should be drawn, given animation, explode, and placement. */
  private resolvePose(
    part: PartDef,
    placement: PlacementState | undefined,
    state: SceneRenderState,
    animatedPose: Pose | undefined,
  ): Pose {
    if (animatedPose) return animatedPose;
    const base = placement && placement.status !== 'ghost' ? placement.pose : part.targetPose;
    if (state.explodeFactor > 0) return explodePose(part, this.centroid, state.explodeFactor, base);
    return base;
  }

  private styleVisual(
    partId: string,
    visual: PartVisual,
    placement: PlacementState | undefined,
    state: SceneRenderState,
  ): void {
    const status = placement?.status ?? 'ghost';
    const severity = state.severityByPart.get(partId);
    const isActive = state.activePartIds.has(partId);
    const isSelected = state.selectedPartId === partId;
    const reco = state.recognitionByPart?.get(partId);

    const loaded = visual.loadedMeshes;
    if (status === 'ghost') {
      // A recognised part is shown even when ghosts are hidden, so the colour
      // lands on that part's area rather than nowhere.
      const visible = state.showGhosts || isActive || reco !== undefined;
      if (loaded) {
        for (const m of loaded) { m.isVisible = visible; m.visibility = reco ? 0.75 : isActive ? 0.6 : 0.35; }
      } else {
        visual.mesh.material = visual.overlayMat;
        visual.mesh.isVisible = visible;
        if (reco) this.tintOverlay(visual, STATUS_COLORS[reco], 0.4);
        else this.tintOverlay(visual, isActive ? DIAGNOSTIC_COLORS.active : DIAGNOSTIC_COLORS.ghost, isActive ? 0.42 : 0.22);
      }
    } else {
      // Placed: show the real geometry; tint by the worst diagnostic.
      if (loaded) {
        for (const m of loaded) { m.isVisible = true; m.visibility = 1; }
        // A loaded model keeps its own PBR materials; status is shown by the
        // outline + pulse below rather than by recolouring baked textures.
      } else {
        visual.mesh.isVisible = true;
        if (severity) {
          this.tintOverlay(visual, DIAGNOSTIC_COLORS[severity], 0.55);
          visual.mesh.material = visual.overlayMat;
        } else {
          visual.mesh.material = visual.solidMat;
        }
      }
    }

    // A recognised part's outline (localised to that part) uses the discrepancy
    // colour and takes precedence; otherwise selection/error styling applies.
    const wantOutline = reco !== undefined || isSelected || severity === 'error';
    const outlineHex = reco ? STATUS_COLORS[reco] : isSelected ? '#ffffff' : DIAGNOSTIC_COLORS.error;
    const outlineTargets: (Mesh | AbstractMesh)[] = loaded ?? [visual.mesh];
    for (const m of outlineTargets) {
      m.renderOutline = wantOutline;
      if (wantOutline) {
        m.outlineColor = Color3.FromHexString(outlineHex);
        m.outlineWidth = reco ? 0.008 : 0.004;
      }
    }
    visual.outline = wantOutline;
    // Attention pulse must NEVER touch geometry: this overlay is measured
    // against real parts in millimetres, so scaling it would falsify the size.
    // Pulse the outline width instead and keep the part exactly 1:1.
    const pulsing = reco !== undefined || severity === 'error';
    const pulse = pulsing ? pulseScale(performance.now() - this.startMs) : 1;
    if (wantOutline) {
      const base = reco ? 0.008 : 0.004;
      for (const m of outlineTargets) m.outlineWidth = base * pulse;
    }
    visual.root.scaling.setAll(1);

    for (const m of this.background) m.setEnabled(state.showBackground);
  }

  private tintOverlay(visual: PartVisual, hex: string, alpha: number): void {
    const mat = visual.overlayMat as unknown as {
      diffuseColor: Color3;
      emissiveColor: Color3;
      alpha: number;
    };
    const c = Color3.FromHexString(hex);
    mat.diffuseColor = c;
    mat.emissiveColor = c.scale(0.6);
    mat.alpha = alpha;
  }

  /** Advance time-based effects (pulse, animation scrub) without a store change. */
  tick(): void {
    if (this.state && (this.state.timeline || this.hasError() || (this.state.recognitionByPart?.size ?? 0) > 0)) this.update(this.state);
  }

  private hasError(): boolean {
    for (const s of this.state?.severityByPart.values() ?? []) if (s === 'error') return true;
    return false;
  }

  /** World-space bounding sphere radius, for framing the camera. */
  /**
   * Put the whole assembly on screen, whatever its size and whatever shape the
   * viewport is.
   *
   * This used to target the first part and sit 0.7 m away, which happens to
   * suit a bench gearbox and puts the camera *inside* a 1.5 m shelf — the view
   * was a wall of one board with no way to tell what you were looking at. The
   * distance now comes from the real bounding sphere and the narrower of the
   * two field-of-view angles, so a tall assembly on a narrow phone is framed by
   * the width and a wide one on a laptop by the height.
   */
  frameCamera(): void {
    const { centre, radius } = this.assemblyBounds();
    this.camera.setTarget(centre);

    const halfVertical = this.camera.fov / 2;
    const aspect = this.engine.getAspectRatio(this.camera) || 1;
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
    const half = Math.max(0.1, Math.min(halfVertical, halfHorizontal));

    const distance = (radius / Math.sin(half)) * 1.15;   // 15% air around it
    this.camera.radius = Math.min(60, Math.max(0.3, distance));
    // Let the operator get close without falling through the far side.
    this.camera.lowerRadiusLimit = Math.max(0.15, radius * 0.35);
    this.camera.upperRadiusLimit = distance * 4;
  }

  /**
   * Centre and bounding radius of the built assembly, in world units.
   *
   * Measured from the meshes rather than from part origins: a datum can sit
   * anywhere on a part, so origins alone under-report a 1.5 m shelf by half its
   * height. Falls back to the origins if nothing is built yet.
   */
  private assemblyBounds(): { centre: Vector3; radius: number } {
    const meshes = this.assemblyRoot.getChildMeshes(false, (n) => n.getClassName().includes('Mesh'));
    if (meshes.length > 0) {
      let min = meshes[0].getBoundingInfo().boundingBox.minimumWorld.clone();
      let max = meshes[0].getBoundingInfo().boundingBox.maximumWorld.clone();
      for (const mesh of meshes) {
        const box = mesh.getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, box.minimumWorld);
        max = Vector3.Maximize(max, box.maximumWorld);
      }
      const centre = min.add(max).scale(0.5);
      const radius = Math.max(0.05, max.subtract(min).length() / 2);
      return { centre, radius };
    }
    const c = this.centroid;
    return { centre: new Vector3(c.x, c.y, c.z), radius: this.assemblyRadius() };
  }

  addGroundGrid(): void {
    const grid = MeshBuilder.CreateGround('grid', { width: 2, height: 2, subdivisions: 20 }, this.scene);
    const mat = makeOverlayMaterial(this.scene, '#1e293b', 0.25, 'gridmat');
    mat.wireframe = true;
    grid.material = mat;
    grid.position.y = -0.001;
  }

  /**
   * Project a part's centre to normalised screen coordinates (0..1), so a small
   * on-part label can be pinned to it. `onScreen` is false when the part is
   * behind the camera or off-frame.
   */
  projectPart(partId: string): { x: number; y: number; onScreen: boolean } | undefined {
    const visual = this.parts.get(partId);
    if (!visual) return undefined;
    // Anchor to the part's visible centre. The root is its datum origin, which
    // for a long part (a shaft, a rail) sits at one end — a label pinned there
    // floats off the object.
    const world = this.visualCentre(visual);
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const p = Vector3.Project(
      world,
      Matrix.Identity(),
      this.scene.getTransformMatrix(),
      this.camera.viewport.toGlobal(w, h),
    );
    return { x: p.x / w, y: p.y / h, onScreen: p.z > 0 && p.z < 1 && p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h };
  }

  /** World-space centre of a part's visible geometry. */
  private visualCentre(visual: PartVisual): Vector3 {
    const meshes = visual.loadedMeshes ?? [visual.mesh];
    let min: Vector3 | undefined;
    let max: Vector3 | undefined;
    for (const m of meshes) {
      if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min = min ? Vector3.Minimize(min, bb.minimumWorld) : bb.minimumWorld.clone();
      max = max ? Vector3.Maximize(max, bb.maximumWorld) : bb.maximumWorld.clone();
    }
    if (!min || !max) return visual.root.getAbsolutePosition();
    return min.add(max).scale(0.5);
  }

  pickPartAt(x: number, y: number): string | undefined {
    const pick = this.scene.pick(x, y);
    const name = pick?.pickedMesh?.name ?? '';
    const m = name.match(/^mesh-(.+)$/);
    return m ? m[1] : undefined;
  }

  /**
   * Runtime auto-degrade: if the scene can't hold the target frame rate, Babylon
   * lowers internal resolution (and other cheap settings) until it can — so a
   * heavy assembly on a weak device stays smooth instead of stuttering.
   */
  private startAdaptiveOptimizer(): void {
    if (!this.perf.adaptive) return;
    // Build the degradation ladder explicitly. The stock "moderate" preset lets
    // HardwareScalingOptimization fall to a quarter of the pixels and never
    // restores it — one stutter and the overlay stays blurry for the session.
    // Here resolution is the LAST lever and is floored at CSS resolution.
    const options = new SceneOptimizerOptions(this.perf.targetFps, 2000);
    options.addOptimization(new ShadowsOptimization(0));
    options.addOptimization(new LensFlaresOptimization(0));
    options.addOptimization(new ParticlesOptimization(1));
    options.addOptimization(new RenderTargetsOptimization(1));
    options.addOptimization(
      new HardwareScalingOptimization(2, Math.max(1, this.baseScalingLevel), 0.25),
    );
    this.optimizer = new SceneOptimizer(this.scene, options);
    this.optimizer.start();
  }

  /** Background geometry never moves — freeze its matrices and materials. */
  private freezeStatic(): void {
    for (const m of this.background) {
      m.freezeWorldMatrix();
      m.material?.freeze();
      m.isPickable = false;
    }
  }

  dispose(): void {
    this.optimizer?.stop();
    this.optimizer?.dispose?.();
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
