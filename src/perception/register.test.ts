import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { Pose } from '../engine/types';
import { assemblyOf, camera, H, K, picture, W, type Solid } from './testScene';
import {
  cameraPositionOf, displacementPx, edgeModel, edgesFromTriangles, gradientPyramid, registerPose, shapeEdges,
} from './register';

/**
 * Registration against pictures whose truth is exact (`testScene.ts`): a few
 * shapes ray-cast into a small image, each face its own shade.
 */
function off(m: [number, number], yawDeg: number): Pose {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180);
  return { position: [m[0], 0, m[1]], rotation: [q.x, q.y, q.z, q.w] };
}
const turnDeg = (p: Pose) => (2 * Math.acos(Math.min(1, Math.abs(p.rotation[3]))) * 180) / Math.PI;
const IDENTITY: Pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

function setup(solids: Solid[], eye = new Vector3(0.9, 1.3, 2.2), target = new Vector3(0, 0.35, 0)) {
  const cam = camera(eye, target);
  const image = picture(solids, cam);
  const model = edgeModel(assemblyOf(solids));
  return {
    model, image,
    input: (start: Pose, modelOverride = model) => ({
      field: gradientPyramid(image, 320), model: modelOverride, start,
      viewMatrix: cam.view, cameraPosition: [eye.x, eye.y, eye.z] as [number, number, number], k: K,
    }),
  };
}

// A cabinet, with a smaller box on it.
const CABINET: Solid[] = [
  { mesh: { type: 'box', size: [0.8, 0.7, 0.4] }, at: new Vector3(0, 0.35, 0) },
  { mesh: { type: 'box', size: [0.3, 0.2, 0.25] }, at: new Vector3(0.15, 0.8, 0) },
];

describe('registerPose', () => {
  it('pulls a pose that is centimetres and degrees off back onto the object', () => {
    const { input } = setup(CABINET);
    for (const start of [off([0.05, -0.04], 4), off([-0.06, 0.03], -5), off([0.08, 0.02], 0)]) {
      const r = registerPose(input(start));
      expect(r.accepted).toBe(true);
      expect(Math.hypot(r.pose.position[0], r.pose.position[2])).toBeLessThan(0.012);
      expect(turnDeg(r.pose)).toBeLessThan(0.6);
      expect(displacementPx(IDENTITY, r.pose, input(start))).toBeLessThan(1);
      expect(r.after).toBeGreaterThan(r.before);
    }
  });

  it('leaves the floor where the platform measured it', () => {
    const { input } = setup(CABINET);
    const start = { ...off([0.05, 0.02], 3), position: [0.05, 0.01, 0.02] as [number, number, number] };
    const r = registerPose(input(start));
    expect(r.pose.position[1]).toBeCloseTo(0.01, 6);
  });

  it('does not move on a picture with nothing in it', () => {
    const { input } = setup(CABINET);
    const blank = new ImageData(new Uint8ClampedArray(W * H * 4).fill(128), W, H);
    const r = registerPose({ ...input(off([0.05, 0], 3)), field: gradientPyramid(blank, 320) });
    expect(r.accepted).toBe(false);
    expect(r.pose).toEqual(off([0.05, 0], 3));
  });

  it('refuses a model of something that is not there', () => {
    // The picture is the cabinet; the model is a tall narrow column.
    const { input } = setup(CABINET);
    const column = edgeModel(assemblyOf([{ mesh: { type: 'box', size: [0.2, 1.4, 0.2] }, at: new Vector3(0, 0.7, 0) }]));
    const r = registerPose(input(off([0.03, 0], 2), column));
    expect(r.accepted).toBe(false);
  });

  it('finds a round object by its outline', () => {
    const tank: Solid[] = [{ mesh: { type: 'cylinder', radius: 0.3, height: 0.8 }, at: new Vector3(0, 0.4, 0) }];
    const { input } = setup(tank);
    const r = registerPose(input(off([0.06, -0.05], 0)));
    expect(r.accepted).toBe(true);
    expect(Math.hypot(r.pose.position[0], r.pose.position[2])).toBeLessThan(0.015);
  });

  it('says so when a repeating object fits as well a step along', () => {
    // Five identical posts in the picture, a model of four: one post along fits as well.
    const post = (x: number): Solid => ({ mesh: { type: 'box', size: [0.06, 0.9, 0.06] }, at: new Vector3(x, 0.45, 0) });
    const seen = [-0.4, -0.2, 0, 0.2, 0.4].map(post);
    const { input } = setup(seen, new Vector3(0, 1.1, 2.4), new Vector3(0, 0.45, 0));
    const four = edgeModel(assemblyOf([-0.3, -0.1, 0.1, 0.3].map(post)));
    const r = registerPose(input(off([0.04, 0], 0), four));
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('ambiguous');
    // And with the whole row modelled, there is one answer.
    const all = edgeModel(assemblyOf(seen));
    const whole = registerPose(input(off([0.04, 0], 0), all));
    expect(whole.accepted).toBe(true);
    expect(Math.abs(whole.pose.position[0])).toBeLessThan(0.01);
  });
});

