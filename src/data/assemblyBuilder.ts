import { Matrix4, Vector3 } from 'three';
import { invertPose, poseMatrix, q4, toVec3, v3 } from '../engine/math';
import type { Connector, ConnectorKind, MateDef, PartDef, Pose, Vec3 } from '../engine/types';

/**
 * Declare joints by where they are in the world, not by hand-computed local
 * coordinates.
 *
 * Hand-authoring connector positions is how the first sample ended up with
 * every mate tens of millimetres and up to 180 degrees out at nominal: each
 * connector had to be expressed in its own part's local frame, and a single
 * wrong offset (a full plate thickness instead of a half) silently breaks the
 * joint. Here you state the physical fact — "the joint is at this world point,
 * the moving part comes in along this axis" — and both connectors are derived
 * by transforming that through each part's own pose. Consistency is then a
 * property of the construction rather than of the author's arithmetic.
 *
 * Unlike a simple offset helper this handles rotated parts correctly (the
 * gearbox shafts are turned 90 degrees), because it uses the full inverse pose.
 */
export class JointFactory {
  readonly mates: MateDef[] = [];
  private connectors = new Map<string, Connector[]>();
  private seq = 0;

  constructor(private readonly parts: Map<string, PartDef>) {
    for (const id of parts.keys()) this.connectors.set(id, []);
  }

  /** Express a world point, axis and roll reference in a part's local frame. */
  private toLocal(
    pose: Pose,
    worldPoint: Vec3,
    worldAxis: Vec3,
    worldUp: Vec3,
  ): { position: Vec3; axis: Vec3; up: Vec3 } {
    const inv = invertPose(pose);
    const m: Matrix4 = poseMatrix(inv);
    const p = v3(worldPoint).applyMatrix4(m);
    const a = v3(worldAxis).applyQuaternion(q4(inv.rotation)).normalize();
    const u = v3(worldUp).applyQuaternion(q4(inv.rotation)).normalize();
    return { position: toVec3(p), axis: toVec3(a), up: toVec3(u) };
  }

  /** Any unit vector perpendicular to `axis`, for the connector's roll reference. */
  private perpendicular(axis: Vec3): Vec3 {
    const a = v3(axis).normalize();
    const seed = Math.abs(a.y) > 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
    return toVec3(new Vector3().crossVectors(seed, a).normalize());
  }

  /**
   * Create a mate. `worldPoint` is where the joint sits when both parts are at
   * their target poses; `worldAxis` is the direction the moving part travels in
   * to engage. Both connectors are generated and attached to their parts.
   */
  joint(
    movingId: string,
    fixedId: string,
    worldPoint: Vec3,
    worldAxis: Vec3,
    opts: {
      type?: MateDef['type'];
      depth?: number;
      movingKind?: ConnectorKind;
      fixedKind?: ConnectorKind;
      /** Rotational symmetry of the moving connector; -1 = roll is free. */
      symmetry?: number;
      id?: string;
    } = {},
  ): MateDef {
    const moving = this.parts.get(movingId);
    const fixed = this.parts.get(fixedId);
    if (!moving || !fixed) throw new Error(`joint between unknown parts ${movingId}/${fixedId}`);

    const id = opts.id ?? `j${this.seq++}`;
    const antiAxis: Vec3 = [-worldAxis[0], -worldAxis[1], -worldAxis[2]];
    // One shared world roll reference. Mating flips the fixed frame 180 degrees
    // about its X, which negates its up — so the fixed side must carry -up for
    // the pair to read zero roll. Choosing each side's up independently is what
    // made keyed joints report exactly 180 degrees out.
    const upWorld = this.perpendicular(worldAxis);
    const antiUp: Vec3 = [-upWorld[0], -upWorld[1], -upWorld[2]];
    const m = this.toLocal(moving.targetPose, worldPoint, worldAxis, upWorld);
    const f = this.toLocal(fixed.targetPose, worldPoint, antiAxis, antiUp);

    const movingConn: Connector = {
      id: `${id}-m`,
      kind: opts.movingKind ?? 'connectorMale',
      position: m.position,
      axis: m.axis,
      up: m.up,
      accepts: [opts.fixedKind ?? 'connectorFemale'],
      symmetry: opts.symmetry ?? -1,
      engagementDepth: opts.depth,
    };
    const fixedConn: Connector = {
      id: `${id}-f`,
      kind: opts.fixedKind ?? 'connectorFemale',
      position: f.position,
      axis: f.axis,
      up: f.up,
      accepts: [opts.movingKind ?? 'connectorMale'],
      symmetry: -1,
      engagementDepth: opts.depth,
    };

    this.connectors.get(movingId)!.push(movingConn);
    this.connectors.get(fixedId)!.push(fixedConn);

    const mate: MateDef = {
      id,
      a: { partId: movingId, connectorId: movingConn.id },
      b: { partId: fixedId, connectorId: fixedConn.id },
      type: opts.type ?? 'insert',
    };
    this.mates.push(mate);
    return mate;
  }

  /** Fold the generated connectors back onto their parts. */
  build(): PartDef[] {
    return [...this.parts.values()].map((p) => ({
      ...p,
      connectors: [...(p.connectors ?? []), ...(this.connectors.get(p.id) ?? [])],
    }));
  }

  /** Mates whose moving part is one of `ids`, for assigning them to a step. */
  matesFor(ids: string[]): MateDef[] {
    return this.mates.filter((m) => ids.includes(m.a.partId));
  }
}
