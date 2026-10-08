/**
 * Read a diagnostics report from a device — the JSON the app's "Export" makes.
 *
 *   node scripts/read-report.mjs spatial-ar-….json [--images=dir]
 *
 * A report is a megabyte of JSON, most of it camera frames, and the questions
 * asked of one are nearly always the same. This answers them first — what
 * build, what device, which AR path, how it rendered — then flags the patterns
 * earlier sessions taught us to look for, then prints the event log as a
 * timeline. `--images` writes the captured camera frames out as files.
 *
 * Reports contain a person's camera images. This only reads them locally; keep
 * them out of the repository.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const round = (v, d = 2) => (typeof v === 'number' ? Number(v.toFixed(d)) : v);

/**
 * The browser, most specific first: Edge, Samsung's and Chrome-on-iOS all
 * carry "Chrome" or "Safari" in their user agent too, earlier in the string.
 */
export function browserOf(ua = '') {
  for (const re of [/EdgA?\/[\d.]+/, /EdgiOS\/[\d.]+/, /SamsungBrowser\/[\d.]+/, /Firefox\/[\d.]+/, /FxiOS\/[\d.]+/,
    /CriOS\/[\d.]+/, /Chrome\/[\d.]+/, /Version\/[\d.]+.*Safari/]) {
    const m = ua.match(re);
    if (m) return m[0].startsWith('Version/') ? `Safari ${m[0].split(/[/ ]/)[1]}` : m[0];
  }
  return undefined;
}

/**
 * Where an iOS report came from: Safari, or a web view — which is what the
 * Needle App Clip hosts the page in. A web view's user agent has no `Safari/`
 * token. An iPad asking for the desktop site says "Macintosh", so the app's
 * own `isIPad` is believed over the user agent.
 */
export function iosHost(report) {
  const caps = report?.capabilities ?? {};
  const ua = report?.device?.userAgent ?? '';
  const ios = caps.isIOS || caps.isIPad || /iPhone|iPad|iPod/.test(ua);
  if (!ios) return undefined;
  return /Safari\//.test(ua) ? 'safari' : 'webview';
}

function deviceOf(report) {
  const caps = report?.capabilities ?? {};
  const ua = report?.device?.userAgent ?? '';
  if (caps.isIPad || /iPad/.test(ua)) return `iPad${ua.match(/OS ([\d_]+)/) ? ` (iOS ${ua.match(/OS ([\d_]+)/)[1].replace(/_/g, '.')})` : ''}`;
  if (caps.isIOS || /iPhone/.test(ua)) return `iPhone${ua.match(/OS ([\d_]+)/) ? ` (iOS ${ua.match(/OS ([\d_]+)/)[1].replace(/_/g, '.')})` : ''}`;
  return ua.match(/(Android [\d.]+|Mac OS X [\d_]+|Windows NT [\d.]+)/)?.[1];
}

