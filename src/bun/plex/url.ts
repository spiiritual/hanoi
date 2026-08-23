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
