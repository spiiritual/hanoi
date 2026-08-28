import { expect, test } from "bun:test";

import {
  composeHomeHubs,
  PlexClient,
  replaceRecentlyPlayedPreview,
} from "../../src/bun/plex/client.ts";

test("home hubs combine populated music-section rows with audio playlists", () => {
  const sectionHubs = [
    {
      Metadata: [
        {
          key: "/library/metadata/artist-1",
          ratingKey: "artist-1",
          title: "Artist",
          type: "artist",
        },
      ],
      hubIdentifier: "music.recent.played.1",
      title: "Recently Played Music",
    },
    {
      Metadata: [
        {
          key: "/library/metadata/album-1",
          parentTitle: "Artist",
          ratingKey: "album-1",
          title: "Album",
          type: "album",
        },
      ],
      hubIdentifier: "music.recent.added.1",
      title: "Recently Added in Music",
    },
    {
      Metadata: [
        {
          key: "/library/metadata/movie-1",
          ratingKey: "movie-1",
          title: "Movie",
          type: "movie",
        },
      ],
      hubIdentifier: "movie.recent",
      title: "Recently Added Movies",
    },
  ];
  const globalHubs = [
    {
      Metadata: [
        {
          key: "/library/metadata/album-1",
          parentTitle: "Artist",
          ratingKey: "album-1",
          title: "Duplicate album row",
          type: "album",
        },
      ],
      hubIdentifier: "home.music.recent.added",
      title: "Recently Added Music",
    },
    {
      Metadata: [
        {
          key: "/playlists/playlist-1/items",
          playlistType: "audio",
          ratingKey: "playlist-1",
          title: "Road trip",
          type: "playlist",
        },
      ],
      hubIdentifier: "home.playlists",
      title: "Recent Playlists",
    },
  ];

  const hubs = composeHomeHubs(sectionHubs, globalHubs);
  expect(hubs.map((hub) => hub.hubIdentifier)).toEqual([
    "music.recent.played.1",
    "music.recent.added.1",
    "home.playlists",
  ]);
});

test("recently played Home preview uses mixed artist, album, and track items", () => {
  const hubs = [
    {
      Metadata: [
        {
          key: "/library/metadata/artist-preview",
          ratingKey: "artist-preview",
          title: "Artist preview",
          type: "artist",
        },
      ],
      hubIdentifier: "music.recent.played.1",
      title: "Recently Played Music",
    },
    {
      Metadata: [],
      hubIdentifier: "music.recent.added.1",
      title: "Recently Added in Music",
    },
  ];
  const recentItems = [
    {
      key: "/library/metadata/artist-1",
      ratingKey: "artist-1",
      title: "Artist",
      type: "artist",
    },
    {
      key: "/library/metadata/album-1",
      parentTitle: "Artist",
      ratingKey: "album-1",
      title: "Album",
      type: "album",
    },
    {
      grandparentTitle: "Artist",
      key: "/library/metadata/track-1",
      parentTitle: "Album",
      ratingKey: "track-1",
      title: "Track",
      type: "track",
    },
    {
      key: "/library/metadata/artist-2",
      ratingKey: "artist-2",
      title: "Another artist",
      type: "artist",
    },
    {
      key: "/library/metadata/album-2",
      parentTitle: "Another artist",
      ratingKey: "album-2",
      title: "Another album",
      type: "album",
    },
    {
      key: "/library/metadata/track-2",
      ratingKey: "track-2",
      title: "Another track",
      type: "track",
    },
    {
      key: "/library/metadata/album-3",
      ratingKey: "album-3",
      title: "Outside preview",
      type: "album",
    },
  ];

  const replaced = replaceRecentlyPlayedPreview(hubs, recentItems);
  expect(replaced[0]?.Metadata?.map((item) => item.type)).toEqual([
    "artist",
    "album",
    "track",
    "artist",
    "album",
    "track",
    "album",
  ]);
  expect(replaced[0]?.Metadata).toHaveLength(7);
  expect(replaced[1]).toEqual(hubs[1]);
});

const requestUrl = (input: RequestInfo | URL): string => {
  if (input instanceof Request) {
    return input.url;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input;
};

test("home hub item requests load the full category from Plex's hub key", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      await Promise.resolve();
      requestedUrls.push(requestUrl(input));
      return Response.json({
        MediaContainer: {
          Metadata: [
            {
              key: "/library/metadata/album-1",
              ratingKey: "album-1",
              title: "Album one",
              type: "album",
            },
            {
              key: "/library/metadata/album-2",
              ratingKey: "album-2",
              title: "Album two",
              type: "album",
            },
          ],
          size: 2,
        },
      });
    },
    { preconnect: originalFetch.preconnect }
  );

  try {
    const client = new PlexClient({
      token: "test-token",
      url: "http://plex.test",
    });
    const items = await client.getHomeHubItems(
      "/library/sections/1/all?type=9&sort=addedAt:desc"
    );
    expect(items.map((item) => item.title)).toEqual(["Album one", "Album two"]);
    expect(requestedUrls).toEqual([
      "http://plex.test/library/sections/1/all?type=9&sort=addedAt:desc",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
