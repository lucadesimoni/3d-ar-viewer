import { Quaternion, Vector3 } from 'three';
import { JointFactory } from './assemblyBuilder';
import type { AssemblyDef, PartDef, Pose, Vec3 } from '../engine/types';

/**
 * A twin-spool turbofan on its transport stand — the complex sample.
 *
 * Fifty parts in sixteen steps, built the way an engine shop actually does
 * it: the core casings onto the stand, the high-pressure spool and its disks
 * inside them, the fuel nozzles round the combustor, the low-pressure shaft
 * through the middle, then the fan, its sixteen blades, and the accessories.
 * Every module has its own colour, so the overlay reads at a glance — cold
 * section blues and greens, a copper combustor, turbines in heat colours.
 *
 * It exercises what the furniture samples cannot: parts nested inside one
 * another round a common axis, many identical parts in a ring (blades and
 * nozzles that must be installed and balanced as sets), radial insertion, and
 * a build order that is a graph rather than a list.
 *
 * Frame: Y up, metres, origin on the floor under the stand's centre. The
 * engine axis runs along Z at `AXIS_Y`, intake towards −Z.
 */

const I: Pose['rotation'] = [0, 0, 0, 1];
/** 90° about X: a Y-axis cylinder or tube becomes one along the engine axis (Z). */
const ALONG_AXIS: Pose['rotation'] = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const AXIS_Y = 1.0;

/** Rotation that turns local +Y to point radially outward at angle `phi` round the axis. */
function radialTurn(phi: number, stagger = 0): Pose['rotation'] {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), phi)
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), stagger));
  return [q.x, q.y, q.z, q.w];
}
/** The outward radial direction at angle `phi` — where local +Y ends up. */
const radial = (phi: number): Vec3 => [-Math.sin(phi), Math.cos(phi), 0];
const onAxis = (z: number): Vec3 => [0, AXIS_Y, z];
const atRadius = (phi: number, r: number, z: number): Vec3 => {
  const u = radial(phi);
  return [u[0] * r, AXIS_Y + u[1] * r, z];
};

/** An axisymmetric module: a ring (tube) or a solid (cylinder) between two axial stations. */
interface Station { z0: number; z1: number }
const span = (s: Station) => ({ centre: (s.z0 + s.z1) / 2, length: s.z1 - s.z0 });

// --- Stations along the axis, metres. Parts meet at shared stations. ---------
const LIP: Station = { z0: -0.97, z1: -0.89 };
const FAN_CASE: Station = { z0: -0.89, z1: -0.30 };
const FAN_DISK: Station = { z0: -0.80, z1: -0.70 };
const LPC: Station = { z0: -0.30, z1: -0.10 };
const HPC: Station = { z0: -0.10, z1: 0.20 };
const COMBUSTOR: Station = { z0: 0.20, z1: 0.42 };
const HPT: Station = { z0: 0.42, z1: 0.55 };
const LPT: Station = { z0: 0.55, z1: 0.80 };
const NOZZLE: Station = { z0: 0.80, z1: 1.00 };
const HP_SPOOL: Station = { z0: -0.10, z1: 0.52 };
const LP_SHAFT: Station = { z0: -0.70, z1: 0.80 };

const FAN_HUB_R = 0.14;
const BLADE_TIP_R = 0.425;
const BLADE_COUNT = 16;
const BLADE_STAGGER = (20 * Math.PI) / 180;
const NOZZLE_COUNT = 8;
const NOZZLE_Z = 0.28;
const HPC_DISK_Z = [-0.05, 0.03, 0.11];
const LPT_DISK_Z = [0.62, 0.72];

const STAND_TOP = 0.08;
const FRONT_MOUNT_Z = 0.05;     // under the HP compressor casing
const REAR_MOUNT_Z = 0.70;      // under the LP turbine casing

/** A ring along the engine axis: outer radius, wall, and where it runs. */
function ring(id: string, name: string, r: number, wall: number, at: Station, color: string,
  extra: Partial<PartDef> = {}): PartDef {
  const { centre, length } = span(at);
  return {
    id, name,
    mesh: { type: 'tube', radius: r, height: length, wall },
    material: { color, metalness: 0.6, roughness: 0.4 },
    targetPose: { position: onAxis(centre), rotation: ALONG_AXIS },
    connectors: [], ...extra,
  };
}

