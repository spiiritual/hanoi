import { useEffect, useState, useSyncExternalStore } from "react";

import type {
  PlexAlbum,
  PlexSection,
  PlexTrack,
} from "../../bun/plex/types.ts";
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

const formatAlbumDuration = (duration: number): string => {
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

const libraryTabs: [ShellView, string][] = [
  ["albums", "Albums"],
  ["artists", "Artists"],
  ["songs", "Songs"],
  ["playlists", "Playlists"],
];
const libraryStatuses = ["idle", "loading", "ready", "error"] as const;
type LibraryStatus = (typeof libraryStatuses)[number];

const AlbumArtwork = ({ album }: { album: PlexAlbum }) => (
  <figure className="album-detail-art" aria-label={`${album.title} cover art`}>
    <ArtworkImage
      source={
        album.thumb !== undefined && album.thumb !== ""
          ? { kind: "server", path: album.thumb }
          : null
      }
      priority
      alt={`${album.title} cover`}
      fallback={album.title.charAt(0).toUpperCase() || "♪"}
      fallbackClassName="album-detail-art-fallback"
    />
  </figure>
);

const getRandomIndex = (exclusiveLimit: number): number => {
  const randomValues = new Uint32Array(1);
  crypto.getRandomValues(randomValues);
  return (randomValues[0] ?? 0) % exclusiveLimit;
};

type PlayerSnapshot = ReturnType<typeof playerState.getSnapshot>;

const AlbumDetailActions = ({
  tracks,
  albumIsPlaying,
  playAlbum,
  shuffleAlbum,
}: {
  tracks: PlexTrack[];
  albumIsPlaying: boolean;
  playAlbum: () => void;
  shuffleAlbum: () => void;
}) => (
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
    <button
      className="album-detail-icon-action"
      type="button"
      aria-label="Like album"
    >
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
);

const AlbumTrackList = ({
  tracks,
  artist,
  player,
  onTrack,
}: {
  tracks: PlexTrack[];
  artist: string;
  player: PlayerSnapshot;
  onTrack: (track: PlexTrack, index: number) => void;
}) => (
  <section className="album-track-list" aria-label="Tracks">
    <div className="album-track-list-header">
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
          const isCurrentTrack =
            player.currentTrack?.ratingKey === track.ratingKey;
          const isTrackPlaying = isCurrentTrack && player.status === "playing";
          return (
            <li key={track.ratingKey}>
              <button
                className={`album-track-row${isCurrentTrack ? " is-playing" : ""}`}
                type="button"
                aria-current={isCurrentTrack ? "true" : undefined}
                aria-label={`${isTrackPlaying ? "Pause" : "Play"} ${track.title}`}
                onClick={() => {
                  onTrack(track, index);
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
);

export const AlbumDetail = ({ ratingKey }: { ratingKey: string }) => {
  const [detailState, setDetailState] = useState<{
    album: PlexAlbum | null;
    tracks: PlexTrack[];
    status: "loading" | "ready" | "error";
    error: string | null;
    reload: number;
  }>({
    album: null,
    error: null,
    reload: 0,
    status: "loading",
    tracks: [],
  });
  const { album, error, reload, status, tracks } = detailState;

  useEffect(() => {
    let active = true;
    const loadAlbum = async (attempt: number): Promise<void> => {
      try {
        const result = await plex.getAlbum(ratingKey);
        if (!active || attempt !== reload) {
          return;
        }
        setDetailState((current) => ({
          ...current,
          album: result.album,
          error: null,
          status: "ready",
          tracks: result.tracks,
        }));
      } catch (caughtError: unknown) {
        if (!active || attempt !== reload) {
          return;
        }
        setDetailState((current) => ({
          ...current,
          error:
            caughtError instanceof Error
              ? caughtError.message
              : "Failed to load album",
          status: "error",
        }));
      }
    };
    void loadAlbum(reload);
    return () => {
      active = false;
    };
  }, [ratingKey, reload]);

  const artist =
    album?.parentTitle ??
    tracks.find(
      (track) =>
        track.grandparentTitle !== undefined && track.grandparentTitle !== ""
    )?.grandparentTitle ??
    "Unknown artist";
  const trackCount = album?.leafCount ?? tracks.length;
  const totalDuration = tracks.reduce(
    (total, track) => total + (track.duration ?? 0),
    0
  );
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot
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
      const randomIndex = getRandomIndex(index + 1);
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
      void playerState.playQueue(tracks, index);
    }
  };

  return (
    <div className="album-detail" id="album-detail">
      {status === "loading" && (
        <div
          className="album-detail-status"
          id="album-detail-status"
          aria-live="polite"
        >
          Loading album…
        </div>
      )}
      {status === "error" && (
        <div
          className="album-detail-error"
          id="album-detail-error"
          role="alert"
        >
          <span>
            Couldn’t load this album
            {error === null || error === "" ? "." : `: ${error}`}
          </span>
          <button
            className="album-detail-retry"
            type="button"
            onClick={() => {
              setDetailState((current) => ({
                ...current,
                album: null,
                error: null,
                reload: current.reload + 1,
                status: "loading",
                tracks: [],
              }));
            }}
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
              <h1 className="album-detail-title">
                {album.title || "Untitled album"}
              </h1>
              <p className="album-detail-artist">{artist}</p>
              <p className="album-detail-meta">
                {[
                  "Album",
                  album.year === undefined || album.year === null
                    ? undefined
                    : String(album.year),
                  `${trackCount} song${trackCount === 1 ? "" : "s"}, ${formatAlbumDuration(totalDuration)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <AlbumDetailActions
                tracks={tracks}
                albumIsPlaying={albumIsPlaying}
                playAlbum={playAlbum}
                shuffleAlbum={shuffleAlbum}
              />
            </div>
          </header>
          <AlbumTrackList
            tracks={tracks}
            artist={artist}
            player={player}
            onTrack={playTrack}
          />
        </>
      )}
    </div>
  );
};

export const AlbumLibrary = ({
  sections,
  sectionsStatus,
  sectionsError,
  onAlbum,
  onView,
}: {
  sections: PlexSection[];
  sectionsStatus: LibraryStatus;
  sectionsError: string | null;
  onAlbum: (album: PlexAlbum) => void;
  onView: (view: ShellView) => void;
}) => {
  const [albums, setAlbums] = useState<PlexAlbum[]>([]);
  const [status, setStatus] = useState<LibraryStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    if (sectionsStatus !== "ready" || sections.length === 0) {
      return () => {
        active = false;
      };
    }

    const loadAlbums = async (attempt: number): Promise<void> => {
      try {
        const results = await Promise.all(
          sections.map(async (section) => {
            const sectionAlbums = await plex.getAlbums(section.key, {
              sort: "addedAt:desc",
            });
            return sectionAlbums;
          })
        );
        if (!active || attempt !== reload) {
          return;
        }
        const unique = new Map<string, PlexAlbum>();
        for (const result of results) {
          for (const album of result) {
            unique.set(album.ratingKey, album);
          }
        }
        setAlbums([...unique.values()]);
        setStatus("ready");
      } catch (caughtError: unknown) {
        if (!active || attempt !== reload) {
          return;
        }
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Failed to load albums"
        );
        setStatus("error");
      }
    };
    void loadAlbums(reload);
    return () => {
      active = false;
    };
  }, [sections, sectionsStatus, reload]);
  const displayedStatus =
    sectionsStatus === "ready" && sections.length > 0 ? status : sectionsStatus;
  const displayedError = sectionsStatus === "ready" ? error : sectionsError;
  const displayedAlbums =
    sectionsStatus === "ready" && sections.length > 0 ? albums : [];
  let message: string | null = null;
  if (displayedStatus === "loading" || sectionsStatus === "loading") {
    message = "Loading albums…";
  } else if (status === "error") {
    const errorSuffix =
      displayedError === null || displayedError === ""
        ? "."
        : `: ${displayedError}`;
    message = `Couldn’t load your albums${errorSuffix}`;
  } else if (albums.length === 0) {
    message = "No albums found in this library.";
  }

  return (
    <div className="album-library" id="album-library">
      <nav className="album-filter-tabs" aria-label="Library views">
        {libraryTabs.map(([view, label]) => (
          <button
            className={`album-filter-tab${view === "albums" ? " is-active" : ""}`}
            type="button"
            key={view}
            onClick={() => {
              onView(view);
            }}
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
      </nav>
      <section className="album-library-section">
        <h1 className="album-library-title">Recently added</h1>
        {message !== null && message !== "" && (
          <div
            className={`album-library-status${displayedStatus === "error" ? " is-error" : ""}`}
            aria-live="polite"
          >
            <span>{message}</span>
            {displayedStatus === "error" && (
              <button
                className="album-library-retry"
                type="button"
                onClick={() => {
                  setStatus("loading");
                  setError(null);
                  setReload((value) => value + 1);
                }}
              >
                Try again
              </button>
            )}
          </div>
        )}
        <ul className="album-grid" id="album-grid">
          {displayedStatus === "ready" &&
            displayedAlbums.map((album) => (
              <MediaCard
                item={album}
                category
                onAlbum={() => {
                  onAlbum(album);
                }}
                key={album.ratingKey}
              />
            ))}
        </ul>
      </section>
    </div>
  );
};
