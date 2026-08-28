import { useSyncExternalStore } from "react";

import { ArtworkImage } from "../artwork/artwork-image.tsx";
import { Icon } from "../components/icon.tsx";
import { playerState } from "../view-state.ts";

export const NowPlaying = () => {
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot
  );
  const track = player.currentTrack;

  const artist = track?.grandparentTitle ?? track?.parentTitle;
  let meta = "Choose a track to start listening";
  if (track !== null) {
    const trackMeta = [artist, track.parentTitle]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    meta = trackMeta.length > 0 ? trackMeta : "Unknown artist";
  }
  if (player.error !== null) {
    meta = player.error;
  }
  const trackThumb = track?.thumb;
  const trackTitle = track?.title;
  const fallback =
    trackTitle !== undefined && trackTitle.length > 0
      ? trackTitle.charAt(0).toUpperCase()
      : "♪";

  return (
    <div className="player-now-playing">
      <div className="player-art" aria-hidden="true">
        <ArtworkImage
          source={
            trackThumb !== undefined && trackThumb.length > 0
              ? { kind: "server", path: trackThumb }
              : null
          }
          priority
          alt=""
          fallback={fallback}
        />
      </div>
      <div className="player-now-copy" aria-live="polite">
        <span className="player-track-name">
          {track?.title ?? "Nothing playing"}
        </span>
        <span className="player-track-meta">{meta}</span>
      </div>
      <button
        className="player-heart"
        type="button"
        aria-label="Like track"
        disabled={track === null}
      >
        <Icon>
          <path d="M20.8 8.7c0 5.5-8.8 10.3-8.8 10.3S3.2 14.2 3.2 8.7A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z" />
        </Icon>
      </button>
    </div>
  );
};