const PALETTE = {
  stand: '#f2c230', mount: '#e8772e', lip: '#d9dde3', fanCase: '#1f4e9c',
  fanDisk: '#8a9bb0', blade: '#9fb4cc', spinner: '#f4f4f4', booster: '#2a9d8f',
  hpc: '#3a7d44', hpcDisk: '#b8c4d0', hpSpool: '#6c7a89', lpShaft: '#c9a227',
  combustor: '#b87333', fuelNozzle: '#ff8c1a', hpt: '#8b2e16', hptDisk: '#d35400',
  lpt: '#a0522d', lptDisk: '#e07b39', exhaust: '#c0c6cc', tailPlug: '#5a5f66',
  agb: '#6a4c93', exciter: '#c0392b', fuelLine: '#ff6f00', ignitionLead: '#fdd835',
};

const bladeIds = Array.from({ length: BLADE_COUNT }, (_, i) => `fan-blade-${String(i + 1).padStart(2, '0')}`);
const nozzleIds = Array.from({ length: NOZZLE_COUNT }, (_, i) => `fuel-nozzle-${i + 1}`);
const hpcDiskIds = HPC_DISK_Z.map((_, i) => `hpc-disk-${i + 1}`);
const lptDiskIds = LPT_DISK_Z.map((_, i) => `lpt-disk-${i + 1}`);
const bladePhi = (i: number) => (2 * Math.PI * i) / BLADE_COUNT;
// Offset half a pitch, so no nozzle sits where the fuel line runs (at 180°).
const nozzlePhi = (i: number) => (2 * Math.PI * (i + 0.5)) / NOZZLE_COUNT;

