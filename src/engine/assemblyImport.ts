import type {
  AssemblyDef, BackgroundGeometryDef, Connector, MaterialSpec, MeshSpec,
  PartDef, Pose, SourceReference, StepDef, Tolerance, Vec3,
} from './types';
import { validateGraph } from './sequencer';

export class AssemblyImportError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'AssemblyImportError';
  }
}

type ObjectValue = Record<string, unknown>;
type Parser<T> = (value: unknown, path: string) => T;

function fail(path: string, message: string): never {
  throw new AssemblyImportError(path, message);
}

function object(value: unknown, path: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(path, 'expected an object');
  }
  return value as ObjectValue;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) return fail(path, 'expected a non-empty string');
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(path, 'expected a finite number');
  return value;
}

function positive(value: unknown, path: string): number {
  const n = number(value, path);
  return n > 0 ? n : fail(path, 'must be greater than zero');
}

function nonnegative(value: unknown, path: string): number {
  const n = number(value, path);
  return n >= 0 ? n : fail(path, 'must not be negative');
}

function fraction(value: unknown, path: string): number {
  const n = nonnegative(value, path);
  return n <= 1 ? n : fail(path, 'must be between 0 and 1');
}

function integer(value: unknown, path: string): number {
  const n = positive(value, path);
  return Number.isSafeInteger(n) ? n : fail(path, 'expected a positive integer');
}

function boolean(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : fail(path, 'expected a boolean');
}

function oneOf<T extends string>(choices: readonly T[]): Parser<T> {
  return (value, path) => choices.find((choice) => choice === value)
    ?? fail(path, `expected one of ${choices.join(', ')}`);
}

function array<T>(value: unknown, path: string, parse: Parser<T>): T[] {
  if (!Array.isArray(value)) return fail(path, 'expected an array');
  return value.map((item, i) => parse(item, `${path}[${i}]`));
}

function optional<T>(o: ObjectValue, key: string, path: string, parse: Parser<T>): T | undefined {
  return o[key] === undefined ? undefined : parse(o[key], `${path}.${key}`);
}

function strings(value: unknown, path: string): string[] {
  const values = array(value, path, text);
  if (new Set(values).size !== values.length) fail(path, 'duplicate values are not allowed');
  return values;
}

function vector(value: unknown, path: string): Vec3 {
  const v = array(value, path, number);
  if (v.length !== 3) return fail(path, 'expected exactly 3 coordinates');
  return [v[0], v[1], v[2]];
}

function size(value: unknown, path: string): Vec3 {
  const v = vector(value, path);
  if (v.some((n) => n <= 0)) fail(path, 'all dimensions must be greater than zero');
  return v;
}

function pose(value: unknown, path: string): Pose {
  const o = object(value, path);
  const rotation = array(o.rotation, `${path}.rotation`, number);
  if (rotation.length !== 4 || Math.abs(Math.hypot(...rotation) - 1) > 0.001) {
    fail(`${path}.rotation`, 'expected a unit quaternion [x, y, z, w]');
  }
  return {
    position: vector(o.position, `${path}.position`),
    rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
  };
}

