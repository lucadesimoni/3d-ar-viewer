/**
 * Domain model for a mechanical assembly rendered as an AR overlay.
 *
 * Everything is expressed in the *assembly frame*: a right-handed, Y-up frame
 * whose origin sits at the assembly datum (usually the fixture's locating pin).
 * Linear units are metres, because that is what WebXR reports; authoring tools
 * that speak millimetres should convert on import (see `data/` for examples).
 */

export type Vec3 = [number, number, number];
/** `[x, y, z, w]` — same ordering as `THREE.Quaternion.toArray()`. */
export type Quat = [number, number, number, number];

export interface Pose {
  position: Vec3;
  rotation: Quat;
}

/**
 * The mating features a part exposes. A connector is a *frame*, not a point:
 * `axis` is the insertion direction and `up` fixes the roll, so a mate can be
 * checked for all six degrees of freedom.
 */
export type ConnectorKind =
  | 'pin'
  | 'socket'
  | 'boltHole'
  | 'threadedBoss'
  | 'faceA'
  | 'faceB'
  | 'railMale'
  | 'railFemale'
  | 'connectorMale'
  | 'connectorFemale';

export interface Connector {
  id: string;
  kind: ConnectorKind;
  /** Origin of the connector frame, in the owning part's local coordinates. */
  position: Vec3;
  /** Insertion axis (local). The mating connector's axis must be anti-parallel. */
  axis: Vec3;
  /** Roll reference, must be perpendicular to `axis` (local). */
  up: Vec3;
  /** Kinds this connector accepts. */
  accepts: ConnectorKind[];
  /**
   * Rotational symmetry order about `axis`. `4` on a square flange means any of
   * four 90-degree rolls is correct; `0`/`1` means the roll is fully constrained;
   * `Infinity` (serialised as `-1`) means roll is free, e.g. a plain round pin.
   */
  symmetry?: number;
  /** Nominal engagement depth along `axis`, metres. Used to flag unseated parts. */
  engagementDepth?: number;
}

export type MeshSpec =
  | { type: 'box'; size: Vec3 }
  | { type: 'cylinder'; radius: number; height: number; radialSegments?: number }
  | { type: 'sphere'; radius: number }
  | { type: 'tube'; radius: number; height: number; wall: number }
  | { type: 'plate'; size: Vec3; holeRadius?: number }
  /**
   * An external 3D model (glTF 2.0 / GLB — the right runtime format for web AR).
   * `bounds` is the full size in metres used for collision/occlusion when the
   * mesh has not been measured yet; without it the engine falls back to a small
   * conservative box until the renderer reports the loaded extents.
   */
  | { type: 'url'; url: string; scale?: number; bounds?: Vec3; draco?: boolean };

export interface MaterialSpec {
  color: string;
  metalness?: number;
  roughness?: number;
  opacity?: number;
}

export interface PartDef {
  id: string;
  name: string;
  /** Manufacturer / ERP part number, shown in the picker and in error reports. */
  sku?: string;
  mesh: MeshSpec;
  material?: MaterialSpec;
  /** Nominal pose of this part once installed, in the assembly frame. */
  targetPose: Pose;
  connectors: Connector[];
  /** Sub-assembly grouping. Parts inherit diagnostics from their parent group. */
  groupId?: string;
  massKg?: number;
  torqueSpecNm?: number;
  /**
   * Part revision — first-class versioning for every part. Accepts aerospace
   * letter revisions ("A", "B", "AA") or dotted numeric ("1", "1.2.3"); the
   * versioning module orders and compares them. Pairs with `sku` to identify an
   * exact part at an exact revision, which is what a BOM and a wrong-revision
   * check need.
   */
  revision?: string;
  /** ISO date the revision was released, for the BOM. */
  revisionDate?: string;
  /** Revision this one supersedes, for a human-readable change trail. */
  supersedes?: string;
  /**
   * Handed variants. Two parts sharing a `mirrorGroup` are geometrically similar
   * and are the classic source of left/right swap errors, so the diagnostics
   * engine checks for them explicitly.
   */
  mirrorGroup?: string;
  /**
   * Where the part is brought in *from*, as a unit vector in the assembly frame
   * pointing away from the installed position — the direction you would pull it
   * back out. A board dropped from above is `[0, 1, 0]`; a cover pushed on from
   * the front is `[0, 0, 1]`.
   *
   * Stated this precisely because the opposite reading (the direction the part
   * travels) is just as natural and produces animations that fly parts in
   * through the assembly, and exploded views that push them into it. Defaults
   * to `[0, 1, 0]`.
   */
  approach?: Vec3;
  /**
   * Parts this one may legitimately overlap. Interference is detected with
   * oriented bounding boxes, which cannot see a bore — so a shaft running
   * through a bearing cap's hole looks like a clash. Parts joined by a mate are
   * exempt automatically; this covers pass-through pairs that are not directly
   * mated.
   */
  clearanceWith?: string[];
}

