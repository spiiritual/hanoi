import { Electroview } from "electrobun/view";

import type { ArtworkVariant } from "../bun/plex/artwork/types.ts";
import type { BrowseOptions } from "../bun/plex/client.ts";
import type { PlexRpc } from "../bun/plex/rpc-schema.ts";

const rpc = Electroview.defineRPC<PlexRpc>({
  handlers: {
    messages: {},
    requests: {},
  },
  maxRequestTime: 60_000,
});
const plexView = new Electroview({ rpc });
export { plexView };

/** Typed, thin view-side access to the Plex client in the main process. */
export const plex = {
  beginAuth: async () => await rpc.request.beginAuth(),
  cancelAuth: async () => {
    await rpc.request.cancelAuth();
  },
  checkServerStatus: async () => await rpc.request.checkServerStatus(),
  clipboardWriteText: async (text: string) => {
    await rpc.request.clipboardWriteText({ text });
  },
  disconnect: async () => {
    await rpc.request.disconnect();
  },
  getAccount: async () => await rpc.request.getAccount(),
  getAccountArtwork: async (variant?: ArtworkVariant) =>
    await rpc.request.getAccountArtwork({ variant }),
  getAlbum: async (ratingKey: string) =>
    await rpc.request.getAlbum({ ratingKey }),
  getAlbums: async (sectionKey: string, opts?: BrowseOptions) =>
    await rpc.request.getAlbums({ opts, sectionKey }),
  getArtist: async (ratingKey: string) =>
    await rpc.request.getArtist({ ratingKey }),
  getArtists: async (sectionKey: string, opts?: BrowseOptions) =>
    await rpc.request.getArtists({ opts, sectionKey }),
  getArtwork: async (path: string, variant?: ArtworkVariant) =>
    await rpc.request.getArtwork({ path, variant }),
  getAuthState: async () => await rpc.request.getAuthState(),
  getHomeHubItems: async (key: string) =>
    await rpc.request.getHomeHubItems({ key }),
  getHomeHubs: async (identifiers?: string[]) =>
    await rpc.request.getHomeHubs({ identifiers }),
  getMostPlayed: async (sinceMs?: number) =>
    await rpc.request.getMostPlayed({ sinceMs }),
  getMusicSections: async () => await rpc.request.getMusicSections(),
  getPlaylist: async (key: string) => await rpc.request.getPlaylist({ key }),
  getPlaylists: async () => await rpc.request.getPlaylists(),
  getRecentlyPlayed: async () => await rpc.request.getRecentlyPlayed(),
  getServers: async () => await rpc.request.getServers(),
  getTracks: async (sectionKey: string, opts?: BrowseOptions) =>
    await rpc.request.getTracks({ opts, sectionKey }),
  openExternal: async (url: string) => {
    await rpc.request.openExternal({ url });
  },
  scrobble: async (key: string) => {
    await rpc.request.scrobble({ key });
  },
  search: async (query: string) => await rpc.request.search({ query }),
  selectServer: async (clientIdentifier: string) => {
    await rpc.request.selectServer({ clientIdentifier });
  },
  streamUrl: async (ratingKey: string) =>
    await rpc.request.streamUrl({ ratingKey }),
};
