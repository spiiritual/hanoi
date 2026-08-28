import type { PlexTrack } from "../../bun/plex/types.ts";

/** The metadata the player needs, without requiring a second library request. */
export type PlaybackTrack = Pick<PlexTrack, "ratingKey" | "title"> &
  Partial<
    Pick<
      PlexTrack,
      "parentTitle" | "grandparentTitle" | "duration" | "thumb" | "index"
    >
  >;

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface PlayerStateSnapshot {
  queue: PlaybackTrack[];
  currentIndex: number;
  currentTrack: PlaybackTrack | null;
  status: PlayerStatus;
  currentTime: number;
  duration: number;
  volume: number;
  error: string | null;
}

export interface PlayerState {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PlayerStateSnapshot;
  playTrack: (track: PlaybackTrack) => Promise<void>;
  playQueue: (tracks: PlaybackTrack[], index?: number) => Promise<void>;
  togglePlay: () => Promise<void>;
  playNext: () => Promise<void>;
  playPrevious: () => Promise<void>;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
}

interface PlaybackMetric {
  event: "resume-request" | "waiting" | "playing";
  ratingKey: string;
  elapsedMs?: number;
  readyState?: number;
  networkState?: number;
  bufferedAhead?: number;
}

export interface PlayerOptions {
  audio?: HTMLAudioElement | null;
  streamUrl: (ratingKey: string) => Promise<string | null>;
  scrobble: (key: string) => Promise<void>;
  onPlaybackMetric?: (metric: PlaybackMetric) => void;
  now?: () => number;
}

const initialSnapshot: PlayerStateSnapshot = {
  currentIndex: -1,
  currentTime: 0,
  currentTrack: null,
  duration: 0,
  error: null,
  queue: [],
  status: "idle",
  volume: 1,
};

const createAudio = (): HTMLAudioElement | null => {
  const AudioConstructor = globalThis.Audio;
  if (AudioConstructor === undefined) {
    return null;
  }
  const audio = new AudioConstructor();
  audio.preload = "auto";
  return audio;
};

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

interface SourceToken {
  generation: number;
  index: number;
}

interface SourceListener {
  type: string;
  listener: EventListener;
}

interface ScrobbleAttempt {
  status: "pending" | "succeeded";
}

/**
 * Small external store around one HTML audio element. Keeping the element here
 * means the player survives album navigation while every player control can
 * subscribe to the same source of truth.
 */
