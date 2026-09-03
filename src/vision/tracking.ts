import { iou, type Detection } from './onnx';

/**
 * Temporal fusion for recognition.
 *
 * A single-frame detector is jittery: boxes flicker, scores wobble, and a part
 * drops out for one frame then reappears. Driving an AR overlay or a wrong-part
 * alert straight off raw per-frame output looks broken and false-alarms. This
 * module smooths recognition over time — associating detections across frames,
 * exponentially averaging their box and score, and only *confirming* a track
 * once it has been seen enough — which is what turns noisy inference into a
 * stable, trustworthy signal.
 */

export interface Track {
  id: number;
  label: string;
  classId: number;
  /** Smoothed box (EMA), normalised in the original frame. */
  box: Detection['box'];
  /** Smoothed confidence (EMA). */
  score: number;
  /** Frames this track has been matched. */
  hits: number;
  /** Consecutive frames missed since the last match. */
  misses: number;
  /** Frames since creation. */
  age: number;
  /** A confirmed track has cleared the min-hits threshold and is still alive. */
  confirmed: boolean;
}

export interface TrackerOptions {
  /** IoU needed to associate a detection with an existing track. */
  iouThreshold?: number;
  /** Matches required before a track is confirmed. */
  minHits?: number;
  /** Misses tolerated before a track is dropped. */
  maxMisses?: number;
  /** EMA factor for box and score (0..1); higher tracks faster, smooths less. */
  smoothing?: number;
}

const DEFAULTS: Required<TrackerOptions> = {
  iouThreshold: 0.3,
  minHits: 3,
  maxMisses: 5,
  smoothing: 0.5,
};

const emaBox = (a: Detection['box'], b: Detection['box'], t: number): Detection['box'] => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

/**
 * Greedy IoU tracker (SORT-style, without the Kalman filter — parts on a bench
 * move slowly relative to the frame rate, so an EMA is enough and far cheaper).
 */
export class DetectionTracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private readonly opts: Required<TrackerOptions>;

  constructor(options: TrackerOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Fold one frame of detections in; returns the currently-confirmed tracks. */
  update(detections: Detection[]): Track[] {
    const unmatched = new Set(this.tracks.keys());
    const usedDet = new Set<number>();

    // Highest-score detections claim their best-IoU track first.
    const order = detections.map((_, i) => i).sort((a, b) => detections[b].score - detections[a].score);
    for (const di of order) {
      const det = detections[di];
      let best = -1;
      let bestIou = this.opts.iouThreshold;
      for (const ti of unmatched) {
        const track = this.tracks[ti];
        if (track.classId !== det.classId) continue;
        const overlap = iou(track.box, det.box);
        if (overlap >= bestIou) {
          bestIou = overlap;
          best = ti;
        }
      }
      if (best >= 0) {
        this.matchTrack(this.tracks[best], det);
        unmatched.delete(best);
        usedDet.add(di);
      }
    }

    // Unmatched tracks age; dead ones are dropped.
    for (const ti of unmatched) {
      const track = this.tracks[ti];
      track.misses += 1;
      track.age += 1;
    }
    this.tracks = this.tracks.filter((t) => t.misses <= this.opts.maxMisses);

    // Unmatched detections spawn new tentative tracks.
    detections.forEach((det, di) => {
      if (usedDet.has(di)) return;
      this.tracks.push({
        id: this.nextId++,
        label: det.label,
        classId: det.classId,
        box: det.box,
        score: det.score,
        hits: 1,
        misses: 0,
        age: 1,
        confirmed: this.opts.minHits <= 1,
      });
    });

    return this.confirmed();
  }

  private matchTrack(track: Track, det: Detection): void {
    const t = this.opts.smoothing;
    track.box = emaBox(track.box, det.box, t);
    track.score = track.score + (det.score - track.score) * t;
    track.label = det.label;
    track.hits += 1;
    track.misses = 0;
    track.age += 1;
    if (track.hits >= this.opts.minHits) track.confirmed = true;
  }

  confirmed(): Track[] {
    return this.tracks.filter((t) => t.confirmed && t.misses === 0);
  }

  all(): Track[] {
    return [...this.tracks];
  }

  reset(): void {
    this.tracks = [];
  }
}

/**
 * Rolling majority vote for classification.
 *
 * A per-frame top-1 label flickers between visually similar parts (exactly the
 * left/right handed pair the app cares about). Voting over a short window turns
 * that into a stable answer with an honest confidence, and refuses to commit
 * when the window is genuinely split.
 */
export class ClassificationVoter {
  private window: { classId: number; label: string; score: number }[] = [];

  constructor(private readonly size = 8) {}

  push(classId: number, label: string, score: number): void {
    this.window.push({ classId, label, score });
    if (this.window.length > this.size) this.window.shift();
  }

  /** Winning label with the fraction of the window that agreed, or undefined. */
  vote(minFraction = 0.5): { classId: number; label: string; confidence: number } | undefined {
    if (this.window.length === 0) return undefined;
    const tally = new Map<number, { label: string; count: number; scoreSum: number }>();
    for (const v of this.window) {
      const t = tally.get(v.classId) ?? { label: v.label, count: 0, scoreSum: 0 };
      t.count += 1;
      t.scoreSum += v.score;
      tally.set(v.classId, t);
    }
    let bestId = -1;
    let best = { label: '', count: 0, scoreSum: 0 };
    for (const [id, t] of tally) {
      if (t.count > best.count) { best = t; bestId = id; }
    }
    const fraction = best.count / this.window.length;
    if (fraction < minFraction) return undefined;
    return { classId: bestId, label: best.label, confidence: (best.scoreSum / best.count) * fraction };
  }

  reset(): void {
    this.window = [];
  }
}
