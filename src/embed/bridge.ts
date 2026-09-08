import type { StoreApi } from 'zustand';
import { AssemblyImportError, parseAssembly } from '../engine/assemblyImport';
import { useStore, type AppState } from '../state/store';

export const EMBED_CHANNEL = 'spatial-ar-viewer';
export const EMBED_VERSION = 1;

export function parseParentOrigin(value: string): string {
  const origin = new URL(value);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value) {
    throw new Error('parentOrigin must be an exact HTTP(S) origin, without a path or trailing slash.');
  }
  return origin.origin;
}

function snapshot(state: AppState) {
  return {
    assembly: {
      id: state.assembly.id, name: state.assembly.name, revision: state.assembly.revision,
      source: state.assembly.source, partCount: state.assembly.parts.length,
    },
    activeStepId: state.activeStepId ?? null,
    selectedPartId: state.selectedPartId ?? null,
    completedStepIds: [...state.completedStepIds],
    progress: state.sequence.progress,
    arSource: state.arSource ?? null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class EmbedCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function execute(command: Record<string, unknown>, store: StoreApi<AppState>) {
  const state = store.getState();
  switch (command.type) {
    case 'get-state': break;
    case 'load-assembly':
      if (state.arSource) throw new EmbedCommandError('ar-active', 'Exit AR before replacing the assembly.');
      state.loadAssembly(parseAssembly(command.assembly));
      break;
    case 'select-part':
      if (command.partId !== null && !state.assembly.parts.some((p) => p.id === command.partId)) {
        throw new EmbedCommandError('unknown-part', 'partId must identify an occurrence in the current assembly, or be null.');
      }
      state.selectPart(command.partId === null ? undefined : state.assembly.parts.find((p) => p.id === command.partId)!.id);
      break;
    case 'set-step': {
      const step = state.assembly.steps.find((s) => s.id === command.stepId);
      if (!step) throw new EmbedCommandError('unknown-step', 'stepId is not in the current assembly.');
      state.setActiveStep(step.id);
      break;
    }
    case 'reset':
      if (state.arSource) throw new EmbedCommandError('ar-active', 'Exit AR before resetting the assembly.');
      state.reset();
      break;
    default: throw new EmbedCommandError('unknown-command', 'Unsupported viewer command.');
  }
  return snapshot(store.getState());
}

/**
 * A host can drive an iframe without exposing the store or accepting messages
 * from unrelated windows. Installation is opt-in with an exact parent origin.
 */
export function installEmbedBridge(
  parentOrigin: string,
  hostWindow: Window = window,
  store: StoreApi<AppState> = useStore,
): () => void {
  const origin = parseParentOrigin(parentOrigin);
  const parent = hostWindow.parent;
  const post = (message: Record<string, unknown>) => {
    parent.postMessage({ channel: EMBED_CHANNEL, version: EMBED_VERSION, ...message }, origin);
  };
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== parent || event.origin !== origin) return;
    const command = event.data;
    if (!record(command) || command.channel !== EMBED_CHANNEL) return;
    const requestId = typeof command.requestId === 'string' && command.requestId.length > 0
      && command.requestId.length <= 128 ? command.requestId : null;
    if (requestId === null || command.version !== EMBED_VERSION) {
      post({
        type: 'response', requestId, ok: false,
        error: { code: 'invalid-envelope', message: 'Use version 1 and a requestId of 1-128 characters.' },
      });
      return;
    }
    try {
      post({ type: 'response', requestId, ok: true, state: execute(command, store) });
    } catch (error) {
      if (error instanceof AssemblyImportError || error instanceof EmbedCommandError) {
        post({
          type: 'response', requestId, ok: false,
          error: {
            code: error instanceof AssemblyImportError ? 'invalid-assembly' : error.code,
            message: error.message,
          },
        });
      } else {
        console.error('Viewer host command failed', error);
        post({
          type: 'response', requestId, ok: false,
          error: { code: 'internal-error', message: 'The viewer could not complete this command.' },
        });
      }
    }
  };
  hostWindow.addEventListener('message', onMessage);
  post({ type: 'ready', state: snapshot(store.getState()) });
  return () => hostWindow.removeEventListener('message', onMessage);
}
