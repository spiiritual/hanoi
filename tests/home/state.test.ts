// oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- Hanoi tests use Bun's native runner.
import { expect, test } from "bun:test";

import type { PlexHub } from "../../src/bun/plex/types.ts";
import { createHomeState } from "../../src/mainview/home/state.ts";
import { filterMusicHomeHubs } from "../../src/mainview/home/utils.ts";

const recentlyPlayed = {
  Metadata: [
    {
      key: "/library/metadata/album-1",
      parentTitle: "Radiohead",
      ratingKey: "album-1",
      title: "In Rainbows",
      type: "album",
    },
  ],
  hubIdentifier: "home.music.recent",
  key: "/hubs/home/music/recent",
  title: "Recently Played Music",
  type: "mixed",
} satisfies PlexHub;

const recentlyAdded = {
  Metadata: [
    {
      key: "/library/metadata/album-2",
      parentTitle: "Radiohead",
      ratingKey: "album-2",
      title: "Kid A",
      type: "album",
    },
  ],
  hubIdentifier: "home.music.recent.added",
  key: "/hubs/home/music/added",
  title: "Recently Added Music",
  type: "album",
} satisfies PlexHub;

test("home hub loading is shared and preserves Plex row categories", async () => {
  let loadCount = 0;
  const homeState = createHomeState({
    loadHomeHubs: async () => {
      await Promise.resolve();
      loadCount += 1;
      return [recentlyPlayed, recentlyAdded];
    },
  });
  homeState.setServer("server-1");

  const [first, second] = await Promise.all([
    homeState.loadHomeHubs(),
    homeState.loadHomeHubs(),
  ]);

  expect(loadCount).toBe(1);
  expect(first.map((hub) => hub.hubIdentifier)).toEqual([
    "home.music.recent",
    "home.music.recent.added",
  ]);
  expect(second).toEqual(first);
  expect(homeState.getSnapshot()).toMatchObject({
    error: null,
    hubs: [recentlyPlayed, recentlyAdded],
    status: "ready",
  });
});

test("home rows keep Plex order and exclude hubs without music metadata", () => {
  const movieHub = {
    Metadata: [
      {
        key: "/library/metadata/movie-1",
        ratingKey: "movie-1",
        title: "A Movie",
        type: "movie",
      },
    ],
    hubIdentifier: "movie.recentlyadded",
    title: "Recently Added Movies",
    type: "movie",
  } satisfies PlexHub;

  const mixedHub = {
    ...recentlyPlayed,
    Metadata: [
      ...(recentlyPlayed.Metadata ?? []),
      {
        key: "/library/metadata/movie-1",
        ratingKey: "movie-1",
        title: "A Movie",
        type: "movie",
      },
      {
        key: "/playlists/playlist-1/items",
        playlistType: "video",
        ratingKey: "playlist-1",
        title: "Watch Later",
        type: "playlist",
      },
    ],
    hubIdentifier: "home.mixed",
  } satisfies PlexHub;

  const filtered = filterMusicHomeHubs([movieHub, recentlyAdded, mixedHub]);
  expect(filtered.map((hub) => hub.hubIdentifier)).toEqual([
    "home.music.recent.added",
    "home.mixed",
  ]);
  expect(filtered[1]?.Metadata?.map((item) => item.type)).toEqual(["album"]);
});

test("failed home hub loads expose an error and can be retried", async () => {
  let loadCount = 0;
  const homeState = createHomeState({
    loadHomeHubs: async () => {
      await Promise.resolve();
      loadCount += 1;
      if (loadCount === 1) {
        throw new Error("Plex home unavailable");
      }
      return [recentlyPlayed];
    },
  });
  homeState.setServer("server-1");

  let failure: unknown;
  try {
    await homeState.loadHomeHubs();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", "Plex home unavailable");
  expect(homeState.getSnapshot()).toMatchObject({
    error: "Plex home unavailable",
    hubs: [],
    status: "error",
  });

  await homeState.loadHomeHubs();
  expect(homeState.getSnapshot()).toMatchObject({
    error: null,
    hubs: [recentlyPlayed],
    status: "ready",
  });
});

test("changing servers invalidates the cached home rows", async () => {
  let loadCount = 0;
  const homeState = createHomeState({
    loadHomeHubs: async () => {
      await Promise.resolve();
      loadCount += 1;
      return [recentlyPlayed];
    },
  });

  homeState.setServer("server-1");
  await homeState.loadHomeHubs();
  homeState.setServer("server-2");
  await homeState.loadHomeHubs();

  expect(loadCount).toBe(2);
  expect(homeState.getSnapshot().status).toBe("ready");
});
