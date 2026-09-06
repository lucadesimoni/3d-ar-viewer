import { create } from 'zustand';
import type { ArMode } from '../engine/tracking/capabilities';
import { runDiagnostics, severityByPart, type Diagnostic, type Severity } from '../engine/diagnostics';
import { buildSequenceView, suggestNextStep, type SequenceView } from '../engine/sequencer';
import { clonePose } from '../engine/math';
import { bestSnap, findSnapCandidates, type MateResidual } from '../engine/snapping';
import type { Timeline } from '../engine/animation';
import type { RecognitionState } from '../vision/verdict';
import type { AssemblyDef, PlacementState, Pose } from '../engine/types';
import { gearbox } from '../data';

export type ViewMode = 'guide' | 'explore' | 'explode' | 'animate';

/**
 * How the assembly got its place in the world.
 *
 * `awaiting` is the state that was missing: the app used to drop the model at a
 * guessed standoff in front of the operator and call that AR. Now it says what
 * it is doing — looking for the floor or for the object itself — until something
 * real fixes the anchor.
 */
/**
 * The handful of AR numbers a device can be wrong about.
 *
 * Browsers expose no camera calibration and no eye height, so the passthrough
 * path runs on two assumptions. Rather than bury them in a constant, they are
 * settings the operator can correct in the field: if the overlay is a little
 * too big or the assembly lands too close, these are the two dials that fix it.
 */
export interface ArSettings {
  /** Assumed vertical field of view of the physical camera, degrees. */
  cameraFovDeg: number;
  /** How high the device is being held, metres — defines the floor plane. */
  eyeHeightM: number;
  /** Let recognition of the object re-anchor the overlay automatically. */
  autoRecognize: boolean;
  /**
   * Ask for a placement every time AR starts.
   *
   * Off means AR opens with the assembly where it was left, and repositioning
   * is something the operator asks for with "Move" — which is what you want
   * once a workpiece is where it belongs and the reticle is just in the way.
   */
  placeOnEntry: boolean;
}

/**
 * `?camfov=<degrees>` pre-sets the camera calibration, so a device that is
 * known to be off can be deep-linked already corrected. Invalid values are
 * ignored rather than breaking the projection.
 */
function readFovOverride(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = new URLSearchParams(window.location.search).get('camfov');
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v > 35 && v < 110 ? v : undefined;
}

export type ArPlacement = 'idle' | 'awaiting' | 'floor' | 'recognized' | 'marker' | 'manual';

export interface AppState {
  assembly: AssemblyDef;
  /** Rigid transform from assembly frame into world/AR frame. */
  anchor: Pose | undefined;
  anchorQuality: number;
  /** Where the anchor came from — drives the AR prompt and the status bar. */
  arPlacement: ArPlacement;
  arSettings: ArSettings;
  arMode: ArMode;
  viewMode: ViewMode;
  explodeFactor: number;
  /** Active build-animation timeline while in 'animate' mode, and its scrub time. */
  animationTimeline: Timeline | undefined;
  animationT: number;
  /** Latest camera recognition + colour-coded discrepancy verdict. */
  recognition: RecognitionState | undefined;
  /** Snap a dropped part onto its mate when it is within capture range. */
  snapEnabled: boolean;
  /** Most recent successful snap, for transient UI feedback. */
  lastSnap: { partId: string; mateId: string; residual: MateResidual; atMs: number } | undefined;

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
  setAnchor(pose: Pose | undefined, quality: number, placement?: ArPlacement): void;
  setArPlacement(placement: ArPlacement): void;
  setArSettings(patch: Partial<ArSettings>): void;
  setArMode(mode: ArMode): void;
  setViewMode(mode: ViewMode): void;
  setExplodeFactor(f: number): void;
  setAnimation(timeline: Timeline | undefined, t: number): void;
  setRecognition(recognition: RecognitionState | undefined): void;
  setSnapEnabled(on: boolean): void;
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

/**
 * Snap a dropped part onto the best mate within capture range.
 *
 * This is what makes placement feel mechanical rather than free-floating: the
 * operator gets the part roughly onto the joint and it seats itself exactly,
 * exactly as the tolerance check then expects. Only mates whose *other* side is
 * already placed are candidates, so a joint goes live only once its counterpart
 * exists. Returns the original pose unchanged when nothing is in range.
 */
function snapToMate(
  assembly: AssemblyDef,
  partId: string,
  pose: Pose,
  placements: Map<string, PlacementState>,
): { pose: Pose; mateId?: string; residual?: MateResidual } {
  const part = assembly.parts.find((p) => p.id === partId);
  if (!part) return { pose };

  const partsById = new Map(assembly.parts.map((p) => [p.id, p]));
  const posesById = new Map<string, Pose>();
  for (const [id, pl] of placements) {
    if (id !== partId && pl.status !== 'ghost') posesById.set(id, pl.pose);
  }

  const mates = assembly.steps.flatMap((s) => s.mates);
  const best = bestSnap(findSnapCandidates(part, pose, mates, partsById, posesById));
  return best ? { pose: best.snappedPose, mateId: best.mate.id, residual: best.residual } : { pose };
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
    arPlacement: 'idle' as ArPlacement,
    arSettings: {
      cameraFovDeg: readFovOverride() ?? 60,
      eyeHeightM: 1.45,
      autoRecognize: true,
      placeOnEntry: true,
    } as ArSettings,
    arMode: 'preview' as ArMode,
    viewMode: 'guide' as ViewMode,
    explodeFactor: 0,
    animationTimeline: undefined,
    animationT: 0,
    recognition: undefined,
    snapEnabled: true,
    lastSnap: undefined,
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
        arPlacement: 'idle',
        selectedPartId: undefined,
        explodeFactor: 0,
        ...derive(next),
      });
    },

    setAnchor(pose, quality, placement) {
      set({
        anchor: pose,
        anchorQuality: quality,
        arPlacement: placement ?? (pose ? 'manual' : 'idle'),
      });
    },
    setArPlacement(placement) {
      set({ arPlacement: placement });
    },
    setArSettings(patch) {
      const next = { ...get().arSettings, ...patch };
      // Clamp to what is physically sensible: a phone camera is 40-100 degrees
      // and nobody holds a tablet below the knee or above their head.
      next.cameraFovDeg = Math.max(35, Math.min(110, next.cameraFovDeg));
      next.eyeHeightM = Math.max(0.4, Math.min(2.2, next.eyeHeightM));
      set({ arSettings: next });
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
    setRecognition(recognition) {
      set({ recognition });
    },
    setSnapEnabled(on) {
      set({ snapEnabled: on });
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
      const { assembly, snapEnabled } = get();
      const placements = new Map(get().placements);
      const snap = snapEnabled
        ? snapToMate(assembly, partId, pose, placements)
        : { pose, mateId: undefined, residual: undefined };
      placements.set(partId, { partId, pose: snap.pose, status: 'placed', placedAtMs: Date.now() });
      set({
        lastSnap: snap.mateId
          ? { partId, mateId: snap.mateId, residual: snap.residual!, atMs: Date.now() }
          : get().lastSnap,
        ...derive({ ...get(), placements }),
      });
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
