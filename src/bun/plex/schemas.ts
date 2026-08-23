/**
 * Zod schemas for every Plex/plex.tv response the client parses.
 *
 * Validation contract — "require the fields we need, tolerate the rest":
 * - Every object schema uses `.passthrough()`: unknown or new fields never
 *   fail validation and are not stripped from the parsed value.
 * - Required fields are the ones the UI and client actually consume (per the
 *   plex.pen screen audit): identity/key fields that render text, keyed
 *   navigation, dedup, or HTTP calls. A value missing them is dropped
 *   (`filterItems`) or rejected (`parseStrict`), each with a logged reason.
 * - Optional fields are consumed but legitimately absent (year, thumb,
 *   viewCount, …). Fields nothing consumes are omitted from the schemas —
 *   passthrough keeps them in the parsed data, so adding one back later is
 *   just re-declaring it.
 */
import { z } from "zod";

/** Strict single-value parse: validated value, or null (mismatch logged). Never throws. */
export function parseStrict<T>(schema: z.ZodType<T>, payload: unknown, context: string): T | null {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  console.error(`Plex response failed validation (${context}):`, result.error.issues);
  return null;
}

/**
 * Strict array validation: each item is validated individually; invalid
 * items are dropped (with the reason and the item logged), valid ones kept.
 * Never throws — one malformed item must not wipe a whole list.
 */
export function filterItems<T>(schema: z.ZodType<T>, items: unknown[], context: string): T[] {
  const valid: T[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      console.error(
        `Plex item failed validation (${context}); dropped:`,
        result.error.issues,
        item,
      );
    }
  }
  return valid;
}

/**
 * Unwrap the top-level `MediaContainer` envelope. A missing/invalid envelope
 * is logged and yields `{}` so callers degrade to empty results.
 */
export function container<T>(payload: unknown, context: string): { MediaContainer?: T } {
  const parsed = parseStrict(
    z.object({ MediaContainer: z.record(z.string(), z.unknown()) }),
    payload,
    context,
  );
  if (!parsed) return {};
  return parsed as { MediaContainer?: T };
}

// ---- plex.tv PIN flow (/api/v2/pins) ----

export const pinSchema = z
  .object({
    // plex.tv returns `id` as a JSON number; coerce to string so the poll
    // URL templating and the `PlexPin.id: string` type stay consistent.
    id: z.coerce.string(),
    code: z.string(),
    clientIdentifier: z.string(),
    expiresIn: z.number(),
    authToken: z.string().nullable().optional(),
  })
  .passthrough();

/** Poll responses: only `authToken` is consumed; anything else is tolerated. */
export const pinPollSchema = z
  .object({
    authToken: z.string().nullable().optional(),
  })
  .passthrough();

// ---- plex.tv resources (/api/v2/resources) ----
// Server Selection + sidebar dropdown show host (from the URI) and online
// (from /identity). `local` picks the best URI; `accessToken` is the
// per-server token; `provides`/`owned` filter to owned media servers.

const connectionSchema = z
  .object({
    protocol: z.string().optional(),
    address: z.string().optional(),
    port: z.number().optional(),
    uri: z.string(),
    local: z.boolean(),
    relay: z.boolean().optional(),
    IPv6: z.boolean().optional(),
  })
  .passthrough();

export const serverResourceSchema = z
  .object({
    name: z.string(),
    clientIdentifier: z.string(),
    /** null on non-server devices (e.g. Plexamp clients); servers may also omit it. */
    accessToken: z.string().nullable().optional(),
    owned: z.boolean(),
    provides: z.string().optional(),
    connections: z.array(connectionSchema).optional(),
  })
  .passthrough();

// ---- plex.tv account (/api/v2/user) ----
// Wire shape of /api/v2/user. The Connected card's "verified" badge is
// plex.tv's `confirmed`; the app maps it to `verified` (see getPlexAccount).

export const plexAccountSchema = z
  .object({
    username: z.string(),
    email: z.string(),
    thumb: z.string().optional(),
    confirmed: z.boolean().optional(),
  })
  .passthrough();

// ---- library metadata items ----
// Field audit from plex.pen: only fields the screens bind are declared.
// - Album card/grid: title, artist (parentTitle), image (thumb),
//   "2019 · 6 plays" (year, viewCount), "7 songs" (leafCount).
// - Artist detail: genres (Genre[].tag), counts (computed by getArtist;
//   childCount/leafCount fall back when Plex omits counts).
// - Track row: title, "Artist · Album" (grandparentTitle · parentTitle),
//   duration, index, viewCount ("32 plays"), audio (Media[0].Part[0].key).
// - Playlist: title, "Focus · 42 songs" (playlistType, leafCount), optional year,
//   duration, cover (composite).
// - Navigation: parentRatingKey/grandparentRatingKey drive the detail
//   screens; ratingKey drives every /library/metadata call.

