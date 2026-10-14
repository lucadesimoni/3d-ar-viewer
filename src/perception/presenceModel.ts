import { loadOrt } from '../vision/onnx';
import { RUNTIME_URLS } from '../vision/runtimeUrls';
import { CHANNELS, INPUT_SIZE, type PresenceCrop } from './presenceInput';

/**
 * The trained presence model: "is this part in place?", from the camera.
 *
 * Trained on synthetic renders (`scripts/presence/`, `docs/PRESENCE_MODEL.md`).
 * It reads the patch of the frame where a part should be, with the part's
 * expected outline (`presenceInput.ts`), and returns a probability. Two
 * thresholds, chosen on held-out renders and shipped beside the model, turn
 * that into a vote or no vote, so an unsure model abstains like the edge check
 * does rather than guessing.
 *
 * It does not decide alone. The edge check (`presence.ts`) was measured on a
 * real session and the model so far only on renders, so a vote counts only
 * where the two do not contradict each other (`combineVotes`). Every reading
 * of both is logged so device sessions can say which to trust more.
 */

export interface PresenceThresholds {
  /** p at or above this votes present. */
  present: number;
  /** p at or below this votes absent. */
  absent: number;
}

export interface PresenceModelInfo {
  thresholds: PresenceThresholds;
}

export type Vote = { present: boolean } | undefined;

/** A probability as a vote, or no vote between the thresholds. */
export function modelVote(p: number, t: PresenceThresholds): Vote {
  if (!Number.isFinite(p)) return undefined;
  if (p >= t.present) return { present: true };
  if (p <= t.absent) return { present: false };
  return undefined;
}

/**
 * One vote from two readers. Agreement counts; a vote from one with silence
 * from the other counts; a contradiction does not. The edge check is silent
 * in the middle of its range, which is where most real frames sit, so this is
 * where the model adds evidence without overruling a measured reader.
 */
export function combineVotes(model: Vote, edges: Vote): Vote {
  if (!model) return edges;
  if (!edges) return model;
  return model.present === edges.present ? model : undefined;
}

type Ort = NonNullable<Awaited<ReturnType<typeof loadOrt>>>;

export class PresenceModel {
  private session: import('onnxruntime-web').InferenceSession | undefined;
  private ort: Ort | undefined;
  private loading: Promise<boolean> | undefined;
  info: PresenceModelInfo | undefined;
  error: string | undefined;

  constructor(readonly url: string, info: PresenceModelInfo) {
    if (info.thresholds.absent < info.thresholds.present) this.info = info;
    else this.error = 'thresholds inverted';
  }

  get ready(): boolean {
    return Boolean(this.session && this.info);
  }

  /** Load the graph once; false, with `error` set, if it is unavailable. */
  load(): Promise<boolean> {
    return this.loading ??= (async () => {
      try {
        if (!this.info) throw new Error(this.error ?? 'no thresholds');
        const ort = await loadOrt();
        if (!ort) throw new Error('ONNX Runtime is unavailable');
        this.ort = ort;
        this.session = await ort.InferenceSession.create(this.url, { executionProviders: ['wasm'] });
        return true;
      } catch (error) {
        this.error = String((error as Error)?.message ?? error);
        return false;
      }
    })();
  }

  /** p(present) for each crop, in order. */
  async score(crops: PresenceCrop[]): Promise<number[]> {
    if (!this.session || !this.ort || crops.length === 0) return [];
    const size = CHANNELS * INPUT_SIZE * INPUT_SIZE;
    const batch = new Float32Array(size * crops.length);
    crops.forEach((c, i) => batch.set(c.data, i * size));
    const input = new this.ort.Tensor('float32', batch, [crops.length, CHANNELS, INPUT_SIZE, INPUT_SIZE]);
    const out = await this.session.run({ input });
    return Array.from(out.present.data as Float32Array);
  }

  dispose(): void {
    void this.session?.release();
    this.session = undefined;
  }
}

let shared: PresenceModel | undefined;

/**
 * This build's model, one per page: undefined when the build has none (the
 * Mendix widget) or it was switched off with `VITE_PRESENCE_MODEL=off`.
 */
export function sharedPresenceModel(): PresenceModel | undefined {
  const config = RUNTIME_URLS.presenceModel;
  if (!config) return undefined;
  return shared ??= new PresenceModel(config.url, config.info);
}
