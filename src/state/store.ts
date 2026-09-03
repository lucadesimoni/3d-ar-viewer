import { create } from 'zustand';
import type { ArMode } from '../engine/tracking/capabilities';
import { runDiagnostics, severityByPart, type Diagnostic, type Severity } from '../engine/diagnostics';
import { buildSequenceView, suggestNextStep, type SequenceView } from '../engine/sequencer';
import { clonePose } from '../engine/math';
import type { Timeline } from '../engine/animation';
import type { AssemblyDef, PlacementState, Pose } from '../engine/types';
import { gearbox } from '../data';

export type ViewMode = 'guide' | 'explore' | 'explode' | 'animate';

export interface AppState {
  assembly: AssemblyDef;
  /** Rigid transform from assembly frame into world/AR frame. */
  anchor: Pose | undefined;
  anchorQuality: number;
  arMode: ArMode;
  viewMode: ViewMode;
  explodeFactor: number;
  /** Active build-animation timeline while in 'animate' mode, and its scrub time. */
  animationTimeline: Timeline | undefined;
  animationT: number;

  placements: Map<string, PlacementState>;
  activeStepId: string | undefined;
  completedStepIds: Set<string>;
  selectedPartId: string | undefined;

  // Derived, recomputed on every mutation so components can read them cheaply.
  diagnostics: Diagnostic[];
  severityByPart: Map<string, Severity>;
  sequence: SequenceView;

  // Actions
  loadAssembly(a: AssemblyDef): void;
  setAnchor(pose: Pose | undefined, quality: number): void;
  setArMode(mode: ArMode): void;
  setViewMode(mode: ViewMode): void;
  setExplodeFactor(f: number): void;
  setAnimation(timeline: Timeline | undefined, t: number): void;
  selectPart(id: string | undefined): void;
  setActiveStep(id: string | undefined): void;

  /** Move a part to a pose without changing its status (used while dragging). */
  movePart(partId: string, pose: Pose): void;
  /** Drop a part: mark placed, then let diagnostics decide if it verifies. */
  placePart(partId: string, pose: Pose): void;
  /** Remove a placement, returning the part to its ghost. */
  removePart(partId: string): void;
  completeStep(id: string): void;
  reopenStep(id: string): void;
  /** Snap every part of the active step to nominal — the "show me" affordance. */
  autoPlaceActiveStep(): void;
  reset(): void;
}

function initialPlacements(assembly: AssemblyDef): Map<string, PlacementState> {
  const m = new Map<string, PlacementState>();
  for (const p of assembly.parts) {
    m.set(p.id, { partId: p.id, pose: clonePose(p.targetPose), status: 'ghost' });
  }
  return m;
}

/**
 * Recompute diagnostics and the sequence view after any change.
 *
 * A placed part is promoted to `verified` when nothing errors on it, and demoted
 * back to `placed` when something does — that single rule is what turns the raw
 * diagnostic list into the green/amber/red the operator sees on the part itself.
 */
function derive(state: {
  assembly: AssemblyDef;
  placements: Map<string, PlacementState>;
  completedStepIds: Set<string>;
  activeStepId: string | undefined;
}): Pick<AppState, 'diagnostics' | 'severityByPart' | 'sequence' | 'placements'> {
  const diagnostics = runDiagnostics({
    assembly: state.assembly,
    placements: state.placements,
    completedStepIds: state.completedStepIds,
  });
  const sev = severityByPart(diagnostics);

  const placements = new Map(state.placements);
  for (const [id, pl] of placements) {
    if (pl.status === 'ghost') continue;
    const hasError = sev.get(id) === 'error';
    const next: PlacementState['status'] = hasError ? 'placed' : 'verified';
    if (next !== pl.status) placements.set(id, { ...pl, status: next });
  }

  const sequence = buildSequenceView(
    state.assembly,
    placements,
    state.completedStepIds,
    state.activeStepId,
    diagnostics,
  );

  return { diagnostics, severityByPart: sev, sequence, placements };
}

