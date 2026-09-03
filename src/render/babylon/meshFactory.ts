import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { CSG } from '@babylonjs/core/Meshes/csg';
import { PBRMetallicRoughnessMaterial } from '@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { MaterialSpec, MeshSpec, Pose } from '../../engine/types';

/**
 * Turn the engine's renderer-agnostic `MeshSpec` into a Babylon mesh.
 *
 * The engine deliberately knows nothing about Babylon — it describes parts as
 * primitives plus dimensions in metres. This is the one place that mapping
 * lives, so swapping the renderer never touches the domain model. glTF parts
 * (`type: 'url'`) are loaded asynchronously and patched in by the scene.
 */
export function buildMesh(scene: Scene, spec: MeshSpec, name: string): Mesh {
  switch (spec.type) {
    case 'box':
      return MeshBuilder.CreateBox(name, { width: spec.size[0], height: spec.size[1], depth: spec.size[2] }, scene);
    case 'sphere':
      return MeshBuilder.CreateSphere(name, { diameter: spec.radius * 2, segments: 24 }, scene);
    case 'cylinder':
      return MeshBuilder.CreateCylinder(
        name,
        { diameter: spec.radius * 2, height: spec.height, tessellation: spec.radialSegments ?? 32 },
        scene,
      );
    case 'tube':
      return buildTube(scene, spec.radius, spec.height, spec.wall, name);
    case 'plate':
      return buildPlate(scene, spec, name);
    case 'url':
      // Placeholder until the glTF resolves; keeps the pose slot occupied.
      return MeshBuilder.CreateBox(name, { size: 0.02 }, scene);
  }
}

function buildTube(scene: Scene, radius: number, height: number, wall: number, name: string): Mesh {
  const outer = MeshBuilder.CreateCylinder(`${name}-o`, { diameter: radius * 2, height, tessellation: 32 }, scene);
  const inner = MeshBuilder.CreateCylinder(
    `${name}-i`,
    { diameter: Math.max(0.0001, (radius - wall) * 2), height: height * 1.2, tessellation: 32 },
    scene,
  );
  const result = CSG.FromMesh(outer).subtract(CSG.FromMesh(inner)).toMesh(name, undefined, scene);
  outer.dispose();
  inner.dispose();
  return result;
}

/** A flat plate, optionally with a central bore — the bearing-cap shape. */
function buildPlate(scene: Scene, spec: Extract<MeshSpec, { type: 'plate' }>, name: string): Mesh {
  const plate = MeshBuilder.CreateBox(
    name,
    { width: spec.size[0], height: spec.size[1], depth: spec.size[2] },
    scene,
  );
  if (!spec.holeRadius) return plate;
  const bore = MeshBuilder.CreateCylinder(
    `${name}-bore`,
    { diameter: spec.holeRadius * 2, height: spec.size[1] * 1.4, tessellation: 32 },
    scene,
  );
  const result = CSG.FromMesh(plate).subtract(CSG.FromMesh(bore)).toMesh(name, undefined, scene);
  plate.dispose();
  bore.dispose();
  return result;
}

export function applyPose(mesh: TransformNode, pose: Pose): void {
  mesh.position.set(pose.position[0], pose.position[1], pose.position[2]);
  if (!mesh.rotationQuaternion) mesh.rotationQuaternion = new Quaternion();
  mesh.rotationQuaternion.set(pose.rotation[0], pose.rotation[1], pose.rotation[2], pose.rotation[3]);
}

export function makeMaterial(scene: Scene, spec: MaterialSpec | undefined, name: string): PBRMetallicRoughnessMaterial {
  const mat = new PBRMetallicRoughnessMaterial(name, scene);
  const c = Color3.FromHexString(spec?.color ?? '#8a94a6');
  mat.baseColor = c;
  mat.metallic = spec?.metalness ?? 0.4;
  mat.roughness = spec?.roughness ?? 0.5;
  if (spec?.opacity !== undefined && spec.opacity < 1) {
    mat.alpha = spec.opacity;
  }
  return mat;
}

/**
 * Translucent, unlit overlay material for ghosts, diagnostics tints, and
 * fixtures. Kept as a StandardMaterial with emissive colour so it reads clearly
 * against a camera passthrough regardless of scene lighting.
 */
export function makeOverlayMaterial(scene: Scene, hex: string, alpha: number, name: string): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  const c = Color3.FromHexString(hex);
  mat.diffuseColor = c;
  mat.emissiveColor = c.scale(0.6);
  mat.alpha = alpha;
  mat.backFaceCulling = false;
  mat.disableLighting = false;
  return mat;
}

export const DIAGNOSTIC_COLORS = {
  error: '#ef4444',
  warning: '#f59e0b',
  info: '#38bdf8',
  verified: '#22c55e',
  ghost: '#64748b',
  active: '#22d3ee',
} as const;

export const vec3 = (v: [number, number, number]): Vector3 => new Vector3(v[0], v[1], v[2]);