const parts: PartDef[] = [
  // --- The stand ------------------------------------------------------------
  {
    id: 'stand-base', name: 'Transport stand base', sku: 'TF-ST-100', revision: 'D',
    mesh: { type: 'box', size: [1.4, STAND_TOP, 1.0] },
    material: { color: PALETTE.stand, metalness: 0.3, roughness: 0.6 },
    targetPose: { position: [0, STAND_TOP / 2, 0.1], rotation: I },
    approach: [0, 1, 0], massKg: 85, connectors: [],
  },
  ...([['mount-front', 'Front mount post', FRONT_MOUNT_Z, AXIS_Y - 0.26],
    ['mount-rear', 'Rear mount post', REAR_MOUNT_Z, AXIS_Y - 0.32]] as const).map(([id, name, z, top]): PartDef => ({
    id, name, sku: 'TF-ST-210', revision: 'B',
    mesh: { type: 'box', size: [0.10, top - STAND_TOP, 0.10] },
    material: { color: PALETTE.mount, metalness: 0.4, roughness: 0.5 },
    targetPose: { position: [0, (STAND_TOP + top) / 2, z], rotation: I },
    approach: [0, 1, 0], massKg: 9, connectors: [],
  })),

  // --- Core casings ---------------------------------------------------------
  ring('hpc-case', 'HP compressor casing', 0.26, 0.02, HPC, PALETTE.hpc,
    { sku: 'TF-CC-300', revision: 'F', approach: [0, 1, 0], massKg: 48 }),
  ring('combustor-case', 'Combustor casing', 0.27, 0.02, COMBUSTOR, PALETTE.combustor,
    { sku: 'TF-CB-400', revision: 'E', approach: [0, 0, 1], massKg: 36 }),
  ring('hpt-case', 'HP turbine casing', 0.28, 0.02, HPT, PALETTE.hpt,
    { sku: 'TF-HT-500', revision: 'C', approach: [0, 0, 1], massKg: 31 }),
  ring('lpt-case', 'LP turbine casing', 0.32, 0.02, LPT, PALETTE.lpt,
    { sku: 'TF-LT-600', revision: 'C', approach: [0, 0, 1], massKg: 44 }),

  // --- HP spool -------------------------------------------------------------
  ring('hp-spool', 'HP spool', 0.08, 0.02, HP_SPOOL, PALETTE.hpSpool,
    { sku: 'TF-HS-310', revision: 'B', approach: [0, 0, -1], massKg: 22 }),
  ...hpcDiskIds.map((id, i) => ring(id, `HP compressor disk ${i + 1}`, 0.22, 0.14,
    { z0: HPC_DISK_Z[i] - 0.02, z1: HPC_DISK_Z[i] + 0.02 }, PALETTE.hpcDisk,
    { sku: `TF-HD-32${i}`, revision: 'A', approach: [0, 0, -1], massKg: 6.5, groupId: 'hpc-stack' })),
  ring('hpt-disk', 'HP turbine disk', 0.24, 0.16, { z0: 0.455, z1: 0.505 }, PALETTE.hptDisk,
    { sku: 'TF-HD-510', revision: 'B', approach: [0, 0, 1], massKg: 11, torqueSpecNm: 140 }),

  // --- Fuel nozzles, radial through the combustor ---------------------------
  ...nozzleIds.map((id, i): PartDef => ({
    id, name: `Fuel nozzle ${i + 1}`, sku: 'TF-FN-410', revision: 'G',
    mesh: { type: 'cylinder', radius: 0.012, height: 0.10 },
    material: { color: PALETTE.fuelNozzle, metalness: 0.7, roughness: 0.3 },
    targetPose: { position: atRadius(nozzlePhi(i), 0.27, NOZZLE_Z), rotation: radialTurn(nozzlePhi(i)) },
    approach: radial(nozzlePhi(i)), groupId: 'fuel-nozzles', torqueSpecNm: 12, massKg: 0.4, connectors: [],
  })),

  // --- LP shaft and turbine -------------------------------------------------
  {
    id: 'lp-shaft', name: 'LP shaft', sku: 'TF-LS-700', revision: 'D',
    mesh: { type: 'cylinder', radius: 0.035, height: span(LP_SHAFT).length },
    material: { color: PALETTE.lpShaft, metalness: 0.9, roughness: 0.2 },
    targetPose: { position: onAxis(span(LP_SHAFT).centre), rotation: ALONG_AXIS },
    approach: [0, 0, 1], massKg: 18, connectors: [],
  },
  ...lptDiskIds.map((id, i) => ring(id, `LP turbine disk ${i + 1}`, 0.28, 0.23,
    { z0: LPT_DISK_Z[i] - 0.025, z1: LPT_DISK_Z[i] + 0.025 }, PALETTE.lptDisk,
    { sku: `TF-LD-61${i}`, revision: 'A', approach: [0, 0, 1], massKg: 9, groupId: 'lpt-stack' })),

  // --- Booster, fan case, fan ----------------------------------------------
  ring('lpc-case', 'Booster casing', 0.30, 0.02, LPC, PALETTE.booster,
    { sku: 'TF-BC-200', revision: 'C', approach: [0, 0, -1], massKg: 27 }),
  ring('fan-case', 'Fan case', 0.46, 0.025, FAN_CASE, PALETTE.fanCase,
    { sku: 'TF-FC-100', revision: 'H', approach: [0, 0, -1], massKg: 120 }),
  ring('fan-disk', 'Fan disk', 0.14, 0.10, FAN_DISK, PALETTE.fanDisk,
    { sku: 'TF-FD-110', revision: 'E', approach: [0, 0, -1], massKg: 38, torqueSpecNm: 320 }),
  ...bladeIds.map((id, i): PartDef => ({
    id, name: `Fan blade ${String(i + 1).padStart(2, '0')}`, sku: 'TF-FB-120', revision: 'K',
    // Thickness across the passage, span out from the hub, chord along the axis.
    mesh: { type: 'box', size: [0.012, BLADE_TIP_R - FAN_HUB_R, span(FAN_DISK).length] },
    material: { color: PALETTE.blade, metalness: 0.85, roughness: 0.25 },
    targetPose: {
      position: atRadius(bladePhi(i), (FAN_HUB_R + BLADE_TIP_R) / 2, span(FAN_DISK).centre),
      rotation: radialTurn(bladePhi(i), BLADE_STAGGER),
    },
    approach: radial(bladePhi(i)), groupId: 'fan-blades', massKg: 3.1, connectors: [],
  })),
  {
    id: 'spinner', name: 'Spinner', sku: 'TF-SP-130', revision: 'B',
    mesh: { type: 'sphere', radius: 0.13 },
    material: { color: PALETTE.spinner, metalness: 0.2, roughness: 0.3 },
    // Ahead of the disk, clear of the LP shaft's front end: centred on the disk
    // face it reached 29 mm into the shaft, and the clash check said so.
    targetPose: { position: onAxis(FAN_DISK.z0 - 0.04), rotation: I },
    approach: [0, 0, -1], massKg: 4, connectors: [],
  },
  ring('intake-lip', 'Intake lip', 0.48, 0.05, LIP, PALETTE.lip,
    { sku: 'TF-IL-140', revision: 'C', approach: [0, 0, -1], massKg: 22 }),

  // --- Exhaust ---------------------------------------------------------------
  ring('exhaust-nozzle', 'Exhaust nozzle', 0.30, 0.015, NOZZLE, PALETTE.exhaust,
    { sku: 'TF-EN-800', revision: 'D', approach: [0, 0, 1], massKg: 26 }),
  {
    id: 'tail-plug', name: 'Tail plug', sku: 'TF-TP-810', revision: 'A',
    mesh: { type: 'cylinder', radius: 0.10, height: 0.16 },
    material: { color: PALETTE.tailPlug, metalness: 0.6, roughness: 0.5 },
    targetPose: { position: onAxis(NOZZLE.z0 + 0.08), rotation: ALONG_AXIS },
    approach: [0, 0, 1], massKg: 7, connectors: [],
  },

  // --- Accessories -------------------------------------------------------------
  {
    id: 'agb', name: 'Accessory gearbox', sku: 'TF-AG-900', revision: 'F',
    mesh: { type: 'box', size: [0.30, 0.14, 0.22] },
    material: { color: PALETTE.agb, metalness: 0.5, roughness: 0.45 },
    // Hung under the fan case, its top against the case.
    targetPose: { position: [0, AXIS_Y - 0.46 - 0.07, -0.60], rotation: I },
    approach: [0, -1, 0], massKg: 34, connectors: [],
  },
  {
    id: 'ignition-exciter', name: 'Ignition exciter', sku: 'TF-IE-910', revision: 'B',
    mesh: { type: 'box', size: [0.12, 0.08, 0.10] },
    material: { color: PALETTE.exciter, metalness: 0.4, roughness: 0.5 },
    targetPose: { position: [0.26 + 0.06, AXIS_Y, 0.05], rotation: I },
    approach: [1, 0, 0], massKg: 3.2, connectors: [],
  },
  {
    id: 'fuel-line', name: 'Fuel manifold line', sku: 'TF-FL-920', revision: 'C',
    mesh: { type: 'cylinder', radius: 0.01, height: 0.34 },
    material: { color: PALETTE.fuelLine, metalness: 0.6, roughness: 0.35 },
    targetPose: { position: [-0.29, AXIS_Y, 0.09], rotation: ALONG_AXIS },
    approach: [-1, 0, 0], massKg: 1.1, connectors: [],
  },
  {
    id: 'ignition-lead', name: 'Ignition lead', sku: 'TF-IL-930', revision: 'A',
    mesh: { type: 'cylinder', radius: 0.008, height: 0.15 },
    material: { color: PALETTE.ignitionLead, metalness: 0.2, roughness: 0.6 },
    targetPose: { position: [0.29, AXIS_Y + 0.08, 0.175], rotation: ALONG_AXIS },
    approach: [1, 0, 0], massKg: 0.3, connectors: [],
  },
];

