import { useEffect, useState, useSyncExternalStore } from "react";
import type { PlexAlbum, PlexSection, PlexTrack } from "../../bun/plex/types.ts";
import { Icon } from "../components/Icon.tsx";
import type { ShellView } from "../app-state.ts";
import { plex } from "../plex.ts";
import { ArtworkImage } from "../artwork/ArtworkImage.tsx";
import { playerState } from "../view-state.ts";
import { MediaCard } from "../home/HomeContent.tsx";

function formatTrackDuration(duration?: number): string {
  if (!duration || duration < 0) return "--:--";
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatAlbumDuration(duration: number): string {
  const totalSeconds = Math.max(0, Math.floor(duration / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} sec`);
  return parts.join(" ");
}

const libraryTabs: Array<[ShellView, string]> = [
  ["albums", "Albums"],
  ["artists", "Artists"],
  ["songs", "Songs"],
  ["playlists", "Playlists"],
];

function AlbumArtwork({ album }: { album: PlexAlbum }) {
  return (
    <div className="album-detail-art" aria-label={`${album.title} cover art`}>
      <ArtworkImage
        source={album.thumb ? { kind: "server", path: album.thumb } : null}
        priority
        alt={`${album.title} cover`}
        fallback={album.title.charAt(0).toUpperCase() || "♪"}
        fallbackClassName="album-detail-art-fallback"
      />
    </div>
  );
}

export function AlbumDetail({ ratingKey }: { ratingKey: string }) {
  const [album, setAlbum] = useState<PlexAlbum | null>(null);
  const [tracks, setTracks] = useState<PlexTrack[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    setError(null);
    setAlbum(null);
    setTracks([]);
    void plex
      .getAlbum(ratingKey)
      .then((result) => {
        if (!active) return;
        setAlbum(result.album);
        setTracks(result.tracks);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load album");
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [ratingKey, reload]);

  const artist =
    album?.parentTitle ??
    tracks.find((track) => track.grandparentTitle)?.grandparentTitle ??
    "Unknown artist";
  const trackCount = album?.leafCount ?? tracks.length;
  const totalDuration = tracks.reduce((total, track) => total + (track.duration ?? 0), 0);
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot,
  );
  const albumIsActive =
    player.currentTrack !== null &&
    tracks.some((track) => track.ratingKey === player.currentTrack?.ratingKey);
  const albumIsPlaying = albumIsActive && player.status === "playing";
  const playAlbum = () => {
    if (albumIsActive) {
      void playerState.togglePlay();
      return;
    }
    void playerState.playQueue(tracks, 0);
  };
  const shuffleAlbum = () => {
    const shuffled = [...tracks];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
    }
    void playerState.playQueue(shuffled, 0);
  };
  const playTrack = (track: PlexTrack, index: number) => {
    if (player.currentTrack?.ratingKey === track.ratingKey) {
      void playerState.togglePlay();
    } else {
      void playerState.playQueue(tracks, index);
    }
  };

  return (
    <div className="album-detail" id="album-detail">
      {status === "loading" && (
        <div className="album-detail-status" id="album-detail-status" aria-live="polite">
          Loading album…
        </div>
      )}
      {status === "error" && (
        <div className="album-detail-error" id="album-detail-error" role="alert">
          <span>Couldn’t load this album{error ? `: ${error}` : "."}</span>
          <button
            className="album-detail-retry"
            type="button"
            onClick={() => setReload((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      )}
      {status === "ready" && album && (
        <>
          <header className="album-detail-header">
            <AlbumArtwork album={album} />
            <div className="album-detail-info">
              <h1 className="album-detail-title">{album.title || "Untitled album"}</h1>
              <p className="album-detail-artist">{artist}</p>
              <p className="album-detail-meta">
                {[
                  "Album",
                  album.year ? String(album.year) : undefined,
                  `${trackCount} song${trackCount === 1 ? "" : "s"}, ${formatAlbumDuration(totalDuration)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div className="album-detail-actions">
                <button
                  className="album-detail-play"
                  type="button"
                  disabled={tracks.length === 0}
                  onClick={playAlbum}
                >
                  <Icon>
                    {albumIsPlaying ? (
                      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                    ) : (
                      <path d="m8 5 11 7-11 7z" />
                    )}
                  </Icon>
                  <span>{albumIsPlaying ? "Playing" : "Play"}</span>
                </button>
                <button
                  className="album-detail-icon-action"
                  type="button"
                  aria-label="Shuffle album"
                  disabled={tracks.length === 0}
                  onClick={shuffleAlbum}
                >
                  <Icon>
                    <path d="M3 7h3c4 0 5 10 9 10h6M17 4l4 3-4 3M3 17h3c1.5 0 2.5-1 3.5-2.5M17 14l4 3-4 3" />
                  </Icon>
                </button>
                <button className="album-detail-icon-action" type="button" aria-label="Like album">
                  <Icon>
                    <path d="M20.8 8.7c0 5.5-8.8 10.3-8.8 10.3S3.2 14.2 3.2 8.7A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z" />
                  </Icon>
                </button>
                <button
                  className="album-detail-icon-action"
                  type="button"
                  aria-label="More album actions"
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
          <section className="album-track-list" aria-label="Tracks">
            <div className="album-track-list-header" role="row">
              <span>#</span>
              <span>Title</span>
              <span>Duration</span>
            </div>
            <div className="album-track-divider" />
            {tracks.length === 0 ? (
              <p className="album-track-empty">This album has no tracks.</p>
            ) : (
              <ul className="album-track-rows">
                {tracks.map((track, index) => {
                  const isCurrentTrack = player.currentTrack?.ratingKey === track.ratingKey;
                  const isTrackPlaying = isCurrentTrack && player.status === "playing";
                  return (
                    <li key={track.ratingKey}>
                      <button
                        className={`album-track-row${isCurrentTrack ? " is-playing" : ""}`}
                        type="button"
                        aria-current={isCurrentTrack ? "true" : undefined}
                        aria-label={`${isTrackPlaying ? "Pause" : "Play"} ${track.title}`}
                        onClick={() => playTrack(track, index)}
                      >
                        <span className="album-track-number">
                          <span className="album-track-index">{track.index ?? index + 1}</span>
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
                            {track.grandparentTitle ?? artist}
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
        </>
      )}
    </div>
  );
}

export function AlbumLibrary({
  sections,
  sectionsStatus,
  sectionsError,
  onAlbum,
  onView,
}: {
  sections: PlexSection[];
  sectionsStatus: "idle" | "loading" | "ready" | "error";
  sectionsError: string | null;
  onAlbum: (album: PlexAlbum) => void;
  onView: (view: ShellView) => void;
}) {
  const [albums, setAlbums] = useState<PlexAlbum[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    if (sectionsStatus !== "ready") {
      setStatus(sectionsStatus);
      setError(sectionsError);
      setAlbums([]);
      return () => {
        active = false;
      };
    }
    if (sections.length === 0) {
      setStatus("ready");
      setError(null);
      setAlbums([]);
      return () => {
        active = false;
      };
    }

    setStatus("loading");
    setError(null);
    void Promise.all(
      sections.map((section) => plex.getAlbums(section.key, { sort: "addedAt:desc" })),
    )
      .then((results) => {
        if (!active) return;
        const unique = new Map<string, PlexAlbum>();
        for (const result of results) {
          for (const album of result) unique.set(album.ratingKey, album);
        }
        setAlbums([...unique.values()]);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load albums");
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [sections, sectionsStatus, sectionsError, reload]);
  const message =
    status === "loading" || sectionsStatus === "loading"
      ? "Loading albums…"
      : status === "error"
        ? `Couldn’t load your albums${error ? `: ${error}` : "."}`
        : albums.length === 0
          ? "No albums found in this library."
          : null;

  return (
    <div className="album-library" id="album-library">
      <div className="album-filter-tabs" aria-label="Library views">
        {libraryTabs.map(([view, label]) => (
          <button
            className={`album-filter-tab${view === "albums" ? " is-active" : ""}`}
            type="button"
            key={view}
            onClick={() => onView(view)}
            aria-current={view === "albums" ? "page" : undefined}
          >
            {label}
          </button>
        ))}
        <div className="album-filter-spacer" />
        <Icon className="album-sort-icon">
          <path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4m0 16 3-3m-3 3-3-3" />
        </Icon>
        <span className="album-sort-label">Recently added</span>
      </div>
      <section className="album-library-section">
        <h1 className="album-library-title">Recently added</h1>
        {message && (
          <div
            className={`album-library-status${status === "error" ? " is-error" : ""}`}
            aria-live="polite"
          >
            <span>{message}</span>
            {status === "error" && (
              <button
                className="album-library-retry"
                type="button"
                onClick={() => setReload((value) => value + 1)}
              >
                Try again
              </button>
            )}
          </div>
        )}
        <ul className="album-grid" id="album-grid">
          {status === "ready" &&
            albums.map((album) => (
              <MediaCard
                item={album}
                category
                onAlbum={() => onAlbum(album)}
                key={album.ratingKey}
              />
            ))}
        </ul>
      </section>
    </div>
  );
}
