import { Icon } from "../components/Icon.tsx";

export function NowPlaying() {
	return (
		<div className="player-now-playing">
			<div className="player-art" aria-hidden="true" />
			<div className="player-now-copy">
				<span className="player-track-name">Nothing playing</span>
				<span className="player-track-meta">Choose a track to start listening</span>
			</div>
			<button
				className="player-heart"
				type="button"
				aria-label="Like track"
				disabled
			>
				<Icon>
					<path d="M20.8 8.7c0 5.5-8.8 10.3-8.8 10.3S3.2 14.2 3.2 8.7A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.3Z" />
				</Icon>
			</button>
		</div>
	);
}
