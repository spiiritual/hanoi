import { NowPlaying } from "./NowPlaying.tsx";
import { PlaybackControls } from "./PlaybackControls.tsx";
import { VolumeControls } from "./VolumeControls.tsx";

export function PlayerBar() {
	return (
		<div className="player-bar" id="player-bar">
			<NowPlaying />
			<PlaybackControls />
			<VolumeControls />
		</div>
	);
}