/**
 * Pass-throughs worked out from the real radii, not listed by hand.
 *
 * Interference is checked with bounding boxes, and a box cannot see a bore: a
 * shaft inside a casing, or blades inside the fan case, are boxes inside boxes.
 * For parts round the engine axis the real shape is a ring between two radii,
 * so two of them are clear of each other exactly when their rings do not
 * overlap — and then they are declared so. Two rings that do overlap are left
 * alone, and a clash between them is reported as one.
 */
function radialBand(p: PartDef): [number, number] | undefined {
  const m = p.mesh;
  if (p.groupId === 'fan-blades') return [FAN_HUB_R, BLADE_TIP_R];
  const centred = Math.abs(p.targetPose.position[0]) < 1e-9 && Math.abs(p.targetPose.position[1] - AXIS_Y) < 1e-9;
  if (!centred) return undefined;
  if (m.type === 'tube') return [m.radius - m.wall, m.radius];
  if (m.type === 'cylinder' || m.type === 'sphere') return [0, m.radius];
  return undefined;
}
for (const a of parts) {
  const ra = radialBand(a);
  if (!ra) continue;
  for (const b of parts) {
    const rb = radialBand(b);
    if (a === b || !rb || (a.groupId === 'fan-blades' && b.groupId === 'fan-blades')) continue;
    const clear = ra[1] <= rb[0] + 1e-9 || rb[1] <= ra[0] + 1e-9;
    if (clear) a.clearanceWith = [...(a.clearanceWith ?? []), b.id];
  }
}

