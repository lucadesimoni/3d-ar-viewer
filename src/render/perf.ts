/**
 * Adaptive performance profile — maximum smoothness on every device.
 *
 * A shop uses whatever it has: a current iPad Pro, a five-year-old Android
 * tablet, a laptop on software GL. One fixed quality setting is wrong for all of
 * them. This module reads the device's real capabilities once, classifies it
 * into a tier, and hands back a profile (pixel-ratio cap, antialias, target FPS,
 * recognition cadence). The renderer then *also* auto-degrades under live load
 * via Babylon's SceneOptimizer, so a scene that starts stuttering drops internal
 * resolution to hold the target frame rate rather than lurching.
 *
 * All detection is injectable and pure, so the tiering is unit-tested; only the
 * application of the profile touches the GPU.
 */

export type PerfTier = 'low' | 'mid' | 'high';

export interface DeviceSignals {
  cores: number;
  memoryGB: number;
  dpr: number;
  mobile: boolean;
  maxTextureSize: number;
  /** Unmasked GL renderer string, lowercased (may be empty). */
  renderer: string;
}

export interface PerfProfile {
  tier: PerfTier;
  /** Upper bound on device-pixel-ratio the canvas renders at. */
  maxPixelRatio: number;
  antialias: boolean;
  /** Frame rate the adaptive optimizer aims to hold. */
  targetFps: number;
  /** How often the recognition pipeline samples a camera frame, ms. */
  recognitionIntervalMs: number;
  /** Whether to run the runtime auto-degrade loop. */
  adaptive: boolean;
}

/** Read what the browser will tell us about the device. Safe on any platform. */
export function readDeviceSignals(): DeviceSignals {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const cores = nav?.hardwareConcurrency ?? 4;
  const memoryGB = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory ?? 4;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const ua = nav?.userAgent ?? '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (nav?.maxTouchPoints ?? 0) > 1;

  let maxTextureSize = 8192;
  let renderer = '';
  if (typeof document !== 'undefined') {
    try {
      const gl = document.createElement('canvas').getContext('webgl2') ??
        document.createElement('canvas').getContext('webgl');
      if (gl) {
        maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '').toLowerCase();
      }
    } catch {
      /* headless / blocked — fall back to defaults */
    }
  }
  return { cores, memoryGB, dpr, mobile, maxTextureSize, renderer };
}

/**
 * Classify a device into a performance tier from its signals.
 *
 * Software renderers (SwiftShader/llvmpipe) and tiny texture limits force `low`
 * regardless of core count; otherwise a small score over cores, memory and form
 * factor decides, with mobiles held back one step unless they are clearly
 * high-end (lots of cores + memory, e.g. an iPad Pro).
 */
export function classifyTier(s: DeviceSignals): PerfTier {
  const software = /swiftshader|llvmpipe|software|basic render/i.test(s.renderer);
  if (software || s.maxTextureSize < 4096) return 'low';

  let score = 0;
  if (s.cores >= 8) score += 2;
  else if (s.cores >= 4) score += 1;
  if (s.memoryGB >= 8) score += 2;
  else if (s.memoryGB >= 4) score += 1;
  if (!s.mobile) score += 1;

  let tier: PerfTier = score >= 4 ? 'high' : score >= 2 ? 'mid' : 'low';
  // Hold mobiles one step back unless they are decisively powerful.
  if (s.mobile && tier === 'high' && !(s.cores >= 8 && s.memoryGB >= 6)) tier = 'mid';
  return tier;
}

const PROFILES: Record<PerfTier, Omit<PerfProfile, 'tier'>> = {
  high: { maxPixelRatio: 2, antialias: true, targetFps: 60, recognitionIntervalMs: 400, adaptive: true },
  mid: { maxPixelRatio: 1.75, antialias: true, targetFps: 45, recognitionIntervalMs: 600, adaptive: true },
  low: { maxPixelRatio: 1.25, antialias: false, targetFps: 30, recognitionIntervalMs: 1000, adaptive: true },
};

export function profileForTier(tier: PerfTier): PerfProfile {
  return { tier, ...PROFILES[tier] };
}

/**
 * Optional URL overrides for benchmarking / kiosk tuning:
 *   ?perf=low|mid|high|max   force a tier ("max" = high, adaptive off)
 *   ?dpr=1.5                 hard pixel-ratio cap
 *   ?fps=30                  target frame rate
 */
export function applyPerfOverrides(profile: PerfProfile, search: string): PerfProfile {
  const p = new URLSearchParams(search);
  const out = { ...profile };
  const perf = p.get('perf');
  if (perf === 'low' || perf === 'mid' || perf === 'high') Object.assign(out, profileForTier(perf), { tier: perf });
  if (perf === 'max') Object.assign(out, profileForTier('high'), { tier: 'high', adaptive: false, maxPixelRatio: 3 });
  const dpr = Number(p.get('dpr'));
  if (Number.isFinite(dpr) && dpr > 0) out.maxPixelRatio = dpr;
  const fps = Number(p.get('fps'));
  if (Number.isFinite(fps) && fps > 0) out.targetFps = fps;
  return out;
}

/** Detect the profile for the current device, applying any URL overrides. */
export function detectPerfProfile(search = typeof window !== 'undefined' ? window.location.search : ''): PerfProfile {
  return applyPerfOverrides(profileForTier(classifyTier(readDeviceSignals())), search);
}
