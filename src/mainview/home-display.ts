import type { PlexHubItem } from "../bun/plex/types.ts";
import type { PlexHub } from "../bun/plex/types.ts";

export const HOME_HUB_PREVIEW_SIZE = 6;

export type HomeHubItemInteraction = "track" | "album" | null;

/** Interaction affordance shown for a Plex Home card. */
export function homeHubItemInteraction(item: PlexHubItem): HomeHubItemInteraction {
	if (item.type === "track") return "track";
	if (item.type === "album") return "album";
	return null;
}

/** Plex Home hubs are previews when they fill all six card slots. */
export function shouldShowHomeHubSeeAll(hub: PlexHub): boolean {
	return (hub.Metadata?.length ?? 0) >= HOME_HUB_PREVIEW_SIZE;
}

/** Text shown beneath cards in a Plex Home row. */
export function homeHubItemMeta(item: PlexHubItem): string {
	if (item.type === "track") {
		return [item.grandparentTitle, item.parentTitle].filter(Boolean).join(" · ") || "Song";
	}
	if (item.type === "album") {
		return item.parentTitle || "Unknown artist";
	}
	if (item.type === "artist") return "Artist";
	if (item.type === "playlist") {
		return [
			item.playlistType === "audio" ? "Playlist" : item.playlistType,
			item.leafCount ? `${item.leafCount} songs` : undefined,
		]
			.filter(Boolean)
			.join(" · ") || "Playlist";
	}
	return item.type;
}

/** Text shown beneath cards on a full Plex category screen. */
export function homeCategoryItemMeta(item: PlexHubItem): string {
	if (item.type === "track") {
		return ["Song", item.grandparentTitle].filter(Boolean).join(" · ");
	}
	if (item.type === "album") {
		return ["Album", item.parentTitle].filter(Boolean).join(" · ");
	}
	if (item.type === "artist") return "Artist";
	if (item.type === "playlist") {
		return [
			"Playlist",
			item.playlistType === "audio" ? undefined : item.playlistType,
			item.leafCount ? `${item.leafCount} songs` : undefined,
		]
			.filter(Boolean)
			.join(" · ");
	}
	return item.type;
}
