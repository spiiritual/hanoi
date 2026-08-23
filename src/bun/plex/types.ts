/**
 * Plex domain types. Response-shaped types (`PlexTrack`, `PlexAlbum`, …)
 * are inferred from the zod schemas in `./schemas.ts` so the runtime
 * validation and the compile-time shapes can never drift apart. Only
 * `PlexServerInfo` is derived in code (discovery + status checks), so it
 * lives here.
 */
export type {
  PlexAlbum,
  PlexArtist,
  PlexConnection,
  PlexGenre,
  PlexHub,
  PlexHubItem,
  PlexMedia,
  PlexMetadata,
  PlexPin,
  PlexPlaylist,
  PlexSection,
  PlexServerResource,
  PlexTrack,
} from "./schemas.ts";

/**
 * Plex.tv account profile (app domain shape). The wire response calls
 * account confirmation `confirmed`; `getPlexAccount` maps it to `verified`,
 * which drives the Connected card's verified badge.
 */
export interface PlexAccount {
  username: string;
  email: string;
  thumb?: string;
  verified: boolean;
}

/** A discovered server, ready for the Server Selection screen and dropdown. */
export interface PlexServerInfo {
  name: string;
  clientIdentifier: string;
  /** Best connection URI (local connection preferred). */
  url: string;
  /** Per-server access token from the resource. */
  token: string;
  local: boolean;
  /** From the `/identity` reachability check. */
  online: boolean;
}