const j = new JointFactory(new Map(parts.map((p) => [p.id, p])));
const down: Vec3 = [0, -1, 0];
const rearward: Vec3 = [0, 0, 1];
const forward: Vec3 = [0, 0, -1];

// Stand.
j.joint('mount-front', 'stand-base', [0, STAND_TOP, FRONT_MOUNT_Z], down,
  { id: 'm-mount-f', type: 'bolt', depth: 0.01, movingKind: 'boltHole', fixedKind: 'threadedBoss', symmetry: 4 });
j.joint('mount-rear', 'stand-base', [0, STAND_TOP, REAR_MOUNT_Z], down,
  { id: 'm-mount-r', type: 'bolt', depth: 0.01, movingKind: 'boltHole', fixedKind: 'threadedBoss', symmetry: 4 });

// Core casings: the HP compressor casing onto the front mount, the rest flange to flange.
j.joint('hpc-case', 'mount-front', [0, AXIS_Y - 0.26, FRONT_MOUNT_Z], down,
  { id: 'm-hpc', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });
j.joint('combustor-case', 'hpc-case', onAxis(HPC.z1), forward,
  { id: 'm-comb', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });
j.joint('hpt-case', 'combustor-case', onAxis(COMBUSTOR.z1), forward,
  { id: 'm-hptc', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });
j.joint('lpt-case', 'hpt-case', onAxis(HPT.z1), forward,
  { id: 'm-lptc', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });
j.joint('lpt-case', 'mount-rear', [0, AXIS_Y - 0.32, REAR_MOUNT_Z], down,
  { id: 'm-lptc-mount', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });

// HP spool slid in from the front; its disks stacked on it; the turbine disk from the rear.
j.joint('hp-spool', 'hpc-case', onAxis(HP_SPOOL.z0), rearward,
  { id: 'm-hps', type: 'insert', depth: 0.05, movingKind: 'pin', fixedKind: 'socket', symmetry: 1 });
hpcDiskIds.forEach((id, i) => j.joint(id, 'hp-spool', onAxis(HPC_DISK_Z[i]), rearward,
  { id: `m-hpcd${i + 1}`, type: 'insert', depth: 0.04, movingKind: 'socket', fixedKind: 'pin', symmetry: 1 }));
j.joint('hpt-disk', 'hp-spool', onAxis(0.48), forward,
  { id: 'm-hptd', type: 'insert', depth: 0.05, movingKind: 'socket', fixedKind: 'pin', symmetry: 1 });

// Fuel nozzles pushed radially into their combustor bosses.
nozzleIds.forEach((id, i) => {
  const out = radial(nozzlePhi(i));
  j.joint(id, 'combustor-case', atRadius(nozzlePhi(i), 0.26, NOZZLE_Z), [-out[0], -out[1], -out[2]],
    { id: `m-fn${i + 1}`, type: 'insert', depth: 0.02, movingKind: 'pin', fixedKind: 'socket', symmetry: 2 });
});

// LP shaft through the HP spool from the rear; its turbine disks onto it.
j.joint('lp-shaft', 'hp-spool', onAxis(HP_SPOOL.z1), forward,
  { id: 'm-lps', type: 'insert', depth: 0.1, movingKind: 'pin', fixedKind: 'socket', symmetry: 1 });
lptDiskIds.forEach((id, i) => j.joint(id, 'lp-shaft', onAxis(LPT_DISK_Z[i]), forward,
  { id: `m-lptd${i + 1}`, type: 'insert', depth: 0.05, movingKind: 'socket', fixedKind: 'pin', symmetry: 1 }));