describe('cameraPositionOf', () => {
  it('reads the camera back out of its view matrix', () => {
    const eye = new Vector3(0.9, 1.3, 2.2);
    const p = cameraPositionOf(camera(eye, new Vector3(0, 0.35, 0)).view);
    expect(p[0]).toBeCloseTo(0.9, 9); expect(p[1]).toBeCloseTo(1.3, 9); expect(p[2]).toBeCloseTo(2.2, 9);
  });
});

describe('edge models', () => {
  it('a box has 12 crease edges', () => {
    const edges = shapeEdges({ type: 'box', size: [1, 2, 3] });
    expect(edges).toHaveLength(12);
    expect(edges.every((e) => e.crease)).toBe(true);
  });

  it('a cylinder has crease rims and smooth sides', () => {
    const edges = shapeEdges({ type: 'cylinder', radius: 0.2, height: 0.5 });
    expect(edges.filter((e) => e.crease)).toHaveLength(48);
    expect(edges.filter((e) => !e.crease)).toHaveLength(24);
  });

  it('a triangle mesh: creases where faces meet at an angle, not across a flat face', () => {
    // A unit cube as 12 triangles with split vertices, as an exporter writes it.
    const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
    const positions: number[] = []; const indices: number[] = [];
    for (const q of quads) {
      const base = positions.length / 3;
      q.forEach((i) => positions.push(...c[i]));
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const edges = edgesFromTriangles(positions, indices);
    expect(edges.filter((e) => e.crease)).toHaveLength(12);
    expect(edges.filter((e) => !e.crease)).toHaveLength(6); // the faces' diagonals
  });

  it('faces wound backwards, as a mirrored import has them, are turned out again by the file\'s normals', () => {
    // One quad on the floor facing up, wound clockwise seen from above, with upward normals.
    const positions = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
    const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    const indices = [0, 1, 2, 0, 2, 3];
    const wound = edgesFromTriangles(positions, indices);
    const turned = edgesFromTriangles(positions, indices, { normals });
    expect(wound[0].n1.y).toBe(-1);
    expect(turned.every((e) => e.n1.y === 1)).toBe(true);
  });

  it('a part from a file with no edges is left out, not guessed at', () => {
    const asm = assemblyOf(CABINET);
    asm.parts.push({ ...asm.parts[0], id: 'file', mesh: { type: 'url', url: 'x.glb', bounds: [1, 1, 1] } });
    expect(edgeModel(asm).boxes).toHaveLength(2);
  });

  it('thins a big model evenly to the sample budget', () => {
    const many = Array.from({ length: 60 }, (_, i): Solid => ({ mesh: { type: 'box', size: [0.4, 0.4, 0.4] }, at: new Vector3(i, 0.2, 0) }));
    const m = edgeModel(assemblyOf(many), { maxSamples: 500 });
    expect(m.samples).toHaveLength(500);
    expect(new Set(m.samples.map((s) => s.part)).size).toBe(60);
  });
});
