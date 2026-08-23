import { Icon } from "../components/Icon.tsx";

export function PlaybackControls() {
	return (
		<div className="player-transport">
			<div className="player-controls">
				<button type="button" aria-label="Previous" disabled>
					<Icon>
						<path d="m19 20-9-8 9-8v16ZM5 19V5" />
					</Icon>
				</button>
				<button className="player-play" type="button" aria-label="Play" disabled>
					<Icon>
						<path d="m8 5 11 7-11 7z" />
					</Icon>
				</button>
				<button type="button" aria-label="Next" disabled>
					<Icon>
						<path d="m5 4 9 8-9 8V4Zm14 1v14" />
					</Icon>
				</button>
			</div>
			<div className="player-progress">
				<span>0:00</span>
				<div className="player-progress-track">
					<span />
				</div>
				<span>0:00</span>
			</div>
		</div>
	);
}
