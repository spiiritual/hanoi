import { z } from "zod";
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
	type PlexAlbum,
	type PlexArtist,
	type PlexHub,
	type PlexHubItem,
	type PlexMetadata,
	type PlexPlaylist,
	type PlexSection,
	type PlexTrack,
} from "./schemas.ts";
import type { PlexServerInfo, PlexAccount } from "./types.ts";
import {
	connectionCandidates,
	discoverServers,
	type PlexConnection,
	type PlexServerResource,
} from "./auth.ts";

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

export type ServerConnectionProbe = (url: string, token: string) => Promise<boolean>;

function isAudioHomeItem(item: PlexHubItem): boolean {
	return (
		item.type === "artist" ||
		item.type === "album" ||
		item.type === "track" ||
		(item.type === "playlist" && item.playlistType !== "video")
	);
}

function hasAudioHomeItems(hub: PlexHub): boolean {
	return (hub.Metadata ?? []).some(isAudioHomeItem);
}

function hasAudioPlaylist(hub: PlexHub): boolean {
	return (hub.Metadata ?? []).some(
		(item) => item.type === "playlist" && item.playlistType !== "video",
	);
}

/**
 * Plex exposes general home hubs and music-library hubs through separate
 * endpoints. Use the music-library order as the main home surface, then keep
 * useful global audio playlist rows that are not part of that response.
 */
export function composeHomeHubs(sectionHubs: PlexHub[], globalHubs: PlexHub[]): PlexHub[] {
	const musicRows = sectionHubs.filter(hasAudioHomeItems);
	if (musicRows.length === 0) return globalHubs.filter(hasAudioHomeItems);

	const sectionIdentifiers = new Set(
		musicRows
			.map((hub) => hub.hubIdentifier)
			.filter((identifier): identifier is string => Boolean(identifier)),
	);
	const globalPlaylistRows = globalHubs.filter(
		(hub) =>
			hasAudioPlaylist(hub) &&
			(!hub.hubIdentifier || !sectionIdentifiers.has(hub.hubIdentifier)),
	);
	return [...musicRows, ...globalPlaylistRows];
}

/** Replace Plex's artist-only recent-play hub with the mixed activity preview. */
export function replaceRecentlyPlayedPreview(
	hubs: PlexHub[],
	recentlyPlayed: PlexHubItem[],
): PlexHub[] {
	if (recentlyPlayed.length === 0) return hubs;
	let replaced = false;
	return hubs.map((hub) => {
		if (replaced || !hub.hubIdentifier?.startsWith(RECENTLY_PLAYED_HUB_PREFIX)) {
			return hub;
		}
		replaced = true;
		return { ...hub, Metadata: recentlyPlayed };
	});
}

/** Probe all candidates concurrently and return the first reachable one by priority. */
export async function selectReachableConnection(
	resource: PlexServerResource,
	token: string,
	probe: ServerConnectionProbe = checkPlexServerStatus,
): Promise<PlexConnection | undefined> {
	const candidates = connectionCandidates(resource);
	const reachable = await Promise.all(
		candidates.map(async (connection) => {
			try {
				return await probe(connection.uri, token);
			} catch {
				return false;
			}
		}),
	);
	return candidates.find((_, index) => reachable[index]);
}

export class PlexClient {
	private readonly _baseUrl: string;
	private readonly _token: string;
	private readonly _clientIdentifier: string;

	constructor({ url, token, clientIdentifier }: PlexClientOptions) {
		this._baseUrl = url.replace(/\/+$/, "");
		this._token = token;
		this._clientIdentifier = clientIdentifier ?? "";
	}

