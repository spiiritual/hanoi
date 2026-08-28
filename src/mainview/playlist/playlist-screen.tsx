import { useEffect, useReducer, useState, useSyncExternalStore } from "react";

import type { PlexPlaylist, PlexTrack } from "../../bun/plex/types.ts";
import type { ShellView } from "../app-state.ts";
import { ArtworkImage } from "../artwork/artwork-image.tsx";
import { Icon } from "../components/icon.tsx";
import { MediaCard } from "../home/home-content.tsx";
import { plex } from "../plex.ts";
import { playerState } from "../view-state.ts";

const formatTrackDuration = (duration?: number): string => {
  if (duration === undefined || duration === null || duration <= 0) {
    return "--:--";
  }
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatPlaylistDuration = (duration: number): string => {
  const totalSeconds = Math.max(0, Math.floor(duration / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} hr`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} min`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} sec`);
  }
  return parts.join(" ");
};

const trackSubtitle = (track: PlexTrack): string =>
  [track.grandparentTitle, track.parentTitle].filter(Boolean).join(" · ") ||
  "Unknown artist";

const playlistMeta = (playlist: PlexPlaylist): string => {
  const type =
    playlist.playlistType === "audio" ? "Playlist" : playlist.playlistType;
  let songs: string | undefined;
  if (playlist.leafCount !== undefined) {
    const suffix = playlist.leafCount === 1 ? "" : "s";
    songs = `${playlist.leafCount} song${suffix}`;
  }
  return [type, songs].filter(Boolean).join(" · ") || "Playlist";
};

const secureRandomIndex = (max: number): number => {
  const values = new Uint32Array(1);
  globalThis.crypto?.getRandomValues(values);
  return (values[0] ?? 0) % max;
};

const libraryTabs: [ShellView, string][] = [
  ["albums", "Albums"],
  ["artists", "Artists"],
  ["songs", "Songs"],
  ["playlists", "Playlists"],
];

const PlaylistArtwork = ({
  playlist,
  className,
}: {
  playlist: PlexPlaylist;
  className: string;
}) => (
  <div className={className}>
    <ArtworkImage
      source={
        playlist.composite !== undefined && playlist.composite !== ""
          ? { kind: "server", path: playlist.composite }
          : null
      }
      priority
      alt={`${playlist.title} cover`}
      fallback={playlist.title.charAt(0).toUpperCase() || "♪"}
    />
  </div>
);

export const PlaylistLibrary = ({
  serverKey,
  onPlaylist,
  onView,
}: {
  serverKey: string | null;
  onPlaylist: (playlist: PlexPlaylist) => void;
  onView: (view: ShellView) => void;
}) => {
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>([]);
  const [status, setStatus] = useState("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const requestKey = `${serverKey ?? "none"}:${reload}`;
  const [loadedRequestKey, setLoadedRequestKey] = useState<string | null>(null);
  const requestReady = loadedRequestKey === requestKey;
  const hasServer = serverKey !== null && serverKey !== "";
  let visibleStatus = status;
  if (!hasServer) {
    visibleStatus = "idle";
  } else if (!requestReady) {
    visibleStatus = "loading";
  }
  const visiblePlaylists = requestReady ? playlists : [];
  const visibleError = requestReady ? loadError : null;

  useEffect(() => {
    let active = true;
    if (!hasServer) {
      return () => {
        active = false;
      };
    }
    const loadPlaylists = async (): Promise<void> => {
      try {
        const result = await plex.getPlaylists();
        if (!active) {
          return;
        }
        const unique = new Map<string, PlexPlaylist>();
        for (const playlist of result) {
          if (playlist.playlistType !== "video") {
            unique.set(playlist.ratingKey, playlist);
          }
        }
        setPlaylists([...unique.values()]);
        setLoadError(null);
        setStatus("ready");
        setLoadedRequestKey(requestKey);
      } catch (caughtError: unknown) {
        if (!active) {
          return;
        }
        setLoadError(
          caughtError instanceof Error
            ? caughtError.message
            : "Failed to load playlists"
        );
        setStatus("error");
        setLoadedRequestKey(requestKey);
      }
    };
    void loadPlaylists();
    return () => {
      active = false;
    };
  }, [hasServer, requestKey]);

  let message: string | null = null;
  if (visibleStatus === "idle") {
    message = "Select a Plex server to view playlists.";
  } else if (visibleStatus === "loading") {
    message = "Loading playlists…";
  } else if (visibleStatus === "error") {
    const errorSuffix =
      visibleError === null || visibleError === "" ? "." : `: ${visibleError}`;
    message = `Couldn’t load your playlists${errorSuffix}`;
  } else if (visiblePlaylists.length === 0) {
    message = "No playlists found in this library.";
  }

  return (
    <div className="playlist-library" id="playlist-library">
      <nav className="playlist-filter-tabs" aria-label="Library views">
        {libraryTabs.map(([view, label]) => (
          <button
            className={`playlist-filter-tab${view === "playlists" ? " is-active" : ""}`}
            type="button"
            key={view}
            onClick={() => {
              onView(view);
            }}
            aria-current={view === "playlists" ? "page" : undefined}
          >
            {label}
          </button>
        ))}
        <div className="playlist-filter-spacer" />
        <Icon className="playlist-sort-icon">
          <path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4m0 16 3-3m-3 3-3-3" />
        </Icon>
        <span className="playlist-sort-label">Recently added</span>
      </nav>
      <section className="playlist-library-section">
        <h1 className="playlist-library-title">Your Playlists</h1>
        {message !== null && message !== "" && (
          <div
            className={`playlist-library-status${visibleStatus === "error" ? " is-error" : ""}`}
            aria-live="polite"
          >
            <span>{message}</span>
            {visibleStatus === "error" && (
              <button
                className="playlist-library-retry"
                type="button"
                onClick={() => {
                  setReload((value) => value + 1);
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}
        <ul className="playlist-grid" id="playlist-grid">
          {visibleStatus === "ready" &&
            visiblePlaylists.map((playlist) => (
              <MediaCard
                item={playlist}
                category
                meta={playlistMeta(playlist)}
                onPlaylist={() => {
                  onPlaylist(playlist);
                }}
                key={playlist.ratingKey}
              />
            ))}
        </ul>
      </section>
    </div>
  );
};

interface PlaylistLoadState {
  playlist: PlexPlaylist | null;
  tracks: PlexTrack[];
  status: "loading" | "ready" | "error";
  loadError: string | null;
  loadedRequestKey: string | null;
}

type PlaylistLoadAction =
  | {
      type: "loaded";
      playlist: PlexPlaylist;
      tracks: PlexTrack[];
      requestKey: string;
    }
  | { type: "failed"; error: string; requestKey: string };

const playlistLoadReducer = (
  state: PlaylistLoadState,
  action: PlaylistLoadAction
): PlaylistLoadState => {
  if (action.type === "loaded") {
    return {
      loadError: null,
      loadedRequestKey: action.requestKey,
      playlist: action.playlist,
      status: "ready",
      tracks: action.tracks,
    };
  }
  return {
    ...state,
    loadError: action.error,
    loadedRequestKey: action.requestKey,
    status: "error",
  };
};

const initialPlaylistLoadState: PlaylistLoadState = {
  loadError: null,
  loadedRequestKey: null,
  playlist: null,
  status: "loading",
  tracks: [],
};

const usePlaylistLoad = (ratingKey: string) => {
  const [loadState, dispatchLoad] = useReducer(
    playlistLoadReducer,
    initialPlaylistLoadState
  );
  const [reload, setReload] = useState(0);
  const requestKey = `${ratingKey}:${reload}`;
  const requestReady = loadState.loadedRequestKey === requestKey;

  useEffect(() => {
    let active = true;
    const loadPlaylist = async (): Promise<void> => {
      try {
        const result = await plex.getPlaylist(ratingKey);
        if (!active) {
          return;
        }
        dispatchLoad({
          playlist: result.playlist,
          requestKey,
          tracks: result.tracks,
          type: "loaded",
        });
      } catch (caughtError: unknown) {
        if (!active) {
          return;
        }
        dispatchLoad({
          error:
            caughtError instanceof Error
              ? caughtError.message
              : "Failed to load playlist",
          requestKey,
          type: "failed",
        });
      }
    };
    void loadPlaylist();
    return () => {
      active = false;
    };
  }, [ratingKey, requestKey]);

  const retry = (): void => {
    setReload((value) => value + 1);
  };

  return {
    loadError: requestReady ? loadState.loadError : null,
    playlist: requestReady ? loadState.playlist : null,
    retry,
    status: requestReady ? loadState.status : "loading",
    tracks: requestReady ? loadState.tracks : [],
  };
};

export const PlaylistDetail = ({ ratingKey }: { ratingKey: string }) => {
  const {
    loadError,
    playlist: visiblePlaylist,
    retry,
    status: visibleStatus,
    tracks: visibleTracks,
  } = usePlaylistLoad(ratingKey);
  const [liked, setLiked] = useState(false);
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot
  );

  if (visibleStatus === "loading") {
    return (
      <div className="playlist-detail" id="playlist-detail">
        <div className="album-detail-status" aria-live="polite">
          Loading playlist…
        </div>
      </div>
    );
  }
  if (visibleStatus === "error" || visiblePlaylist === null) {
    const errorSuffix =
      loadError === null || loadError === "" ? "." : `: ${loadError}`;
    return (
      <div className="playlist-detail" id="playlist-detail">
        <div className="album-detail-error" role="alert">
          <span>{`Couldn’t load this playlist${errorSuffix}`}</span>
          <button
            className="album-detail-retry"
            type="button"
            onClick={() => {
              retry();
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const currentPlaylist = visiblePlaylist;
  const trackCount = currentPlaylist.leafCount ?? visibleTracks.length;
  const totalDuration =
    currentPlaylist.duration ??
    visibleTracks.reduce((total, track) => total + (track.duration ?? 0), 0);
  const playlistYear =
    currentPlaylist.year === undefined || currentPlaylist.year === null
      ? undefined
      : String(currentPlaylist.year);
  const playlistIsActive = visibleTracks.some(
    (track) => track.ratingKey === player.currentTrack?.ratingKey
  );
  const playlistIsPlaying = playlistIsActive && player.status === "playing";
  const playPlaylist = () => {
    if (playlistIsActive) {
      void playerState.togglePlay();
      return;
    }
    void playerState.playQueue(visibleTracks, 0);
  };
  const shufflePlaylist = () => {
    const shuffled = [...visibleTracks];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const randomIndex = secureRandomIndex(index + 1);
      [shuffled[index], shuffled[randomIndex]] = [
        shuffled[randomIndex],
        shuffled[index],
      ];
    }
    void playerState.playQueue(shuffled, 0);
  };
  const playTrack = (track: PlexTrack, index: number) => {
    if (player.currentTrack?.ratingKey === track.ratingKey) {
      void playerState.togglePlay();
    } else {
      void playerState.playQueue(visibleTracks, index);
    }
  };

  return (
    <div className="album-detail playlist-detail" id="playlist-detail">
      <header className="album-detail-header">
        <PlaylistArtwork
          playlist={currentPlaylist}
          className="playlist-detail-art"
        />
        <div className="album-detail-info">
          <h1 className="album-detail-title">
            {currentPlaylist.title || "Untitled playlist"}
          </h1>
          <p className="album-detail-artist">Playlist by You</p>
          <p className="album-detail-meta">
            {[
              "Playlist",
              playlistYear,
              `${trackCount} song${trackCount === 1 ? "" : "s"}, ${formatPlaylistDuration(totalDuration)}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="album-detail-actions">
            <button
              className="album-detail-play"
              type="button"
              disabled={visibleTracks.length === 0}
              onClick={playPlaylist}
            >
              <Icon>
                {playlistIsPlaying ? (
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                ) : (
                  <path d="m8 5 11 7-11 7z" />
                )}
              </Icon>
              <span>{playlistIsPlaying ? "Playing" : "Play"}</span>
            </button>
            <button
              className="album-detail-icon-action"
              type="button"
              aria-label="Shuffle playlist"
              disabled={visibleTracks.length === 0}
              onClick={shufflePlaylist}
            >
              <Icon>
                <path d="M3 7h3c4 0 5 10 9 10h6M17 4l4 3-4 3M3 17h3c1.5 0 2.5-1 3.5-2.5M17 14l4 3-4 3" />
              </Icon>
            </button>
            <button
              className={`album-detail-icon-action${liked ? " is-liked" : ""}`}
              type="button"
              aria-label={liked ? "Unlike playlist" : "Like playlist"}
              aria-pressed={liked}
              onClick={() => {
                setLiked((value) => !value);
              }}
            >
              <Icon>
                <path d="M20.8 8.7c0 5.5-8.8 10.3-8.8 10.3S3.2 14.2 3.2 8.7A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z" />
              </Icon>
            </button>
            <button
              className="album-detail-icon-action"
              type="button"
              aria-label="More playlist actions"
            >
              <Icon>
                <circle cx="5" cy="12" r="1" />
                <circle cx="12" cy="12" r="1" />
                <circle cx="19" cy="12" r="1" />
              </Icon>
            </button>
          </div>
        </div>
      </header>
      <section className="album-track-list" aria-label="Playlist tracks">
        <div className="album-track-list-header">
          <span>#</span>
          <span>Title</span>
          <span>Duration</span>
        </div>
        <div className="album-track-divider" />
        {visibleTracks.length === 0 ? (
          <p className="album-track-empty">This playlist has no tracks.</p>
        ) : (
          <ul className="album-track-rows">
            {visibleTracks.map((track, index) => {
              const isCurrentTrack =
                player.currentTrack?.ratingKey === track.ratingKey;
              const isTrackPlaying =
                isCurrentTrack && player.status === "playing";
              return (
                <li key={track.ratingKey}>
                  <button
                    className={`album-track-row${isCurrentTrack ? " is-playing" : ""}`}
                    type="button"
                    aria-current={isCurrentTrack ? "true" : undefined}
                    aria-label={`${isTrackPlaying ? "Pause" : "Play"} ${track.title}`}
                    onClick={() => {
                      playTrack(track, index);
                    }}
                  >
                    <span className="album-track-number">
                      <span className="album-track-index">
                        {track.index ?? index + 1}
                      </span>
                      <span className="album-track-play" aria-hidden="true">
                        {isTrackPlaying ? (
                          <span className="album-track-spectrum">
                            <span />
                            <span />
                            <span />
                          </span>
                        ) : (
                          <Icon>
                            <path d="m8 5 11 7-11 7z" />
                          </Icon>
                        )}
                      </span>
                    </span>
                    <div className="album-track-copy">
                      <span className="album-track-title">{track.title}</span>
                      <span className="album-track-artist">
                        {trackSubtitle(track)}
                      </span>
                    </div>
                    <span className="album-track-duration">
                      {formatTrackDuration(track.duration)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};
