import { JointFactory } from './assemblyBuilder';
import type { AssemblyDef, MateDef, PartDef, StepDef, Vec3 } from '../engine/types';

/**
 * A 4x4 cube shelf — the IKEA KALLAX 147 x 147 cm — as a testable sample.
 *
 * Why this one: it is the assembly most people can actually put in front of a
 * tablet. Every other sample here is a machine you have to imagine; this is a
 * real object with published dimensions, a genuine build sequence (long boards
 * first, short shelves last), and a facade that is a perfectly regular grid —
 * which is exactly the signature `vision/gridRecognition` locks onto. Point the
 * app at a real KALLAX and the overlay should land on it, to scale, with no
 * marker and no manual registration.
 *
 * Dimensions are derived from the two published numbers rather than guessed, so
 * they cannot drift apart: the unit is 1470 mm across and a cube opening is
 * 330 mm, which fixes the board thickness at (1470 - 4 x 330) / 5 = 30 mm.
 * Depth is 390 mm. The 3 mm hardboard back sits behind the frame.
 *
 * Frame: Y up, metres, origin on the floor at the centre of the footprint, the
 * open front facing +Z.
 */

const CUBE = 0.33;              // clear opening, published
const T = 0.03;                 // board thickness, derived — see above
const COLS = 4;
const ROWS = 4;
const W = COLS * CUBE + (COLS + 1) * T;   // 1.470
const H = ROWS * CUBE + (ROWS + 1) * T;   // 1.470 (square in 4x4)
const D = 0.39;
const PITCH = CUBE + T;         // 0.360
const BACK_T = 0.003;

const I: [number, number, number, number] = [0, 0, 0, 1];
const BOARD = { color: '#f1efe8', metalness: 0.02, roughness: 0.85 };
const HARDBOARD = { color: '#d8d2c4', metalness: 0.02, roughness: 0.95 };

/** Centre of the i-th vertical board, i = 0..COLS (0 and COLS are the sides). */
const panelX = (i: number): number => -W / 2 + T / 2 + i * PITCH;
/** Centre of the j-th horizontal board, j = 0 (bottom) .. ROWS (top). */
const boardY = (j: number): number => T / 2 + j * PITCH;
/** Centre of the c-th column of openings. */
const cubeX = (c: number): number => -W / 2 + T + CUBE / 2 + c * PITCH;

const INNER_H = H - 2 * T;      // 1.410 — verticals run between top and bottom
const FRONT_Z = D / 2;
const BACK_Z = -D / 2;

const dividerIds = [1, 2, 3].map((i) => `div-${i}`);
const shelfId = (r: number, c: number): string => `shelf-r${r}c${c}`;

const parts: PartDef[] = [
  {
    id: 'bottom', name: 'Bottom board', sku: 'KLX-B147',
    revision: '1', revisionDate: '2024-06-01',
    mesh: { type: 'box', size: [W, T, D] },
    material: BOARD,
    targetPose: { position: [0, boardY(0), 0], rotation: I },
    approach: [0, -1, 0], massKg: 4.6, connectors: [],
  },
  {
    id: 'side-l', name: 'Side panel, left', sku: 'KLX-S141', mirrorGroup: 'side',
    revision: '1', revisionDate: '2024-06-01',
    mesh: { type: 'box', size: [T, INNER_H, D] },
    material: BOARD,
    targetPose: { position: [panelX(0), T + INNER_H / 2, 0], rotation: I },
    approach: [0, -1, 0], massKg: 4.4, connectors: [],
  },
  {
    id: 'side-r', name: 'Side panel, right', sku: 'KLX-S141', mirrorGroup: 'side',
    revision: '1', revisionDate: '2024-06-01',
    mesh: { type: 'box', size: [T, INNER_H, D] },
    material: BOARD,
    targetPose: { position: [panelX(COLS), T + INNER_H / 2, 0], rotation: I },
    approach: [0, -1, 0], massKg: 4.4, connectors: [],
  },
  ...dividerIds.map((id, k) => ({
    id, name: `Divider ${k + 1}`, sku: 'KLX-D141',
    revision: '1', revisionDate: '2024-06-01',
    mesh: { type: 'box' as const, size: [T, INNER_H, D] as Vec3 },
    material: BOARD,
    targetPose: { position: [panelX(k + 1), T + INNER_H / 2, 0] as Vec3, rotation: I },
    approach: [0, -1, 0] as Vec3, massKg: 4.4, connectors: [],
  })),
  // Three rows of four short shelves. In a KALLAX the verticals run the full
  // height and the shelves are the short cross pieces, not the other way round.
  ...[1, 2, 3].flatMap((r) =>
    [0, 1, 2, 3].map((c) => ({
      id: shelfId(r, c), name: `Shelf row ${r}, bay ${c + 1}`, sku: 'KLX-H330',
      revision: '1', revisionDate: '2024-06-01',
      mesh: { type: 'box' as const, size: [CUBE, T, D] as Vec3 },
      material: BOARD,
      targetPose: { position: [cubeX(c), boardY(r), 0] as Vec3, rotation: I },
      approach: [0, -1, 0] as Vec3, massKg: 1.1, connectors: [],
    })),
  ),
  {
    id: 'top', name: 'Top board', sku: 'KLX-B147',
    revision: '1', revisionDate: '2024-06-01',
    mesh: { type: 'box', size: [W, T, D] },
    material: BOARD,
    targetPose: { position: [0, boardY(ROWS), 0], rotation: I },
    approach: [0, -1, 0], massKg: 4.6, connectors: [],
  },
  {
    id: 'back', name: 'Back panel', sku: 'KLX-BP147',
    revision: '2', revisionDate: '2025-02-14', supersedes: '1',
    mesh: { type: 'box', size: [W, H, BACK_T] },
    material: HARDBOARD,
    targetPose: { position: [0, H / 2, BACK_Z - BACK_T / 2], rotation: I },
    approach: [0, 0, -1], massKg: 2.3, connectors: [],
  },
];

