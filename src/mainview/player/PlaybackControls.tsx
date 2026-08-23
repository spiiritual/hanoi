import { useSyncExternalStore } from "react";
import { Icon } from "../components/Icon.tsx";
import { playerState } from "../view-state.ts";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function PlaybackControls() {
  const player = useSyncExternalStore(
    playerState.subscribe,
    playerState.getSnapshot,
    playerState.getSnapshot,
  );
  const hasTrack = Boolean(player.currentTrack);
  const isPlaying = player.status === "playing";
  const progress =
    player.duration > 0 ? Math.min(100, (player.currentTime / player.duration) * 100) : 0;

  return (
    <div className="player-transport" aria-busy={player.status === "loading"}>
      <div className="player-controls">
        <button
          type="button"
          aria-label="Previous"
          disabled={!hasTrack}
          onClick={() => void playerState.playPrevious()}
        >
          <Icon>
            <path d="m19 20-9-8 9-8v16ZM5 19V5" />
          </Icon>
        </button>
        <button
          className="player-play"
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          disabled={!hasTrack || player.status === "loading"}
          onClick={() => void playerState.togglePlay()}
        >
          <Icon>{isPlaying ? <path d="M7 5v14M17 5v14" /> : <path d="m8 5 11 7-11 7z" />}</Icon>
        </button>
        <button
          type="button"
          aria-label="Next"
          disabled={!hasTrack || player.currentIndex >= player.queue.length - 1}
          onClick={() => void playerState.playNext()}
        >
          <Icon>
            <path d="m5 4 9 8-9 8V4Zm14 1v14" />
          </Icon>
        </button>
      </div>
      <div className="player-progress">
        <span>{formatTime(player.currentTime)}</span>
        <div className="player-progress-track">
          <progress max="100" value={progress} aria-hidden="true" />
          <input
            type="range"
            min="0"
            max={player.duration || 0}
            step="0.1"
            value={Math.min(player.currentTime, player.duration || 0)}
            disabled={!hasTrack || player.duration <= 0}
            aria-label="Track progress"
            onChange={(event) => playerState.seek(Number(event.currentTarget.value))}
          />
        </div>
        <span>{formatTime(player.duration)}</span>
      </div>
    </div>
  );
}
