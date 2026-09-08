import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraTracker, orientationToQuaternion } from './cameraTracker';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function media() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function videoElement() {
  return {
    srcObject: null,
    setAttribute: vi.fn(),
    muted: false,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  } as unknown as HTMLVideoElement;
}

function orientation(type = 'deviceorientation', alpha = 0, heading = 30) {
  window.dispatchEvent(Object.assign(new Event(type), {
    alpha, beta: 60, gamma: 0, webkitCompassHeading: heading,
  }));
}

describe('CameraTracker lifecycle', () => {
  let tracker: CameraTracker;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tracker = new CameraTracker();
    getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  });

  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stops a late permission result without binding video or reviving sensors', async () => {
    const permission = deferred<MediaStream>();
    const { stream, tracks } = media();
    const video = videoElement();
    getUserMedia.mockReturnValue(permission.promise);
    const start = tracker.start(video);
    tracker.stop();
    permission.resolve(stream);
    await start;
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(video.play).not.toHaveBeenCalled();
    orientation();
    expect(tracker.state).toMatchObject({ running: false, receivingMotion: false });
  });

  it('does not retry or report errors from a cancelled permission request', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValue(permission.promise);
    const start = tracker.start(videoElement());
    tracker.stop();
    permission.reject(new DOMException('busy', 'NotReadableError'));
    await start;
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(tracker.state.error).toBeUndefined();
  });

  it('reports a current permission denial without retrying', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await tracker.start(videoElement());
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(tracker.state.running).toBe(false);
    expect(tracker.state.error).toContain('Camera access was denied');
  });

  it('reports an absent camera API without requesting media', async () => {
    vi.stubGlobal('navigator', {});
    await tracker.start(videoElement());
    expect(tracker.state.running).toBe(false);
    expect(tracker.state.error).toContain('no camera API');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('cancels the busy-camera retry timer', async () => {
    vi.useFakeTimers();
    getUserMedia.mockRejectedValue(new DOMException('busy', 'NotReadableError'));
    const start = tracker.start(videoElement());
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    tracker.stop();
    await start;
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('still retries a busy camera when the session is current', async () => {
    vi.useFakeTimers();
    const { stream } = media();
    getUserMedia.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'))
      .mockResolvedValueOnce(stream);
    const start = tracker.start(videoElement());
    await vi.advanceTimersByTimeAsync(450);
    await start;
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(tracker.state.running).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)('ignores a stale play %s after stop', async (result) => {
    const playback = deferred<void>();
    const { stream, tracks } = media();
    const video = videoElement();
    vi.mocked(video.play).mockReturnValue(playback.promise);
    getUserMedia.mockResolvedValue(stream);
    const start = tracker.start(video);
    await Promise.resolve();
    await Promise.resolve();
    expect(video.play).toHaveBeenCalledOnce();
    tracker.stop();
    expect(video.srcObject).toBeNull();
    expect(video.pause).toHaveBeenCalledOnce();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    if (result === 'resolve') playback.resolve();
    else playback.reject(new Error('interrupted'));
    await start;
    orientation();
    expect(tracker.state).toMatchObject({ running: false, receivingMotion: false });
    expect(tracker.state.error).toBeUndefined();
  });

  it('cleans up playback failure and can subsequently restart', async () => {
    const failed = media();
    const video = videoElement();
    getUserMedia.mockResolvedValueOnce(failed.stream).mockResolvedValueOnce(media().stream);
    vi.mocked(video.play).mockRejectedValueOnce(new Error('autoplay denied'));
    await tracker.start(video);
    expect(tracker.state.running).toBe(false);
    expect(tracker.state.error).toContain('Camera playback failed');
    expect(video.srcObject).toBeNull();
    for (const track of failed.tracks) expect(track.stop).toHaveBeenCalledOnce();
    orientation();
    expect(tracker.state.receivingMotion).toBe(false);
    await tracker.start(video);
    expect(tracker.state.running).toBe(true);
    expect(tracker.state.error).toBeUndefined();
  });

  it('lets only the latest pending start own the stream', async () => {
    const first = deferred<MediaStream>();
    const old = media();
    const current = media();
    const video = videoElement();
    getUserMedia.mockReturnValueOnce(first.promise).mockResolvedValueOnce(current.stream);
    const staleStart = tracker.start(video);
    await tracker.start(video);
    first.resolve(old.stream);
    await staleStart;
    expect(video.srcObject).toBe(current.stream);
    expect(tracker.state.running).toBe(true);
    for (const track of old.tracks) expect(track.stop).toHaveBeenCalledOnce();
    for (const track of current.tracks) expect(track.stop).not.toHaveBeenCalled();
  });

  it('does not let an old playback failure detach the replacement session', async () => {
    const playback = deferred<void>();
    const old = media();
    const current = media();
    const video = videoElement();
    vi.mocked(video.play).mockReturnValueOnce(playback.promise);
    getUserMedia.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(current.stream);
    const staleStart = tracker.start(video);
    await Promise.resolve();
    await Promise.resolve();
    await tracker.start(video);
    playback.reject(new Error('old playback interrupted'));
    await staleStart;
    expect(video.srcObject).toBe(current.stream);
    expect(tracker.state.running).toBe(true);
    expect(tracker.state.error).toBeUndefined();
    for (const track of old.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it('does not let a stale camera error overwrite a running replacement', async () => {
    const first = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(first.promise).mockResolvedValueOnce(media().stream);
    const staleStart = tracker.start(videoElement());
    await tracker.start(videoElement());
    first.reject(new DOMException('denied', 'NotAllowedError'));
    await staleStart;
    expect(tracker.state.running).toBe(true);
    expect(tracker.state.error).toBeUndefined();
  });

  it('replaces a running session, removes listeners and resets its heading baseline', async () => {
    const old = media();
    const video = videoElement();
    getUserMedia.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(media().stream);
    await tracker.start(video);
    orientation('deviceorientation', 0, 30);
    orientation('deviceorientationabsolute', 20, 45);
    expect(tracker.state.driftDeg).toBe(15);
    await tracker.start(video);
    for (const track of old.tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(tracker.state).toMatchObject({ receivingMotion: false, driftDeg: 0 });
    const subscriber = vi.fn();
    tracker.subscribe(subscriber);
    orientation('deviceorientation', 80, 120);
    expect(subscriber).toHaveBeenCalledOnce();
    expect(tracker.state.orientation).toEqual(orientationToQuaternion(80, 60, 0).toArray());
    expect(tracker.state.driftDeg).toBe(0);
    tracker.stop();
    subscriber.mockClear();
    orientation();
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('does not pause or detach media installed by the embedding host', async () => {
    const own = media();
    const replacement = media();
    const video = videoElement();
    getUserMedia.mockResolvedValue(own.stream);
    await tracker.start(video);
    video.srcObject = replacement.stream;
    tracker.stop();
    tracker.stop();
    expect(video.srcObject).toBe(replacement.stream);
    expect(video.pause).not.toHaveBeenCalled();
    for (const track of own.tracks) expect(track.stop).toHaveBeenCalledOnce();
    for (const track of replacement.tracks) expect(track.stop).not.toHaveBeenCalled();
  });
});