// Booster and fan case forward of the core, flange to flange.
j.joint('lpc-case', 'hpc-case', onAxis(HPC.z0), rearward,
  { id: 'm-lpc', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });
j.joint('fan-case', 'lpc-case', onAxis(LPC.z0), rearward,
  { id: 'm-fanc', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });

// Fan disk onto the front of the LP shaft; blades into its slots, radially.
j.joint('fan-disk', 'lp-shaft', onAxis(LP_SHAFT.z0), rearward,
  { id: 'm-fand', type: 'faceMate', depth: 0.03, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });
bladeIds.forEach((id, i) => {
  const out = radial(bladePhi(i));
  j.joint(id, 'fan-disk', atRadius(bladePhi(i), FAN_HUB_R, span(FAN_DISK).centre), [-out[0], -out[1], -out[2]],
    { id: `m-fb${String(i + 1).padStart(2, '0')}`, type: 'slide', depth: 0.03,
      movingKind: 'railMale', fixedKind: 'railFemale', symmetry: 1 });
});

// Spinner on the disk, lip on the fan case.
j.joint('spinner', 'fan-disk', onAxis(FAN_DISK.z0), rearward,
  { id: 'm-spin', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });
j.joint('intake-lip', 'fan-case', onAxis(FAN_CASE.z0), rearward,
  { id: 'm-lip', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });

// Exhaust.
j.joint('exhaust-nozzle', 'lpt-case', onAxis(LPT.z1), forward,
  { id: 'm-noz', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });
j.joint('tail-plug', 'lp-shaft', onAxis(LP_SHAFT.z1), forward,
  { id: 'm-plug', type: 'faceMate', depth: 0.005, movingKind: 'faceB', fixedKind: 'faceA', symmetry: 1 });

// Accessories.
j.joint('agb', 'fan-case', [0, AXIS_Y - 0.46, -0.60], [0, 1, 0],
  { id: 'm-agb', type: 'bolt', depth: 0.01, movingKind: 'boltHole', fixedKind: 'threadedBoss', symmetry: 1 });
j.joint('ignition-exciter', 'hpc-case', [0.26, AXIS_Y, 0.05], [-1, 0, 0],
  { id: 'm-exc', type: 'bolt', depth: 0.01, movingKind: 'boltHole', fixedKind: 'threadedBoss', symmetry: 1 });
j.joint('fuel-line', 'hpc-case', [-0.29, AXIS_Y, -0.08], rearward,
  { id: 'm-fuel', type: 'insert', depth: 0.01, movingKind: 'connectorMale', fixedKind: 'connectorFemale', symmetry: -1 });
j.joint('ignition-lead', 'ignition-exciter', [0.29, AXIS_Y + 0.08, 0.10], rearward,
  { id: 'm-lead', type: 'insert', depth: 0.01, movingKind: 'connectorMale', fixedKind: 'connectorFemale', symmetry: -1 });

