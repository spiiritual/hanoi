import { expect, test } from "bun:test";
import { createPlayerState, type PlaybackTrack } from "../src/mainview/player/state.ts";

type AudioListener = () => void;

class FakeAudio {
  volume = 1;
  src = "";
  currentTime = 0;
  duration = 12;
  paused = true;
  ended = false;
  readyState = 4;
  networkState = 1;
  bufferedEnd = 12;
  buffered = {
    length: 1,
    start: () => 0,
    end: () => this.bufferedEnd,
  };
  private listeners = new Map<string, Set<AudioListener>>();

  addEventListener(type: string, listener: AudioListener) {
    const listeners = this.listeners.get(type) ?? new Set<AudioListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  load() {}

  pause() {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) this.emit("pause");
  }

  play() {
    this.paused = false;
    this.ended = false;
    this.emit("play");
    this.emit("playing");
    return Promise.resolve();
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const firstTrack: PlaybackTrack = {
  ratingKey: "track-1",
  title: "First song",
  duration: 12_000,
};
const secondTrack: PlaybackTrack = {
  ratingKey: "track-2",
  title: "Second song",
  duration: 20_000,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (cause: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function makePlayer(audio: FakeAudio, urls: string[], scrobbled: string[]) {
  return createPlayerState({
    audio: audio as unknown as HTMLAudioElement,
    streamUrl: async (ratingKey) => {
      urls.push(ratingKey);
      return `https://plex.test/${ratingKey}.mp3`;
    },
    scrobble: async (key) => {
      scrobbled.push(key);
    },
  });
}

test("loads an album queue and advances when a track ends", async () => {
  const audio = new FakeAudio();
  const urls: string[] = [];
  const scrobbled: string[] = [];
  const player = makePlayer(audio, urls, scrobbled);

  await player.playQueue([firstTrack, secondTrack]);
  expect(player.getSnapshot()).toMatchObject({
    currentIndex: 0,
    currentTrack: firstTrack,
    status: "playing",
  });
  expect(urls).toEqual(["track-1"]);

  audio.currentTime = 6;
  audio.emit("timeupdate");
  audio.emit("timeupdate");
  expect(scrobbled).toEqual(["track-1"]);

  audio.ended = true;
  audio.emit("ended");
  await Promise.resolve();
  expect(player.getSnapshot()).toMatchObject({
    currentIndex: 1,
    currentTrack: secondTrack,
    status: "playing",
  });
  expect(urls).toEqual(["track-1", "track-2"]);
});

test("retries a rejected scrobble after queue advancement", async () => {
  const audio = new FakeAudio();
  const requests: Array<{ key: string; deferred: Deferred<void> }> = [];
  const player = createPlayerState({
    audio: audio as unknown as HTMLAudioElement,
    streamUrl: async (ratingKey) => `https://plex.test/${ratingKey}.mp3`,
    scrobble: (key) => {
      const request = deferred<void>();
      requests.push({ key, deferred: request });
      return request.promise;
    },
  });

  await player.playQueue([firstTrack, secondTrack]);
  audio.currentTime = 6;
  audio.emit("timeupdate");
  expect(requests.map(({ key }) => key)).toEqual(["track-1"]);

  audio.ended = true;
  audio.emit("ended");
  await Promise.resolve();
  expect(player.getSnapshot().currentIndex).toBe(1);

  requests[0]!.deferred.reject(new Error("temporary scrobble failure"));
  await Promise.resolve();

  await player.playPrevious();
  audio.currentTime = 6;
  audio.emit("timeupdate");
  audio.emit("timeupdate");
  expect(requests.map(({ key }) => key)).toEqual(["track-1", "track-1"]);

  requests[1]!.deferred.resolve();
  await Promise.resolve();
  audio.emit("timeupdate");
  expect(requests.map(({ key }) => key)).toEqual(["track-1", "track-1"]);
});

test("retries resolving a failed stream when Play is pressed", async () => {
  const audio = new FakeAudio();
  let resolveCalls = 0;
  const player = createPlayerState({
    audio: audio as unknown as HTMLAudioElement,
    streamUrl: async (ratingKey) => {
      resolveCalls += 1;
      return resolveCalls === 1 ? null : `https://plex.test/${ratingKey}.mp3`;
    },
    scrobble: async () => undefined,
  });

  await player.playTrack(firstTrack);
  expect(resolveCalls).toBe(1);
  expect(player.getSnapshot()).toMatchObject({
    status: "paused",
    error: "Plex could not find an audio file for this track.",
  });

  await player.togglePlay();
  expect(resolveCalls).toBe(2);
  expect(player.getSnapshot().status).toBe("playing");
});

test("reports resume buffering metrics", async () => {
  const audio = new FakeAudio();
  const metrics: Array<{
    event: string;
    elapsedMs?: number;
    bufferedAhead?: number;
  }> = [];
  let now = 100;
  const player = createPlayerState({
    audio: audio as unknown as HTMLAudioElement,
    streamUrl: async (ratingKey) => `https://plex.test/${ratingKey}.mp3`,
    scrobble: async () => undefined,
    now: () => now,
    onPlaybackMetric: (metric) => metrics.push(metric),
  });

  await player.playTrack(firstTrack);
  await player.togglePlay();
  now += 42;
  await player.togglePlay();

  expect(metrics.map(({ event }) => event)).toEqual(["playing", "resume-request", "playing"]);
  expect(metrics[1]?.bufferedAhead).toBe(12);
  expect(metrics[2]?.elapsedMs).toBe(0);
});

test("toggles playback, seeks, and changes volume", async () => {
  const audio = new FakeAudio();
  const player = makePlayer(audio, [], []);

  await player.playTrack(firstTrack);
  audio.currentTime = 2.25;
  await player.togglePlay();
  expect(player.getSnapshot()).toMatchObject({
    status: "paused",
    currentTime: 2.25,
  });
  await player.togglePlay();
  expect(player.getSnapshot().status).toBe("playing");

  player.seek(4);
  player.setVolume(0.35);
  expect(player.getSnapshot()).toMatchObject({ currentTime: 4, volume: 0.35 });
  expect(audio.currentTime).toBe(4);
  expect(audio.volume).toBe(0.35);
});
