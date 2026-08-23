import { useEffect, useState } from "react";
import { plex } from "../plex.ts";
import {
	filterMusicHomeHubs,
	HOME_HUB_PREVIEW_SIZE,
	homeCategoryItemMeta,
	homeHubItemMeta,
	homeHubItemInteraction,
	shouldShowHomeHubSeeAll,
} from "./utils.ts";
import type { HomeStateSnapshot } from "./state.ts";
import { Icon } from "../components/Icon.tsx";
import type { PlexHub, PlexHubItem } from "../../bun/plex/types.ts";

export type HomeCategoryView = {
	hub: PlexHub;
	items: PlexHubItem[];
	status: "loading" | "ready" | "error";
	error: string | null;
};

export function MediaCard({
	item,
	category,
	onPlay,
}: {
	item: PlexHubItem;
	category?: boolean;
	onPlay?: () => void;
}) {
	const [image, setImage] = useState<string | null>(null);
	const interaction = homeHubItemInteraction(item);

	useEffect(() => {
		let active = true;
		const path = item.thumb ?? item.composite ?? item.art;
		setImage(null);
		if (path) {
			void plex
				.imageUrl(path)
				.then((url) => {
					if (active) setImage(url);
				})
				.catch(() => undefined);
		}
		return () => {
			active = false;
		};
	}, [item]);

	return (
		<article
			className={`home-hub-card${category ? " home-category-card" : ""} home-hub-card-${interaction}`}
			role="listitem"
		>
			<div className="home-hub-card-art">
				<span className="home-hub-card-art-fallback" hidden={Boolean(image)}>
					{item.title.charAt(0).toUpperCase() || "♪"}
				</span>
				{image && <img src={image} alt="" onError={() => setImage(null)} />}
				{interaction === "track" && (
					<button
						className="home-hub-card-play"
						type="button"
						aria-label={`Play ${item.title}`}
						onClick={onPlay}
					>
						<Icon>
							<path d="m8 5 11 7-11 7z" />
						</Icon>
					</button>
				)}
			</div>
			<div className="home-hub-card-text">
				<span className="home-hub-card-title">{item.title}</span>
				<span className="home-hub-card-meta">
					{category ? homeCategoryItemMeta(item) : homeHubItemMeta(item)}
				</span>
			</div>
		</article>
	);
}

export function HomeCategory({ view }: { view: HomeCategoryView }) {
	return (
		<div className="home-category" id="home-category">
			<header className="home-category-header">
				<h2 className="home-category-title" id="home-category-title">
					{view.hub.title ?? view.hub.hubIdentifier ?? "Plex category"}
				</h2>
			</header>
			<div
				className="home-category-status"
				id="home-category-status"
				aria-live="polite"
				hidden={view.status === "ready" && view.items.length > 0}
			>
				{view.status === "loading"
					? "Loading…"
					: view.status === "error"
						? `Couldn't load this category${view.error ? `: ${view.error}` : "."}`
						: "No items in this category."}
			</div>
			<div className="home-category-cards" id="home-category-cards" role="list">
				{view.status === "ready" &&
					view.items.map((item) => (
						<MediaCard item={item} category key={`${item.ratingKey ?? item.title}`} />
					))}
			</div>
		</div>
	);
}

export function HomeDashboard({
	state,
	onRetry,
	onCategory,
}: {
	state: HomeStateSnapshot;
	onRetry: () => void;
	onCategory: (hub: PlexHub) => void;
}) {
	const hubs = filterMusicHomeHubs(state.hubs);

	return (
		<div className="home-dashboard" id="home-dashboard">
			<div
				className={`home-state${state.status === "error" ? " is-error" : ""}`}
				id="home-state"
				aria-live="polite"
				hidden={state.status !== "loading" && state.status !== "error"}
			>
				{state.status === "loading"
					? "Loading your Plex home…"
					: state.status === "error"
						? state.error
							? `Couldn't load your Plex home: ${state.error}`
							: "Couldn't load your Plex home."
						: ""}
			</div>
			{state.status === "error" && (
				<button
					className="home-retry"
					id="home-retry"
					type="button"
					onClick={onRetry}
				>
					Try again
				</button>
			)}
			{state.status === "ready" && hubs.length === 0 && (
				<div className="home-empty" id="home-empty">
					<h3>No music rows yet</h3>
					<p>Plex has not returned any music recommendations for this server.</p>
				</div>
			)}
			<div className="home-hub-rows" id="home-hub-rows">
				{state.status === "ready" &&
					hubs.map((hub) => (
						<section
							className="home-hub-row"
							key={hub.hubIdentifier ?? hub.key ?? hub.title}
						>
							<div className="home-hub-heading">
								<h3 className="home-hub-title">
									{hub.title ?? hub.hubIdentifier ?? "Plex Home"}
								</h3>
								{shouldShowHomeHubSeeAll(hub) && (hub.hubIdentifier ?? hub.key) && (
									<button
										className="home-hub-see-all"
										type="button"
										onClick={() => onCategory(hub)}
									>
										See all
									</button>
								)}
							</div>
							<div className="home-hub-cards" role="list">
								{(hub.Metadata ?? []).slice(0, HOME_HUB_PREVIEW_SIZE).map((item) => (
									<MediaCard item={item} key={`${item.ratingKey ?? item.title}`} />
								))}
							</div>
						</section>
					))}
			</div>
		</div>
	);
}
