import { Icon } from "../components/Icon.tsx";

export function VolumeControls() {
	return (
		<div className="player-right-controls">
			<Icon>
				<path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
			</Icon>
			<div className="player-volume-track">
				<span />
			</div>
		</div>
	);
}