export interface PartConnectorRef {
  partId: string;
  connectorId: string;
}

export type MateType = 'insert' | 'faceMate' | 'bolt' | 'slide';

export interface MateDef {
  id: string;
  a: PartConnectorRef;
  /** `b` is the already-installed side; `a` is the part being placed. */
  b: PartConnectorRef;
  type: MateType;
}

/**
 * Acceptance envelope. `warn*` values are the "yellow band" — inside spec but
 * close enough to the limit that the operator should be told before they torque
 * anything down.
 */
export interface Tolerance {
  positionMm: number;
  angleDeg: number;
  warnPositionMm?: number;
  warnAngleDeg?: number;
}

export interface StepDef {
  id: string;
  title: string;
  instruction: string;
  /** Parts installed during this step. */
  partIds: string[];
  /** Step ids that must be complete first — this is the sequencing DAG. */
  requires: string[];
  mates: MateDef[];
  tolerance?: Tolerance;
  toolIds?: string[];
  /** Seconds, used for the remaining-time estimate in the HUD. */
  durationEstS?: number;
  /** Safety or quality note surfaced above the instruction. */
  caution?: string;
}

/**
 * Real-world geometry that is *not* part of the assembly: the bench, a fixture,
 * a wall. Rendered as a depth-only occluder so virtual parts disappear behind
 * real ones, which is the single biggest cue for believable AR registration.
 */
export interface BackgroundGeometryDef {
  id: string;
  name: string;
  mesh: MeshSpec;
  pose: Pose;
  /** `occluder` writes depth only; `fixture` is drawn as translucent reference. */
  role: 'occluder' | 'fixture' | 'keepOut';
}

export interface ToolDef {
  id: string;
  name: string;
  note?: string;
}

/**
 * A face made of `cols` x `rows` equal rectangular openings — a cube shelf, a
 * drawer bank, a patch panel. `widthM`/`heightM` are the outer size of that
 * face, which is what turns a detection into a metric pose.
 */
export interface GridTargetDef {
  kind: 'grid';
  cols: number;
  rows: number;
  /**
   * Span of the lattice, centre-to-centre of the outermost board lines — not
   * the outer size of the object. This is deliberate: what a camera measures is
   * where the boards are, and each outer board's two edges merge into a single
   * line at its centre. Quoting the outer size here would bake a half-board
   * scale error (2% on a KALLAX, 30 mm of range at 1.5 m) into every pose.
   */
  widthM: number;
  heightM: number;
  /**
   * Pose of the face centre in the assembly frame. The face's own frame is
   * +X across it, +Y up it, and **+Z into the object, away from whoever is
   * looking at it** — the renderer's left-handed convention, which is also
   * what the pose solver returns. So a face that looks along world -Z carries
   * a 180-degree rotation about Y, not identity.
   */
  poseInAssembly: Pose;
  /** Shown to the operator while the app is looking for it. */
  label?: string;
}

export interface AssemblyDef {
  id: string;
  name: string;
  revision: string;
  /** Source units of the authoring CAD system, for display only. */
  sourceUnits?: 'mm' | 'cm' | 'm' | 'in';
  defaultTolerance: Tolerance;
  parts: PartDef[];
  steps: StepDef[];
  background: BackgroundGeometryDef[];
  tools?: ToolDef[];
  /**
   * Fiducial that pins the assembly frame to the world. When present the app
   * can re-register after tracking loss without asking the operator to re-place.
   */
  marker?: { id: string; sizeM: number; poseInAssembly: Pose };

  /**
   * A markerless recognition target: the real object itself. Furniture and
   * equipment racks present a regular grid of identical openings, which is a
   * strong, cheap visual signature — far more reliable on a phone than a
   * generic object detector, and it comes with metric scale for free because
   * the opening pitch is known from the BOM. Seeing it re-registers the anchor
   * exactly like a fiducial would.
   */
  recognition?: GridTargetDef;
  /** Named datum points used by the 3-point manual registration flow. */
  datums?: { id: string; label: string; position: Vec3 }[];
  /**
   * USDZ model for the iOS AR Quick Look fallback. iOS Safari has no WebXR, and
   * Quick Look wants USDZ (not glTF), so a deployment supplies a pre-converted
   * USDZ of the whole assembly here to enable the system AR viewer on iPhone.
   */
  quickLookUrl?: string;
}

/** Runtime placement of a part as the operator has actually positioned it. */
export interface PlacementState {
  partId: string;
  pose: Pose;
  /** `ghost` = not yet placed, `placed` = operator dropped it, `verified` = in tolerance. */
  status: 'ghost' | 'placed' | 'verified';
  placedAtMs?: number;
}
