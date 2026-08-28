import { expect, test } from "bun:test";

import { createPlayerState } from "../src/mainview/player/state.ts";
import type { PlaybackTrack } from "../src/mainview/player/state.ts";

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
    end: () => this.bufferedEnd,
    length: 1,
    start: () => 0,
  };
  private readonly listeners = new Map<string, Set<AudioListener>>();

  addEventListener(type: string, listener: AudioListener) {
    const listeners = this.listeners.get(type) ?? new Set<AudioListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  load(): void {
    const { src } = this;
    if (src.length === 0) {
      this.src = src;
    }
  }

  pause() {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) {
      this.emit("pause");
    }
  }

  async play(): Promise<void> {
    this.paused = false;
    this.ended = false;
    this.emit("play");
    this.emit("playing");
    await Promise.resolve();
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

const firstTrack: PlaybackTrack = {
  duration: 12_000,
  ratingKey: "track-1",
  title: "First song",
};
const secondTrack: PlaybackTrack = {
  duration: 20_000,
  ratingKey: "track-2",
  title: "Second song",
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (cause: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  const { promise, reject, resolve } = Promise.withResolvers<T>();
  return { promise, reject, resolve };
};

type PlayerOptionsWithoutAudio = Omit<
  Parameters<typeof createPlayerState>[0],
  "audio"
>;

const createPlayerWithFakeAudio = (
  audio: FakeAudio,
  options: PlayerOptionsWithoutAudio
): ReturnType<typeof createPlayerState> => {
  const originalAudioDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Audio"
  );
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    value: function value(): FakeAudio {
      return audio;
    },
  });
  try {
    return createPlayerState(options);
  } finally {
    if (originalAudioDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "Audio");
    } else {
      Object.defineProperty(globalThis, "Audio", originalAudioDescriptor);
    }
  }
};

const makePlayer = (audio: FakeAudio, urls: string[], scrobbled: string[]) =>
  createPlayerWithFakeAudio(audio, {
    scrobble: async (key) => {
      scrobbled.push(key);
      await Promise.resolve();
    },
    streamUrl: async (ratingKey) => {
      urls.push(ratingKey);
      return await Promise.resolve(`https://plex.test/${ratingKey}.mp3`);
    },
  });

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
  const requests: { key: string; deferred: Deferred<null> }[] = [];
  const player = createPlayerWithFakeAudio(audio, {
    scrobble: async (key) => {
      const request = deferred<null>();
      requests.push({ deferred: request, key });
      await request.promise;
    },
    streamUrl: async (ratingKey) => {
      await Promise.resolve();
      return `https://plex.test/${ratingKey}.mp3`;
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

  requests[0].deferred.reject(new Error("temporary scrobble failure"));
  await Promise.resolve();

  await player.playPrevious();
  audio.currentTime = 6;
  audio.emit("timeupdate");
  audio.emit("timeupdate");
  expect(requests.map(({ key }) => key)).toEqual(["track-1", "track-1"]);

  requests[1].deferred.resolve(null);
  await Promise.resolve();
  audio.emit("timeupdate");
  expect(requests.map(({ key }) => key)).toEqual(["track-1", "track-1"]);
});

test("retries resolving a failed stream when Play is pressed", async () => {
  const audio = new FakeAudio();
  let resolveCalls = 0;
  const player = createPlayerWithFakeAudio(audio, {
    scrobble: async () => {
      await Promise.resolve();
    },
    streamUrl: async (ratingKey) => {
      resolveCalls += 1;
      await Promise.resolve();
      return resolveCalls === 1 ? null : `https://plex.test/${ratingKey}.mp3`;
    },
  });

  await player.playTrack(firstTrack);
  expect(resolveCalls).toBe(1);
  expect(player.getSnapshot()).toMatchObject({
    error: "Plex could not find an audio file for this track.",
    status: "paused",
  });

  await player.togglePlay();
  expect(resolveCalls).toBe(2);
  expect(player.getSnapshot().status).toBe("playing");
});

test("reports resume buffering metrics", async () => {
  const audio = new FakeAudio();
  const metrics: {
    event: string;
    elapsedMs?: number;
    bufferedAhead?: number;
  }[] = [];
  let now = 100;
  const player = createPlayerWithFakeAudio(audio, {
    now: () => now,
    onPlaybackMetric: (metric) => {
      metrics.push(metric);
    },
    scrobble: async () => {
      await Promise.resolve();
    },
    streamUrl: async (ratingKey) => {
      await Promise.resolve();
      return `https://plex.test/${ratingKey}.mp3`;
    },
  });

  await player.playTrack(firstTrack);
  await player.togglePlay();
  now += 42;
  await player.togglePlay();

  expect(metrics.map(({ event }) => event)).toEqual([
    "playing",
    "resume-request",
    "playing",
  ]);
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
    currentTime: 2.25,
    status: "paused",
  });
  await player.togglePlay();
  expect(player.getSnapshot().status).toBe("playing");

  player.seek(4);
  player.setVolume(0.35);
  expect(player.getSnapshot()).toMatchObject({ currentTime: 4, volume: 0.35 });
  expect(audio.currentTime).toBe(4);
  expect(audio.volume).toBe(0.35);
});
