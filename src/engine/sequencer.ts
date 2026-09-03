import type { AssemblyDef, PlacementState, StepDef } from './types';
import type { Diagnostic } from './diagnostics';

export type StepStatus = 'locked' | 'ready' | 'active' | 'complete' | 'error';

export interface StepState {
  step: StepDef;
  status: StepStatus;
  /** Prerequisite step ids that are still outstanding. */
  blockedBy: string[];
  /** Parts of this step that have been placed. */
  placedPartIds: string[];
  diagnostics: Diagnostic[];
}

export interface SequenceView {
  steps: StepState[];
  /** 0..1 over parts placed and verified, not over steps ticked off. */
  progress: number;
  /** Seconds of estimated work left, from `durationEstS` on incomplete steps. */
  remainingS: number;
  /** Steps that could be worked right now. */
  readyStepIds: string[];
  /** Ordering issues in the step graph itself, not in the operator's work. */
  graphErrors: string[];
}

/**
 * Topological order of the step DAG.
 *
 * Returns `undefined` when the graph has a cycle, which is an authoring bug
 * worth surfacing loudly rather than silently rendering a partial order.
 */
export function topoOrder(steps: StepDef[]): string[] | undefined {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const known = new Set(steps.map((s) => s.id));

  for (const s of steps) {
    const reqs = s.requires.filter((r) => known.has(r));
    indegree.set(s.id, reqs.length);
    for (const r of reqs) {
      const list = dependents.get(r) ?? [];
      list.push(s.id);
      dependents.set(r, list);
    }
  }

  const queue = steps.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const dep of dependents.get(id) ?? []) {
      const n = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, n);
      if (n === 0) queue.push(dep);
    }
  }

  return order.length === steps.length ? order : undefined;
}

/** Static problems with the step graph: cycles and dangling prerequisites. */
export function validateGraph(assembly: AssemblyDef): string[] {
  const errors: string[] = [];
  const known = new Set(assembly.steps.map((s) => s.id));
  const partIds = new Set(assembly.parts.map((p) => p.id));

  for (const s of assembly.steps) {
    for (const r of s.requires) {
      if (!known.has(r)) errors.push(`Step "${s.title}" requires unknown step "${r}".`);
    }
    for (const p of s.partIds) {
      if (!partIds.has(p)) errors.push(`Step "${s.title}" installs unknown part "${p}".`);
    }
  }

  if (!topoOrder(assembly.steps)) {
    errors.push('Step prerequisites contain a cycle — no valid build order exists.');
  }

  const covered = new Set(assembly.steps.flatMap((s) => s.partIds));
  for (const p of assembly.parts) {
    if (!covered.has(p.id)) errors.push(`Part "${p.name}" is not installed by any step.`);
  }

  return errors;
}

/**
 * Current state of the whole build.
 *
 * A step is `complete` only when the operator has signed it off *and* nothing
 * in it is erroring; an errored step stays visible as `error` so it cannot be
 * quietly walked past.
 */
export function buildSequenceView(
  assembly: AssemblyDef,
  placements: Map<string, PlacementState>,
  completedStepIds: Set<string>,
  activeStepId: string | undefined,
  diagnostics: Diagnostic[],
): SequenceView {
  const byStep = new Map<string, Diagnostic[]>();
  const partToStep = new Map<string, string>();
  for (const s of assembly.steps) for (const p of s.partIds) partToStep.set(p, s.id);

  for (const d of diagnostics) {
    const stepId = d.stepId ?? d.partIds.map((p) => partToStep.get(p)).find(Boolean);
    if (!stepId) continue;
    const list = byStep.get(stepId) ?? [];
    list.push(d);
    byStep.set(stepId, list);
  }

  const steps: StepState[] = assembly.steps.map((step) => {
    const stepDiagnostics = byStep.get(step.id) ?? [];
    const blockedBy = step.requires.filter((r) => !completedStepIds.has(r));
    const placedPartIds = step.partIds.filter(
      (id) => placements.get(id) && placements.get(id)!.status !== 'ghost',
    );

    let status: StepStatus;
    if (stepDiagnostics.some((d) => d.severity === 'error')) status = 'error';
    else if (completedStepIds.has(step.id)) status = 'complete';
    else if (step.id === activeStepId) status = 'active';
    else if (blockedBy.length > 0) status = 'locked';
    else status = 'ready';

    return { step, status, blockedBy, placedPartIds, diagnostics: stepDiagnostics };
  });

  const totalParts = assembly.parts.length || 1;
  const verified = [...placements.values()].filter((p) => p.status === 'verified').length;
  const placed = [...placements.values()].filter((p) => p.status === 'placed').length;
  // Placed-but-unverified counts for half: work has happened, it is not signed off.
  const progress = Math.min(1, (verified + placed * 0.5) / totalParts);

  const remainingS = steps
    .filter((s) => s.status !== 'complete')
    .reduce((sum, s) => sum + (s.step.durationEstS ?? 0), 0);

  return {
    steps,
    progress,
    remainingS,
    readyStepIds: steps.filter((s) => s.status === 'ready').map((s) => s.step.id),
    graphErrors: validateGraph(assembly),
  };
}

/** Next step to work on: the active one if it is still open, else the first ready one. */
export function suggestNextStep(view: SequenceView, activeStepId?: string): string | undefined {
  const active = view.steps.find((s) => s.step.id === activeStepId);
  if (active && active.status !== 'complete') return active.step.id;
  const order = topoOrder(view.steps.map((s) => s.step)) ?? [];
  const byId = new Map(view.steps.map((s) => [s.step.id, s]));
  return order.find((id) => {
    const s = byId.get(id);
    return s !== undefined && (s.status === 'ready' || s.status === 'error');
  });
}