const jf = new JointFactory(new Map(parts.map((p) => [p.id, p])));
const DOWEL = { depth: 0.014, symmetry: 2, type: 'insert' as const };

// Verticals are dowelled down into the bottom board.
for (const [i, id] of [[0, 'side-l'], [1, 'div-1'], [2, 'div-2'], [3, 'div-3'], [4, 'side-r']] as const) {
  jf.joint(id, 'bottom', [panelX(i), T, 0], [0, -1, 0], { ...DOWEL, id: `j-base-${id}` });
}
// Each shelf is dowelled into the vertical on either side of its bay.
for (const r of [1, 2, 3]) {
  for (const c of [0, 1, 2, 3]) {
    const left = c === 0 ? 'side-l' : `div-${c}`;
    const right = c === 3 ? 'side-r' : `div-${c + 1}`;
    const y = boardY(r);
    jf.joint(shelfId(r, c), left, [cubeX(c) - CUBE / 2, y, 0], [-1, 0, 0], { ...DOWEL, id: `j-${shelfId(r, c)}-l` });
    jf.joint(shelfId(r, c), right, [cubeX(c) + CUBE / 2, y, 0], [1, 0, 0], { ...DOWEL, id: `j-${shelfId(r, c)}-r` });
  }
}
// Top board drops onto every vertical.
for (const [i, id] of [[0, 'side-l'], [1, 'div-1'], [2, 'div-2'], [3, 'div-3'], [4, 'side-r']] as const) {
  jf.joint('top', id, [panelX(i), H - T, 0], [0, -1, 0], { ...DOWEL, id: `j-top-${id}` });
}
// Hardboard back, nailed on from behind.
jf.joint('back', 'side-l', [panelX(0), H / 2, BACK_Z], [0, 0, -1], { depth: 0.002, symmetry: 2, id: 'j-back-l' });
jf.joint('back', 'side-r', [panelX(COLS), H / 2, BACK_Z], [0, 0, -1], { depth: 0.002, symmetry: 2, id: 'j-back-r' });

const built = jf.build();
const step = (
  id: string, title: string, instruction: string, partIds: string[], requires: string[],
  extra: Partial<StepDef> = {},
): StepDef => ({
  id, title, instruction, partIds, requires,
  mates: jf.matesFor(partIds).filter((m: MateDef) => partIds.includes(m.a.partId)),
  durationEstS: 90,
  ...extra,
});

const steps: StepDef[] = [
  step('s1', 'Lay out the bottom board', 'Place the bottom board face down on the floor. Its dowel holes face up.', ['bottom'], []),
  step('s2', 'Fit the side panels', 'Push both side panels onto the outer dowels. They are handed only by their pre-drilled back edge.', ['side-l', 'side-r'], ['s1'], { caution: 'Mirrored pair — the pre-drilled back edge must face the back.' }),
  step('s3', 'Fit the three dividers', 'Set the full-height dividers on the three inner dowel pairs, 360 mm apart.', dividerIds, ['s1']),
  step('s4', 'Shelves, bottom row', 'Dowel the four short shelves of the bottom row between the verticals.', [0, 1, 2, 3].map((c) => shelfId(1, c)), ['s2', 's3']),
  step('s5', 'Shelves, middle row', 'Repeat for the middle row.', [0, 1, 2, 3].map((c) => shelfId(2, c)), ['s4']),
  step('s6', 'Shelves, top row', 'Repeat for the top row.', [0, 1, 2, 3].map((c) => shelfId(3, c)), ['s5']),
  step('s7', 'Close with the top board', 'Lower the top board onto all five verticals at once and tap it home.', ['top'], ['s6'], { durationEstS: 120 }),
  step('s8', 'Nail on the back panel', 'Square the frame, then nail the hardboard back on.', ['back'], ['s7'], { caution: 'Square the frame before nailing — the back is what holds it square.', durationEstS: 240 }),
];

export const kallax: AssemblyDef = {
  id: 'kallax-4x4',
  name: 'Cube shelf 4x4 (KALLAX)',
  revision: 'A',
  sourceUnits: 'mm',
  defaultTolerance: { positionMm: 5, angleDeg: 2.5, warnPositionMm: 3, warnAngleDeg: 1.5 },
  parts: built,
  steps,
  background: [],
  tools: [
    { id: 'allen', name: '4 mm hex key', note: 'Supplied in the box.' },
    { id: 'hammer', name: 'Hammer', note: 'For the back panel nails only.' },
  ],
  // The facade is the recognition target: 4 x 4 openings across 1470 mm. The
  // lattice the camera actually sees runs board centre to board centre, one
  // board thickness in from each outer face.
  recognition: {
    kind: 'grid', cols: COLS, rows: ROWS, widthM: W - T, heightM: H - T,
    poseInAssembly: { position: [0, H / 2, FRONT_Z], rotation: I },
    label: '4x4 cube shelf front',
  },
  datums: [
    { id: 'd1', label: 'Front bottom left corner', position: [-W / 2, 0, FRONT_Z] },
    { id: 'd2', label: 'Front bottom right corner', position: [W / 2, 0, FRONT_Z] },
    { id: 'd3', label: 'Front top left corner', position: [-W / 2, H, FRONT_Z] },
  ],
};

/** Exported so the recognition tests and the UI can quote the real numbers. */
export const KALLAX_DIMENSIONS = { widthM: W, heightM: H, depthM: D, boardT: T, openingM: CUBE, cols: COLS, rows: ROWS };
