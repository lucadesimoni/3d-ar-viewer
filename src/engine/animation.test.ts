import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { assemblyTimeline, explodePose, samplePose, stepTimeline } from './animation';
import { gearbox } from '../data/gearbox';

describe('samplePose', () => {
  it('clamps before the first and after the last keyframe', () => {
    const track = {
      partId: 'p',
      keyframes: [
        { t: 1, pose: { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] } },
        { t: 2, pose: { position: [1, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] } },
      ],
    };
    expect(samplePose(track, 0).position[0]).toBe(0);
    expect(samplePose(track, 5).position[0]).toBe(1);
    expect(samplePose(track, 1.5).position[0]).toBeGreaterThan(0);
  });
});

describe('assemblyTimeline', () => {
  it('covers every part and lands each on its target at the end', () => {
    const tl = assemblyTimeline(gearbox);
    expect(tl.tracks.length).toBe(gearbox.parts.length);
    const end = tl.durationS;
    for (const track of tl.tracks) {
      const part = gearbox.parts.find((p) => p.id === track.partId)!;
      const pose = samplePose(track, end);
      const d = new Vector3(...pose.position).distanceTo(new Vector3(...part.targetPose.position));
      expect(d).toBeLessThan(1e-6);
    }
  });

  it('emits a marker per step', () => {
    expect(assemblyTimeline(gearbox).markers.length).toBe(gearbox.steps.length);
  });
});

describe('stepTimeline', () => {
  it('staggers parts within a multi-part step', () => {
    const step = gearbox.steps.find((s) => s.partIds.length > 1)!;
    const tl = stepTimeline(gearbox, step);
    expect(tl.tracks.length).toBe(step.partIds.length);
  });
});

describe('explodePose', () => {
  it('pushes a part away from the centroid and returns to nominal at factor 0', () => {
    const part = gearbox.parts.find((p) => p.id === 'housing')!;
    const centroid = new Vector3(0, 0, 0);
    const exploded = explodePose(part, centroid, 1);
    const nominal = explodePose(part, centroid, 0);
    expect(nominal.position).toEqual(part.targetPose.position);
    const dExploded = new Vector3(...exploded.position).length();
    const dNominal = new Vector3(...nominal.position).length();
    expect(dExploded).toBeGreaterThan(dNominal);
  });
});
