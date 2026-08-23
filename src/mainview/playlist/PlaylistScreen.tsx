import { useEffect, useState, useSyncExternalStore } from "react";
import type { PlexPlaylist, PlexTrack } from "../../bun/plex/types.ts";
import { Icon } from "../components/Icon.tsx";
import { plex } from "../plex.ts";
import { ArtworkImage } from "../artwork/ArtworkImage.tsx";
import { playerState } from "../view-state.ts";

function formatTrackDuration(duration?: number): string {
  if (!duration || duration < 0) return "--:--";
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatPlaylistDuration(duration: number): string {
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

function trackSubtitle(track: PlexTrack): string {
  return (
    [track.grandparentTitle, track.parentTitle].filter(Boolean).join(" · ") || "Unknown artist"
  );
}

function PlaylistArtwork({ playlist, className }: { playlist: PlexPlaylist; className: string }) {
  return (
    <div className={className} aria-label={`${playlist.title} cover art`}>
      <ArtworkImage
        source={playlist.composite ? { kind: "server", path: playlist.composite } : null}
        priority
        alt={`${playlist.title} cover`}
        fallback={playlist.title.charAt(0).toUpperCase() || "♪"}
      />
    </div>
  );
}

export function PlaylistDetail({ ratingKey }: { ratingKey: string }) {
  const [playlist, setPlaylist] = useState<PlexPlaylist | null>(null);
  const [tracks, setTracks] = useState<PlexTrack[]>([]);
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
    setPlaylist(null);
    setTracks([]);
    void plex
      .getPlaylist(ratingKey)
      .then((result) => {
        if (!active) return;
        setPlaylist(result.playlist);
        setTracks(result.tracks);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load playlist");
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [ratingKey, reload]);

  if (status === "loading") {
    return (
      <div className="playlist-detail" id="playlist-detail">
        <div className="album-detail-status" aria-live="polite">
          Loading playlist…
        </div>
      </div>
    );
  }
  if (status === "error" || !playlist) {
    return (
      <div className="playlist-detail" id="playlist-detail">
        <div className="album-detail-error" role="alert">
          <span>Couldn’t load this playlist{error ? `: ${error}` : "."}</span>
          <button
            className="album-detail-retry"
            type="button"
            onClick={() => setReload((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const trackCount = playlist.leafCount ?? tracks.length;
  const totalDuration =
    playlist.duration ?? tracks.reduce((total, track) => total + (track.duration ?? 0), 0);
  const playlistYear = playlist.year ? String(playlist.year) : undefined;
  const playlistIsActive = tracks.some(
    (track) => track.ratingKey === player.currentTrack?.ratingKey,
  );
  const playlistIsPlaying = playlistIsActive && player.status === "playing";
  const playPlaylist = () => {
    if (playlistIsActive) {
      void playerState.togglePlay();
      return;
    }
    void playerState.playQueue(tracks, 0);
  };
  const shufflePlaylist = () => {
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
    <div className="album-detail playlist-detail" id="playlist-detail">
      <header className="album-detail-header">
        <PlaylistArtwork playlist={playlist} className="playlist-detail-art" />
        <div className="album-detail-info">
          <h1 className="album-detail-title">{playlist.title || "Untitled playlist"}</h1>
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
              disabled={tracks.length === 0}
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
              disabled={tracks.length === 0}
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
              onClick={() => setLiked((value) => !value)}
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
        <div className="album-track-list-header" role="row">
          <span>#</span>
          <span>Title</span>
          <span>Duration</span>
        </div>
        <div className="album-track-divider" />
        {tracks.length === 0 ? (
          <p className="album-track-empty">This playlist has no tracks.</p>
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
                      <span className="album-track-artist">{trackSubtitle(track)}</span>
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
}
