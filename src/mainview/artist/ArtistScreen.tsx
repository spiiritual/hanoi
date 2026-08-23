import { useEffect, useState, useSyncExternalStore } from "react";
import type { PlexAlbum, PlexArtist, PlexSection, PlexTrack } from "../../bun/plex/types.ts";
import { Icon } from "../components/Icon.tsx";
import type { ShellView } from "../app-state.ts";
import { plex } from "../plex.ts";
import { ArtworkImage } from "../ArtworkImage.tsx";
import { playerState } from "../view-state.ts";
import { MediaCard } from "../home/HomeContent.tsx";

function formatTrackDuration(duration?: number): string {
  if (!duration || duration < 0) return "--:--";
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

const libraryTabs: Array<[ShellView, string]> = [
  ["albums", "Albums"],
  ["artists", "Artists"],
  ["songs", "Songs"],
  ["playlists", "Playlists"],
];

function ArtistArtwork({ artist }: { artist: PlexArtist }) {
  const path = artist["thumb"] ?? artist["art"];
  return (
    <div className="artist-detail-avatar" aria-label={`${artist.title} artwork`}>
      <ArtworkImage
        source={path ? { kind: "server", path } : null}
        priority
        alt={`${artist.title} artwork`}
        fallback={artist.title.charAt(0).toUpperCase() || "♪"}
        fallbackClassName="artist-detail-avatar-fallback"
      />
    </div>
  );
}

function TrackArtwork({ track }: { track: PlexTrack }) {
  return (
    <div className="artist-song-art" aria-hidden="true">
      <ArtworkImage
        source={track.thumb ? { kind: "server", path: track.thumb } : null}
        alt=""
        fallback={track.title.charAt(0).toUpperCase() || "♪"}
        fallbackClassName="artist-song-art-fallback"
      />
    </div>
  );
}

function trackMeta(track: PlexTrack): string {
  return `${track.parentTitle ?? "Single"} · ${track.viewCount ?? 0} plays`;
}

export function ArtistDetail({
  ratingKey,
  onAlbum,
}: {
  ratingKey: string;
  onAlbum: (album: PlexAlbum) => void;
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof plex.getArtist>> | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [liked, setLiked] = useState(false);
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot,
  );

  useEffect(() => {
    let active = true;
    setStatus("loading");
    setError(null);
    setDetail(null);
    void plex
      .getArtist(ratingKey)
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load artist");
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [ratingKey, reload]);

  const topTracks = detail?.topTracks ?? [];
  const visibleTopTracks = topTracks.slice(0, 4);
  const artistIsActive = topTracks.some(
    (track) => track.ratingKey === player.currentTrack?.ratingKey,
  );
  const artistIsPlaying = artistIsActive && player.status === "playing";
  const playArtist = () => {
    if (artistIsActive) {
      void playerState.togglePlay();
      return;
    }
    void playerState.playQueue(topTracks, 0);
  };
  const shuffleArtist = () => {
    const shuffled = [...topTracks];
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
      void playerState.playQueue(topTracks, index);
    }
  };

  if (status === "loading") {
    return (
      <div className="artist-detail" id="artist-detail">
        <div className="artist-detail-status" aria-live="polite">
          Loading artist…
        </div>
      </div>
    );
  }

  if (status === "error" || !detail) {
    return (
      <div className="artist-detail" id="artist-detail">
        <div className="artist-detail-error" role="alert">
          <span>Couldn’t load this artist{error ? `: ${error}` : "."}</span>
          <button
            className="artist-detail-retry"
            type="button"
            onClick={() => setReload((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const { artist, genres, albumCount, songCount, albums } = detail;
  return (
    <div className="artist-detail" id="artist-detail">
      <header className="artist-detail-header">
        <ArtistArtwork artist={artist} />
        <div className="artist-detail-info">
          <h1 className="artist-detail-title">{artist.title || "Unknown artist"}</h1>
          <p className="artist-detail-meta">
            Artist · {formatCount(albumCount, "album")} · {formatCount(songCount, "song")}
          </p>
          {genres.length > 0 && <p className="artist-detail-genres">{genres.join(" · ")}</p>}
          <div className="artist-detail-actions">
            <button
              className="artist-detail-play"
              type="button"
              disabled={topTracks.length === 0}
              onClick={playArtist}
            >
              <Icon>
                {artistIsPlaying ? (
                  <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
                ) : (
                  <path d="m8 5 11 7-11 7z" />
                )}
              </Icon>
              <span>{artistIsPlaying ? "Playing" : "Play"}</span>
            </button>
            <button
              className="artist-detail-icon-action"
              type="button"
              aria-label="Shuffle artist"
              disabled={topTracks.length === 0}
              onClick={shuffleArtist}
            >
              <Icon>
                <path d="M3 7h3c4 0 5 10 9 10h6M17 4l4 3-4 3M3 17h3c1.5 0 2.5-1 3.5-2.5M17 14l4 3-4 3" />
              </Icon>
            </button>
            <button
              className={`artist-detail-icon-action${liked ? " is-liked" : ""}`}
              type="button"
              aria-label={liked ? "Unlike artist" : "Like artist"}
              aria-pressed={liked}
              onClick={() => setLiked((value) => !value)}
            >
              <Icon>
                <path d="M20.8 8.7c0 5.5-8.8 10.3-8.8 10.3S3.2 14.2 3.2 8.7A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z" />
              </Icon>
            </button>
            <button
              className="artist-detail-icon-action"
              type="button"
              aria-label="More artist actions"
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

      <section className="artist-popular-section" aria-labelledby="artist-popular-title">
        <div className="artist-section-header">
          <h2 className="artist-section-title" id="artist-popular-title">
            Your Top Songs
          </h2>
        </div>
        {topTracks.length === 0 ? (
          <p className="artist-empty">This artist has no songs.</p>
        ) : (
          <ul className="artist-song-list">
            {visibleTopTracks.map((track, index) => {
              const isCurrentTrack = player.currentTrack?.ratingKey === track.ratingKey;
              return (
                <li key={track.ratingKey}>
                  <button
                    className={`artist-song-row${isCurrentTrack ? " is-playing" : ""}`}
                    type="button"
                    aria-current={isCurrentTrack ? "true" : undefined}
                    onClick={() => playTrack(track, index)}
                  >
                    <TrackArtwork track={track} />
                    <span className="artist-song-copy">
                      <span className="artist-song-title">{track.title}</span>
                      <span className="artist-song-meta">{trackMeta(track)}</span>
                    </span>
                    <span className="artist-song-duration">
                      {formatTrackDuration(track.duration)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="artist-albums-section" aria-labelledby="artist-albums-title">
        <div className="artist-section-header">
          <h2 className="artist-section-title" id="artist-albums-title">
            Albums
          </h2>
        </div>
        {albums.length === 0 ? (
          <p className="artist-empty">This artist has no albums.</p>
        ) : (
          <ul className="artist-albums-row">
            {albums.map((album) => (
              <MediaCard
                item={album}
                category
                meta={[album.year ? String(album.year) : undefined, `${album.viewCount ?? 0} plays`]
                  .filter(Boolean)
                  .join(" · ")}
                onAlbum={() => onAlbum(album)}
                key={album.ratingKey}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ArtistCard({
  artist,
  onArtist,
}: {
  artist: PlexArtist;
  onArtist: (artist: PlexArtist) => void;
}) {
  const path = artist["thumb"] ?? artist["art"];
  return (
    <li className="artist-card">
      <button
        className="artist-card-button"
        type="button"
        aria-label={`Open artist ${artist.title}`}
        onClick={() => onArtist(artist)}
      >
        <div className="artist-card-avatar">
          <ArtworkImage
            source={path ? { kind: "server", path } : null}
            alt=""
            fallback={artist.title.charAt(0).toUpperCase() || "♪"}
            fallbackClassName="artist-card-avatar-fallback"
          />
        </div>
        <span className="artist-card-copy">
          <span className="artist-card-title">{artist.title}</span>
          <span className="artist-card-meta">Artist</span>
        </span>
      </button>
    </li>
  );
}

export function ArtistLibrary({
  sections,
  sectionsStatus,
  sectionsError,
  onArtist,
  onView,
}: {
  sections: PlexSection[];
  sectionsStatus: "idle" | "loading" | "ready" | "error";
  sectionsError: string | null;
  onArtist: (artist: PlexArtist) => void;
  onView: (view: ShellView) => void;
}) {
  const [artists, setArtists] = useState<PlexArtist[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    if (sectionsStatus !== "ready") {
      setStatus(sectionsStatus);
      setError(sectionsError);
      setArtists([]);
      return () => {
        active = false;
      };
    }
    if (sections.length === 0) {
      setStatus("ready");
      setError(null);
      setArtists([]);
      return () => {
        active = false;
      };
    }

    setStatus("loading");
    setError(null);
    void Promise.all(
      sections.map((section) => plex.getArtists(section.key, { sort: "addedAt:desc" })),
    )
      .then((results) => {
        if (!active) return;
        const unique = new Map<string, PlexArtist>();
        for (const result of results) {
          for (const artist of result) unique.set(artist.ratingKey, artist);
        }
        setArtists([...unique.values()]);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load artists");
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [sections, sectionsStatus, sectionsError, reload]);
  const message =
    status === "loading" || sectionsStatus === "loading"
      ? "Loading artists…"
      : status === "error"
        ? `Couldn’t load your artists${error ? `: ${error}` : "."}`
        : artists.length === 0
          ? "No artists found in this library."
          : null;

  return (
    <div className="artist-library" id="artist-library">
      <div className="artist-filter-tabs" aria-label="Library views">
        {libraryTabs.map(([view, label]) => (
          <button
            className={`artist-filter-tab${view === "artists" ? " is-active" : ""}`}
            type="button"
            key={view}
            onClick={() => onView(view)}
            aria-current={view === "artists" ? "page" : undefined}
          >
            {label}
          </button>
        ))}
        <div className="artist-filter-spacer" />
        <Icon className="artist-sort-icon">
          <path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4m0 16 3-3m-3 3-3-3" />
        </Icon>
        <span className="artist-sort-label">Recently added</span>
      </div>
      <section className="artist-library-section">
        <h1 className="artist-library-title">Your Artists</h1>
        {message && (
          <div
            className={`artist-library-status${status === "error" ? " is-error" : ""}`}
            aria-live="polite"
          >
            <span>{message}</span>
            {status === "error" && (
              <button
                className="artist-library-retry"
                type="button"
                onClick={() => setReload((value) => value + 1)}
              >
                Try again
              </button>
            )}
          </div>
        )}
        <ul className="artist-grid" id="artist-grid">
          {status === "ready" &&
            artists.map((artist) => (
              <ArtistCard artist={artist} onArtist={onArtist} key={artist.ratingKey} />
            ))}
        </ul>
      </section>
    </div>
  );
}
