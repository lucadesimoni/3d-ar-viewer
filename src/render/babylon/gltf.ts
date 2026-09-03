import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Vec3 } from '../../engine/types';

// Register the glTF 2.0 loader and Draco decompression on the side-effect import.
// glTF/GLB is the runtime 3D format for the web; Draco keeps CAD-scale meshes
// small enough to stream over cellular.
import '@babylonjs/loaders/glTF/2.0';
import { DracoCompression } from '@babylonjs/core/Meshes/Compression/dracoCompression';

let dracoConfigured = false;

/**
 * Point Babylon's Draco decoder at a pinned CDN so compressed glTF loads with no
 * extra asset wiring in a deployment. Called lazily the first time a Draco model
 * is requested; override `DracoCompression.Configuration` at startup to
 * self-host the decoder instead.
 */
function ensureDraco(): void {
  if (dracoConfigured) return;
  dracoConfigured = true;
  DracoCompression.Configuration = {
    decoder: {
      wasmUrl: 'https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf.wasm',
      wasmBinaryUrl: 'https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf.wasm',
      fallbackUrl: 'https://cdn.jsdelivr.net/npm/draco3dgltf@1.5.7/draco_decoder_gltf.js',
    },
  };
}

export interface LoadedModel {
  root: TransformNode;
  meshes: AbstractMesh[];
  /** Full size of the loaded model in metres, after scaling. */
  size: Vec3;
  dispose(): void;
}

/**
 * Load a glTF / GLB model and attach it under `parent`.
 *
 * The whole file is loaded into an asset container and added to the scene, then
 * every root mesh is re-parented under the caller's part node so it inherits the
 * part's pose and the assembly anchor. The model is optionally uniform-scaled,
 * and its world bounding box is measured and returned so collision and occlusion
 * can use real extents instead of the conservative placeholder.
 *
 * Returns `undefined` on any load failure (network, malformed file, unsupported
 * extension) — the caller keeps the placeholder primitive so a missing model
 * never blanks out the assembly.
 */
export async function loadPartModel(
  scene: Scene,
  url: string,
  parent: TransformNode,
  opts: { scale?: number; draco?: boolean } = {},
): Promise<LoadedModel | undefined> {
  if (opts.draco) ensureDraco();
  let container: AssetContainer;
  try {
    container = await LoadAssetContainerAsync(url, scene);
  } catch {
    return undefined;
  }
  container.addAllToScene();

  const scale = opts.scale ?? 1;
  const roots = container.meshes.filter((m) => !m.parent);
  for (const r of roots) {
    r.parent = parent;
    if (scale !== 1) r.scaling.scaleInPlace(scale);
  }

  const size = measureSize(container.meshes);
  return {
    root: parent,
    meshes: container.meshes,
    size,
    dispose: () => container.dispose(),
  };
}

/** World-space size of a set of meshes, in metres. */
function measureSize(meshes: AbstractMesh[]): Vec3 {
  let min = new Vector3(Infinity, Infinity, Infinity);
  let max = new Vector3(-Infinity, -Infinity, -Infinity);
  let any = false;
  for (const m of meshes) {
    if (!m.getTotalVertices || m.getTotalVertices() === 0) continue;
    m.computeWorldMatrix(true);
    const info = m.getBoundingInfo();
    min = Vector3.Minimize(min, info.boundingBox.minimumWorld);
    max = Vector3.Maximize(max, info.boundingBox.maximumWorld);
    any = true;
  }
  if (!any) return [0, 0, 0];
  return [max.x - min.x, max.y - min.y, max.z - min.z];
}
