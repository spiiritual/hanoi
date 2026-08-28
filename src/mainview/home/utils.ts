import type { PlexHub, PlexHubItem } from "../../bun/plex/types.ts";

export const HOME_HUB_PREVIEW_SIZE = 6;

const musicItemTypes = new Set(["artist", "album", "track", "playlist"]);

const isMusicHomeItem = (item: PlexHubItem): boolean => {
  if (!musicItemTypes.has(item.type)) {
    return false;
  }
  return item.type !== "playlist" || item.playlistType !== "video";
};

/** Keep Plex's row order while omitting non-music rows and cards. */
export const filterMusicHomeHubs = (hubs: PlexHub[]): PlexHub[] =>
  hubs.flatMap((hub) => {
    const metadata = (hub.Metadata ?? []).filter(isMusicHomeItem);
    return metadata.length > 0 ? [{ ...hub, Metadata: metadata }] : [];
  });

export type HomeHubItemInteraction = "track" | "other";

/** Interaction affordance shown for a Plex Home card. */
export const homeHubItemInteraction = (
  item: PlexHubItem
): HomeHubItemInteraction => {
  if (item.type === "track") {
    return "track";
  }
  return "other";
};

/** Plex Home hubs are previews when they fill all six card slots. */
export const shouldShowHomeHubSeeAll = (hub: PlexHub): boolean =>
  (hub.Metadata?.length ?? 0) >= HOME_HUB_PREVIEW_SIZE;

/** Text shown beneath cards in a Plex Home row. */
export const homeHubItemMeta = (item: PlexHubItem): string => {
  if (item.type === "track") {
    const byline = [item.grandparentTitle, item.parentTitle]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    return byline.length > 0 ? byline : "Song";
  }
  if (item.type === "album") {
    return item.parentTitle ?? "Unknown artist";
  }
  if (item.type === "artist") {
    return "Artist";
  }
  if (item.type === "playlist") {
    const playlistType =
      item.playlistType === "audio" ? "Playlist" : item.playlistType;
    const songCount =
      item.leafCount !== undefined && item.leafCount > 0
        ? `${item.leafCount} songs`
        : null;
    const details = [playlistType, songCount].filter((value): value is string =>
      Boolean(value)
    );
    return details.length > 0 ? details.join(" · ") : "Playlist";
  }
  return item.type;
};

/** Text shown beneath cards on a full Plex category screen. */
export const homeCategoryItemMeta = (item: PlexHubItem): string => {
  if (item.type === "track") {
    return ["Song", item.grandparentTitle].filter(Boolean).join(" · ");
  }
  if (item.type === "album") {
    return ["Album", item.parentTitle].filter(Boolean).join(" · ");
  }
  if (item.type === "artist") {
    return "Artist";
  }
  if (item.type === "playlist") {
    const playlistType =
      item.playlistType === "audio" ? null : (item.playlistType ?? null);
    const songCount =
      item.leafCount !== undefined && item.leafCount > 0
        ? `${item.leafCount} songs`
        : null;
    return ["Playlist", playlistType, songCount]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  return item.type;
};
