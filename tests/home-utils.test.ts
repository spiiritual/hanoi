import { expect, test } from "bun:test";
import {
  homeCategoryItemMeta,
  homeHubItemMeta,
  homeHubItemInteraction,
  shouldShowHomeHubSeeAll,
} from "../src/mainview/home/utils.ts";
import type { PlexHub } from "../src/bun/plex/types.ts";

test("Home shows See all when Plex returned a capped six-card preview", () => {
  const hub = {
    Metadata: Array.from({ length: 6 }, (_, index) => ({
      ratingKey: `album-${index}`,
      key: `/library/metadata/album-${index}`,
      type: "album",
      title: `Album ${index}`,
    })),
  } as PlexHub;

  expect(shouldShowHomeHubSeeAll(hub)).toBe(true);
  expect(shouldShowHomeHubSeeAll({ ...hub, Metadata: hub.Metadata?.slice(0, 5) })).toBe(false);
});

test("album home cards use the artist as their consistent byline", () => {
  expect(
    homeHubItemMeta({
      ratingKey: "album-1",
      key: "/library/metadata/album-1",
      type: "album",
      title: "BABY BOI",
      parentTitle: "Playboi Carti",
      year: 2023,
    }),
  ).toBe("Playboi Carti");
});

test("album home cards have a clear fallback when Plex omits the artist", () => {
  expect(
    homeHubItemMeta({
      ratingKey: "album-1",
      key: "/library/metadata/album-1",
      type: "album",
      title: "Unknown album",
    }),
  ).toBe("Unknown artist");
});

test("expanded category cards identify the Plex media type", () => {
  expect(
    homeCategoryItemMeta({
      ratingKey: "album-1",
      key: "/library/metadata/album-1",
      type: "album",
      title: "Album one",
      parentTitle: "Artist one",
    }),
  ).toBe("Album · Artist one");
  expect(
    homeCategoryItemMeta({
      ratingKey: "track-1",
      key: "/library/metadata/track-1",
      type: "track",
      title: "Track one",
      grandparentTitle: "Artist one",
      parentTitle: "Album one",
    }),
  ).toBe("Song · Artist one");
  expect(
    homeCategoryItemMeta({
      ratingKey: "artist-1",
      key: "/library/metadata/artist-1",
      type: "artist",
      title: "Artist one",
    }),
  ).toBe("Artist");
});

test("home cards expose the Pen track hover state only for tracks", () => {
  expect(
    homeHubItemInteraction({
      ratingKey: "track-1",
      key: "/library/metadata/track-1",
      type: "track",
      title: "Track one",
    }),
  ).toBe("track");
});

test("home cards expose the shared non-track hover state for every other media type", () => {
  expect(
    homeHubItemInteraction({
      ratingKey: "album-1",
      key: "/library/metadata/album-1",
      type: "album",
      title: "Album one",
    }),
  ).toBe("other");
  expect(
    homeHubItemInteraction({
      ratingKey: "artist-1",
      key: "/library/metadata/artist-1",
      type: "artist",
      title: "Artist one",
    }),
  ).toBe("other");
  expect(
    homeHubItemInteraction({
      ratingKey: "playlist-1",
      key: "/playlists/playlist-1/items",
      type: "playlist",
      title: "Playlist one",
    }),
  ).toBe("other");
});
