import { JointFactory } from './assemblyBuilder';
import type { AssemblyDef, MateDef, PartDef, StepDef, Vec3 } from '../engine/types';

/**
 * A cube-shelf grid — the IKEA KALLAX family — as a testable sample, built by
 * one factory so every size shares the same geometry, joints and recognition
 * math instead of drifting apart in separate copies.
 *
 * Why this family: it is the assembly most people can actually put in front
 * of a tablet. Every other sample here is a machine you have to imagine; this
 * is a real object with published dimensions, a genuine build sequence (long
 * boards first, short shelves last), and a facade that is a perfectly regular
 * grid — which is exactly the signature `vision/gridRecognition` locks onto.
 * Point the app at a real KALLAX and the overlay should land on it, to scale,
 * with no marker and no manual registration.
 *
 * Dimensions are derived from the two published numbers for the 4x4 rather
 * than guessed, so they cannot drift apart: the unit is 1470 mm across and a
 * cube opening is 330 mm, which fixes the board thickness at
 * (1470 - 4 x 330) / 5 = 30 mm. Depth is 390 mm. Every other size in the
 * family — same board stock, same cube opening, just a different column and
 * row count — reuses that same board thickness and cube opening rather than a
 * separately published height, since IKEA build every size from the same
 * parts. That is a named approximation: it is not checked against a tape
 * measure on a real 4x2 unit, only against the 4x4's own published numbers.
 *
 * Frame: Y up, metres, origin on the floor at the centre of the footprint, the
 * open front facing +Z.
 */

const CUBE = 0.33;              // clear opening, published
const T = 0.03;                 // board thickness, derived — see above
const D = 0.39;
const BACK_T = 0.003;

const I: [number, number, number, number] = [0, 0, 0, 1];
const BOARD = { color: '#f1efe8', metalness: 0.02, roughness: 0.85 };
const HARDBOARD = { color: '#d8d2c4', metalness: 0.02, roughness: 0.95 };

/** Which internal shelf rows exist, and what to call the build step for each. */
function shelfRowTitles(rows: number): { row: number; title: string }[] {
  const inner = Array.from({ length: rows - 1 }, (_, i) => i + 1);
  return inner.map((row, i) => {
    const title = inner.length === 1 ? 'middle row'
      : i === 0 ? 'bottom row'
        : i === inner.length - 1 ? 'top row'
          : `row ${i + 1}`;
    return { row, title };
  });
}

/**
 * Build one size of the KALLAX family: `cols` x `rows` cube openings.
 *
 * Every position formula here is the 4x4's original, generalised over `cols`
 * and `rows` rather than hard-coded to 4 — a divider count of `cols - 1`, an
 * internal shelf row for every gap between `rows` cube rows, and so on. The
 * 4x4 call below must therefore reproduce the exact structure (part ids, step
 * ids, joint ids, recognition geometry) the original file had, since several
 * tests assert on it directly.
 */
