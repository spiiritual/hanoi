import { expect, test } from "bun:test";
import {
  composeHomeHubs,
  PlexClient,
  replaceRecentlyPlayedPreview,
} from "../src/bun/plex/client.ts";

test("home hubs combine populated music-section rows with audio playlists", async () => {
  const sectionHubs = [
    {
      title: "Recently Played Music",
      hubIdentifier: "music.recent.played.1",
      Metadata: [
        {
          ratingKey: "artist-1",
          key: "/library/metadata/artist-1",
          type: "artist",
          title: "Artist",
        },
      ],
    },
    {
      title: "Recently Added in Music",
      hubIdentifier: "music.recent.added.1",
      Metadata: [
        {
          ratingKey: "album-1",
          key: "/library/metadata/album-1",
          type: "album",
          title: "Album",
          parentTitle: "Artist",
        },
      ],
    },
    {
      title: "Recently Added Movies",
      hubIdentifier: "movie.recent",
      Metadata: [
        {
          ratingKey: "movie-1",
          key: "/library/metadata/movie-1",
          type: "movie",
          title: "Movie",
        },
      ],
    },
  ];
  const globalHubs = [
    {
      title: "Recently Added Music",
      hubIdentifier: "home.music.recent.added",
      Metadata: [
        {
          ratingKey: "album-1",
          key: "/library/metadata/album-1",
          type: "album",
          title: "Duplicate album row",
          parentTitle: "Artist",
        },
      ],
    },
    {
      title: "Recent Playlists",
      hubIdentifier: "home.playlists",
      Metadata: [
        {
          ratingKey: "playlist-1",
          key: "/playlists/playlist-1/items",
          type: "playlist",
          title: "Road trip",
          playlistType: "audio",
        },
      ],
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
      title: "Recently Played Music",
      hubIdentifier: "music.recent.played.1",
      Metadata: [
        {
          ratingKey: "artist-preview",
          key: "/library/metadata/artist-preview",
          type: "artist",
          title: "Artist preview",
        },
      ],
    },
    {
      title: "Recently Added in Music",
      hubIdentifier: "music.recent.added.1",
      Metadata: [],
    },
  ];
  const recentItems = [
    {
      ratingKey: "artist-1",
      key: "/library/metadata/artist-1",
      type: "artist",
      title: "Artist",
    },
    {
      ratingKey: "album-1",
      key: "/library/metadata/album-1",
      type: "album",
      title: "Album",
      parentTitle: "Artist",
    },
    {
      ratingKey: "track-1",
      key: "/library/metadata/track-1",
      type: "track",
      title: "Track",
      parentTitle: "Album",
      grandparentTitle: "Artist",
    },
    {
      ratingKey: "artist-2",
      key: "/library/metadata/artist-2",
      type: "artist",
      title: "Another artist",
    },
    {
      ratingKey: "album-2",
      key: "/library/metadata/album-2",
      type: "album",
      title: "Another album",
      parentTitle: "Another artist",
    },
    {
      ratingKey: "track-2",
      key: "/library/metadata/track-2",
      type: "track",
      title: "Another track",
    },
    {
      ratingKey: "album-3",
      key: "/library/metadata/album-3",
      type: "album",
      title: "Outside preview",
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

test("home hub item requests load the full category from Plex's hub key", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return Response.json({
      MediaContainer: {
        size: 2,
        Metadata: [
          {
            ratingKey: "album-1",
            key: "/library/metadata/album-1",
            type: "album",
            title: "Album one",
          },
          {
            ratingKey: "album-2",
            key: "/library/metadata/album-2",
            type: "album",
            title: "Album two",
          },
        ],
      },
    });
  };

  try {
    const client = new PlexClient({ url: "http://plex.test", token: "test-token" });
    const items = await client.getHomeHubItems("/library/sections/1/all?type=9&sort=addedAt:desc");
    expect(items.map((item) => item.title)).toEqual(["Album one", "Album two"]);
    expect(requestedUrls).toEqual([
      "http://plex.test/library/sections/1/all?type=9&sort=addedAt:desc",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
