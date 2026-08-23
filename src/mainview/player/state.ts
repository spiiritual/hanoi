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

type PlaybackMetric = {
	event: "resume-request" | "waiting" | "playing";
	ratingKey: string;
	elapsedMs?: number;
	readyState?: number;
	networkState?: number;
	bufferedAhead?: number;
};

export type PlayerOptions = {
	audio?: HTMLAudioElement | null;
	streamUrl: (ratingKey: string) => Promise<string | null>;
	scrobble: (key: string) => Promise<void>;
	onPlaybackMetric?: (metric: PlaybackMetric) => void;
	now?: () => number;
};

const initialSnapshot: PlayerStateSnapshot = {
	queue: [],
	currentIndex: -1,
	currentTrack: null,
	status: "idle",
	currentTime: 0,
	duration: 0,
	volume: 1,
	error: null,
};

function createAudio(): HTMLAudioElement | null {
	const AudioConstructor = globalThis.Audio;
	if (AudioConstructor === undefined) return null;
	const audio = new AudioConstructor();
	audio.preload = "auto";
	return audio;
}

function errorMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback;
}

type SourceToken = {
	generation: number;
	index: number;
};

type SourceListener = {
	type: string;
	listener: EventListener;
};

type ScrobbleAttempt = {
	status: "pending" | "succeeded";
};

/**
 * Small external store around one HTML audio element. Keeping the element here
 * means the player survives album navigation while every player control can
 * subscribe to the same source of truth.
 */
