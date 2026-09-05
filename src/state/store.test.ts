import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { gearbox } from '../data';
import { poseDistance } from '../engine/math';
import type { Pose } from '../engine/types';

/** Nudge a pose off nominal by `d` metres on X. */
const offBy = (p: Pose, d: number): Pose => ({
  position: [p.position[0] + d, p.position[1], p.position[2]],
  rotation: [...p.rotation] as Pose['rotation'],
});

const part = (id: string) => gearbox.parts.find((p) => p.id === id)!;

describe('placePart snapping', () => {
  beforeEach(() => {
    useStore.getState().loadAssembly(gearbox);
    useStore.getState().setSnapEnabled(true);
  });

  it('snaps a part dropped near its mate onto the exact joint', () => {
    const base = part('baseplate');
    const housing = part('housing');
    useStore.getState().placePart('baseplate', base.targetPose);

    // Drop the housing 6 mm off — inside the capture radius.
    const sloppy = offBy(housing.targetPose, 0.006);
    useStore.getState().placePart('housing', sloppy);

    const placed = useStore.getState().placements.get('housing')!;
    const errorAfter = poseDistance(placed.pose, housing.targetPose);
    // Snapped essentially onto nominal, far better than the 6 mm it was dropped at.
    expect(errorAfter).toBeLessThan(0.0005);
    expect(useStore.getState().lastSnap?.partId).toBe('housing');
  });

  it('leaves the pose untouched when snapping is disabled', () => {
    useStore.getState().setSnapEnabled(false);
    useStore.getState().placePart('baseplate', part('baseplate').targetPose);
    const sloppy = offBy(part('housing').targetPose, 0.006);
    useStore.getState().placePart('housing', sloppy);
    const placed = useStore.getState().placements.get('housing')!;
    expect(poseDistance(placed.pose, sloppy)).toBeCloseTo(0, 6);
  });

  it('does not snap when the mate counterpart is not placed yet', () => {
    // Housing mates to the baseplate, which is still a ghost here.
    const sloppy = offBy(part('housing').targetPose, 0.006);
    useStore.getState().placePart('housing', sloppy);
    const placed = useStore.getState().placements.get('housing')!;
    expect(poseDistance(placed.pose, sloppy)).toBeCloseTo(0, 6);
  });

  it('does not drag a far-away part across the assembly', () => {
    useStore.getState().placePart('baseplate', part('baseplate').targetPose);
    const far = offBy(part('housing').targetPose, 0.5); // 500 mm away
    useStore.getState().placePart('housing', far);
    const placed = useStore.getState().placements.get('housing')!;
    expect(poseDistance(placed.pose, far)).toBeCloseTo(0, 6);
  });
});