	private async request<T>(path: string): Promise<T> {
		const res = await fetch(`${this._baseUrl}${path}`, {
			headers: {
				Accept: "application/json",
				"X-Plex-Token": this._token,
			},
		});
		if (!res.ok) {
			throw new Error(`Plex request failed: ${res.status} ${res.statusText} for ${path}`);
		}
		const contentType = res.headers.get("content-type") ?? "";
		if (!contentType.includes("json")) {
			throw new Error(
				`Plex returned ${contentType || "non-JSON"} for ${path}; expected application/json`,
			);
		}
		return (await res.json()) as T;
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
			throw new Error(`Plex request failed: ${res.status} ${res.statusText} for ${path}`);
		}
		// Drain the body so the connection is reusable.
		await res.arrayBuffer();
	}

	private buildBrowsePath(
		sectionKey: string | number,
		type: number,
		opts?: BrowseOptions,
	): string {
		const params = new URLSearchParams();
		params.set("type", String(type));
		if (opts?.sort) params.set("sort", opts.sort);
		if (opts?.filter) params.set("filter", opts.filter);
		if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
		if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
		return `/library/sections/${sectionKey}/all?${params.toString()}`;
	}

	/** Fetch a `Metadata[]` container and validate its items with a per-type schema. */
	private async parseItems<T extends { type: string }>(
		sectionKey: string | number,
		type: number,
		opts: BrowseOptions | undefined,
		path: string = this.buildBrowsePath(sectionKey, type, opts),
	): Promise<T[]> {
		const payload = await this.request<unknown>(path);
		const envelope = container<{ Metadata?: T[] }>(payload, path);
		const items = envelope.MediaContainer?.Metadata ?? [];
		if (items.length === 0) return [];
		let schema: z.ZodType<T> | undefined;
		switch (type) {
			case 8:
				schema = artistSchema as unknown as z.ZodType<T>;
				break;
			case 9:
				schema = albumSchema as unknown as z.ZodType<T>;
				break;
			case 10:
				schema = trackSchema as unknown as z.ZodType<T>;
				break;
		}
		if (!schema) return items;
		return filterItems(schema, items as unknown[], path);
	}

	/** Fetch `/library/metadata/{ratingKey}` and validate the items against a per-type schema. */
	private async parseMetadata<T extends { type: string }>(
		ratingKey: string | number,
	): Promise<{ items: T[]; totals: PlexMetadata }> {
		const path = `/library/metadata/${ratingKey}`;
		const payload = await this.request<unknown>(path);
		const envelope = container<{ Metadata?: T[] } & PlexMetadata>(payload, path);
		const mc = envelope.MediaContainer;
		const items = mc?.Metadata ?? [];
		if (items.length > 0) {
			const sample = items[0] as { type?: string };
			const schema: z.ZodType<T> | undefined =
				sample.type === "album"
					? (albumSchema as unknown as z.ZodType<T>)
					: sample.type === "artist"
						? (artistSchema as unknown as z.ZodType<T>)
						: sample.type === "track"
							? (trackSchema as unknown as z.ZodType<T>)
							: sample.type === "playlist"
								? (playlistSchema as unknown as z.ZodType<T>)
								: undefined;
			if (schema) {
				const parsed = filterItems(schema, items as unknown[], path);
				return { items: parsed, totals: this.totals(mc ?? {}) };
			} else {
				console.error(`Plex response validation skipped for unknown item type (${path}): ${String(sample.type)}`);
			}
		}
		return { items, totals: this.totals(mc ?? {}) };
	}

	private totals(envelope: { size?: number; leafCount?: number; duration?: number }): PlexMetadata {
		return {
			size: envelope.size,
			leafCount: envelope.leafCount,
			duration: envelope.duration,
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
		key: "Metadata" | "Hub" | "Directory",
	): Promise<T[]> {
		const payload = await this.request<unknown>(path);
		const envelope = container<Record<string, T[]>>(payload, path);
		const items = envelope.MediaContainer?.[key] ?? [];
		if (items.length === 0) return [];
		return filterItems(schema, items as unknown[], path);
	}

	/** All library sections. */
	async getSections(): Promise<PlexSection[]> {
		return this.parseContainerArray<PlexSection>(
			"/library/sections",
			sectionSchema,
			"Directory",
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
		opts?: BrowseOptions,
	): Promise<PlexArtist[]> {
		return this.getItems<PlexArtist>(sectionKey, 8, opts);
	}

	/** Albums in a library section, with optional sort/filter/limit. */
	async getAlbums(
		sectionKey: string | number,
		opts?: BrowseOptions,
	): Promise<PlexAlbum[]> {
		return this.getItems<PlexAlbum>(sectionKey, 9, opts);
	}

	/** Tracks in a library section, with optional sort/filter/limit. */
	async getTracks(
		sectionKey: string | number,
		opts?: BrowseOptions,
	): Promise<PlexTrack[]> {
		return this.getItems<PlexTrack>(sectionKey, 10, opts);
	}

	/**
	 * Items of a given Plex media type in a library section, via
	 * `/library/sections/{key}/all?type=N`. Music types: 8=artist, 9=album,
	 * 10=track. Other common types: 1=movie, 2=show, 4=episode, 13=photo,
	 * 14=photoalbum, 18=collection.
	 */
	async getItems<T extends { type: string }>(
		sectionKey: string | number,
		type: number,
		opts?: BrowseOptions,
	): Promise<T[]> {
		return this.parseItems<T>(sectionKey, type, opts);
	}

	/** All playlists on the server. */
	async getPlaylists(): Promise<PlexPlaylist[]> {
		return this.parseContainerArray<PlexPlaylist>(
			"/playlists",
			playlistSchema,
			"Metadata",
		);
	}

	/** Music (audio) playlists on the server. */
	async getMusicPlaylists(): Promise<PlexPlaylist[]> {
		const playlists = await this.getPlaylists();
		return playlists.filter((p) => p.playlistType === "audio");
	}

	/** All artists across every music section, deduplicated by rating key. */
	async getAllArtists(): Promise<PlexArtist[]> {
		return this.getAllByType(8);
	}

	/** All albums across every music section, deduplicated by rating key. */
	async getAllAlbums(): Promise<PlexAlbum[]> {
		return this.getAllByType(9);
	}

	/** All tracks across every music section, deduplicated by rating key. */
	async getAllTracks(): Promise<PlexTrack[]> {
		return this.getAllByType(10);
	}

	/** Items of one media type across every music section, deduplicated by rating key. */
	private async getAllByType<T extends { type: string; ratingKey: string }>(
		type: number,
	): Promise<T[]> {
		const sections = await this.getMusicSections();
		const perSection = await Promise.all(
			sections.map((section) => this.getItems<T>(section.key, type)),
		);
		const seen = new Set<string>();
		return perSection.flat().filter((item) => {
			if (seen.has(item.ratingKey)) return false;
			seen.add(item.ratingKey);
			return true;
		});
	}

	/**
	 * Search the whole server via `/hubs/search`, grouped by media type for
	 * the Search screen's split Songs/Albums/Artists columns. Playlists are
	 * excluded; the result is exactly `{artists, albums, tracks}`.
	 */
	async search(query: string): Promise<{ artists: PlexArtist[]; albums: PlexAlbum[]; tracks: PlexTrack[] }> {
		const trimmed = query.trim();
		const empty: { artists: PlexArtist[]; albums: PlexAlbum[]; tracks: PlexTrack[] } = {
			artists: [],
			albums: [],
			tracks: [],
		};
		if (!trimmed) return empty;
		const path = `/hubs/search?query=${encodeURIComponent(trimmed)}&limit=20`;
		const hubs = await this.parseContainerArray<PlexHub>(path, hubSchema, "Hub");
		const items = hubs.flatMap((hub) => hub.Metadata ?? []);
		const artists: PlexArtist[] = [];
		const albums: PlexAlbum[] = [];
		const tracks: PlexTrack[] = [];
		const seen = new Set<string>();
		for (const item of items) {
			if (seen.has(item.ratingKey)) continue;
			seen.add(item.ratingKey);
			switch (item.type) {
				case "artist":
					artists.push(item as PlexArtist);
					break;
				case "album":
					albums.push(item as PlexAlbum);
					break;
				case "track":
					tracks.push(item as PlexTrack);
					break;
			}
		}
		return { artists, albums, tracks };
	}

	/**
	 * Home-screen hub groupings. Plex's global `/hubs` response only contains a
	 * subset of music rows, so the default request combines it with each music
	 * section's `/hubs/sections/{key}` response. `identifiers` preserves the
	 * direct global-hub query for callers that need a specific hub set.
	 */
	async getHomeHubs(identifiers?: string[]): Promise<PlexHub[]> {
		const query = identifiers?.length ? `?identifier=${identifiers.join(",")}` : "";
		if (identifiers?.length) {
			return this.parseContainerArray<PlexHub>(`/hubs${query}`, hubSchema, "Hub");
		}

		const globalHubs = await this.parseContainerArray<PlexHub>("/hubs", hubSchema, "Hub");
		const sections = await this.getMusicSections();
		if (sections.length === 0) return globalHubs;
		const [sectionHubs, recentlyPlayed] = await Promise.all([
			Promise.all(sections.map((section) => this.getSectionHubs(section.key))).then((hubs) =>
				hubs.flat(),
			),
			this.getRecentlyPlayedForSections(sections),
		]);
		return replaceRecentlyPlayedPreview(
			composeHomeHubs(sectionHubs, globalHubs),
			recentlyPlayed,
		);
	}

	/** Hubs for a library section via `/hubs/sections/{key}`. */
	async getSectionHubs(sectionKey: string | number): Promise<PlexHub[]> {
		return this.parseContainerArray<PlexHub>(
			`/hubs/sections/${sectionKey}`,
			hubSchema,
			"Hub",
		);
	}

	/** Load every item for a Home row from the full-data key Plex attaches to the hub. */
	async getHomeHubItems(key: string): Promise<PlexHubItem[]> {
		return this.parseContainerArray<PlexHubItem>(key, hubItemSchema, "Metadata");
	}

	/**
	 * Recently played music across all music sections: artists, albums, and
	 * tracks, most recently played first. The `music.recent.played` hub only
	 * covers artists, so each type is fetched via the hub's underlying query
	 * (`viewCount>=1&sort=lastViewedAt:desc`) and merged.
	 */
	async getRecentlyPlayed(): Promise<PlexHubItem[]> {
		const sections = await this.getMusicSections();
		return this.getRecentlyPlayedForSections(sections);
	}

	private async getRecentlyPlayedForSections(
		sections: PlexSection[],
	): Promise<PlexHubItem[]> {
		const perSection = await Promise.all(
			sections.map(async (section) => {
				const [artists, albums, tracks] = await Promise.all([
					this.getRecentlyPlayedByType(section.key, 8),
					this.getRecentlyPlayedByType(section.key, 9),
					this.getRecentlyPlayedByType(section.key, 10),
				]);
				return [...artists, ...albums, ...tracks];
			}),
		);
		const seen = new Set<string>();
		const unique = perSection.flat().filter((item) => {
			if (seen.has(item.ratingKey)) return false;
			seen.add(item.ratingKey);
			return true;
		});
		return unique.sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0));
	}

	/** Recently played items of one media type in a section, newest first. */
	private async getRecentlyPlayedByType(
		sectionKey: string | number,
		type: number,
	): Promise<PlexHubItem[]> {
		return this.parseContainerArray<PlexHubItem>(
			`/library/sections/${sectionKey}/all?viewCount%3E=1&type=${type}&sort=lastViewedAt:desc`,
			hubItemSchema,
			"Metadata",
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
				const since = sinceMs !== undefined ? new Date(sinceMs).getTime() / 1000 : undefined;
				return this.parseContainerArray<PlexHubItem>(
					`/library/sections/${section.key}/all?viewCount%3E=1&type=10&sort=viewCount:desc${since !== undefined ? `&addedAt%3E=${Math.floor(since)}` : ""}`,
					hubItemSchema,
					"Metadata",
				);
			}),
		);
		const seen = new Set<string>();
		const unique = perSection.flat().filter((item) => {
			if (seen.has(item.ratingKey)) return false;
			seen.add(item.ratingKey);
			return true;
		});
		return unique.sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0));
	}

	/**
	 * Metadata for one item via `/library/metadata/{ratingKey}`. The returned
	 * `PlexMetadata` carries the top-level `MediaContainer` totals
	 * (`size`/`leafCount`/`duration`) that drive the "N songs, M min" headers.
	 */
	async getMetadata<T extends { type: string }>(
		ratingKey: string | number,
	): Promise<{ items: T[]; totals: PlexMetadata }> {
		return this.parseMetadata<T>(ratingKey);
	}

	/** Album metadata + its tracks, in Plex track order (disc, then index). */
	async getAlbum(ratingKey: string | number): Promise<{
		album: PlexAlbum;
		tracks: PlexTrack[];
	}> {
		const { items } = await this.getMetadata<{ type: string }>(ratingKey);
		const album = items.find((i) => i.type === "album") as PlexAlbum | undefined;
		const tracks = await this.parseContainerArray<PlexTrack>(
			`/library/metadata/${ratingKey}/children`,
			trackSchema,
			"Metadata",
		);
		return {
			album: album ?? { ratingKey: String(ratingKey), key: "", type: "album", title: "" },
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
		const { items } = await this.getMetadata<{ type: string }>(ratingKey);
		const artist = items.find((i) => i.type === "artist") as PlexArtist | undefined;
		const genres = artist?.Genre?.map((g) => g.tag) ?? [];

		// Plex does not populate childCount/leafCount on artist metadata, so
		// counts come from full unfiltered queries (`size` = exact total).
		const sections = await this.getMusicSections();
		const perSection = await Promise.all(
			sections.map(async (section) => {
				const tracksParams = new URLSearchParams({
					type: "10",
					filter: `artist.id=${ratingKey}`,
					sort: "viewCount:desc",
				});
				const albumsParams = new URLSearchParams({
					type: "9",
					parentRatingKey: String(ratingKey),
				});
				const [tracksData, albumsData] = await Promise.all([
					this.parseContainerArray<PlexTrack>(
						`/library/sections/${section.key}/all?${tracksParams.toString()}`,
						trackSchema,
						"Metadata",
					),
					this.parseContainerArray<PlexAlbum>(
						`/library/sections/${section.key}/all?${albumsParams.toString()}`,
						albumSchema,
						"Metadata",
					),
				]);
				return {
					tracks: tracksData,
					albums: albumsData,
				};
			}),
		);
		const totalSongs = perSection.reduce((n, s) => n + s.tracks.length, 0);
		const totalAlbums = perSection.reduce((n, s) => n + s.albums.length, 0);

		const seenTracks = new Set<string>();
		const tracks = perSection.flatMap((s) => s.tracks).filter((item) => {
			if (seenTracks.has(item.ratingKey)) return false;
			seenTracks.add(item.ratingKey);
			return true;
		});
		const seenAlbums = new Set<string>();
		const albums = perSection.flatMap((s) => s.albums).filter((item) => {
			if (seenAlbums.has(item.ratingKey)) return false;
			seenAlbums.add(item.ratingKey);
			return true;
		});

		return {
			artist: artist ?? { ratingKey: String(ratingKey), key: "", type: "artist", title: "" },
			genres,
			albumCount: totalAlbums || artist?.childCount || 0,
			songCount: totalSongs || artist?.leafCount || 0,
			topTracks: tracks.slice(0, 30),
			albums,
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
			"Metadata",
		);
		const playlist = playlists[0] ?? {
			ratingKey: String(key),
			key: `/playlists/${key}`,
			type: "playlist",
			title: "",
		};
		const tracks = await this.parseContainerArray<PlexTrack>(
			`/playlists/${key}/items`,
			trackSchema,
			"Metadata",
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
		return getPlexAccount(this._token);
	}

	/**
	 * Servers owned by the account, each with its best connection URI and a
	 * fresh `/identity` reachability check (parallel, short timeout). Used by
	 * Server Selection and the sidebar dropdown; never persisted.
	 */
	async getServers(): Promise<PlexServerInfo[]> {
		return discoverPlexServers(this._token, this._clientIdentifier);
	}

	/** Reachability of a server: GET `/identity` with the token, ~3s timeout. */
	async checkServerStatus(url: string, token: string = this.token): Promise<boolean> {
		return checkPlexServerStatus(url, token);
	}

	/**
	 * Mark a track as played/unplayed via `/:/scrobble`/`/:/unscrobble` —
	 * increments/decrements the `viewCount` that powers "X plays".
	 */
	async scrobble(key: string): Promise<void> {
		await this.requestRaw(`/:/scrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(key)}`);
	}

	async unscrobble(key: string): Promise<void> {
		await this.requestRaw(`/:/unscrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(key)}`);
	}

	/** Resolve a relative Plex image path (e.g. `thumb`, `art`) to a full URL with the token. */
	imageUrl(path: string | undefined | null): string | null {
		if (!path) return null;
		if (/^https?:\/\//.test(path)) return path;
		return `${this._baseUrl}${path}${path.includes("?") ? "&" : "?"}X-Plex-Token=${this._token}`;
	}

	/** Transcode a Plex image path to a fixed-size image via `/photo/:/transcode`. */
	transcodedImageUrl(
		path: string | undefined | null,
		width: number,
		height: number,
	): string | null {
		if (!path) return null;
		return `${this._baseUrl}/photo/:/transcode?width=${width}&height=${height}&url=${encodeURIComponent(path)}&X-Plex-Token=${this._token}`;
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

/**
 * The account's Plex.tv profile. Token-only — usable before a server is
 * selected (Connected card, sidebar user row).
 */
export async function getPlexAccount(token: string): Promise<PlexAccount> {
	const res = await fetch("https://plex.tv/api/v2/user", {
		headers: {
			Accept: "application/json",
			"X-Plex-Token": token,
		},
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch Plex account: ${res.status} ${res.statusText}`);
	}
	const user = (await res.json()) as unknown;
	const parsed = parseStrict(plexAccountSchema, user, "plex.tv /api/v2/user");
	if (!parsed) {
		throw new Error("Failed to fetch Plex account: unexpected response from plex.tv");
	}
	// plex.tv reports account confirmation as `confirmed`; the app's domain
	// shape calls it `verified` (drives the Connected card's verified badge).
	return {
		username: parsed.username,
		email: parsed.email,
		thumb: parsed.thumb,
		verified: parsed.confirmed === true,
	};
}

/**
 * Servers owned by the account, each with its best connection URI and a
 * fresh `/identity` reachability check (parallel, short timeout). Used by
 * Server Selection and the sidebar dropdown; never persisted.
 */
export async function discoverPlexServers(
	token: string,
	clientIdentifier: string,
): Promise<PlexServerInfo[]> {
	const resources = await discoverServers(token, clientIdentifier);
	return Promise.all(
		resources.map(async (resource) => {
			const serverToken = resource.accessToken ?? token;
			const candidates = connectionCandidates(resource);
			const selected = await selectReachableConnection(resource, serverToken);
			const fallback = candidates[0];
			const connection = selected ?? fallback;
			return {
				name: resource.name,
				clientIdentifier: resource.clientIdentifier,
				url: connection?.uri ?? "",
				token: serverToken,
				local: connection?.local ?? false,
				online: selected !== undefined,
			};
		}),
	);
}

/** Reachability of a server: GET `/identity` with the token, ~3s timeout. */
export async function checkPlexServerStatus(
	url: string,
	token: string,
): Promise<boolean> {
	try {
		const res = await fetch(`${url.replace(/\/+$/, "")}/identity`, {
			headers: { Accept: "application/json", "X-Plex-Token": token },
			signal: AbortSignal.timeout(DEFAULT_STATUS_TIMEOUT_MS),
		});
		return res.ok;
	} catch {
		return false;
	}
}