export function createPlayerState(options: PlayerOptions): PlayerState {
	const audio = options.audio === undefined ? createAudio() : options.audio;
	const resolveStreamUrl = options.streamUrl;
	const scrobble = options.scrobble;
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
		for (const listener of listeners) listener();
	};

	const setSnapshot = (patch: Partial<PlayerStateSnapshot>) => {
		snapshot = { ...snapshot, ...patch };
		notify();
	};

	const currentTrackKey = () => snapshot.currentTrack?.ratingKey ?? null;

	const bufferedAhead = () => {
		const ranges = audio?.buffered;
		if (!ranges || ranges.length === 0) return undefined;
		const currentTime = audio?.currentTime ?? snapshot.currentTime;
		for (let index = 0; index < ranges.length; index += 1) {
			const end = ranges.end(index);
			if (currentTime <= end) return Math.max(0, end - currentTime);
		}
		return 0;
	};

	const emitPlaybackMetric = (
		event: PlaybackMetric["event"],
		elapsedMs?: number,
	) => {
		const ratingKey = currentTrackKey();
		if (!ratingKey || !reportPlaybackMetric) return;
		reportPlaybackMetric({
			event,
			ratingKey,
			elapsedMs,
			readyState: audio?.readyState,
			networkState: audio?.networkState,
			bufferedAhead: bufferedAhead(),
		});
	};

	const markScrobbled = () => {
		const track = snapshot.currentTrack;
		const key = currentTrackKey();
		if (!track || !key) return;
		const previousAttempt = scrobbleAttempts.get(key);
		if (
			previousAttempt?.status === "pending" ||
			previousAttempt?.status === "succeeded"
		)
			return;

		const attempt: ScrobbleAttempt = { status: "pending" };
		scrobbleAttempts.set(key, attempt);
		let request: Promise<void>;
		try {
			request = scrobble(track.ratingKey);
		} catch {
			if (scrobbleAttempts.get(key) === attempt) scrobbleAttempts.delete(key);
			return;
		}
		void request.then(
			() => {
				if (scrobbleAttempts.get(key) === attempt) attempt.status = "succeeded";
			},
			() => {
				// Keep the failed track eligible for a later event. The identity
				// check prevents a late rejection from deleting a newer retry.
				if (scrobbleAttempts.get(key) === attempt) scrobbleAttempts.delete(key);
			},
		);
	};

	const maybeScrobble = () => {
		const duration =
			snapshot.duration || (snapshot.currentTrack?.duration ?? 0) / 1000;
		if (duration <= 0) return;
		// Plex clients count a listen after half the track, capped at 30 seconds.
		if (snapshot.currentTime >= Math.min(30, duration / 2)) markScrobbled();
	};

	const removeSourceListeners = () => {
		if (audio) {
			for (const { type, listener } of sourceListeners)
				audio.removeEventListener?.(type, listener);
		}
		sourceListeners = [];
	};

	const isActiveSource = (source: SourceToken) =>
		activeSource === source && source.generation === loadGeneration;

	const addSourceListener = (
		source: SourceToken,
		type: string,
		handler: () => void,
	) => {
		if (!audio) return;
		const listener: EventListener = () => {
			if (isActiveSource(source)) handler();
		};
		audio.addEventListener(type, listener);
		sourceListeners.push({ type, listener });
	};

	const installSourceListeners = (source: SourceToken, track: PlaybackTrack) => {
		addSourceListener(source, "loadedmetadata", () => {
			const mediaDuration = audio?.duration;
			const duration =
				mediaDuration !== undefined && Number.isFinite(mediaDuration)
					? mediaDuration
					: (track.duration ?? 0) / 1000;
			if (duration > 0) setSnapshot({ duration });
		});
		addSourceListener(source, "timeupdate", () => {
			setSnapshot({ currentTime: audio?.currentTime ?? 0 });
			maybeScrobble();
		});
		addSourceListener(source, "play", () =>
			setSnapshot({ status: "playing", error: null }),
		);
		addSourceListener(source, "playing", () => {
			const elapsedMs =
				resumeStartedAt === null ? undefined : readNow() - resumeStartedAt;
			resumeStartedAt = null;
			emitPlaybackMetric("playing", elapsedMs);
		});
		addSourceListener(source, "waiting", () => emitPlaybackMetric("waiting"));
		addSourceListener(source, "pause", () => {
			if (snapshot.status === "playing") setSnapshot({ status: "paused" });
		});
		addSourceListener(source, "ended", () => {
			markScrobbled();
			const nextIndex = source.index + 1;
			if (nextIndex < snapshot.queue.length) {
				void loadTrack(nextIndex);
			} else {
				setSnapshot({
					status: "paused",
					currentTime: snapshot.duration,
				});
			}
		});
		addSourceListener(source, "error", () => {
			sourceFailed = true;
			setSnapshot({
				status: "error",
				error: "Plex could not play this audio file.",
			});
		});
	};

	const loadTrack = async (index: number): Promise<void> => {
		const track = snapshot.queue[index];
		if (!track) return;
		const generation = ++loadGeneration;
		activeSource = null;
		sourceFailed = false;
		resumeStartedAt = null;
		removeSourceListeners();
		setSnapshot({
			currentIndex: index,
			currentTrack: track,
			status: "loading",
			currentTime: 0,
			duration: (track.duration ?? 0) / 1000,
			error: null,
		});
		if (audio) {
			audio.pause();
			audio.src = "";
			audio.load();
		}

		if (!audio) {
			setSnapshot({
				status: "error",
				error: "Audio playback is unavailable in this window.",
			});
			return;
		}

		try {
			const url = await resolveStreamUrl(track.ratingKey);
			if (generation !== loadGeneration) return;
			if (!url)
				throw new Error("Plex could not find an audio file for this track.");
			const source: SourceToken = { generation, index };
			activeSource = source;
			installSourceListeners(source, track);
			audio.src = url;
			audio.currentTime = 0;
			audio.load();
			await audio.play();
			if (generation === loadGeneration && isActiveSource(source))
				setSnapshot({ status: "playing" });
		} catch (cause) {
			if (generation !== loadGeneration) return;
			resumeStartedAt = null;
			if (!(cause instanceof Error && cause.name === "NotAllowedError"))
				sourceFailed = true;
			setSnapshot({
				status: "paused",
				error:
					cause instanceof Error && cause.name === "NotAllowedError"
						? "Playback was blocked. Press play to try again."
						: errorMessage(cause, "Unable to play this track."),
			});
		}
	};

	if (audio) audio.volume = initialSnapshot.volume;

	const playQueue = (tracks: PlaybackTrack[], index = 0): Promise<void> => {
		if (tracks.length === 0) return Promise.resolve();
		snapshot = {
			...snapshot,
			queue: [...tracks],
			currentIndex: -1,
			currentTrack: null,
			status: "idle",
			currentTime: 0,
			duration: 0,
			error: null,
		};
		notify();
		return loadTrack(Math.max(0, Math.min(index, tracks.length - 1)));
	};

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot() {
			return snapshot;
		},
		playTrack(track) {
			return playQueue([track], 0);
		},
		playQueue,
		togglePlay() {
			if (!snapshot.currentTrack) return Promise.resolve();
			if (snapshot.status === "loading") return Promise.resolve();
			if (audio) {
				const sourceNeedsRetry =
					!activeSource ||
					activeSource.generation !== loadGeneration ||
					activeSource.index !== snapshot.currentIndex ||
					sourceFailed ||
					audio.src === "";
				if (sourceNeedsRetry) return loadTrack(snapshot.currentIndex);
				if (!audio.paused) {
					if (Number.isFinite(audio.currentTime))
						setSnapshot({ currentTime: audio.currentTime });
					maybeScrobble();
					audio.pause();
					return Promise.resolve();
				}
				if (audio.ended) audio.currentTime = 0;
				resumeStartedAt = readNow();
				emitPlaybackMetric("resume-request");
				return audio.play().then(
					() => setSnapshot({ status: "playing", error: null }),
					(cause) => {
						resumeStartedAt = null;
						setSnapshot({
							status: "paused",
							error: errorMessage(cause, "Unable to resume playback."),
						});
					},
				);
			}
			return loadTrack(snapshot.currentIndex);
		},
		playNext() {
			const nextIndex = snapshot.currentIndex + 1;
			return nextIndex < snapshot.queue.length
				? loadTrack(nextIndex)
				: Promise.resolve();
		},
		playPrevious() {
			if (!snapshot.currentTrack) return Promise.resolve();
			if (snapshot.currentTime > 3) {
				if (audio) audio.currentTime = 0;
				setSnapshot({ currentTime: 0 });
				return Promise.resolve();
			}
			const previousIndex = snapshot.currentIndex - 1;
			return previousIndex >= 0
				? loadTrack(previousIndex)
				: loadTrack(snapshot.currentIndex);
		},
		seek(time) {
			if (!audio || !Number.isFinite(time)) return;
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
	};
}