/** Models are resources, not executable URLs or embedded data payloads. */
export function assetUrl(value: unknown, path: string): string {
  const url = text(value, path);
  let parsed: URL;
  try { parsed = new URL(url, 'https://assembly.invalid/'); }
  catch { return fail(path, 'invalid resource URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    fail(path, 'use an HTTP(S) or relative resource URL');
  }
  if (parsed.username || parsed.password) fail(path, 'credentials must not be included in URLs');
  return url;
}

function source(value: unknown, path: string): SourceReference {
  const o = object(value, path);
  return {
    system: text(o.system, `${path}.system`),
    itemId: text(o.itemId, `${path}.itemId`),
    revisionId: optional(o, 'revisionId', path, text),
    occurrenceId: optional(o, 'occurrenceId', path, text),
  };
}

function tolerance(value: unknown, path: string): Tolerance {
  const o = object(value, path);
  const result: Tolerance = {
    positionMm: positive(o.positionMm, `${path}.positionMm`),
    angleDeg: positive(o.angleDeg, `${path}.angleDeg`),
    warnPositionMm: optional(o, 'warnPositionMm', path, nonnegative),
    warnAngleDeg: optional(o, 'warnAngleDeg', path, nonnegative),
  };
  if (result.angleDeg > 180) fail(`${path}.angleDeg`, 'must not exceed 180 degrees');
  if ((result.warnPositionMm ?? 0) > result.positionMm || (result.warnAngleDeg ?? 0) > result.angleDeg) {
    fail(path, 'warning thresholds must not exceed acceptance thresholds');
  }
  return result;
}

function mesh(value: unknown, path: string): MeshSpec {
  const o = object(value, path);
  const type = oneOf(['box', 'plate', 'cylinder', 'sphere', 'tube', 'url'] as const)(o.type, `${path}.type`);
  switch (type) {
    case 'box': return { type, size: size(o.size, `${path}.size`) };
    case 'plate': return {
      type, size: size(o.size, `${path}.size`), holeRadius: optional(o, 'holeRadius', path, positive),
    };
    case 'sphere': return { type, radius: positive(o.radius, `${path}.radius`) };
    case 'cylinder': return {
      type, radius: positive(o.radius, `${path}.radius`), height: positive(o.height, `${path}.height`),
      radialSegments: optional(o, 'radialSegments', path, integer),
    };
    case 'tube': {
      const radius = positive(o.radius, `${path}.radius`);
      const wall = positive(o.wall, `${path}.wall`);
      if (wall >= radius) fail(`${path}.wall`, 'must be smaller than the outer radius');
      return { type, radius, wall, height: positive(o.height, `${path}.height`) };
    }
    case 'url': return {
      type, url: assetUrl(o.url, `${path}.url`),
      scale: optional(o, 'scale', path, positive), bounds: optional(o, 'bounds', path, size),
      draco: optional(o, 'draco', path, boolean),
    };
  }
}

function material(value: unknown, path: string): MaterialSpec {
  const o = object(value, path);
  const color = text(o.color, `${path}.color`);
  if (!/^#[0-9a-f]{6}$/i.test(color)) fail(`${path}.color`, 'expected a six-digit hex color');
  return {
    color, metalness: optional(o, 'metalness', path, fraction),
    roughness: optional(o, 'roughness', path, fraction), opacity: optional(o, 'opacity', path, fraction),
  };
}

const connectorKind = oneOf([
  'pin', 'socket', 'boltHole', 'threadedBoss', 'faceA', 'faceB', 'railMale', 'railFemale',
  'connectorMale', 'connectorFemale',
] as const);

function connector(value: unknown, path: string): Connector {
  const o = object(value, path);
  const axis = vector(o.axis, `${path}.axis`);
  const up = vector(o.up, `${path}.up`);
  const norm = Math.hypot(...axis) * Math.hypot(...up);
  if (norm < 1e-12 || Math.abs(axis.reduce((sum, n, i) => sum + n * up[i], 0) / norm) > 0.001) {
    fail(path, 'connector axis and up must be nonzero and perpendicular');
  }
  const symmetry = optional(o, 'symmetry', path, number);
  if (symmetry !== undefined && (!Number.isInteger(symmetry) || symmetry < -1)) {
    fail(`${path}.symmetry`, 'expected -1 (free rotation) or a nonnegative integer');
  }
  return {
    id: text(o.id, `${path}.id`), kind: connectorKind(o.kind, `${path}.kind`),
    position: vector(o.position, `${path}.position`), axis, up, symmetry,
    accepts: array(o.accepts, `${path}.accepts`, connectorKind),
    engagementDepth: optional(o, 'engagementDepth', path, nonnegative),
  };
}

function uniqueIds<T extends { id: string }>(items: T[], path: string): Map<string, T> {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (byId.has(item.id)) fail(path, `duplicate id "${item.id}"; each occurrence needs its own id`);
    byId.set(item.id, item);
  }
  return byId;
}

function part(value: unknown, path: string): PartDef {
  const o = object(value, path);
  const connectors = array(o.connectors, `${path}.connectors`, connector);
  uniqueIds(connectors, `${path}.connectors`);
  const approach = optional(o, 'approach', path, vector);
  if (approach && Math.hypot(...approach) < 1e-12) fail(`${path}.approach`, 'must be nonzero');
  return {
    id: text(o.id, `${path}.id`), name: text(o.name, `${path}.name`),
    mesh: mesh(o.mesh, `${path}.mesh`), targetPose: pose(o.targetPose, `${path}.targetPose`),
    connectors, approach, source: optional(o, 'source', path, source),
    material: optional(o, 'material', path, material), sku: optional(o, 'sku', path, text),
    groupId: optional(o, 'groupId', path, text), massKg: optional(o, 'massKg', path, nonnegative),
    torqueSpecNm: optional(o, 'torqueSpecNm', path, nonnegative),
    revision: optional(o, 'revision', path, text), revisionDate: optional(o, 'revisionDate', path, text),
    supersedes: optional(o, 'supersedes', path, text), mirrorGroup: optional(o, 'mirrorGroup', path, text),
    clearanceWith: optional(o, 'clearanceWith', path, strings),
  };
}

function step(value: unknown, path: string): StepDef {
  const o = object(value, path);
  const ref = (value: unknown, path: string) => {
    const r = object(value, path);
    return { partId: text(r.partId, `${path}.partId`), connectorId: text(r.connectorId, `${path}.connectorId`) };
  };
  return {
    id: text(o.id, `${path}.id`), title: text(o.title, `${path}.title`),
    instruction: text(o.instruction, `${path}.instruction`),
    partIds: strings(o.partIds, `${path}.partIds`), requires: strings(o.requires, `${path}.requires`),
    mates: array(o.mates, `${path}.mates`, (value, path) => {
      const m = object(value, path);
      return {
        id: text(m.id, `${path}.id`), a: ref(m.a, `${path}.a`), b: ref(m.b, `${path}.b`),
        type: oneOf(['insert', 'faceMate', 'bolt', 'slide'] as const)(m.type, `${path}.type`),
      };
    }),
    tolerance: optional(o, 'tolerance', path, tolerance),
    toolIds: optional(o, 'toolIds', path, strings), durationEstS: optional(o, 'durationEstS', path, nonnegative),
    caution: optional(o, 'caution', path, text),
  };
}

/** Parse into fresh, validated runtime data before any live state is replaced. */
export function parseAssembly(value: unknown): AssemblyDef {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { return fail('assembly', 'invalid JSON'); }
  }
  const path = 'assembly';
  const o = object(value, path);
  const assembly: AssemblyDef = {
    id: text(o.id, `${path}.id`), name: text(o.name, `${path}.name`),
    revision: text(o.revision, `${path}.revision`), source: optional(o, 'source', path, source),
    sourceUnits: optional(o, 'sourceUnits', path, oneOf(['mm', 'cm', 'm', 'in'] as const)),
    defaultTolerance: tolerance(o.defaultTolerance, `${path}.defaultTolerance`),
    parts: array(o.parts, `${path}.parts`, part), steps: array(o.steps, `${path}.steps`, step),
    background: array(o.background, `${path}.background`, (value, path): BackgroundGeometryDef => {
      const b = object(value, path);
      return {
        id: text(b.id, `${path}.id`), name: text(b.name, `${path}.name`),
        mesh: mesh(b.mesh, `${path}.mesh`), pose: pose(b.pose, `${path}.pose`),
        role: oneOf(['occluder', 'fixture', 'keepOut'] as const)(b.role, `${path}.role`),
      };
    }),
    tools: optional(o, 'tools', path, (value, path) => array(value, path, (value, path) => {
      const t = object(value, path);
      return { id: text(t.id, `${path}.id`), name: text(t.name, `${path}.name`), note: optional(t, 'note', path, text) };
    })),
    workSurfaceM: optional(o, 'workSurfaceM', path, nonnegative),
    quickLookUrl: optional(o, 'quickLookUrl', path, assetUrl),
    marker: optional(o, 'marker', path, (value, path) => {
      const m = object(value, path);
      return {
        id: text(m.id, `${path}.id`), sizeM: positive(m.sizeM, `${path}.sizeM`),
        poseInAssembly: pose(m.poseInAssembly, `${path}.poseInAssembly`),
      };
    }),
    recognition: optional(o, 'recognition', path, (value, path) => {
      const r = object(value, path);
      return {
        kind: oneOf(['grid'] as const)(r.kind, `${path}.kind`),
        cols: integer(r.cols, `${path}.cols`), rows: integer(r.rows, `${path}.rows`),
        widthM: positive(r.widthM, `${path}.widthM`), heightM: positive(r.heightM, `${path}.heightM`),
        poseInAssembly: pose(r.poseInAssembly, `${path}.poseInAssembly`), label: optional(r, 'label', path, text),
      };
    }),
    datums: optional(o, 'datums', path, (value, path) => array(value, path, (value, path) => {
      const d = object(value, path);
      return {
        id: text(d.id, `${path}.id`), label: text(d.label, `${path}.label`),
        position: vector(d.position, `${path}.position`),
      };
    })),
  };
  if (assembly.parts.length === 0) fail('assembly.parts', 'at least one part is required');
  const parts = uniqueIds(assembly.parts, 'assembly.parts');
  uniqueIds(assembly.steps, 'assembly.steps');
  uniqueIds(assembly.background, 'assembly.background');
  uniqueIds(assembly.datums ?? [], 'assembly.datums');
  const tools = uniqueIds(assembly.tools ?? [], 'assembly.tools');
  uniqueIds(assembly.steps.flatMap((s) => s.mates), 'assembly.steps.mates');
  for (const part of assembly.parts) {
    for (const id of part.clearanceWith ?? []) {
      if (!parts.has(id)) fail(`part ${part.id}.clearanceWith`, `unknown part "${id}"`);
    }
  }
  for (const step of assembly.steps) {
    for (const id of step.toolIds ?? []) {
      if (!tools.has(id)) fail(`step ${step.id}.toolIds`, `unknown tool "${id}"`);
    }
    for (const mate of step.mates) {
      for (const ref of [mate.a, mate.b]) {
        if (!parts.get(ref.partId)?.connectors.some((c) => c.id === ref.connectorId)) {
          fail(`mate ${mate.id}`, `unknown connector "${ref.partId}/${ref.connectorId}"`);
        }
      }
      if (mate.a.partId === mate.b.partId) fail(`mate ${mate.id}`, 'a mate must join two different parts');
    }
  }
  // A CAD-only export may have no authored work instructions yet.
  if (assembly.steps.length) {
    const errors = validateGraph(assembly);
    if (errors.length) fail('assembly.steps', errors.join(' '));
  }
  return assembly;
}
