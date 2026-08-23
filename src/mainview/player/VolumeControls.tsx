import { useSyncExternalStore } from "react";
import { Icon } from "../components/Icon.tsx";
import { playerState } from "../view-state.ts";

export function VolumeControls() {
	const player = useSyncExternalStore(
		playerState.subscribe,
		playerState.getSnapshot,
		playerState.getSnapshot,
	);

	return (
		<div className="player-right-controls">
			<Icon>
				<path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
			</Icon>
			<div className="player-volume-track">
				<progress max="1" value={player.volume} aria-hidden="true" />
				<input
					type="range"
					min="0"
					max="1"
					step="0.01"
					value={player.volume}
					aria-label="Volume"
					onChange={(event) =>
						playerState.setVolume(Number(event.currentTarget.value))
					}
				/>
			</div>
		</div>
	);
}
