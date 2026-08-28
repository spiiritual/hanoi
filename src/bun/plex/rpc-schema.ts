import type { ArtworkRpcResult, ArtworkVariant } from "./artwork/types.ts";
import type { BrowseOptions } from "./client.ts";
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

/**
 * Electrobun RPC schema for the Plex client. Both sides import this file:
 * the bun side registers request handlers (`BrowserView.defineRPC`), the
 * view side calls them (`Electroview.defineRPC` + `new Electroview`).
 * Authentication tokens never cross into the renderer for artwork — the view receives
 * artwork bytes; the authenticated stream URL remains available for audio.
 */
type RpcResponse = ReturnType<() => void>;

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

export interface PlexRpc {
  bun: {
    requests: {
      // auth lifecycle
      beginAuth: {
        params: undefined;
        response: { authUrl: string; pinCode: string };
      };
      cancelAuth: { params: undefined; response: RpcResponse };
      selectServer: {
        params: { clientIdentifier: string };
        response: RpcResponse;
      };
      getAuthState: {
        params: undefined;
        response: {
          authenticated: boolean;
          hasServer: boolean;
          authenticating: boolean;
          authError?: string;
          account?: PlexAccount;
          server?: ServerViewSummary;
        };
      };
      disconnect: { params: undefined; response: RpcResponse };
      // account + servers
      getAccount: { params: undefined; response: PlexAccount };
      getServers: { params: undefined; response: ServerViewSummary[] };
      checkServerStatus: { params: undefined; response: boolean };
      // browse
      getMusicSections: { params: undefined; response: PlexSection[] };
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
      getPlaylists: { params: undefined; response: PlexPlaylist[] };
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
      getRecentlyPlayed: { params: undefined; response: PlexHubItem[] };
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
      getArtwork: {
        params: { path: string; variant?: ArtworkVariant };
        response: ArtworkRpcResult;
      };
      /** Account avatar bytes; the account path and token stay in the main process. */
      getAccountArtwork: {
        params: { variant?: ArtworkVariant };
        response: ArtworkRpcResult;
      };
      scrobble: { params: { key: string }; response: RpcResponse };
      // system helpers (main process only)
      openExternal: { params: { url: string }; response: RpcResponse };
      clipboardWriteText: { params: { text: string }; response: RpcResponse };
    };
    messages: Record<never, never>;
  };
  webview: {
    messages: Record<never, never>;
    requests: Record<never, never>;
  };
}
