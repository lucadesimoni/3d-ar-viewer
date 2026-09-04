import type { AssemblyDef } from '../engine/types';

/**
 * A worked example assembly: a two-stage bench gearbox.
 *
 * It is small enough to grasp and yet exercises every diagnostic — a handed pair
 * of bearing caps (the left/right swap trap), a keyed shaft (roll matters),
 * bolts that must follow their housing, a keep-out volume over the output shaft,
 * and a strict build order. All dimensions are in metres in the assembly frame,
 * with the origin at the base-plate locating pin.
 */

// Millimetre helpers keep the authoring readable; the model is metres.
const mm = (n: number): number => n / 1000;
const I: [number, number, number, number] = [0, 0, 0, 1];

export const gearbox: AssemblyDef = {
  id: 'bench-gearbox',
  name: 'Two-Stage Bench Gearbox',
  revision: 'C',
  sourceUnits: 'mm',
  defaultTolerance: { positionMm: 1.2, angleDeg: 1.5, warnPositionMm: 0.8, warnAngleDeg: 1.0 },

  marker: {
    id: 'gearbox-datum',
    sizeM: mm(80),
    poseInAssembly: { position: [mm(-90), mm(2), mm(-70)], rotation: I },
  },
  datums: [
    { id: 'd0', label: 'Locating pin', position: [0, mm(6), 0] },
    { id: 'd1', label: 'Front-left foot', position: [mm(-80), 0, mm(-60)] },
    { id: 'd2', label: 'Front-right foot', position: [mm(80), 0, mm(-60)] },
    { id: 'd3', label: 'Rear-left foot', position: [mm(-80), 0, mm(60)] },
  ],

  parts: [
    {
      id: 'baseplate',
      name: 'Base plate',
      sku: 'GBX-100',
      revision: 'B',
      revisionDate: '2025-03-11',
      supersedes: 'A',
      mesh: { type: 'plate', size: [mm(200), mm(12), mm(160)] },
      material: { color: '#5b6472', metalness: 0.6, roughness: 0.4 },
      targetPose: { position: [0, mm(6), 0], rotation: I },
      approach: [0, -1, 0],
      massKg: 1.8,
      connectors: [
        { id: 'boss-fl', kind: 'threadedBoss', position: [mm(-70), mm(12), mm(-55)], axis: [0, 1, 0], up: [0, 0, 1], accepts: ['boltHole'] },
        { id: 'boss-fr', kind: 'threadedBoss', position: [mm(70), mm(12), mm(-55)], axis: [0, 1, 0], up: [0, 0, 1], accepts: ['boltHole'] },
        { id: 'boss-rl', kind: 'threadedBoss', position: [mm(-70), mm(12), mm(55)], axis: [0, 1, 0], up: [0, 0, 1], accepts: ['boltHole'] },
        { id: 'boss-rr', kind: 'threadedBoss', position: [mm(70), mm(12), mm(55)], axis: [0, 1, 0], up: [0, 0, 1], accepts: ['boltHole'] },
        { id: 'housing-seat', kind: 'faceA', position: [0, mm(12), 0], axis: [0, 1, 0], up: [0, 0, 1], accepts: ['faceB'], symmetry: 1 },
      ],
    },
    {
      id: 'housing',
      name: 'Gear housing',
      sku: 'GBX-200',
      revision: 'C',
      revisionDate: '2026-01-20',
      supersedes: 'B',
      mesh: { type: 'box', size: [mm(160), mm(70), mm(120)] },
      material: { color: '#7d8794', metalness: 0.5, roughness: 0.5 },
      targetPose: { position: [0, mm(47), 0], rotation: I },
      approach: [0, 1, 0],
      massKg: 2.4,
      connectors: [
        { id: 'foot', kind: 'faceB', position: [0, mm(-35), 0], axis: [0, -1, 0], up: [0, 0, 1], accepts: ['faceA'], symmetry: 1, engagementDepth: mm(2) },
        { id: 'bore-in', kind: 'socket', position: [mm(-45), 0, mm(-60)], axis: [0, 0, -1], up: [0, 1, 0], accepts: ['pin'], engagementDepth: mm(18) },
        { id: 'bore-out', kind: 'socket', position: [mm(45), 0, mm(60)], axis: [0, 0, 1], up: [0, 1, 0], accepts: ['pin'], engagementDepth: mm(18) },
        { id: 'cap-left-seat', kind: 'railFemale', position: [mm(-45), mm(20), mm(-60)], axis: [0, 0, -1], up: [0, 1, 0], accepts: ['railMale'], symmetry: 1 },
        { id: 'cap-right-seat', kind: 'railFemale', position: [mm(45), mm(20), mm(60)], axis: [0, 0, 1], up: [0, 1, 0], accepts: ['railMale'], symmetry: 1 },
      ],
    },
    {
      id: 'input-shaft',
      name: 'Input shaft + pinion',
      sku: 'GBX-310',
      revision: 'B',
      revisionDate: '2025-09-02',
      mesh: { type: 'cylinder', radius: mm(9), height: mm(150) },
      material: { color: '#c9a227', metalness: 0.9, roughness: 0.2 },
      targetPose: { position: [mm(-45), 0, 0], rotation: [0.7071, 0, 0, 0.7071] },
      approach: [0, 0, -1],
      massKg: 0.35,
      torqueSpecNm: 0,
      connectors: [
        // Keyed: the flat must line up, so roll is fully constrained (symmetry 1).
        { id: 'j-in', kind: 'pin', position: [0, 0, mm(-70)], axis: [0, 0, -1], up: [0, 1, 0], accepts: ['socket'], symmetry: 1, engagementDepth: mm(18) },
      ],
    },
    {
      id: 'output-shaft',
      name: 'Output shaft + gear',
      sku: 'GBX-320',
      revision: 'B',
      revisionDate: '2025-09-02',
      mesh: { type: 'cylinder', radius: mm(11), height: mm(150) },
      material: { color: '#c9a227', metalness: 0.9, roughness: 0.2 },
      targetPose: { position: [mm(45), 0, 0], rotation: [0.7071, 0, 0, 0.7071] },
      approach: [0, 0, 1],
      massKg: 0.5,
      connectors: [
        { id: 'j-out', kind: 'pin', position: [0, 0, mm(70)], axis: [0, 0, 1], up: [0, 1, 0], accepts: ['socket'], symmetry: 1, engagementDepth: mm(18) },
      ],
    },
    {
      id: 'cap-left',
      name: 'Bearing cap — LEFT',
      sku: 'GBX-410L',
      revision: 'A',
      mesh: { type: 'plate', size: [mm(40), mm(30), mm(14)], holeRadius: mm(10) },
      material: { color: '#9aa4b2', metalness: 0.7, roughness: 0.35 },
      targetPose: { position: [mm(-45), mm(20), mm(-60)], rotation: I },
      approach: [0, mm(0), -1],
      mirrorGroup: 'bearing-cap',
      connectors: [
        { id: 'rail', kind: 'railMale', position: [0, 0, mm(7)], axis: [0, 0, -1], up: [0, 1, 0], accepts: ['railFemale'], symmetry: 1, engagementDepth: mm(4) },
      ],
    },
    {
      id: 'cap-right',
      name: 'Bearing cap — RIGHT',
      sku: 'GBX-410R',
      revision: 'A',
      mesh: { type: 'plate', size: [mm(40), mm(30), mm(14)], holeRadius: mm(12) },
      material: { color: '#9aa4b2', metalness: 0.7, roughness: 0.35 },
      targetPose: { position: [mm(45), mm(20), mm(60)], rotation: I },
      approach: [0, mm(0), 1],
      mirrorGroup: 'bearing-cap',
      connectors: [
        { id: 'rail', kind: 'railMale', position: [0, 0, mm(-7)], axis: [0, 0, 1], up: [0, 1, 0], accepts: ['railFemale'], symmetry: 1, engagementDepth: mm(4) },
      ],
    },
    ...(['fl', 'fr', 'rl', 'rr'] as const).map((corner, i) => {
      const x = corner.includes('l') ? mm(-70) : mm(70);
      const z = corner.startsWith('f') ? mm(-55) : mm(55);
      return {
        id: `bolt-${corner}`,
        name: `M6 hex bolt (${corner.toUpperCase()})`,
        sku: 'GBX-500',
        revision: 'A',
        mesh: { type: 'cylinder' as const, radius: mm(3), height: mm(24) },
        material: { color: '#2f3542', metalness: 0.8, roughness: 0.3 },
        targetPose: { position: [x, mm(24), z] as [number, number, number], rotation: I },
        approach: [0, 1, 0] as [number, number, number],
        groupId: 'fasteners',
        torqueSpecNm: 9,
        // Hex head has 6-fold symmetry — never flag its roll.
        connectors: [
          {
            id: 'thread',
            kind: 'boltHole' as const,
            position: [0, mm(-12), 0] as [number, number, number],
            axis: [0, -1, 0] as [number, number, number],
            up: [0, 0, 1] as [number, number, number],
            accepts: ['threadedBoss' as const],
            symmetry: 6,
            engagementDepth: mm(10),
          },
        ],
        _bolt: i, // silence unused index without eslint noise
      };
    }).map(({ _bolt, ...p }) => p),
  ],

  background: [
    {
      id: 'bench',
      name: 'Workbench top',
      mesh: { type: 'box', size: [mm(1200), mm(40), mm(800)] },
      pose: { position: [0, mm(-20), 0], rotation: I },
      role: 'occluder',
    },
    {
      id: 'fixture',
      name: 'Assembly fixture',
      mesh: { type: 'plate', size: [mm(240), mm(10), mm(200)] },
      pose: { position: [0, mm(1), 0], rotation: I },
      role: 'fixture',
    },
    {
      id: 'output-clearance',
      name: 'Output shaft service gap',
      mesh: { type: 'box', size: [mm(60), mm(80), mm(60)] },
      pose: { position: [mm(120), mm(40), mm(30)], rotation: I },
      role: 'keepOut',
    },
  ],

  tools: [
    { id: 't-hex5', name: '5 mm hex key', note: 'For the M6 housing bolts — 9 Nm.' },
    { id: 't-press', name: 'Arbor press', note: 'Seat the bearing caps square; do not hammer.' },
    { id: 't-loctite', name: 'Threadlocker 243', note: 'One drop per bolt.' },
  ],

  steps: [
    {
      id: 's1',
      title: 'Mount base plate',
      instruction: 'Set the base plate on the fixture and drop it onto the locating pin. Confirm it sits flat.',
      partIds: ['baseplate'],
      requires: [],
      mates: [],
      durationEstS: 40,
    },
    {
      id: 's2',
      title: 'Fit gear housing',
      instruction: 'Lower the housing straight down onto the base plate. The foot face must seat fully before you let go.',
      partIds: ['housing'],
      requires: ['s1'],
      mates: [{ id: 'm-housing', a: { partId: 'housing', connectorId: 'foot' }, b: { partId: 'baseplate', connectorId: 'housing-seat' }, type: 'faceMate' }],
      durationEstS: 60,
      caution: 'Heavy — support the far side so it lands square, not cocked.',
    },
    {
      id: 's3',
      title: 'Install input shaft',
      instruction: 'Slide the input shaft into the rear bore from the front, key up, until it bottoms.',
      partIds: ['input-shaft'],
      requires: ['s2'],
      mates: [{ id: 'm-in', a: { partId: 'input-shaft', connectorId: 'j-in' }, b: { partId: 'housing', connectorId: 'bore-in' }, type: 'insert' }],
      toolIds: ['t-press'],
      durationEstS: 50,
    },
    {
      id: 's4',
      title: 'Install output shaft',
      instruction: 'Slide the output shaft into the front bore, meshing its gear with the input pinion.',
      partIds: ['output-shaft'],
      requires: ['s2'],
      mates: [{ id: 'm-out', a: { partId: 'output-shaft', connectorId: 'j-out' }, b: { partId: 'housing', connectorId: 'bore-out' }, type: 'insert' }],
      toolIds: ['t-press'],
      durationEstS: 50,
    },
    {
      id: 's5',
      title: 'Fit bearing caps',
      instruction: 'Fit the LEFT cap on the input side and the RIGHT cap on the output side. The caps are handed — check the L/R stamp.',
      partIds: ['cap-left', 'cap-right'],
      requires: ['s3', 's4'],
      mates: [
        { id: 'm-capl', a: { partId: 'cap-left', connectorId: 'rail' }, b: { partId: 'housing', connectorId: 'cap-left-seat' }, type: 'slide' },
        { id: 'm-capr', a: { partId: 'cap-right', connectorId: 'rail' }, b: { partId: 'housing', connectorId: 'cap-right-seat' }, type: 'slide' },
      ],
      toolIds: ['t-press'],
      durationEstS: 70,
      caution: 'Swapping the caps looks fine but pinches the wrong bearing OD. Verify the hand.',
    },
    {
      id: 's6',
      title: 'Torque housing bolts',
      instruction: 'Fit all four M6 bolts with threadlocker and torque to 9 Nm in a cross pattern.',
      partIds: ['bolt-fl', 'bolt-fr', 'bolt-rl', 'bolt-rr'],
      requires: ['s5'],
      mates: [
        { id: 'm-bfl', a: { partId: 'bolt-fl', connectorId: 'thread' }, b: { partId: 'baseplate', connectorId: 'boss-fl' }, type: 'bolt' },
        { id: 'm-bfr', a: { partId: 'bolt-fr', connectorId: 'thread' }, b: { partId: 'baseplate', connectorId: 'boss-fr' }, type: 'bolt' },
        { id: 'm-brl', a: { partId: 'bolt-rl', connectorId: 'thread' }, b: { partId: 'baseplate', connectorId: 'boss-rl' }, type: 'bolt' },
        { id: 'm-brr', a: { partId: 'bolt-rr', connectorId: 'thread' }, b: { partId: 'baseplate', connectorId: 'boss-rr' }, type: 'bolt' },
      ],
      toolIds: ['t-hex5', 't-loctite'],
      durationEstS: 120,
    },
  ],
};
