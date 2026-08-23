import { expect, test } from "bun:test";
import type { PlexHub } from "../src/bun/plex/types.ts";
import { createHomeState } from "../src/mainview/home/state.ts";
import { filterMusicHomeHubs } from "../src/mainview/home/utils.ts";

const recentlyPlayed = {
  key: "/hubs/home/music/recent",
  title: "Recently Played Music",
  type: "mixed",
  hubIdentifier: "home.music.recent",
  Metadata: [
    {
      ratingKey: "album-1",
      key: "/library/metadata/album-1",
      type: "album",
      title: "In Rainbows",
      parentTitle: "Radiohead",
    },
  ],
} as PlexHub;

const recentlyAdded = {
  key: "/hubs/home/music/added",
  title: "Recently Added Music",
  type: "album",
  hubIdentifier: "home.music.recent.added",
  Metadata: [
    {
      ratingKey: "album-2",
      key: "/library/metadata/album-2",
      type: "album",
      title: "Kid A",
      parentTitle: "Radiohead",
    },
  ],
} as PlexHub;

test("home hub loading is shared and preserves Plex row categories", async () => {
  let loadCount = 0;
  const homeState = createHomeState({
    loadHomeHubs: async () => {
      loadCount += 1;
      return [recentlyPlayed, recentlyAdded];
    },
  });
  homeState.setServer("server-1");

  const [first, second] = await Promise.all([homeState.loadHomeHubs(), homeState.loadHomeHubs()]);

  expect(loadCount).toBe(1);
  expect(first.map((hub) => hub.hubIdentifier)).toEqual([
    "home.music.recent",
    "home.music.recent.added",
  ]);
  expect(second).toEqual(first);
  expect(homeState.getSnapshot()).toMatchObject({
    status: "ready",
    hubs: [recentlyPlayed, recentlyAdded],
    error: null,
  });
});

test("home rows keep Plex order and exclude hubs without music metadata", () => {
  const movieHub = {
    title: "Recently Added Movies",
    type: "movie",
    hubIdentifier: "movie.recentlyadded",
    Metadata: [
      {
        ratingKey: "movie-1",
        key: "/library/metadata/movie-1",
        type: "movie",
        title: "A Movie",
      },
    ],
  } as PlexHub;

  const mixedHub = {
    ...recentlyPlayed,
    hubIdentifier: "home.mixed",
    Metadata: [
      ...(recentlyPlayed.Metadata ?? []),
      {
        ratingKey: "movie-1",
        key: "/library/metadata/movie-1",
        type: "movie",
        title: "A Movie",
      },
      {
        ratingKey: "playlist-1",
        key: "/playlists/playlist-1/items",
        type: "playlist",
        title: "Watch Later",
        playlistType: "video",
      },
    ],
  } as PlexHub;

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
      loadCount += 1;
      if (loadCount === 1) throw new Error("Plex home unavailable");
      return [recentlyPlayed];
    },
  });
  homeState.setServer("server-1");

  let failure: unknown;
  try {
    await homeState.loadHomeHubs();
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", "Plex home unavailable");
  expect(homeState.getSnapshot()).toMatchObject({
    status: "error",
    error: "Plex home unavailable",
    hubs: [],
  });

  await homeState.loadHomeHubs();
  expect(homeState.getSnapshot()).toMatchObject({
    status: "ready",
    error: null,
    hubs: [recentlyPlayed],
  });
});

test("changing servers invalidates the cached home rows", async () => {
  let loadCount = 0;
  const homeState = createHomeState({
    loadHomeHubs: async () => {
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
