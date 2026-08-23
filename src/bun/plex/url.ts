/**
 * Pure URL helpers for Plex media/image/stream URLs. Importable from the
 * view (no client instance needed) so `<img src>` / `<audio src>` can be
 * built directly. Audio playback uses the authenticated direct stream URL in
 * the renderer so pause/resume can reuse the browser's existing buffer.
 */
import type { PlexTrack } from "./types.ts";

/** Base URL + token pair needed to resolve Plex URLs. */
export interface PlexUrlSource {
  baseUrl: string;
  token: string;
}

function withToken(url: string, token: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}X-Plex-Token=${token}`;
}

/**
 * Resolve a relative Plex image path (e.g. `thumb`, `art`, `composite`) to a
 * full URL with the auth token. Absolute http(s) URLs pass through unchanged.
 * Returns null for empty input.
 */
export function imageUrl(source: PlexUrlSource, path: string | undefined | null): string | null {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return withToken(`${source.baseUrl}${path}`, source.token);
}

/** Resolve a Plex.tv account avatar path and attach the account token. */
export function accountImageUrl(path: string | undefined | null, token: string): string | null {
  if (!path) return null;
  const url = /^https?:\/\//i.test(path)
    ? path
    : `https://plex.tv${path.startsWith("/") ? path : `/${path}`}`;
  return withToken(url, token);
}

/**
 * Transcode a Plex image path to a fixed-size image via `/photo/:/transcode`.
 * Fallback for thumbs the native decoder rejects (e.g. PNGs with a bare
 * `gAMA` chunk and no color profile). Returns null for empty input.
 */
export function transcodedImageUrl(
  source: PlexUrlSource,
  path: string | undefined | null,
  width: number,
  height: number,
): string | null {
  if (!path) return null;
  return `${source.baseUrl}/photo/:/transcode?width=${width}&height=${height}&url=${encodeURIComponent(path)}&X-Plex-Token=${source.token}`;
}

/**
 * Audio URL for `<audio src>`: the first playable `Media` part's key resolved
 * against the server, token attached. Returns null when the track has no
 * media/part. The URL carries the token so the audio element can stream
 * directly from the server without proxying bytes through the main process.
 */
export function streamUrl(
  source: PlexUrlSource,
  track: Pick<PlexTrack, "Media"> | undefined | null,
): string | null {
  const part = track?.Media?.[0]?.Part?.[0];
  const key = part?.key;
  if (!key) return null;
  return withToken(`${source.baseUrl}${key}`, source.token);
}
