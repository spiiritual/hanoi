import { NowPlaying } from "./now-playing.tsx";
import { PlaybackControls } from "./playback-controls.tsx";
import { VolumeControls } from "./volume-controls.tsx";

export const PlayerBar = () => (
  <div className="player-bar" id="player-bar">
    <NowPlaying />
    <PlaybackControls />
    <VolumeControls />
  </div>
);
