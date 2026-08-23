import { Electroview } from "electrobun/view";
import type { PlexRpc } from "../bun/plex/rpc-schema.ts";
import type { BrowseOptions } from "../bun/plex/client.ts";
import type { ArtworkVariant } from "../bun/plex/artwork-types.ts";

const rpc = Electroview.defineRPC<PlexRpc>({
  maxRequestTime: 60_000,
  handlers: {
    requests: {},
    messages: {},
  },
});
new Electroview({ rpc });

/** Typed, thin view-side access to the Plex client in the main process. */
export const plex = {
  // auth lifecycle
  beginAuth: () => rpc.request.beginAuth(),
  cancelAuth: () => rpc.request.cancelAuth(),
  selectServer: (clientIdentifier: string) => rpc.request.selectServer({ clientIdentifier }),
  getAuthState: () => rpc.request.getAuthState(),
  disconnect: () => rpc.request.disconnect(),
  // account + servers
  getAccount: () => rpc.request.getAccount(),
  getServers: () => rpc.request.getServers(),
  checkServerStatus: () => rpc.request.checkServerStatus(),
  // browse
  getMusicSections: () => rpc.request.getMusicSections(),
  getArtists: (sectionKey: string, opts?: BrowseOptions) =>
    rpc.request.getArtists({ sectionKey, opts }),
  getAlbums: (sectionKey: string, opts?: BrowseOptions) =>
    rpc.request.getAlbums({ sectionKey, opts }),
  getTracks: (sectionKey: string, opts?: BrowseOptions) =>
    rpc.request.getTracks({ sectionKey, opts }),
  getPlaylists: () => rpc.request.getPlaylists(),
  // detail
  getAlbum: (ratingKey: string) => rpc.request.getAlbum({ ratingKey }),
  getPlaylist: (key: string) => rpc.request.getPlaylist({ key }),
  getArtist: (ratingKey: string) => rpc.request.getArtist({ ratingKey }),
  // home
  getHomeHubs: (identifiers?: string[]) => rpc.request.getHomeHubs({ identifiers }),
  getHomeHubItems: (key: string) => rpc.request.getHomeHubItems({ key }),
  getRecentlyPlayed: () => rpc.request.getRecentlyPlayed(),
  getMostPlayed: (sinceMs?: number) => rpc.request.getMostPlayed({ sinceMs }),
  // search
  search: (query: string) => rpc.request.search({ query }),
  // playback + media URLs
  streamUrl: (ratingKey: string) => rpc.request.streamUrl({ ratingKey }),
  getArtwork: (path: string, variant?: ArtworkVariant) => rpc.request.getArtwork({ path, variant }),
  getAccountArtwork: (variant?: ArtworkVariant) => rpc.request.getAccountArtwork({ variant }),
  scrobble: (key: string) => rpc.request.scrobble({ key }),
  // system helpers
  openExternal: (url: string) => rpc.request.openExternal({ url }),
  clipboardWriteText: (text: string) => rpc.request.clipboardWriteText({ text }),
};
