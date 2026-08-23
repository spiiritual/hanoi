/**
 * Electrobun RPC schema for the Plex client. Both sides import this file:
 * the bun side registers request handlers (`BrowserView.defineRPC`), the
 * view side calls them (`Electroview.defineRPC` + `new Electroview`).
 * The token never crosses into the renderer — the view only ever receives
 * data and URL strings.
 */
import type {
	PlexAccount,
	PlexAlbum,
	PlexArtist,
	PlexHubItem,
	PlexHub,
	PlexPlaylist,
	PlexSection,
	PlexServerInfo,
	PlexTrack,
} from "./types.ts";
import type { BrowseOptions } from "./client.ts";

/**
 * Server info as seen by the view — the per-server token never leaves the
 * main process. `local` and `online` are measured during discovery and are
 * intentionally available to the server picker, but never persisted.
 */
export type ServerViewSummary = Pick<
	PlexServerInfo,
	"name" | "clientIdentifier" | "url"
> &
	Partial<Pick<PlexServerInfo, "local" | "online">>;

export type PlexRpc = {
	bun: {
		requests: {
			// auth lifecycle
			beginAuth: { params: void; response: { authUrl: string; pinCode: string } };
			cancelAuth: { params: void; response: void };
			selectServer: { params: { clientIdentifier: string }; response: void };
			getAuthState: {
				params: void;
				response: {
					authenticated: boolean;
					hasServer: boolean;
					authenticating: boolean;
					authError?: string;
					account?: PlexAccount;
					server?: ServerViewSummary;
				};
			};
			disconnect: { params: void; response: void };
			// account + servers
			getAccount: { params: void; response: PlexAccount };
			getAccountAvatarUrl: { params: void; response: string | null };
			getServers: { params: void; response: ServerViewSummary[] };
			checkServerStatus: { params: void; response: boolean };
			// browse
			getMusicSections: { params: void; response: PlexSection[] };
			getArtists: {
				params: { sectionKey: string; opts?: BrowseOptions };
				response: PlexArtist[];
			};
			getAlbums: {
				params: { sectionKey: string; opts?: BrowseOptions };
				response: PlexAlbum[];
			};
			getTracks: {
				params: { sectionKey: string; opts?: BrowseOptions };
				response: PlexTrack[];
			};
			getPlaylists: { params: void; response: PlexPlaylist[] };
			// detail
			getAlbum: {
				params: { ratingKey: string };
				response: { album: PlexAlbum; tracks: PlexTrack[] };
			};
			getPlaylist: {
				params: { key: string };
				response: { playlist: PlexPlaylist; tracks: PlexTrack[] };
			};
			getArtist: {
				params: { ratingKey: string };
				response: {
					artist: PlexArtist;
					genres: string[];
					albumCount: number;
					songCount: number;
					topTracks: PlexTrack[];
					albums: PlexAlbum[];
				};
			};
			// home
			getHomeHubs: {
				params: { identifiers?: string[] };
				response: PlexHub[];
			};
			getHomeHubItems: { params: { key: string }; response: PlexHubItem[] };
			getRecentlyPlayed: { params: void; response: PlexHubItem[] };
			getMostPlayed: { params: { sinceMs?: number }; response: PlexHubItem[] };
			// search
			search: {
				params: { query: string };
				response: {
					artists: PlexArtist[];
					albums: PlexAlbum[];
					tracks: PlexTrack[];
				};
			};
			// playback + media URLs (token stays in the main process)
			streamUrl: { params: { ratingKey: string }; response: string | null };
			imageUrl: { params: { path: string }; response: string | null };
			transcodedImageUrl: {
				params: { path: string; width: number; height: number };
				response: string | null;
			};
			scrobble: { params: { key: string }; response: void };
			// system helpers (main process only)
			openExternal: { params: { url: string }; response: void };
			clipboardWriteText: { params: { text: string }; response: void };
		};
		messages: {};
	};
	webview: { requests: {}; messages: {} };
};