/** The facts, the findings and the timeline of one report. Pure: no I/O. */
export function summarise(report) {
  const r = report ?? {};
  const render = r.render ?? {};
  const ar = r.ar ?? {};
  const device = r.device ?? {};
  const log = Array.isArray(r.log) ? r.log : [];
  const dpr = device.devicePixelRatio ?? 1;

  const facts = {
    build: r.build?.commit ?? 'unknown',
    at: r.at,
    device: [device.platform, deviceOf(r),
      browserOf(device.userAgent) ?? (iosHost(r) === 'webview' ? 'iOS web view (the App Clip?)' : undefined)]
      .filter(Boolean).join(' · '),
    screen: `${device.viewport?.join('×') ?? '?'} css @ ${round(dpr)}x`,
    assembly: r.assembly ? `${r.assembly.name} (${r.assembly.id}), step ${r.assembly.activeStep}` : 'none',
    ar: `${ar.mode ?? ar.source ?? 'off'} · placement ${ar.placement ?? '?'}${ar.xrSession?.camera?.granted ? ' · camera granted' : ''}`,
    render: `${round(render.fps, 1)} fps · ${render.frames ?? '?'} ticks, ${render.idleFrames ?? 0} idle · ${render.stalls ?? 0} stalls · scaling ${round(render.scaling, 3)}`,
    camera: render.frameSource ? `${render.frameSource}${render.frameSourceSize ? ` ${render.frameSourceSize.join('×')}` : ''}${render.frameReadbackMs ? ` · readback ${render.frameReadbackMs} ms` : ''}` : 'none',
    captures: Array.isArray(r.captures) ? r.captures.length : 0,
  };

  const findings = [];
  const say = (level, text) => findings.push({ level, text });

  if (render.stalls > 0) say('warn', `the render loop stalled ${render.stalls} time(s)`);
  if (render.contextLost) say('warn', 'the WebGL context was lost');
  if (render.renderError) say('warn', `render error: ${render.renderError}`);
  if (render.frameUniform) say('warn', 'the last camera frame was all one colour — a read that found no picture');
  // Below device resolution: hardware scaling above 1/dpr (capped at 3x).
  const full = 1 / Math.min(dpr, 3);
  if (typeof render.scaling === 'number' && render.scaling > full * 1.01) {
    say('info', `drawing at ${round(1 / render.scaling, 2)}x CSS pixels of a possible ${round(Math.min(dpr, 3), 2)}x`
      + (log.some((e) => e.message === 'resolution lowered') ? ' (see "resolution lowered")' : ''));
  }
  if (ar.xrSession && ar.xrSession.camera?.requested && !ar.xrSession.camera?.granted) {
    say('info', 'the session was asked for its camera and did not give it — no recognition possible');
  }
  // The two iOS paths, each with its own known limit.
  const host = iosHost(r);
  if (host === 'webview' && render.frameSource === 'xr-blind') {
    say('warn', 'App Clip session with no camera image (xr-blind): recognition and frame capture cannot work there — placement by hand only');
  }
  if (host === 'safari' && (ar.mode ?? ar.source) === 'camera') {
    say('info', 'iOS Safari has no WebXR: the camera path, orientation only — position is not tracked; the App Clip is the route to real tracking');
  }

  // A tap, then the platform moving the anchor within a fraction of a second:
  // the pattern behind "every tap moves it".
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (!/^tap ignored|^placing on a tap/.test(e.message ?? '')) continue;
    const next = log.slice(i + 1).find((n) => n.message === 'the platform moved the anchor' && n.t - e.t <= 300);
    if (next && next.data?.byM >= 0.1) {
      say('info', `at ${(e.t / 1000).toFixed(1)} s a tap was followed ${next.t - e.t} ms later by the anchor moving ${next.data.byM} m`
        + (next.data.followed === false ? ' (not followed)' : ''));
    }
  }
  for (const e of log.filter((x) => x.message === 'camera jumped')) {
    say('warn', `at ${(e.t / 1000).toFixed(1)} s the session camera jumped ${e.data?.byM} m in ${e.data?.inMs} ms — the platform re-based the room`);
  }
  const errors = log.filter((e) => e.kind === 'error');
  if (errors.length) say('warn', `${errors.length} error(s) in the log — first: ${errors[0].message}`);

  const timeline = log.map((e) => ({
    t: e.t,
    kind: e.kind,
    message: e.message,
    data: e.data && Object.keys(e.data).length ? e.data : undefined,
  }));

  return { facts, findings, timeline };
}

/** Write each captured frame out as an image file; returns the paths. */
export function extractImages(report, dir) {
  mkdirSync(dir, { recursive: true });
  const paths = [];
  (report.captures ?? []).forEach((c, i) => {
    const m = /^data:image\/(\w+);base64,(.*)$/s.exec(c.image ?? '');
    if (!m) return;
    const path = join(dir, `capture-${i}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    writeFileSync(path, Buffer.from(m[2], 'base64'));
    paths.push(path);
  });
  return paths;
}

function print({ facts, findings, timeline }) {
  for (const [k, v] of Object.entries(facts)) console.log(`${k.padEnd(10)} ${v ?? '—'}`);
  console.log(findings.length ? '\nfindings' : '\nfindings   none');
  for (const f of findings) console.log(`  ${f.level === 'warn' ? '!' : '·'} ${f.text}`);
  console.log('\ntimeline');
  for (const e of timeline) {
    console.log(`  ${(e.t / 1000).toFixed(2).padStart(7)} s  ${String(e.kind).padEnd(7)} ${e.message}${e.data ? `  ${JSON.stringify(e.data)}` : ''}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node scripts/read-report.mjs <report.json> [--images=dir]');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  print(summarise(report));
  const images = process.argv.find((a) => a.startsWith('--images='))?.slice('--images='.length);
  if (images) for (const p of extractImages(report, images)) console.log(`wrote ${p}`);
}
