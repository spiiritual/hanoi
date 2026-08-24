import { useEffect, useState, useSyncExternalStore } from "react";
import type { PlexSection, PlexTrack } from "../../bun/plex/types.ts";
import { ArtworkImage } from "../artwork/ArtworkImage.tsx";
import { Icon } from "../components/Icon.tsx";
import type { ShellView } from "../app-state.ts";
import { plex } from "../plex.ts";
import { playerState } from "../view-state.ts";

function formatTrackDuration(duration?: number): string {
  if (!duration || duration < 0) return "--:--";
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function trackSubtitle(track: PlexTrack): string {
  return (
    [track.grandparentTitle, track.parentTitle].filter(Boolean).join(" · ") || "Unknown artist"
  );
}

const libraryTabs: Array<[ShellView, string]> = [
  ["albums", "Albums"],
  ["artists", "Artists"],
  ["songs", "Songs"],
  ["playlists", "Playlists"],
];

function TrackArtwork({
  track,
  isCurrentTrack,
  isPlaying,
}: {
  track: PlexTrack;
  isCurrentTrack: boolean;
  isPlaying: boolean;
}) {
  return (
    <div className={`songs-track-art${isCurrentTrack ? " is-playing" : ""}`} aria-hidden="true">
      <ArtworkImage
        source={track.thumb ? { kind: "server", path: track.thumb } : null}
        alt=""
        fallback={track.title.charAt(0).toUpperCase() || "♪"}
        fallbackClassName="songs-track-art-fallback"
      />
      {isCurrentTrack && (
        <span className="songs-playing-indicator">
          <Icon>
            {isPlaying ? <path d="M6 5h4v14H6zM14 5h4v14h-4z" /> : <path d="m8 5 11 7-11 7z" />}
          </Icon>
        </span>
      )}
    </div>
  );
}

export function SongsLibrary({
  sections,
  sectionsStatus,
  sectionsError,
  onView,
}: {
  sections: PlexSection[];
  sectionsStatus: "idle" | "loading" | "ready" | "error";
  sectionsError: string | null;
  onView: (view: ShellView) => void;
}) {
  const [songs, setSongs] = useState<PlexTrack[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot,
  );

  useEffect(() => {
    let active = true;
    if (sectionsStatus !== "ready") {
      setStatus(sectionsStatus);
      setError(sectionsError);
      setSongs([]);
      return () => {
        active = false;
      };
    }
    if (sections.length === 0) {
      setStatus("ready");
      setError(null);
      setSongs([]);
      return () => {
        active = false;
      };
    }

    setStatus("loading");
    setError(null);
    void Promise.all(
      sections.map((section) => plex.getTracks(section.key, { sort: "addedAt:desc" })),
    )
      .then((results) => {
        if (!active) return;
        const unique = new Map<string, PlexTrack>();
        for (const result of results) {
          for (const song of result) unique.set(song.ratingKey, song);
        }
        setSongs([...unique.values()]);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load songs");
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [sections, sectionsStatus, sectionsError, reload]);

  const message =
    status === "loading" || sectionsStatus === "loading"
      ? "Loading songs…"
      : status === "error"
        ? `Couldn’t load your songs${error ? `: ${error}` : "."}`
        : songs.length === 0
          ? "No songs found in this library."
          : null;
  const playSong = (song: PlexTrack, index: number) => {
    if (player.currentTrack?.ratingKey === song.ratingKey) {
      void playerState.togglePlay();
    } else {
      void playerState.playQueue(songs, index);
    }
  };

  return (
    <div className="songs-library" id="songs-library">
      <div className="songs-filter-tabs" aria-label="Library views">
        {libraryTabs.map(([view, label]) => (
          <button
            className={`songs-filter-tab${view === "songs" ? " is-active" : ""}`}
            type="button"
            key={view}
            onClick={() => onView(view)}
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
      </div>
      <section className="songs-library-section">
        <header className="songs-header">
          <h1 className="songs-title">All Songs</h1>
          <span className="songs-count">
            {songs.length} song{songs.length === 1 ? "" : "s"}
          </span>
        </header>
        {message && (
          <div
            className={`songs-library-status${status === "error" ? " is-error" : ""}`}
            aria-live="polite"
          >
            <span>{message}</span>
            {status === "error" && (
              <button
                className="songs-library-retry"
                type="button"
                onClick={() => setReload((value) => value + 1)}
              >
                Try again
              </button>
            )}
          </div>
        )}
        <ul className="songs-list" id="songs-list">
          {status === "ready" &&
            songs.map((song, index) => {
              const isCurrentTrack = player.currentTrack?.ratingKey === song.ratingKey;
              const isPlaying = isCurrentTrack && player.status === "playing";
              return (
                <li key={song.ratingKey}>
                  <button
                    className={`songs-row${isCurrentTrack ? " is-playing" : ""}`}
                    type="button"
                    aria-current={isCurrentTrack ? "true" : undefined}
                    aria-label={`${isPlaying ? "Pause" : "Play"} ${song.title}`}
                    onClick={() => playSong(song, index)}
                  >
                    <TrackArtwork
                      track={song}
                      isCurrentTrack={isCurrentTrack}
                      isPlaying={isPlaying}
                    />
                    <span className="songs-track-info">
                      <span className="songs-track-title">{song.title}</span>
                      <span className="songs-track-artist">{trackSubtitle(song)}</span>
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
}
