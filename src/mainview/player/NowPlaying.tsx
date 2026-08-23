import { useSyncExternalStore } from "react";
import { ArtworkImage } from "../ArtworkImage.tsx";
import { Icon } from "../components/Icon.tsx";
import { playerState } from "../view-state.ts";

export function NowPlaying() {
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot,
  );
  const track = player.currentTrack;

  const artist = track?.grandparentTitle ?? track?.parentTitle;
  const meta = player.error
    ? player.error
    : track
      ? [artist, track.parentTitle].filter(Boolean).join(" · ") || "Unknown artist"
      : "Choose a track to start listening";

  return (
    <div className="player-now-playing">
      <div className="player-art" aria-hidden="true">
        <ArtworkImage
          source={track?.thumb ? { kind: "server", path: track.thumb } : null}
          priority
          alt=""
          fallback={track?.title.charAt(0).toUpperCase() || "♪"}
        />
      </div>
      <div className="player-now-copy" aria-live="polite">
        <span className="player-track-name">{track?.title ?? "Nothing playing"}</span>
        <span className="player-track-meta">{meta}</span>
      </div>
      <button className="player-heart" type="button" aria-label="Like track" disabled={!track}>
        <Icon>
          <path d="M20.8 8.7c0 5.5-8.8 10.3-8.8 10.3S3.2 14.2 3.2 8.7A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z" />
        </Icon>
      </button>
    </div>
  );
}
