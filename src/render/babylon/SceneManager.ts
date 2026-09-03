import '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Rendering/edgesRenderer';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Material } from '@babylonjs/core/Materials/material';

import type { AssemblyDef, PartDef, PlacementState, Pose } from '../../engine/types';
import type { Severity } from '../../engine/diagnostics';
import { assemblyCentroid, explodePose, pulseScale, sampleTimeline, type Timeline } from '../../engine/animation';
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
}

interface PartVisual {
  root: TransformNode;
  mesh: Mesh;
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
  readonly engine: Engine;
  readonly scene: Scene;
  camera: ArcRotateCamera;
  readonly assemblyRoot: TransformNode;

  private parts = new Map<string, PartVisual>();
  private background: AbstractMesh[] = [];
  private centroid: ReturnType<typeof assemblyCentroid>;
  private state: SceneRenderState | undefined;
  private startMs = performance.now();

  constructor(
    canvas: HTMLCanvasElement,
    private assembly: AssemblyDef,
    opts: { transparent?: boolean } = {},
  ) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
    this.scene = new Scene(this.engine);
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

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.75;
    const key = new DirectionalLight('key', new Vector3(-0.4, -1, -0.6), this.scene);
    key.intensity = 1.4;

    this.assemblyRoot = new TransformNode('assembly', this.scene);
    this.centroid = assemblyCentroid(assembly);

    this.buildParts();
    this.buildBackground();

    this.engine.runRenderLoop(() => this.scene.render());
    window.addEventListener('resize', this.onResize);
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
      this.parts.set(part.id, { root, mesh, solidMat, overlayMat, outline: false });
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

    if (status === 'ghost') {
      visual.mesh.material = visual.overlayMat;
      visual.mesh.isVisible = state.showGhosts || isActive;
      this.tintOverlay(visual, isActive ? DIAGNOSTIC_COLORS.active : DIAGNOSTIC_COLORS.ghost, isActive ? 0.42 : 0.22);
    } else {
      // Placed: show the solid part, tinted by its worst diagnostic.
      visual.mesh.isVisible = true;
      if (severity) {
        this.tintOverlay(visual, DIAGNOSTIC_COLORS[severity], 0.55);
        visual.mesh.material = visual.overlayMat;
      } else {
        visual.mesh.material = visual.solidMat;
      }
    }

    // Selected or erroring parts get an outline and a subtle attention pulse.
    const wantOutline = isSelected || severity === 'error';
    if (wantOutline !== visual.outline) {
      visual.mesh.renderOutline = wantOutline;
      visual.mesh.outlineColor = Color3.FromHexString(isSelected ? '#ffffff' : DIAGNOSTIC_COLORS.error);
      visual.mesh.outlineWidth = 0.004;
      visual.outline = wantOutline;
    }
    const pulse = severity === 'error' ? pulseScale(performance.now() - this.startMs) : 1;
    visual.mesh.scaling.setAll(pulse);

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
    if (this.state && (this.state.timeline || this.hasError())) this.update(this.state);
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

  pickPartAt(x: number, y: number): string | undefined {
    const pick = this.scene.pick(x, y);
    const name = pick?.pickedMesh?.name ?? '';
    const m = name.match(/^mesh-(.+)$/);
    return m ? m[1] : undefined;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