export const useStore = create<AppState>((set, get) => {
  const assembly = gearbox;
  const placements = initialPlacements(assembly);
  const base = {
    assembly,
    placements,
    completedStepIds: new Set<string>(),
    activeStepId: assembly.steps[0]?.id,
  };

  return {
    ...base,
    anchor: undefined,
    anchorQuality: 0,
    arMode: 'preview' as ArMode,
    viewMode: 'guide' as ViewMode,
    explodeFactor: 0,
    animationTimeline: undefined,
    animationT: 0,
    selectedPartId: undefined,
    ...derive(base),

    loadAssembly(a) {
      const next = {
        assembly: a,
        placements: initialPlacements(a),
        completedStepIds: new Set<string>(),
        activeStepId: a.steps[0]?.id,
      };
      set({
        ...next,
        anchor: undefined,
        anchorQuality: 0,
        selectedPartId: undefined,
        explodeFactor: 0,
        ...derive(next),
      });
    },

    setAnchor(pose, quality) {
      set({ anchor: pose, anchorQuality: quality });
    },
    setArMode(mode) {
      set({ arMode: mode });
    },
    setViewMode(mode) {
      set({
        viewMode: mode,
        explodeFactor: mode === 'explode' ? Math.max(get().explodeFactor, 0.6) : get().explodeFactor,
        animationTimeline: mode === 'animate' ? get().animationTimeline : undefined,
      });
    },
    setExplodeFactor(f) {
      set({ explodeFactor: Math.max(0, Math.min(1.5, f)) });
    },
    setAnimation(timeline, t) {
      set({ animationTimeline: timeline, animationT: t });
    },
    selectPart(id) {
      set({ selectedPartId: id });
    },
    setActiveStep(id) {
      set({ activeStepId: id });
    },

    movePart(partId, pose) {
      const placements = new Map(get().placements);
      const pl = placements.get(partId);
      if (!pl) return;
      placements.set(partId, { ...pl, pose, status: pl.status === 'ghost' ? 'placed' : pl.status });
      set({ ...derive({ ...get(), placements }) });
    },

    placePart(partId, pose) {
      const placements = new Map(get().placements);
      placements.set(partId, { partId, pose, status: 'placed', placedAtMs: Date.now() });
      set({ ...derive({ ...get(), placements }) });
    },

    removePart(partId) {
      const { assembly } = get();
      const part = assembly.parts.find((p) => p.id === partId);
      if (!part) return;
      const placements = new Map(get().placements);
      placements.set(partId, { partId, pose: clonePose(part.targetPose), status: 'ghost' });
      set({ ...derive({ ...get(), placements }) });
    },

    completeStep(id) {
      const completedStepIds = new Set(get().completedStepIds);
      completedStepIds.add(id);
      const derived = derive({ ...get(), completedStepIds });
      const next = suggestNextStep(derived.sequence, id);
      set({ completedStepIds, activeStepId: next, ...derived });
    },

    reopenStep(id) {
      const completedStepIds = new Set(get().completedStepIds);
      completedStepIds.delete(id);
      set({ completedStepIds, activeStepId: id, ...derive({ ...get(), completedStepIds }) });
    },

    autoPlaceActiveStep() {
      const { assembly, activeStepId } = get();
      const step = assembly.steps.find((s) => s.id === activeStepId);
      if (!step) return;
      const placements = new Map(get().placements);
      for (const partId of step.partIds) {
        const part = assembly.parts.find((p) => p.id === partId);
        if (!part) continue;
        placements.set(partId, {
          partId,
          pose: clonePose(part.targetPose),
          status: 'placed',
          placedAtMs: Date.now(),
        });
      }
      set({ ...derive({ ...get(), placements }) });
    },

    reset() {
      const placements = initialPlacements(get().assembly);
      const next = { ...get(), placements, completedStepIds: new Set<string>(), activeStepId: get().assembly.steps[0]?.id };
      set({
        completedStepIds: new Set<string>(),
        activeStepId: get().assembly.steps[0]?.id,
        selectedPartId: undefined,
        explodeFactor: 0,
        ...derive(next),
      });
    },
  };
});