const genreSchema = z.object({ tag: z.string() }).passthrough();

const partSchema = z
  .object({
    key: z.string().optional(),
  })
  .passthrough();

const mediaSchema = z
  .object({
    Part: z.array(partSchema),
  })
  .passthrough();

export const sectionSchema = z
  .object({
    key: z.string(),
    type: z.string(),
    title: z.string(),
  })
  .passthrough();

export const artistSchema = z
  .object({
    ratingKey: z.string(),
    key: z.string(),
    type: z.literal("artist"),
    title: z.string(),
    childCount: z.number().optional(),
    leafCount: z.number().optional(),
    Genre: z.array(genreSchema).optional(),
  })
  .passthrough();

export const albumSchema = z
  .object({
    ratingKey: z.string(),
    key: z.string(),
    type: z.literal("album"),
    title: z.string(),
    parentTitle: z.string().optional(),
    parentRatingKey: z.string().optional(),
    thumb: z.string().optional(),
    year: z.number().optional(),
    leafCount: z.number().optional(),
    viewCount: z.number().optional(),
  })
  .passthrough();

export const trackSchema = z
  .object({
    ratingKey: z.string(),
    key: z.string(),
    type: z.literal("track"),
    title: z.string(),
    parentTitle: z.string().optional(),
    parentRatingKey: z.string().optional(),
    grandparentTitle: z.string().optional(),
    grandparentRatingKey: z.string().optional(),
    index: z.number().optional(),
    duration: z.number().optional(),
    thumb: z.string().optional(),
    viewCount: z.number().optional(),
    Media: z.array(mediaSchema).optional(),
  })
  .passthrough();

export const playlistSchema = z
  .object({
    ratingKey: z.string(),
    key: z.string(),
    type: z.literal("playlist"),
    title: z.string(),
    playlistType: z.string().optional(),
    composite: z.string().optional(),
    year: z.number().optional(),
    duration: z.number().optional(),
    leafCount: z.number().optional(),
  })
  .passthrough();

export const hubItemSchema = z
  .object({
    ratingKey: z.string(),
    key: z.string(),
    type: z.string(),
    title: z.string(),
    thumb: z.string().optional(),
    composite: z.string().optional(),
    art: z.string().optional(),
    parentTitle: z.string().optional(),
    parentRatingKey: z.string().optional(),
    grandparentTitle: z.string().optional(),
    grandparentRatingKey: z.string().optional(),
    year: z.number().optional(),
    duration: z.number().optional(),
    leafCount: z.number().optional(),
    childCount: z.number().optional(),
    playlistType: z.string().optional(),
    viewCount: z.number().optional(),
    viewedAt: z.number().optional(),
    lastViewedAt: z.number().optional(),
    addedAt: z.number().optional(),
    updatedAt: z.number().optional(),
  })
  .passthrough();

/** A server-provided Home row and the media items displayed inside it. */
export const hubSchema = z
  .object({
    key: z.string().optional(),
    title: z.string().optional(),
    type: z.string().optional(),
    hubIdentifier: z.string().optional(),
    context: z.string().optional(),
    size: z.number().optional(),
    totalSize: z.number().optional(),
    Metadata: z.array(hubItemSchema).optional(),
  })
  .passthrough();

/** Totals carried on single-metadata `MediaContainer` envelopes ("N songs, M min"). */
export const metadataTotalsSchema = z
  .object({
    size: z.number().optional(),
    leafCount: z.number().optional(),
    duration: z.number().optional(),
  })
  .passthrough();

// ---- derived types mirroring src/bun/plex/types.ts domain interfaces ----

export type PlexSection = z.infer<typeof sectionSchema>;
export type PlexArtist = z.infer<typeof artistSchema>;
export type PlexAlbum = z.infer<typeof albumSchema>;
export type PlexTrack = z.infer<typeof trackSchema>;
export type PlexPlaylist = z.infer<typeof playlistSchema>;
export type PlexHub = z.infer<typeof hubSchema>;
export type PlexHubItem = z.infer<typeof hubItemSchema>;
export type PlexPin = z.infer<typeof pinSchema>;
export type PlexServerResource = z.infer<typeof serverResourceSchema>;
export type PlexConnection = z.infer<typeof connectionSchema>;
export type PlexMetadata = z.infer<typeof metadataTotalsSchema>;
export type PlexMedia = z.infer<typeof mediaSchema>;
export type PlexGenre = z.infer<typeof genreSchema>;
