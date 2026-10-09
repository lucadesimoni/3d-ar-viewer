import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { SceneManager } from './SceneManager';
import { DIAGNOSTIC_COLORS } from './meshFactory';
import { jetEngine } from '../../data';

describe('parts not yet installed', () => {
  it('show their own colour, translucent — and the step in hand stands out', () => {
    const manager = new SceneManager(document.createElement('canvas'), jetEngine, {}, {
      engine: new NullEngine(), kind: 'webgl',
      perf: { tier: 'low', antialias: false, adaptive: false, maxPixelRatio: 1, targetFps: 30, recognitionIntervalMs: 1000 },
    });
    const active = jetEngine.steps[0].partIds;
    manager.update({
      placements: new Map(), severityByPart: new Map(), selectedPartId: undefined,
      activePartIds: new Set(active), explodeFactor: 0, showBackground: true, showGhosts: true,
      recognitionByPart: new Map(),
    } as never);
    const parts = (manager as unknown as { parts: Map<string, { overlayMat: { diffuseColor: Color3; alpha: number } }> }).parts;
    const hex = (id: string) => parts.get(id)!.overlayMat.diffuseColor.toHexString().toLowerCase();
    const own = (id: string) => jetEngine.parts.find((p) => p.id === id)!.material!.color.toLowerCase();

    for (const id of ['fan-case', 'combustor-case', 'fan-blade-01', 'agb']) expect(hex(id), id).toBe(own(id));
    expect(hex(active[0])).toBe(DIAGNOSTIC_COLORS.active.toLowerCase());
    expect(parts.get('fan-case')!.overlayMat.alpha).toBeLessThan(0.5);      // still a ghost
    manager.dispose();
  });
});
