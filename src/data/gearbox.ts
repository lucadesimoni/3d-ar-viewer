import { JointFactory } from './assemblyBuilder';
import type { AssemblyDef, PartDef, Vec3 } from '../engine/types';

/**
 * A worked example assembly: a two-stage bench gearbox.
 *
 * Small enough to read at a glance, yet it exercises every diagnostic — a handed
 * pair of bearing caps (the classic left/right swap), a keyed shaft (roll
 * matters), bolts that must follow their housing, a keep-out volume over the
 * output shaft, and a strict build order.
 *
 * Geometry is stated once, physically: each part's target pose places it where
 * it really sits, and every joint is declared by its world point and insertion
 * axis (see `assemblyBuilder`). Connector frames are derived from those, so the
 * mates are consistent at nominal by construction rather than by hand-computed
 * local offsets — which is exactly what went wrong before.
 *
 * Frame: Y up, metres, origin at the base plate's locating pin on the bench.
 */

const mm = (n: number): number => n / 1000;
const I: [number, number, number, number] = [0, 0, 0, 1];
/** 90 degrees about X — turns a Y-axis cylinder into a Z-axis shaft. */
const ROT_X90: [number, number, number, number] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

// --- Key dimensions, so the parts and the joints cannot drift apart. ---
const PLATE = { w: mm(200), t: mm(12), d: mm(160) };
const PLATE_Y = PLATE.t / 2;              // centre; top face at PLATE.t
const PLATE_TOP = PLATE.t;

const HOUSING = { w: mm(160), h: mm(70), d: mm(120) };
const HOUSING_Y = PLATE_TOP + HOUSING.h / 2;   // sits on the plate
const HOUSING_FRONT = -HOUSING.d / 2;
const HOUSING_BACK = HOUSING.d / 2;

const SHAFT_LEN = mm(150);
const IN_X = mm(-45);
const OUT_X = mm(45);
const CAP_T = mm(14);

// Outside the housing footprint (±80 x, ±60 z) yet inside the plate (±100, ±80).
const BOLT_XY: [number, number][] = [
  [mm(-90), mm(-70)], [mm(90), mm(-70)], [mm(-90), mm(70)], [mm(90), mm(70)],
];
const BOLT_LEN = mm(24);