export const createPlayerState = (options: PlayerOptions): PlayerState => {
  const audio = options.audio === undefined ? createAudio() : options.audio;
  const resolveStreamUrl = options.streamUrl;
  const { scrobble } = options;
  const reportPlaybackMetric = options.onPlaybackMetric;
  const readNow =
    options.now ?? (() => globalThis.performance?.now() ?? Date.now());
  let snapshot = { ...initialSnapshot };
  const listeners = new Set<() => void>();
  let loadGeneration = 0;
  let activeSource: SourceToken | null = null;
  let sourceListeners: SourceListener[] = [];
  let sourceFailed = false;
  const scrobbleAttempts = new Map<string, ScrobbleAttempt>();
  let resumeStartedAt: number | null = null;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setSnapshot = (patch: Partial<PlayerStateSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    notify();
  };

  const currentTrackKey = () => snapshot.currentTrack?.ratingKey ?? null;

  const bufferedAhead = () => {
    const ranges = audio?.buffered;
    if (!ranges || ranges.length === 0) {
      return 0;
    }
    const currentTime = audio?.currentTime ?? snapshot.currentTime;
    for (let index = 0; index < ranges.length; index += 1) {
      const end = ranges.end(index);
      if (currentTime <= end) {
        return Math.max(0, end - currentTime);
      }
    }
    return 0;
  };

  const emitPlaybackMetric = (
    event: PlaybackMetric["event"],
    elapsedMs?: number
  ) => {
    const ratingKey = currentTrackKey();
    if (
      ratingKey === null ||
      ratingKey === "" ||
      reportPlaybackMetric === undefined
    ) {
      return;
    }
    reportPlaybackMetric({
      bufferedAhead: bufferedAhead(),
      elapsedMs,
      event,
      networkState: audio?.networkState,
      ratingKey,
      readyState: audio?.readyState,
    });
  };

  const markScrobbled = () => {
    const track = snapshot.currentTrack;
    const key = currentTrackKey();
    if (track === null || key === null || key === "") {
      return;
    }
    const previousAttempt = scrobbleAttempts.get(key);
    if (
      previousAttempt?.status === "pending" ||
      previousAttempt?.status === "succeeded"
    ) {
      return;
    }

    const attempt: ScrobbleAttempt = { status: "pending" };
    scrobbleAttempts.set(key, attempt);
    let request: Promise<void>;
    try {
      request = scrobble(track.ratingKey);
    } catch {
      if (scrobbleAttempts.get(key) === attempt) {
        scrobbleAttempts.delete(key);
      }
      return;
    }
    const settleScrobble = async (): Promise<void> => {
      try {
        await request;
        if (scrobbleAttempts.get(key) === attempt) {
          attempt.status = "succeeded";
        }
      } catch {
        // Keep the failed track eligible for a later event. The identity
        // check prevents a late rejection from deleting a newer retry.
        if (scrobbleAttempts.get(key) === attempt) {
          scrobbleAttempts.delete(key);
        }
      }
    };
    void settleScrobble();
  };

  const maybeScrobble = () => {
    const duration =
      snapshot.duration || (snapshot.currentTrack?.duration ?? 0) / 1000;
    if (duration <= 0) {
      return;
    }
    // Plex clients count a listen after half the track, capped at 30 seconds.
    if (snapshot.currentTime >= Math.min(30, duration / 2)) {
      markScrobbled();
    }
  };

  const removeSourceListeners = () => {
    if (audio) {
      for (const { type, listener } of sourceListeners) {
        audio.removeEventListener?.(type, listener);
      }
    }
    sourceListeners = [];
  };

  const isActiveSource = (source: SourceToken) =>
    activeSource === source && source.generation === loadGeneration;

  const addSourceListener = (
    source: SourceToken,
    type: string,
    handler: () => void
  ) => {
    if (!audio) {
      return;
    }
    const listener: EventListener = () => {
      if (isActiveSource(source)) {
        handler();
      }
    };
    audio.addEventListener(type, listener);
    sourceListeners.push({ listener, type });
  };

  const installSourceListeners = (
    source: SourceToken,
    track: PlaybackTrack
  ) => {
    addSourceListener(source, "loadedmetadata", () => {
      const mediaDuration = audio?.duration;
      const duration =
        mediaDuration !== undefined && Number.isFinite(mediaDuration)
          ? mediaDuration
          : (track.duration ?? 0) / 1000;
      if (duration > 0) {
        setSnapshot({ duration });
      }
    });
    addSourceListener(source, "timeupdate", () => {
      setSnapshot({ currentTime: audio?.currentTime ?? 0 });
      maybeScrobble();
    });
    addSourceListener(source, "play", () => {
      setSnapshot({ error: null, status: "playing" });
    });
    addSourceListener(source, "playing", () => {
      const elapsedMs =
        resumeStartedAt === null ? undefined : readNow() - resumeStartedAt;
      resumeStartedAt = null;
      emitPlaybackMetric("playing", elapsedMs);
    });
    addSourceListener(source, "waiting", () => {
      emitPlaybackMetric("waiting");
    });
    addSourceListener(source, "pause", () => {
      if (snapshot.status === "playing") {
        setSnapshot({ status: "paused" });
      }
    });
    addSourceListener(source, "ended", () => {
      markScrobbled();
      const nextIndex = source.index + 1;
      if (nextIndex < snapshot.queue.length) {
        // oxlint-disable-next-line eslint/no-use-before-define -- audio events fire after initialization
        void loadTrack(nextIndex);
      } else {
        setSnapshot({
          currentTime: snapshot.duration,
          status: "paused",
        });
      }
    });
    addSourceListener(source, "error", () => {
      sourceFailed = true;
      setSnapshot({
        error: "Plex could not play this audio file.",
        status: "error",
      });
    });
  };

  const loadTrack = async (index: number): Promise<void> => {
    const track = snapshot.queue[index];
    if (track === undefined) {
      return;
    }
    loadGeneration += 1;
    const generation = loadGeneration;
    activeSource = null;
    sourceFailed = false;
    resumeStartedAt = null;
    removeSourceListeners();
    setSnapshot({
      currentIndex: index,
      currentTime: 0,
      currentTrack: track,
      duration: (track.duration ?? 0) / 1000,
      error: null,
      status: "loading",
    });
    if (audio === null) {
      setSnapshot({
        error: "Audio playback is unavailable in this window.",
        status: "error",
      });
      return;
    }

    audio.pause();
    audio.src = "";
    audio.load();

    try {
      const url = await resolveStreamUrl(track.ratingKey);
      if (generation !== loadGeneration) {
        return;
      }
      if (url === null || url === "") {
        throw new Error("Plex could not find an audio file for this track.");
      }
      const source: SourceToken = { generation, index };
      activeSource = source;
      installSourceListeners(source, track);
      audio.src = url;
      audio.currentTime = 0;
      audio.load();
      await audio.play();
      if (generation === loadGeneration && isActiveSource(source)) {
        setSnapshot({ status: "playing" });
      }
    } catch (error) {
      if (generation !== loadGeneration) {
        return;
      }
      resumeStartedAt = null;
      const playbackBlocked =
        error instanceof Error && error.name === "NotAllowedError";
      if (!playbackBlocked) {
        sourceFailed = true;
      }
      const playbackError = playbackBlocked
        ? "Playback was blocked. Press play to try again."
        : errorMessage(error, "Unable to play this track.");
      setSnapshot({ error: playbackError, status: "paused" });
    }
  };

  if (audio) {
    audio.volume = initialSnapshot.volume;
  }

  const playQueue = async (
    tracks: PlaybackTrack[],
    index = 0
  ): Promise<void> => {
    if (tracks.length === 0) {
      return;
    }
    snapshot = {
      ...snapshot,
      currentIndex: -1,
      currentTime: 0,
      currentTrack: null,
      duration: 0,
      error: null,
      queue: [...tracks],
      status: "idle",
    };
    notify();
    await loadTrack(Math.max(0, Math.min(index, tracks.length - 1)));
  };

  return {
    getSnapshot() {
      return snapshot;
    },
    async playNext(): Promise<void> {
      const nextIndex = snapshot.currentIndex + 1;
      if (nextIndex < snapshot.queue.length) {
        await loadTrack(nextIndex);
      }
    },
    async playPrevious(): Promise<void> {
      if (snapshot.currentTrack === null) {
        return;
      }
      if (snapshot.currentTime > 3) {
        if (audio !== null) {
          audio.currentTime = 0;
        }
        setSnapshot({ currentTime: 0 });
        return;
      }
      const previousIndex = snapshot.currentIndex - 1;
      await loadTrack(
        previousIndex >= 0 ? previousIndex : snapshot.currentIndex
      );
    },
    async playQueue(tracks: PlaybackTrack[], index = 0): Promise<void> {
      await playQueue(tracks, index);
    },
    async playTrack(track): Promise<void> {
      await playQueue([track], 0);
    },
    seek(time) {
      if (!audio || !Number.isFinite(time)) {
        return;
      }
      const nextTime = Math.max(0, Math.min(time, snapshot.duration || time));
      audio.currentTime = nextTime;
      setSnapshot({ currentTime: nextTime });
      maybeScrobble();
    },
    setVolume(volume) {
      const nextVolume = Math.max(0, Math.min(1, volume));
      if (audio) {
        audio.volume = nextVolume;
      }
      setSnapshot({ volume: nextVolume });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async togglePlay(): Promise<void> {
      if (snapshot.currentTrack === null || snapshot.status === "loading") {
        return;
      }
      if (audio === null) {
        await loadTrack(snapshot.currentIndex);
        return;
      }
      const sourceIsCurrent =
        activeSource?.generation === loadGeneration &&
        activeSource.index === snapshot.currentIndex;
      const sourceNeedsRetry =
        !sourceIsCurrent || sourceFailed || audio.src === "";
      if (sourceNeedsRetry) {
        await loadTrack(snapshot.currentIndex);
        return;
      }
      if (!audio.paused) {
        if (Number.isFinite(audio.currentTime)) {
          setSnapshot({ currentTime: audio.currentTime });
        }
        maybeScrobble();
        audio.pause();
        return;
      }
      if (audio.ended) {
        audio.currentTime = 0;
      }
      resumeStartedAt = readNow();
      emitPlaybackMetric("resume-request");
      try {
        await audio.play();
        setSnapshot({ error: null, status: "playing" });
      } catch (error) {
        resumeStartedAt = null;
        setSnapshot({
          error: errorMessage(error, "Unable to resume playback."),
          status: "paused",
        });
      }
    },
  };
};
