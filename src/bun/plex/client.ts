import { z } from "zod";

import { connectionCandidates, discoverServers } from "./auth.ts";
import type { PlexConnection, PlexServerResource } from "./auth.ts";
import {
  container,
  filterItems,
  parseStrict,
  albumSchema,
  artistSchema,
  hubItemSchema,
  hubSchema,
  playlistSchema,
  plexAccountSchema,
  sectionSchema,
  trackSchema,
} from "./schemas.ts";
import type {
  PlexAlbum,
  PlexArtist,
  PlexHub,
  PlexHubItem,
  PlexMetadata,
  PlexPlaylist,
  PlexSection,
  PlexTrack,
} from "./schemas.ts";
import type { PlexServerInfo, PlexAccount } from "./types.ts";

export interface PlexClientOptions {
  /** Base URL of the Plex Media Server, e.g. http://192.168.1.10:32400 */
  url: string;
  /** Plex API token (X-Plex-Token). */
  token: string;
  /** Persistent client identifier sent with plex.tv requests. */
  clientIdentifier?: string;
}

/** Sort/limit options every browse call accepts. */
export interface BrowseOptions {
  /** Plex sort key, e.g. `addedAt:desc`, `titleSort:asc`, `viewCount:desc`. */
  sort?: string;
  /** Raw Plex filter expression, e.g. `genre=Soundtrack`. */
  filter?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_STATUS_TIMEOUT_MS = 3000;
const RECENTLY_PLAYED_HUB_PREFIX = "music.recent.played.";

interface RawMetadataItem {
  type?: string;
}

type MetadataItem =
  | PlexAlbum
  | PlexArtist
  | PlexTrack
  | PlexPlaylist
  | RawMetadataItem;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

export type ServerConnectionProbe = (
  url: string,
  token: string
) => Promise<boolean>;

const isAudioHomeItem = (item: PlexHubItem): boolean => {
  if (
    item.type === "artist" ||
    item.type === "album" ||
    item.type === "track"
  ) {
    return true;
  }
  return item.type === "playlist" && item.playlistType !== "video";
};

const hasAudioHomeItems = (hub: PlexHub): boolean =>
  (hub.Metadata ?? []).some(isAudioHomeItem);

const hasAudioPlaylist = (hub: PlexHub): boolean =>
  (hub.Metadata ?? []).some(
    (item) => item.type === "playlist" && item.playlistType !== "video"
  );

/**
 * Plex exposes general home hubs and music-library hubs through separate
 * endpoints. Use the music-library order as the main home surface, then keep
 * useful global audio playlist rows that are not part of that response.
 */
export const composeHomeHubs = (
  sectionHubs: PlexHub[],
  globalHubs: PlexHub[]
): PlexHub[] => {
  const musicRows = sectionHubs.filter(hasAudioHomeItems);
  if (musicRows.length === 0) {
    return globalHubs.filter(hasAudioHomeItems);
  }

  const sectionIdentifiers = new Set(
    musicRows
      .map((hub) => hub.hubIdentifier)
      .filter((identifier): identifier is string => Boolean(identifier))
  );
  const globalPlaylistRows = globalHubs.filter(
    (hub) =>
      hasAudioPlaylist(hub) &&
      (hub.hubIdentifier === undefined ||
        hub.hubIdentifier.length === 0 ||
        !sectionIdentifiers.has(hub.hubIdentifier))
  );
  return [...musicRows, ...globalPlaylistRows];
};

/** Replace Plex's artist-only recent-play hub with the mixed activity preview. */
export const replaceRecentlyPlayedPreview = (
  hubs: PlexHub[],
  recentlyPlayed: PlexHubItem[]
): PlexHub[] => {
  if (recentlyPlayed.length === 0) {
    return hubs;
  }
  let replaced = false;
  return hubs.map((hub) => {
    if (
      replaced ||
      hub.hubIdentifier === undefined ||
      hub.hubIdentifier.length === 0 ||
      !hub.hubIdentifier.startsWith(RECENTLY_PLAYED_HUB_PREFIX)
    ) {
      return hub;
    }
    replaced = true;
    return { ...hub, Metadata: recentlyPlayed };
  });
};

export const checkPlexServerStatus = async (
  url: string,
  token: string
): Promise<boolean> => {
  try {
    const res = await fetch(`${url.replace(/\/+$/u, "")}/identity`, {
      headers: { Accept: "application/json", "X-Plex-Token": token },
      signal: AbortSignal.timeout(DEFAULT_STATUS_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
};

/** Probe all candidates concurrently and return the first reachable one. */
export const selectReachableConnection = async (
  resource: PlexServerResource,
  token: string,
  probe: ServerConnectionProbe = checkPlexServerStatus
): Promise<PlexConnection | undefined> => {
  const candidates = connectionCandidates(resource);
  const probes = candidates.map(async (connection) => {
    try {
      if (await probe(connection.uri, token)) {
        return connection;
      }
    } catch {
      // A failed candidate is expected while trying the remaining connections.
    }
    throw new Error(`Plex connection is unreachable: ${connection.uri}`);
  });

  try {
    return await Promise.any(probes);
  } catch {
    return undefined;
  }
};

/** The account's Plex.tv profile. Token-only — usable before a server is selected. */
export const getPlexAccount = async (token: string): Promise<PlexAccount> => {
  const res = await fetch("https://plex.tv/api/v2/user", {
    headers: {
      Accept: "application/json",
      "X-Plex-Token": token,
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Plex account: ${res.status} ${res.statusText}`
    );
  }
  // SAFETY: The parsed value is intentionally kept unknown until plexAccountSchema validates it.
  // SAFETY: The response is validated by plexAccountSchema before use.
  const user = (await res.json()) as unknown;
  const parsed = parseStrict(plexAccountSchema, user, "plex.tv /api/v2/user");
  if (!parsed) {
    throw new Error(
      "Failed to fetch Plex account: unexpected response from plex.tv"
    );
  }
  return {
    email: parsed.email,
    thumb: parsed.thumb,
    username: parsed.username,
    verified: parsed.confirmed === true,
  };
};

/** Servers owned by the account, each with its best connection URI. */
export const discoverPlexServers = async (
  token: string,
  clientIdentifier: string
): Promise<PlexServerInfo[]> => {
  const resources = await discoverServers(token, clientIdentifier);
  return await Promise.all(
    resources.map(async (resource) => {
      const serverToken = resource.accessToken ?? token;
      const candidates = connectionCandidates(resource);
      const selected = await selectReachableConnection(resource, serverToken);
      const [fallback] = candidates;
      const connection = selected ?? fallback;
      return {
        clientIdentifier: resource.clientIdentifier,
        local: connection?.local ?? false,
        name: resource.name,
        online: selected !== undefined,
        token: serverToken,
        url: connection?.uri ?? "",
      };
    })
  );
};

export class PlexClient {
  private readonly _baseUrl: string;
  private readonly _token: string;
  private readonly _clientIdentifier: string;

  constructor({ url, token, clientIdentifier }: PlexClientOptions) {
    this._baseUrl = url.replace(/\/+$/u, "");
    this._token = token;
    this._clientIdentifier = clientIdentifier ?? "";
  }

  private async request(path: string): Promise<JsonValue> {
    const res = await fetch(`${this._baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        "X-Plex-Token": this._token,
      },
    });
    if (!res.ok) {
      throw new Error(
        `Plex request failed: ${res.status} ${res.statusText} for ${path}`
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new Error(
        `Plex returned ${contentType || "non-JSON"} for ${path}; expected application/json`
      );
    }
    const payload = jsonValueSchema.safeParse(await res.json());
    if (!payload.success) {
      throw new Error(`Plex returned an invalid JSON payload for ${path}`);
    }
    return payload.data;
  }

  /**
   * Fire-and-forget request for the legacy action endpoints (`/:/scrobble`,
   * `/:/unscrobble`), which reply with an HTML page rather than JSON — the
   * `request()` content-type gate would reject them after the server had
   * already applied the change.
   */
  private async requestRaw(path: string): Promise<void> {
    const res = await fetch(`${this._baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        "X-Plex-Token": this._token,
      },
    });
    if (!res.ok) {
      throw new Error(
        `Plex request failed: ${res.status} ${res.statusText} for ${path}`
      );
    }
    // Drain the body so the connection is reusable.
    await res.arrayBuffer();
  }

  private static buildBrowsePath(
    sectionKey: string | number,
    type: number,
    opts?: BrowseOptions
  ): string {
    const params = new URLSearchParams();
    params.set("type", String(type));
    if (opts?.sort !== undefined && opts.sort !== "") {
      params.set("sort", opts.sort);
    }
    if (opts?.filter !== undefined && opts.filter !== "") {
      params.set("filter", opts.filter);
    }
    if (opts?.limit !== undefined) {
      params.set("limit", String(opts.limit));
    }
    if (opts?.offset !== undefined) {
      params.set("offset", String(opts.offset));
    }
    return `/library/sections/${sectionKey}/all?${params.toString()}`;
  }

  /** Fetch a `Metadata[]` container and validate its items with a per-type schema. */
  private async parseItems<T>(
    sectionKey: string | number,
    type: number,
    opts: BrowseOptions | undefined,
    schema: z.ZodType<T>,
    path: string = PlexClient.buildBrowsePath(sectionKey, type, opts)
  ): Promise<T[]> {
    const payload = await this.request(path);
    const envelope = container<{ Metadata?: unknown[] }>(payload, path);
    const items = envelope.MediaContainer?.Metadata ?? [];
    return filterItems(schema, items, path);
  }

  /** Fetch `/library/metadata/{ratingKey}` and validate the items against a per-type schema. */
  private async parseMetadata(
    ratingKey: string | number
  ): Promise<{ items: MetadataItem[]; totals: PlexMetadata }> {
    const path = `/library/metadata/${ratingKey}`;
    const payload = await this.request(path);
    const envelope = container<{ Metadata?: RawMetadataItem[] } & PlexMetadata>(
      payload,
      path
    );
    const mc = envelope.MediaContainer;
    const items = mc?.Metadata ?? [];
    const [sample] = items;
    const sampleType = sample?.type;
    switch (sampleType) {
      case "album": {
        return {
          items: filterItems(albumSchema, items, path),
          totals: PlexClient.totals(mc ?? {}),
        };
      }
      case "artist": {
        return {
          items: filterItems(artistSchema, items, path),
          totals: PlexClient.totals(mc ?? {}),
        };
      }
      case "track": {
        return {
          items: filterItems(trackSchema, items, path),
          totals: PlexClient.totals(mc ?? {}),
        };
      }
      case "playlist": {
        return {
          items: filterItems(playlistSchema, items, path),
          totals: PlexClient.totals(mc ?? {}),
        };
      }
      case undefined: {
        return {
          items,
          totals: PlexClient.totals(mc ?? {}),
        };
      }
      default: {
        console.error(
          `Plex response validation skipped for unknown item type (${path}): ${sampleType}`
        );
        return {
          items,
          totals: PlexClient.totals(mc ?? {}),
        };
      }
    }
  }

  private static totals(envelope: {
    size?: number;
    leafCount?: number;
    duration?: number;
  }): PlexMetadata {
    return {
      duration: envelope.duration,
      leafCount: envelope.leafCount,
      size: envelope.size,
    };
  }

  /**
   * Fetch a `{ key: T[] }` container (Metadata/Directory/Hub) and validate
   * its items against a schema. Items missing required fields are dropped
   * (logged); valid items pass through with unknown fields preserved.
   */
  private async parseContainerArray<T>(
    path: string,
    schema: z.ZodType<T>,
    key: "Metadata" | "Hub" | "Directory"
  ): Promise<T[]> {
    const payload = await this.request(path);
    const envelope = container<Record<string, T[]>>(payload, path);
    const items = envelope.MediaContainer?.[key] ?? [];
    if (items.length === 0) {
      return [];
    }
    return filterItems(schema, items, path);
  }

  /** All library sections. */
  async getSections(): Promise<PlexSection[]> {
    return await this.parseContainerArray<PlexSection>(
      "/library/sections",
      sectionSchema,
      "Directory"
    );
  }

  /** Sections whose type is "artist" (music libraries). */
  async getMusicSections(): Promise<PlexSection[]> {
    const sections = await this.getSections();
    return sections.filter((s) => s.type === "artist");
  }

  /** Artists in a library section, with optional sort/filter/limit. */
  async getArtists(
    sectionKey: string | number,
    opts?: BrowseOptions
  ): Promise<PlexArtist[]> {
    return await this.parseItems(sectionKey, 8, opts, artistSchema);
  }

  /** Albums in a library section, with optional sort/filter/limit. */
  async getAlbums(
    sectionKey: string | number,
    opts?: BrowseOptions
  ): Promise<PlexAlbum[]> {
    return await this.parseItems(sectionKey, 9, opts, albumSchema);
  }

  /** Tracks in a library section, with optional sort/filter/limit. */
  async getTracks(
    sectionKey: string | number,
    opts?: BrowseOptions
  ): Promise<PlexTrack[]> {
    return await this.parseItems(sectionKey, 10, opts, trackSchema);
  }

  /**
   * Items of a given Plex media type in a library section, via
   * `/library/sections/{key}/all?type=N`. Music types: 8=artist, 9=album,
   * 10=track. Other common types: 1=movie, 2=show, 4=episode, 13=photo,
   * 14=photoalbum, 18=collection.
   */
  async getItems(
    sectionKey: string | number,
    type: 8,
    opts?: BrowseOptions
  ): Promise<PlexArtist[]>;
  async getItems(
    sectionKey: string | number,
    type: 9,
    opts?: BrowseOptions
  ): Promise<PlexAlbum[]>;
  async getItems(
    sectionKey: string | number,
    type: 10,
    opts?: BrowseOptions
  ): Promise<PlexTrack[]>;
  async getItems(
    sectionKey: string | number,
    type: number,
    opts?: BrowseOptions
  ): Promise<PlexHubItem[]>;
  async getItems(
    sectionKey: string | number,
    type: number,
    opts?: BrowseOptions
  ): Promise<PlexHubItem[]> {
    switch (type) {
      case 8: {
        return await this.parseItems(sectionKey, type, opts, artistSchema);
      }
      case 9: {
        return await this.parseItems(sectionKey, type, opts, albumSchema);
      }
      case 10: {
        return await this.parseItems(sectionKey, type, opts, trackSchema);
      }
      default: {
        return await this.parseItems(sectionKey, type, opts, hubItemSchema);
      }
    }
  }

  /** All playlists on the server. */
  async getPlaylists(): Promise<PlexPlaylist[]> {
    return await this.parseContainerArray<PlexPlaylist>(
      "/playlists",
      playlistSchema,
      "Metadata"
    );
  }

  /** Music (audio) playlists on the server. */
  async getMusicPlaylists(): Promise<PlexPlaylist[]> {
    const playlists = await this.getPlaylists();
    return playlists.filter((p) => p.playlistType === "audio");
  }

  /** All artists across every music section, deduplicated by rating key. */
  async getAllArtists(): Promise<PlexArtist[]> {
    return await this.getAllByType(8);
  }

  /** All albums across every music section, deduplicated by rating key. */
  async getAllAlbums(): Promise<PlexAlbum[]> {
    return await this.getAllByType(9);
  }

  /** All tracks across every music section, deduplicated by rating key. */
  async getAllTracks(): Promise<PlexTrack[]> {
    return await this.getAllByType(10);
  }

  /** Items of one media type across every music section, deduplicated by rating key. */
  private async getAllByType(type: 8): Promise<PlexArtist[]>;
  private async getAllByType(type: 9): Promise<PlexAlbum[]>;
  private async getAllByType(type: 10): Promise<PlexTrack[]>;
  private async getAllByType(type: number): Promise<PlexHubItem[]> {
    const sections = await this.getMusicSections();
    const perSection = await Promise.all(
      sections.map(async (section) => await this.getItems(section.key, type))
    );
    const seen = new Set<string>();
    return perSection.flat().filter((item) => {
      if (seen.has(item.ratingKey)) {
        return false;
      }
      seen.add(item.ratingKey);
      return true;
    });
  }

  /**
   * Search the whole server via `/hubs/search`, grouped by media type for
   * the Search screen's split Songs/Albums/Artists columns. Playlists are
   * excluded; the result is exactly `{artists, albums, tracks}`.
   */
  async search(query: string): Promise<{
    artists: PlexArtist[];
    albums: PlexAlbum[];
    tracks: PlexTrack[];
  }> {
    const trimmed = query.trim();
    const empty = {
      albums: [],
      artists: [],
      tracks: [],
    } satisfies {
      artists: PlexArtist[];
      albums: PlexAlbum[];
      tracks: PlexTrack[];
    };
    if (!trimmed) {
      return empty;
    }
    const path = `/hubs/search?query=${encodeURIComponent(trimmed)}&limit=20`;
    const hubs = await this.parseContainerArray<PlexHub>(
      path,
      hubSchema,
      "Hub"
    );
    const items = hubs.flatMap((hub) => hub.Metadata ?? []);
    const artists: PlexArtist[] = [];
    const albums: PlexAlbum[] = [];
    const tracks: PlexTrack[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.ratingKey)) {
        continue;
      }
      seen.add(item.ratingKey);
      switch (item.type) {
        case "artist": {
          const [artist] = filterItems(artistSchema, [item], path);
          if (artist !== undefined) {
            artists.push(artist);
          }
          break;
        }
        case "album": {
          const [album] = filterItems(albumSchema, [item], path);
          if (album !== undefined) {
            albums.push(album);
          }
          break;
        }
        case "track": {
          const [track] = filterItems(trackSchema, [item], path);
          if (track !== undefined) {
            tracks.push(track);
          }
          break;
        }
        default: {
          break;
        }
      }
    }
    return { albums, artists, tracks };
  }

  /**
   * Home-screen hub groupings. Plex's global `/hubs` response only contains a
   * subset of music rows, so the default request combines it with each music
   * section's `/hubs/sections/{key}` response. `identifiers` preserves the
   * direct global-hub query for callers that need a specific hub set.
   */
  async getHomeHubs(identifiers?: string[]): Promise<PlexHub[]> {
    const hasIdentifiers = identifiers !== undefined && identifiers.length > 0;
    const query = hasIdentifiers ? `?identifier=${identifiers.join(",")}` : "";
    if (hasIdentifiers) {
      return await this.parseContainerArray<PlexHub>(
        `/hubs${query}`,
        hubSchema,
        "Hub"
      );
    }

    const [globalHubs, sections] = await Promise.all([
      this.parseContainerArray<PlexHub>("/hubs", hubSchema, "Hub"),
      this.getMusicSections(),
    ]);
    if (sections.length === 0) {
      return globalHubs;
    }
    const [sectionHubGroups, recentlyPlayed] = await Promise.all([
      Promise.all(
        sections.map(async (section) => await this.getSectionHubs(section.key))
      ),
      this.getRecentlyPlayedForSections(sections),
    ]);
    return replaceRecentlyPlayedPreview(
      composeHomeHubs(sectionHubGroups.flat(), globalHubs),
      recentlyPlayed
    );
  }

  /** Hubs for a library section via `/hubs/sections/{key}`. */
  async getSectionHubs(sectionKey: string | number): Promise<PlexHub[]> {
    return await this.parseContainerArray<PlexHub>(
      `/hubs/sections/${sectionKey}`,
      hubSchema,
      "Hub"
    );
  }

  /** Load every item for a Home row from the full-data key Plex attaches to the hub. */
  async getHomeHubItems(key: string): Promise<PlexHubItem[]> {
    return await this.parseContainerArray<PlexHubItem>(
      key,
      hubItemSchema,
      "Metadata"
    );
  }

  /**
   * Recently played music across all music sections: artists, albums, and
   * tracks, most recently played first. The `music.recent.played` hub only
   * covers artists, so each type is fetched via the hub's underlying query
   * (`viewCount>=1&sort=lastViewedAt:desc`) and merged.
   */
  async getRecentlyPlayed(): Promise<PlexHubItem[]> {
    const sections = await this.getMusicSections();
    return await this.getRecentlyPlayedForSections(sections);
  }

  private async getRecentlyPlayedForSections(
    sections: PlexSection[]
  ): Promise<PlexHubItem[]> {
    const perSection = await Promise.all(
      sections.map(async (section) => {
        const [artists, albums, tracks] = await Promise.all([
          this.getRecentlyPlayedByType(section.key, 8),
          this.getRecentlyPlayedByType(section.key, 9),
          this.getRecentlyPlayedByType(section.key, 10),
        ]);
        return [...artists, ...albums, ...tracks];
      })
    );
    const seen = new Set<string>();
    const unique = perSection.flat().filter((item) => {
      if (seen.has(item.ratingKey)) {
        return false;
      }
      seen.add(item.ratingKey);
      return true;
    });
    return unique.toSorted(
      (a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0)
    );
  }

  /** Recently played items of one media type in a section, newest first. */
  private async getRecentlyPlayedByType(
    sectionKey: string | number,
    type: number
  ): Promise<PlexHubItem[]> {
    return await this.parseContainerArray<PlexHubItem>(
      `/library/sections/${sectionKey}/all?viewCount%3E=1&type=${type}&sort=lastViewedAt:desc`,
      hubItemSchema,
      "Metadata"
    );
  }

  /**
   * Most-played tracks across all music sections, by `viewCount`.
   * `sinceMs` (epoch ms) filters to tracks added since that time — the Home
   * "Most Played in December" row passes the start of December.
   */
  async getMostPlayed(sinceMs?: number): Promise<PlexHubItem[]> {
    const sections = await this.getMusicSections();
    const perSection = await Promise.all(
      sections.map(async (section) => {
        const since =
          sinceMs === undefined
            ? undefined
            : new Date(sinceMs).getTime() / 1000;
        const addedAtQuery =
          since === undefined ? "" : `&addedAt%3E=${Math.floor(since)}`;
        return await this.parseContainerArray<PlexHubItem>(
          `/library/sections/${section.key}/all?viewCount%3E=1&type=10&sort=viewCount:desc${addedAtQuery}`,
          hubItemSchema,
          "Metadata"
        );
      })
    );
    const seen = new Set<string>();
    const unique = perSection.flat().filter((item) => {
      if (seen.has(item.ratingKey)) {
        return false;
      }
      seen.add(item.ratingKey);
      return true;
    });
    return unique.toSorted((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
  }

  /**
   * Metadata for one item via `/library/metadata/{ratingKey}`. The returned
   * `PlexMetadata` carries the top-level `MediaContainer` totals
   * (`size`/`leafCount`/`duration`) that drive the "N songs, M min" headers.
   */
  async getMetadata(
    ratingKey: string | number
  ): Promise<{ items: MetadataItem[]; totals: PlexMetadata }> {
    return await this.parseMetadata(ratingKey);
  }

  /** Album metadata + its tracks, in Plex track order (disc, then index). */
  async getAlbum(ratingKey: string | number): Promise<{
    album: PlexAlbum;
    tracks: PlexTrack[];
  }> {
    const { items } = await this.getMetadata(ratingKey);
    const album = items.find(
      (item): item is PlexAlbum => item.type === "album"
    );
    const tracks = await this.parseContainerArray<PlexTrack>(
      `/library/metadata/${ratingKey}/children`,
      trackSchema,
      "Metadata"
    );
    return {
      album: album ?? {
        key: "",
        ratingKey: String(ratingKey),
        title: "",
        type: "album",
      },
      tracks: tracks.filter((item) => item.type === "track"),
    };
  }

  /** Artist detail: metadata + counts, "Your Top Songs", and albums. */
  async getArtist(ratingKey: string | number): Promise<{
    artist: PlexArtist;
    genres: string[];
    albumCount: number;
    songCount: number;
    topTracks: PlexTrack[];
    albums: PlexAlbum[];
  }> {
    const { items } = await this.getMetadata(ratingKey);
    const artist = items.find(
      (item): item is PlexArtist => item.type === "artist"
    );
    const genres = artist?.Genre?.map((g) => g.tag) ?? [];

    // Plex does not populate childCount/leafCount on artist metadata, so
    // counts come from full unfiltered queries (`size` = exact total).
    const sections = await this.getMusicSections();
    // The section-wide `parentRatingKey` query is not consistently honored by
    // Plex servers. The artist children endpoint is scoped to this artist and
    // avoids leaking albums from the rest of the library into the detail view.
    const albumsPromise = this.parseContainerArray<PlexAlbum>(
      `/library/metadata/${ratingKey}/children`,
      albumSchema,
      "Metadata"
    );
    const perSection = await Promise.all(
      sections.map(async (section) => {
        const tracksParams = new URLSearchParams({
          filter: `artist.id=${ratingKey}`,
          sort: "viewCount:desc",
          type: "10",
        });
        const tracksData = await this.parseContainerArray<PlexTrack>(
          `/library/sections/${section.key}/all?${tracksParams.toString()}`,
          trackSchema,
          "Metadata"
        );
        return { tracks: tracksData };
      })
    );
    const artistAlbums = await albumsPromise;
    let totalSongs = 0;
    for (const section of perSection) {
      totalSongs += section.tracks.length;
    }
    const totalAlbums = artistAlbums.length;

    const seenTracks = new Set<string>();
    const tracks: PlexTrack[] = [];
    for (const section of perSection) {
      for (const track of section.tracks) {
        if (seenTracks.has(track.ratingKey)) {
          continue;
        }
        seenTracks.add(track.ratingKey);
        tracks.push(track);
      }
    }
    const seenAlbums = new Set<string>();
    const albums = artistAlbums.filter((album) => {
      if (seenAlbums.has(album.ratingKey)) {
        return false;
      }
      seenAlbums.add(album.ratingKey);
      return true;
    });

    return {
      albumCount: totalAlbums > 0 ? totalAlbums : (artist?.childCount ?? 0),
      albums,
      artist: artist ?? {
        key: "",
        ratingKey: String(ratingKey),
        title: "",
        type: "artist",
      },
      genres,
      songCount: totalSongs > 0 ? totalSongs : (artist?.leafCount ?? 0),
      topTracks: tracks.slice(0, 30),
    };
  }

  /** Playlist metadata plus its items (tracks) via `/playlists/{id}/items`. */
  async getPlaylist(key: string | number): Promise<{
    playlist: PlexPlaylist;
    tracks: PlexTrack[];
  }> {
    const playlists = await this.parseContainerArray<PlexPlaylist>(
      `/playlists/${key}`,
      playlistSchema,
      "Metadata"
    );
    const playlist = playlists[0] ?? {
      key: `/playlists/${key}`,
      ratingKey: String(key),
      title: "",
      type: "playlist",
    };
    const tracks = await this.parseContainerArray<PlexTrack>(
      `/playlists/${key}/items`,
      trackSchema,
      "Metadata"
    );
    return {
      playlist,
      tracks,
    };
  }

  /**
   * The current user's Plex.tv account profile (username, email, verified)
   * via `/api/v2/user`, for the Sidebar user row and Connected card.
   */
  async getAccount(): Promise<PlexAccount> {
    return await getPlexAccount(this._token);
  }

  /**
   * Servers owned by the account, each with its best connection URI and a
   * fresh `/identity` reachability check (parallel, short timeout). Used by
   * Server Selection and the sidebar dropdown; never persisted.
   */
  async getServers(): Promise<PlexServerInfo[]> {
    return await discoverPlexServers(this._token, this._clientIdentifier);
  }

  /** Reachability of a server: GET `/identity` with the token, ~3s timeout. */
  async checkServerStatus(url: string, token?: string): Promise<boolean> {
    return await checkPlexServerStatus(url, token ?? this._token);
  }

  /**
   * Mark a track as played/unplayed via `/:/scrobble`/`/:/unscrobble` —
   * increments/decrements the `viewCount` that powers "X plays".
   */
  async scrobble(key: string): Promise<void> {
    await this.requestRaw(
      `/:/scrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(key)}`
    );
  }

  async unscrobble(key: string): Promise<void> {
    await this.requestRaw(
      `/:/unscrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(key)}`
    );
  }

  /** Server base URL; used to build media URLs (e.g. streamUrl). */
  get baseUrl(): string {
    return this._baseUrl;
  }

  /** Account token; used to build media URLs (e.g. streamUrl). */
  get token(): string {
    return this._token;
  }
}