const parts: PartDef[] = [
  {
    id: 'baseplate', name: 'Base plate', sku: 'GBX-100',
    revision: 'B', revisionDate: '2025-03-11', supersedes: 'A',
    mesh: { type: 'plate', size: [PLATE.w, PLATE.t, PLATE.d] },
    material: { color: '#5b6472', metalness: 0.6, roughness: 0.4 },
    targetPose: { position: [0, PLATE_Y, 0], rotation: I },
    approach: [0, -1, 0], massKg: 1.8, connectors: [],
  },
  {
    id: 'housing', name: 'Gear housing', sku: 'GBX-200',
    revision: 'C', revisionDate: '2026-01-20', supersedes: 'B',
    mesh: { type: 'box', size: [HOUSING.w, HOUSING.h, HOUSING.d] },
    material: { color: '#7d8794', metalness: 0.5, roughness: 0.5 },
    targetPose: { position: [0, HOUSING_Y, 0], rotation: I },
    approach: [0, 1, 0], massKg: 2.4, connectors: [],
  },
  {
    // Runs through the housing at its mid-height — not at the bench surface.
    id: 'input-shaft', name: 'Input shaft + pinion', sku: 'GBX-310',
    revision: 'B', revisionDate: '2025-09-02',
    mesh: { type: 'cylinder', radius: mm(9), height: SHAFT_LEN },
    material: { color: '#c9a227', metalness: 0.9, roughness: 0.2 },
    targetPose: { position: [IN_X, HOUSING_Y, 0], rotation: ROT_X90 },
    approach: [0, 0, -1], massKg: 0.35, connectors: [],
  },
  {
    id: 'output-shaft', name: 'Output shaft + gear', sku: 'GBX-320',
    revision: 'B', revisionDate: '2025-09-02',
    mesh: { type: 'cylinder', radius: mm(11), height: SHAFT_LEN },
    material: { color: '#c9a227', metalness: 0.9, roughness: 0.2 },
    targetPose: { position: [OUT_X, HOUSING_Y, 0], rotation: ROT_X90 },
    approach: [0, 0, 1], massKg: 0.5, connectors: [],
  },
  {
    id: 'cap-left', name: 'Bearing cap — LEFT', sku: 'GBX-410L', revision: 'A',
    mesh: { type: 'plate', size: [mm(40), mm(30), CAP_T], holeRadius: mm(10) },
    material: { color: '#9aa4b2', metalness: 0.7, roughness: 0.35 },
    // On the housing's front face, centred on the input shaft.
    targetPose: { position: [IN_X, HOUSING_Y, HOUSING_FRONT - CAP_T / 2], rotation: I },
    approach: [0, 0, -1], mirrorGroup: 'bearing-cap', clearanceWith: ['input-shaft'], connectors: [],
  },
  {
    id: 'cap-right', name: 'Bearing cap — RIGHT', sku: 'GBX-410R', revision: 'A',
    mesh: { type: 'plate', size: [mm(40), mm(30), CAP_T], holeRadius: mm(12) },
    material: { color: '#9aa4b2', metalness: 0.7, roughness: 0.35 },
    targetPose: { position: [OUT_X, HOUSING_Y, HOUSING_BACK + CAP_T / 2], rotation: I },
    approach: [0, 0, 1], mirrorGroup: 'bearing-cap', clearanceWith: ['output-shaft'], connectors: [],
  },
  ...BOLT_XY.map(([x, z], i): PartDef => ({
    id: `bolt-${['fl', 'fr', 'rl', 'rr'][i]}`,
    name: `M6 hex bolt (${['FL', 'FR', 'RL', 'RR'][i]})`,
    sku: 'GBX-500', revision: 'A',
    mesh: { type: 'cylinder', radius: mm(3), height: BOLT_LEN },
    material: { color: '#2f3542', metalness: 0.8, roughness: 0.3 },
    // Threaded down into the plate: its lower end sits on the plate's top face.
    targetPose: { position: [x, PLATE_TOP + BOLT_LEN / 2, z] as Vec3, rotation: I },
    approach: [0, 1, 0], groupId: 'fasteners', torqueSpecNm: 9, connectors: [],
  })),
];

const j = new JointFactory(new Map(parts.map((p) => [p.id, p])));

// --- Joints, stated as physical facts in world coordinates. ---
// Housing lands on the plate's top face.
j.joint('housing', 'baseplate', [0, PLATE_TOP, 0], [0, -1, 0],
  { id: 'm-housing', type: 'faceMate', depth: mm(2), movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });

// Shafts slide into the housing bores; keyed, so roll is constrained.
j.joint('input-shaft', 'housing', [IN_X, HOUSING_Y, HOUSING_FRONT], [0, 0, 1],
  { id: 'm-in', type: 'insert', depth: mm(18), movingKind: 'pin', fixedKind: 'socket', symmetry: 1 });
j.joint('output-shaft', 'housing', [OUT_X, HOUSING_Y, HOUSING_BACK], [0, 0, -1],
  { id: 'm-out', type: 'insert', depth: mm(18), movingKind: 'pin', fixedKind: 'socket', symmetry: 1 });

// Handed caps onto their own housing faces.
j.joint('cap-left', 'housing', [IN_X, HOUSING_Y, HOUSING_FRONT], [0, 0, 1],
  { id: 'm-capl', type: 'slide', depth: mm(4), movingKind: 'railMale', fixedKind: 'railFemale', symmetry: 1 });
j.joint('cap-right', 'housing', [OUT_X, HOUSING_Y, HOUSING_BACK], [0, 0, -1],
  { id: 'm-capr', type: 'slide', depth: mm(4), movingKind: 'railMale', fixedKind: 'railFemale', symmetry: 1 });

// Bolts thread down into the plate's bosses. Hex head: 6-fold symmetry.
const boltIds = ['bolt-fl', 'bolt-fr', 'bolt-rl', 'bolt-rr'];
BOLT_XY.forEach(([x, z], i) => {
  j.joint(boltIds[i], 'baseplate', [x, PLATE_TOP, z], [0, -1, 0],
    { id: `m-b${['fl', 'fr', 'rl', 'rr'][i]}`, type: 'bolt', depth: mm(10),
      movingKind: 'boltHole', fixedKind: 'threadedBoss', symmetry: 6 });
});

