import '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Rendering/edgesRenderer';
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
import { SceneOptimizer, SceneOptimizerOptions } from '@babylonjs/core/Misc/sceneOptimizer';
import { detectPerfProfile, type PerfProfile } from '../perf';
import { createBestEngine, type RenderBackendKind } from './engineFactory';
import { STATUS_COLORS, type RecognitionStatus } from '../../vision/verdict';
import {
  DIAGNOSTIC_COLORS,
  applyPose,
  buildMesh,
  makeMaterial,
  makeOverlayMaterial,
  vec3,
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
    canvas: HTMLCanvasElement,
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
    // Cap render resolution to the profile's pixel-ratio ceiling — the single
    // biggest lever on fill-rate-bound tablets.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.engine.setHardwareScalingLevel(Math.max(1, dpr / this.perf.maxPixelRatio));
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
    this.arCamera.fov = (this.arFovDeg * Math.PI) / 180;

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

  /** Vertical FOV assumed for the passthrough camera, degrees. */
  private readonly arFovDeg = 60;

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
    const radius = this.assemblyRadius();
    const halfFov = ((this.arFovDeg * Math.PI) / 180) / 2;
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

  /** Clear to transparent (AR passthrough) or to the opaque studio background. */
  setTransparent(on: boolean): void {
    this.scene.clearColor = on ? new Color4(0, 0, 0, 0) : new Color4(0.05, 0.07, 0.1, 1);
    // The ground grid is a studio aid; it must not float over the real world.
    this.scene.getMeshByName('grid')?.setEnabled(!on);
  }

  private onResize = (): void => this.engine.resize();

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
  frameCamera(): void {
    this.camera.setTarget(vec3(this.assembly.parts[0]?.targetPose.position ?? [0, 0, 0]));
    this.camera.radius = 0.7;
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
    const options = SceneOptimizerOptions.ModerateDegradationAllowed(this.perf.targetFps);
    options.targetFrameRate = this.perf.targetFps;
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
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