const authored: AssemblyDef = {
  id: 'jet-engine',
  name: 'Twin-Spool Turbofan',
  revision: 'B',
  sourceUnits: 'mm',
  defaultTolerance: { positionMm: 2.0, angleDeg: 1.0, warnPositionMm: 1.2, warnAngleDeg: 0.6 },
  datums: [
    { id: 'd0', label: 'Stand front-left corner', position: [-0.7, STAND_TOP, -0.4] },
    { id: 'd1', label: 'Stand front-right corner', position: [0.7, STAND_TOP, -0.4] },
    { id: 'd2', label: 'Stand rear-left corner', position: [-0.7, STAND_TOP, 0.6] },
  ],
  parts: j.build(),
  background: [
    { id: 'floor', name: 'Hangar floor', mesh: { type: 'box', size: [4, 0.02, 4] },
      pose: { position: [0, -0.01, 0], rotation: I }, role: 'occluder' },
    // A slab across the intake rather than a block: it marks where nobody stands,
    // without hiding the fan behind a red wall.
    { id: 'intake-zone', name: 'Intake danger zone', mesh: { type: 'box', size: [1.0, 1.0, 0.12] },
      pose: { position: [0, AXIS_Y, -1.10], rotation: I }, role: 'keepOut' },
  ],
  // On a floor stand: built at floor level, not at a bench.
  workSurfaceM: 0,
  tools: [
    { id: 't-sling', name: 'Engine lifting sling', note: 'Rated 1 t. Lift casings level; never by a flange alone.' },
    { id: 't-torque', name: 'Torque wrench 20–350 Nm', note: 'Disk and casing flange bolts.' },
    { id: 't-blade', name: 'Fan blade balance chart', note: 'Blades go in opposing pairs, by moment weight.' },
    { id: 't-bore', name: 'Borescope', note: 'Check every fuel nozzle tip and the turbine first stage.' },
  ],
  steps: [
    { id: 's1', title: 'Set up the transport stand',
      instruction: 'Position the stand base on level floor and lock all four castors.',
      partIds: ['stand-base'], requires: [], mates: [], durationEstS: 120 },
    { id: 's2', title: 'Fit the engine mounts',
      instruction: 'Bolt the front and rear mount posts to the base. The front post is the taller one.',
      partIds: ['mount-front', 'mount-rear'], requires: ['s1'], mates: j.matesFor(['mount-front', 'mount-rear']),
      toolIds: ['t-torque'], durationEstS: 300 },
    { id: 's3', title: 'Lay in the HP compressor casing',
      instruction: 'Lower the HP compressor casing onto the front mount, level, with the drain boss at the bottom.',
      partIds: ['hpc-case'], requires: ['s2'], mates: j.matesFor(['hpc-case']), toolIds: ['t-sling'], durationEstS: 600,
      caution: 'Suspended load — nobody under the casing while it is on the sling.' },
    { id: 's4', title: 'Insert the HP spool',
      instruction: 'Slide the HP spool in from the front until its forward flange seats in the casing.',
      partIds: ['hp-spool'], requires: ['s3'], mates: j.matesFor(['hp-spool']), durationEstS: 480 },
    { id: 's5', title: 'Stack the HP compressor disks',
      instruction: 'Fit compressor disks 1 to 3 onto the spool in order, front to back. Each is stamped with its stage.',
      partIds: hpcDiskIds, requires: ['s4'], mates: j.matesFor(hpcDiskIds), toolIds: ['t-torque'], durationEstS: 900,
      caution: 'Disks are not interchangeable between stages — check the stamp, not the size.' },
    { id: 's6', title: 'Fit the combustor casing',
      instruction: 'Bolt the combustor casing to the rear flange of the compressor casing.',
      partIds: ['combustor-case'], requires: ['s3'], mates: j.matesFor(['combustor-case']),
      toolIds: ['t-sling', 't-torque'], durationEstS: 600 },
    { id: 's7', title: 'Install the fuel nozzles',
      instruction: 'Push the eight fuel nozzles radially into their bosses and torque to 12 Nm.',
      partIds: nozzleIds, requires: ['s6'], mates: j.matesFor(nozzleIds), toolIds: ['t-torque', 't-bore'], durationEstS: 960,
      caution: 'Borescope every nozzle tip after fitting: a cocked nozzle burns a hole in the liner.' },
    { id: 's8', title: 'Fit the HP turbine',
      instruction: 'Bolt the HP turbine casing to the combustor, then fit the HP turbine disk onto the spool from the rear.',
      partIds: ['hpt-case', 'hpt-disk'], requires: ['s5', 's6'], mates: j.matesFor(['hpt-case', 'hpt-disk']),
      toolIds: ['t-torque'], durationEstS: 900 },
    { id: 's9', title: 'Fit the LP turbine casing',
      instruction: 'Bolt the LP turbine casing to the HP turbine casing and onto the rear mount.',
      partIds: ['lpt-case'], requires: ['s8'], mates: j.matesFor(['lpt-case']), toolIds: ['t-sling', 't-torque'], durationEstS: 600 },
    { id: 's10', title: 'Insert the LP shaft',
      instruction: 'Thread the LP shaft through the HP spool from the rear until its shoulder seats.',
      partIds: ['lp-shaft'], requires: ['s9'], mates: j.matesFor(['lp-shaft']), durationEstS: 600,
      caution: 'Long and heavy: two people, and keep it on the axis — a scratched bore is a scrapped spool.' },
    { id: 's11', title: 'Fit the LP turbine disks',
      instruction: 'Fit LP turbine disks 1 and 2 onto the shaft from the rear, stage 1 first.',
      partIds: lptDiskIds, requires: ['s10'], mates: j.matesFor(lptDiskIds), toolIds: ['t-torque'], durationEstS: 720 },
    { id: 's12', title: 'Fit the booster and the fan case',
      instruction: 'Bolt the booster casing to the front of the compressor casing, then hang the fan case on the booster.',
      partIds: ['lpc-case', 'fan-case'], requires: ['s3'], mates: j.matesFor(['lpc-case', 'fan-case']),
      toolIds: ['t-sling', 't-torque'], durationEstS: 1200 },
    { id: 's13', title: 'Mount the fan disk',
      instruction: 'Fit the fan disk onto the front of the LP shaft and torque the retaining nut to 320 Nm.',
      partIds: ['fan-disk'], requires: ['s10', 's12'], mates: j.matesFor(['fan-disk']), toolIds: ['t-torque'], durationEstS: 600 },
    { id: 's14', title: 'Install the fan blades',
      instruction: 'Slide the sixteen fan blades into the disk slots in opposing pairs, following the balance chart.',
      partIds: bladeIds, requires: ['s13'], mates: j.matesFor(bladeIds), toolIds: ['t-blade'], durationEstS: 1800,
      caution: 'Opposing pairs only. Fitting blades in sequence round the disk leaves it out of balance.' },
    { id: 's15', title: 'Fit the spinner, intake lip and exhaust',
      instruction: 'Fit the spinner and the intake lip at the front, the exhaust nozzle and tail plug at the rear.',
      partIds: ['spinner', 'intake-lip', 'exhaust-nozzle', 'tail-plug'], requires: ['s11', 's14'],
      mates: j.matesFor(['spinner', 'intake-lip', 'exhaust-nozzle', 'tail-plug']), toolIds: ['t-torque'], durationEstS: 900 },
    { id: 's16', title: 'Install the accessories',
      instruction: 'Hang the accessory gearbox under the fan case, fit the ignition exciter, run the fuel line and the ignition lead.',
      partIds: ['agb', 'ignition-exciter', 'fuel-line', 'ignition-lead'], requires: ['s7', 's12'],
      mates: j.matesFor(['agb', 'ignition-exciter', 'fuel-line', 'ignition-lead']), toolIds: ['t-torque'], durationEstS: 1500 },
  ],
};