export const gearbox: AssemblyDef = {
  id: 'bench-gearbox',
  name: 'Two-Stage Bench Gearbox',
  revision: 'C',
  sourceUnits: 'mm',
  defaultTolerance: { positionMm: 1.2, angleDeg: 1.5, warnPositionMm: 0.8, warnAngleDeg: 1.0 },
  marker: { id: 'gearbox-datum', sizeM: mm(80), poseInAssembly: { position: [mm(-90), mm(2), mm(-70)], rotation: I } },
  datums: [
    { id: 'd0', label: 'Locating pin', position: [0, PLATE_TOP, 0] },
    { id: 'd1', label: 'Front-left foot', position: [mm(-80), 0, mm(-60)] },
    { id: 'd2', label: 'Front-right foot', position: [mm(80), 0, mm(-60)] },
    { id: 'd3', label: 'Rear-left foot', position: [mm(-80), 0, mm(60)] },
  ],
  parts: j.build(),
  background: [
    { id: 'bench', name: 'Workbench top', mesh: { type: 'box', size: [mm(1200), mm(40), mm(800)] },
      pose: { position: [0, mm(-20), 0], rotation: I }, role: 'occluder' },
    { id: 'fixture', name: 'Assembly fixture', mesh: { type: 'plate', size: [mm(240), mm(10), mm(200)] },
      pose: { position: [0, mm(-5), 0], rotation: I }, role: 'fixture' },
    { id: 'output-clearance', name: 'Output shaft service gap', mesh: { type: 'box', size: [mm(60), mm(80), mm(60)] },
      pose: { position: [mm(155), mm(60), mm(30)], rotation: I }, role: 'keepOut' },
  ],
  tools: [
    { id: 't-hex5', name: '5 mm hex key', note: 'For the M6 housing bolts — 9 Nm.' },
    { id: 't-press', name: 'Arbor press', note: 'Seat the bearing caps square; do not hammer.' },
    { id: 't-loctite', name: 'Threadlocker 243', note: 'One drop per bolt.' },
  ],
  steps: [
    { id: 's1', title: 'Mount base plate',
      instruction: 'Set the base plate on the fixture and drop it onto the locating pin. Confirm it sits flat.',
      partIds: ['baseplate'], requires: [], mates: [], durationEstS: 40 },
    { id: 's2', title: 'Fit gear housing',
      instruction: 'Lower the housing straight down onto the base plate. The foot face must seat fully before you let go.',
      partIds: ['housing'], requires: ['s1'], mates: j.matesFor(['housing']), durationEstS: 60,
      caution: 'Heavy — support the far side so it lands square, not cocked.' },
    { id: 's3', title: 'Install input shaft',
      instruction: 'Slide the input shaft into the front bore, key up, until it bottoms.',
      partIds: ['input-shaft'], requires: ['s2'], mates: j.matesFor(['input-shaft']),
      toolIds: ['t-press'], durationEstS: 50 },
    { id: 's4', title: 'Install output shaft',
      instruction: 'Slide the output shaft into the rear bore, meshing its gear with the input pinion.',
      partIds: ['output-shaft'], requires: ['s2'], mates: j.matesFor(['output-shaft']),
      toolIds: ['t-press'], durationEstS: 50 },
    { id: 's5', title: 'Fit bearing caps',
      instruction: 'Fit the LEFT cap on the input side and the RIGHT cap on the output side. The caps are handed — check the L/R stamp.',
      partIds: ['cap-left', 'cap-right'], requires: ['s3', 's4'],
      mates: j.matesFor(['cap-left', 'cap-right']), toolIds: ['t-press'], durationEstS: 70,
      caution: 'Swapping the caps looks fine but pinches the wrong bearing OD. Verify the hand.' },
    { id: 's6', title: 'Torque housing bolts',
      instruction: 'Fit all four M6 bolts with threadlocker and torque to 9 Nm in a cross pattern.',
      partIds: boltIds, requires: ['s5'], mates: j.matesFor(boltIds),
      toolIds: ['t-hex5', 't-loctite'], durationEstS: 120 },
  ],
};
