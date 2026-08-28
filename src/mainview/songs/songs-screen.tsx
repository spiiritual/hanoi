import { useEffect, useState, useSyncExternalStore } from "react";

import type { PlexSection, PlexTrack } from "../../bun/plex/types.ts";
import type { MusicSectionsStatus, ShellView } from "../app-state.ts";
import { ArtworkImage } from "../artwork/artwork-image.tsx";
import { Icon } from "../components/icon.tsx";
import { plex } from "../plex.ts";
import { playerState } from "../view-state.ts";

const formatTrackDuration = (duration?: number): string => {
  if (duration === undefined || duration <= 0) {
    return "--:--";
  }
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const trackSubtitle = (track: PlexTrack): string =>
  [track.grandparentTitle, track.parentTitle].filter(Boolean).join(" · ") ||
  "Unknown artist";

const libraryTabs: [ShellView, string][] = [
  ["albums", "Albums"],
  ["artists", "Artists"],
  ["songs", "Songs"],
  ["playlists", "Playlists"],
];

const TrackArtwork = ({
  track,
  isCurrentTrack,
  isPlaying,
}: {
  track: PlexTrack;
  isCurrentTrack: boolean;
  isPlaying: boolean;
}) => (
  <div
    className={`songs-track-art${isCurrentTrack ? " is-playing" : ""}`}
    aria-hidden="true"
  >
    <ArtworkImage
      source={
        track.thumb === undefined || track.thumb === ""
          ? null
          : { kind: "server", path: track.thumb }
      }
      alt=""
      fallback={track.title.charAt(0).toUpperCase() || "♪"}
      fallbackClassName="songs-track-art-fallback"
    />
    {isCurrentTrack && (
      <span className="songs-playing-indicator">
        <Icon>
          {isPlaying ? (
            <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
          ) : (
            <path d="m8 5 11 7-11 7z" />
          )}
        </Icon>
      </span>
    )}
  </div>
);

export const SongsLibrary = ({
  sections,
  sectionsStatus,
  sectionsError,
  onView,
}: {
  sections: PlexSection[];
  sectionsStatus: MusicSectionsStatus;
  sectionsError: string | null;
  onView: (view: ShellView) => void;
}) => {
  const [songs, setSongs] = useState<PlexTrack[]>([]);
  const [status, setStatus] = useState<MusicSectionsStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot
  );

  useEffect(() => {
    let active = true;
    if (sectionsStatus !== "ready" || sections.length === 0) {
      return () => {
        active = false;
      };
    }

    const loadSongs = async (attempt: number): Promise<void> => {
      await Promise.resolve();
      if (!active || attempt !== reload) {
        return;
      }
      setStatus("loading");
      setError(null);
      try {
        const results = await Promise.all(
          sections.map(
            async (section) =>
              await plex.getTracks(section.key, { sort: "addedAt:desc" })
          )
        );
        if (!active || attempt !== reload) {
          return;
        }
        const unique = new Map<string, PlexTrack>();
        for (const result of results) {
          for (const song of result) {
            unique.set(song.ratingKey, song);
          }
        }
        setSongs([...unique.values()]);
        setStatus("ready");
      } catch (caughtError: unknown) {
        if (!active || attempt !== reload) {
          return;
        }
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Failed to load songs"
        );
        setStatus("error");
      }
    };
    void loadSongs(reload);
    return () => {
      active = false;
    };
  }, [sections, sectionsStatus, reload]);

  const displayedStatus =
    sectionsStatus === "ready" && sections.length > 0 ? status : sectionsStatus;
  const displayedError = sectionsStatus === "ready" ? error : sectionsError;
  const displayedSongs =
    sectionsStatus === "ready" && sections.length > 0 ? songs : [];
  let message: string | null = null;
  if (displayedStatus === "loading" || sectionsStatus === "loading") {
    message = "Loading songs…";
  } else if (displayedStatus === "error") {
    const errorSuffix =
      displayedError === null || displayedError === ""
        ? "."
        : `: ${displayedError}`;
    message = `Couldn’t load your songs${errorSuffix}`;
  } else if (displayedSongs.length === 0) {
    message = "No songs found in this library.";
  }
  const playSong = (song: PlexTrack, index: number) => {
    if (player.currentTrack?.ratingKey === song.ratingKey) {
      void playerState.togglePlay();
    } else {
      void playerState.playQueue(displayedSongs, index);
    }
  };

  return (
    <div className="songs-library" id="songs-library">
      <nav className="songs-filter-tabs" aria-label="Library views">
        {libraryTabs.map(([view, label]) => (
          <button
            className={`songs-filter-tab${view === "songs" ? " is-active" : ""}`}
            type="button"
            key={view}
            onClick={() => {
              onView(view);
            }}
            aria-current={view === "songs" ? "page" : undefined}
          >
            {label}
          </button>
        ))}
        <div className="songs-filter-spacer" />
        <Icon className="songs-sort-icon">
          <path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4m0 16 3-3m-3 3-3-3" />
        </Icon>
        <span className="songs-sort-label">Recently added</span>
      </nav>
      <section className="songs-library-section">
        <header className="songs-header">
          <h1 className="songs-title">All Songs</h1>
          <span className="songs-count">
            {displayedSongs.length} song{displayedSongs.length === 1 ? "" : "s"}
          </span>
        </header>
        {message !== null && message !== "" && (
          <div
            className={`songs-library-status${displayedStatus === "error" ? " is-error" : ""}`}
            aria-live="polite"
          >
            <span>{message}</span>
            {displayedStatus === "error" && (
              <button
                className="songs-library-retry"
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
        <ul className="songs-list" id="songs-list">
          {displayedStatus === "ready" &&
            displayedSongs.map((song, index) => {
              const isCurrentTrack =
                player.currentTrack?.ratingKey === song.ratingKey;
              const isPlaying = isCurrentTrack && player.status === "playing";
              return (
                <li key={song.ratingKey}>
                  <button
                    className={`songs-row${isCurrentTrack ? " is-playing" : ""}`}
                    type="button"
                    aria-current={isCurrentTrack ? "true" : undefined}
                    aria-label={`${isPlaying ? "Pause" : "Play"} ${song.title}`}
                    onClick={() => {
                      playSong(song, index);
                    }}
                  >
                    <TrackArtwork
                      track={song}
                      isCurrentTrack={isCurrentTrack}
                      isPlaying={isPlaying}
                    />
                    <span className="songs-track-info">
                      <span className="songs-track-title">{song.title}</span>
                      <span className="songs-track-artist">
                        {trackSubtitle(song)}
                      </span>
                    </span>
                    <span className="songs-track-duration">
                      {formatTrackDuration(song.duration)}
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>
      </section>
    </div>
  );
};