function buildKallax(cols: number, rows: number, id: string, name: string): { assembly: AssemblyDef; dims: { widthM: number; heightM: number; depthM: number; boardT: number; openingM: number; cols: number; rows: number } } {
  const PITCH = CUBE + T;
  const W = cols * CUBE + (cols + 1) * T;
  const H = rows * CUBE + (rows + 1) * T;

  const panelX = (i: number): number => -W / 2 + T / 2 + i * PITCH;
  const boardY = (j: number): number => T / 2 + j * PITCH;
  const cubeX = (c: number): number => -W / 2 + T + CUBE / 2 + c * PITCH;

  const INNER_H = H - 2 * T;
  const FRONT_Z = D / 2;
  const BACK_Z = -D / 2;

  const dividerIds = Array.from({ length: cols - 1 }, (_, i) => `div-${i + 1}`);
  const shelfId = (r: number, c: number): string => `shelf-r${r}c${c}`;
  const shelfRows = shelfRowTitles(rows);

  const parts: PartDef[] = [
    {
      id: 'bottom', name: 'Bottom board', sku: `KLX-B${Math.round(W * 1000)}`,
      revision: '1', revisionDate: '2024-06-01',
      mesh: { type: 'box', size: [W, T, D] },
      material: BOARD,
      targetPose: { position: [0, boardY(0), 0], rotation: I },
      approach: [0, 1, 0], massKg: 4.6, connectors: [],
    },
    {
      id: 'side-l', name: 'Side panel, left', sku: `KLX-S${Math.round(INNER_H * 1000)}`, mirrorGroup: 'side',
      revision: '1', revisionDate: '2024-06-01',
      mesh: { type: 'box', size: [T, INNER_H, D] },
      material: BOARD,
      targetPose: { position: [panelX(0), T + INNER_H / 2, 0], rotation: I },
      approach: [0, 1, 0], massKg: 4.4, connectors: [],
    },
    {
      id: 'side-r', name: 'Side panel, right', sku: `KLX-S${Math.round(INNER_H * 1000)}`, mirrorGroup: 'side',
      revision: '1', revisionDate: '2024-06-01',
      mesh: { type: 'box', size: [T, INNER_H, D] },
      material: BOARD,
      targetPose: { position: [panelX(cols), T + INNER_H / 2, 0], rotation: I },
      approach: [0, 1, 0], massKg: 4.4, connectors: [],
    },
    ...dividerIds.map((did, k) => ({
      id: did, name: `Divider ${k + 1}`, sku: `KLX-D${Math.round(INNER_H * 1000)}`,
      revision: '1', revisionDate: '2024-06-01',
      mesh: { type: 'box' as const, size: [T, INNER_H, D] as Vec3 },
      material: BOARD,
      targetPose: { position: [panelX(k + 1), T + INNER_H / 2, 0] as Vec3, rotation: I },
      approach: [0, 1, 0] as Vec3, massKg: 4.4, connectors: [],
    })),
    // Every row of short shelves. In a KALLAX the verticals run the full
    // height and the shelves are the short cross pieces, not the other way
    // round.
    ...shelfRows.flatMap(({ row: r }) =>
      Array.from({ length: cols }, (_, c) => ({
        id: shelfId(r, c), name: `Shelf row ${r}, bay ${c + 1}`, sku: 'KLX-H330',
        revision: '1', revisionDate: '2024-06-01',
        mesh: { type: 'box' as const, size: [CUBE, T, D] as Vec3 },
        material: BOARD,
        targetPose: { position: [cubeX(c), boardY(r), 0] as Vec3, rotation: I },
        approach: [0, 1, 0] as Vec3, massKg: 1.1, connectors: [],
      })),
    ),
    {
      id: 'top', name: 'Top board', sku: `KLX-B${Math.round(W * 1000)}`,
      revision: '1', revisionDate: '2024-06-01',
      mesh: { type: 'box', size: [W, T, D] },
      material: BOARD,
      targetPose: { position: [0, boardY(rows), 0], rotation: I },
      approach: [0, 1, 0], massKg: 4.6, connectors: [],
    },
    {
      id: 'back', name: 'Back panel', sku: `KLX-BP${Math.round(W * 1000)}`,
      revision: '2', revisionDate: '2025-02-14', supersedes: '1',
      mesh: { type: 'box', size: [W, H, BACK_T] },
      material: HARDBOARD,
      targetPose: { position: [0, H / 2, BACK_Z - BACK_T / 2], rotation: I },
      approach: [0, 0, -1], massKg: 2.3, connectors: [],
    },
  ];

  const jf = new JointFactory(new Map(parts.map((p) => [p.id, p])));
  const DOWEL = { depth: 0.014, symmetry: 2, type: 'insert' as const };

  const verticals: [number, string][] = [
    [0, 'side-l'], ...dividerIds.map((did, k) => [k + 1, did] as [number, string]), [cols, 'side-r'],
  ];
  // Verticals are dowelled down into the bottom board.
  for (const [i, vid] of verticals) {
    jf.joint(vid, 'bottom', [panelX(i), T, 0], [0, -1, 0], { ...DOWEL, id: `j-base-${vid}` });
  }
  // Each shelf is dowelled into the vertical on either side of its bay.
  for (const { row: r } of shelfRows) {
    for (let c = 0; c < cols; c++) {
      const left = c === 0 ? 'side-l' : `div-${c}`;
      const right = c === cols - 1 ? 'side-r' : `div-${c + 1}`;
      const y = boardY(r);
      jf.joint(shelfId(r, c), left, [cubeX(c) - CUBE / 2, y, 0], [-1, 0, 0], { ...DOWEL, id: `j-${shelfId(r, c)}-l` });
      jf.joint(shelfId(r, c), right, [cubeX(c) + CUBE / 2, y, 0], [1, 0, 0], { ...DOWEL, id: `j-${shelfId(r, c)}-r` });
    }
  }
  // Top board drops onto every vertical.
  for (const [i, vid] of verticals) {
    jf.joint('top', vid, [panelX(i), H - T, 0], [0, -1, 0], { ...DOWEL, id: `j-top-${vid}` });
  }
  // Hardboard back, nailed on from behind.
  jf.joint('back', 'side-l', [panelX(0), H / 2, BACK_Z], [0, 0, -1], { depth: 0.002, symmetry: 2, id: 'j-back-l' });
  jf.joint('back', 'side-r', [panelX(cols), H / 2, BACK_Z], [0, 0, -1], { depth: 0.002, symmetry: 2, id: 'j-back-r' });

  const built = jf.build();
  let stepSeq = 0;
  const step = (
    title: string, instruction: string, partIds: string[], requires: string[],
    extra: Partial<StepDef> = {},
  ): StepDef => ({
    id: `s${++stepSeq}`, title, instruction, partIds, requires,
    mates: jf.matesFor(partIds).filter((m: MateDef) => partIds.includes(m.a.partId)),
    durationEstS: 90,
    ...extra,
  });

  const steps: StepDef[] = [
    step('Lay out the bottom board', 'Place the bottom board face down on the floor. Its dowel holes face up.', ['bottom'], []),
    step('Fit the side panels', 'Push both side panels onto the outer dowels. They are handed only by their pre-drilled back edge.', ['side-l', 'side-r'], ['s1'], { caution: 'Mirrored pair — the pre-drilled back edge must face the back.' }),
    ...(dividerIds.length > 0
      ? [step(`Fit the ${dividerIds.length === 1 ? '' : dividerIds.length + ' '}divider${dividerIds.length === 1 ? '' : 's'}`.trim(),
        `Set the full-height divider${dividerIds.length === 1 ? '' : 's'} on the inner dowel pair${dividerIds.length === 1 ? '' : 's'}, ${Math.round(PITCH * 1000)} mm apart.`, dividerIds, ['s1'])]
      : []),
    ...shelfRows.map(({ row: r, title }) => {
      const partIds = Array.from({ length: cols }, (_, c) => shelfId(r, c));
      return step(`Shelves, ${title}`, `Dowel the ${cols} short shelves of the ${title} between the verticals.`,
        partIds, [`s${stepSeq}`]);
    }),
    step('Close with the top board', `Lower the top board onto all ${cols + 1} verticals at once and tap it home.`, ['top'], [`s${stepSeq}`], { durationEstS: 120 }),
    step('Nail on the back panel', 'Square the frame, then nail the hardboard back on.', ['back'], [`s${stepSeq}`], { caution: 'Square the frame before nailing — the back is what holds it square.', durationEstS: 240 }),
  ];

  const assembly: AssemblyDef = {
    id,
    name,
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
    // The facade is the recognition target: cols x rows openings across W mm.
    // The lattice the camera actually sees runs board centre to board centre,
    // one board thickness in from each outer face.
    recognition: {
      kind: 'grid', cols, rows, widthM: W - T, heightM: H - T,
      // The front looks along world +Z, and a recognition target's +Z points
      // away from the viewer — hence the half turn about Y rather than identity.
      poseInAssembly: { position: [0, H / 2, FRONT_Z], rotation: [0, 1, 0, 0] },
      label: `${cols}x${rows} cube shelf front`,
    },
    datums: [
      { id: 'd1', label: 'Front bottom left corner', position: [-W / 2, 0, FRONT_Z] },
      { id: 'd2', label: 'Front bottom right corner', position: [W / 2, 0, FRONT_Z] },
      { id: 'd3', label: 'Front top left corner', position: [-W / 2, H, FRONT_Z] },
    ],
  };

  return { assembly, dims: { widthM: W, heightM: H, depthM: D, boardT: T, openingM: CUBE, cols, rows } };
}

const kallax4x4 = buildKallax(4, 4, 'kallax-4x4', 'Cube shelf 4x4 (KALLAX)');
export const kallax: AssemblyDef = kallax4x4.assembly;
/** Exported so the recognition tests and the UI can quote the real numbers. */
export const KALLAX_DIMENSIONS = kallax4x4.dims;

// The unit in the KALLAX-adjacent photo this app is being calibrated against:
// 4 columns wide, 2 rows tall — the classic IKEA 4x2 (147 x 77 cm). Same
// board stock and cube opening as the 4x4, just fewer rows — see the
// approximation note above.
const kallax4x2 = buildKallax(4, 2, 'kallax-4x2', 'Cube shelf 4x2 (KALLAX)');
export const kallax4x2Assembly: AssemblyDef = kallax4x2.assembly;
export const KALLAX_4X2_DIMENSIONS = kallax4x2.dims;
