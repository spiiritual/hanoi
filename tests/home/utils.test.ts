// oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- Hanoi tests use Bun's native runner.
import { expect, test } from "bun:test";

import type { PlexHub } from "../../src/bun/plex/types.ts";
import {
  homeCategoryItemMeta,
  homeHubItemMeta,
  homeHubItemInteraction,
  shouldShowHomeHubSeeAll,
} from "../../src/mainview/home/utils.ts";

test("Home shows See all when Plex returned a capped six-card preview", () => {
  // SAFETY: This fixture contains the required fields for a Plex hub item.
  const hub = {
    Metadata: Array.from({ length: 6 }, (_, index) => ({
      key: `/library/metadata/album-${index}`,
      ratingKey: `album-${index}`,
      title: `Album ${index}`,
      type: "album",
    })),
  } satisfies PlexHub;

  expect(shouldShowHomeHubSeeAll(hub)).toBe(true);
  expect(
    shouldShowHomeHubSeeAll({ ...hub, Metadata: hub.Metadata?.slice(0, 5) })
  ).toBe(false);
});

test("album home cards use the artist as their consistent byline", () => {
  expect(
    homeHubItemMeta({
      key: "/library/metadata/album-1",
      parentTitle: "Playboi Carti",
      ratingKey: "album-1",
      title: "BABY BOI",
      type: "album",
      year: 2023,
    })
  ).toBe("Playboi Carti");
});

test("album home cards have a clear fallback when Plex omits the artist", () => {
  expect(
    homeHubItemMeta({
      key: "/library/metadata/album-1",
      ratingKey: "album-1",
      title: "Unknown album",
      type: "album",
    })
  ).toBe("Unknown artist");
});

test("expanded category cards identify the Plex media type", () => {
  expect(
    homeCategoryItemMeta({
      key: "/library/metadata/album-1",
      parentTitle: "Artist one",
      ratingKey: "album-1",
      title: "Album one",
      type: "album",
    })
  ).toBe("Album · Artist one");
  expect(
    homeCategoryItemMeta({
      grandparentTitle: "Artist one",
      key: "/library/metadata/track-1",
      parentTitle: "Album one",
      ratingKey: "track-1",
      title: "Track one",
      type: "track",
    })
  ).toBe("Song · Artist one");
  expect(
    homeCategoryItemMeta({
      key: "/library/metadata/artist-1",
      ratingKey: "artist-1",
      title: "Artist one",
      type: "artist",
    })
  ).toBe("Artist");
});

test("home cards expose the Pen track hover state only for tracks", () => {
  expect(
    homeHubItemInteraction({
      key: "/library/metadata/track-1",
      ratingKey: "track-1",
      title: "Track one",
      type: "track",
    })
  ).toBe("track");
});

test("home cards expose the shared non-track hover state for every other media type", () => {
  expect(
    homeHubItemInteraction({
      key: "/library/metadata/album-1",
      ratingKey: "album-1",
      title: "Album one",
      type: "album",
    })
  ).toBe("other");
  expect(
    homeHubItemInteraction({
      key: "/library/metadata/artist-1",
      ratingKey: "artist-1",
      title: "Artist one",
      type: "artist",
    })
  ).toBe("other");
  expect(
    homeHubItemInteraction({
      key: "/playlists/playlist-1/items",
      ratingKey: "playlist-1",
      title: "Playlist one",
      type: "playlist",
    })
  ).toBe("other");
});