/**
 * The engine turned side-on.
 *
 * Authored along Z because that reads naturally (stations, intake at −Z), but
 * the default view looks along Z, and an engine seen end-on from above read as
 * a stack of rings standing on its stand. Turned 90° about the vertical, the
 * axis runs across the screen: intake on the left, exhaust on the right, the
 * way an engine on a stand is shown. One rigid turn of everything in the world
 * frame — part poses, approach directions, scenery, datums — and nothing else:
 * connectors are in each part's own frame, so every joint stays exactly as it
 * was authored.
 */
const TURN = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
/** The stand's centre goes to the origin, under the middle of the engine. */
const PIVOT = new Vector3(0, 0, 0.1);
const turnPoint = (v: Vec3): Vec3 => {
  const r = new Vector3(...v).sub(PIVOT).applyQuaternion(TURN);
  return [r.x, r.y, r.z];
};
const turnDir = (v: Vec3): Vec3 => {
  const r = new Vector3(...v).applyQuaternion(TURN);
  return [r.x, r.y, r.z];
};
const turnPose = (p: Pose): Pose => {
  const q = TURN.clone().multiply(new Quaternion(...p.rotation));
  return { position: turnPoint(p.position), rotation: [q.x, q.y, q.z, q.w] };
};

export const jetEngine: AssemblyDef = {
  ...authored,
  parts: authored.parts.map((p) => ({
    ...p,
    targetPose: turnPose(p.targetPose),
    ...(p.approach ? { approach: turnDir(p.approach) } : {}),
  })),
  background: authored.background.map((b) => ({ ...b, pose: turnPose(b.pose) })),
  datums: authored.datums?.map((d) => ({ ...d, position: turnPoint(d.position) })),
};

/** The engine axis in the assembly frame: through `origin`, along `direction` (intake to exhaust). */
export const jetEngineAxis = { origin: turnPoint([0, AXIS_Y, 0]), direction: turnDir([0, 0, 1]) };

