/**
 * Zod schemas for every Plex/plex.tv response the client parses.
 *
 * Validation contract — "require the fields we need, tolerate the rest":
 * - Every response object schema uses `z.looseObject()`: unknown or new
 *   fields never fail validation and are not stripped from the parsed value.
 * - Required fields are the ones the UI and client actually consume (per the
 *   plex.pen screen audit): identity/key fields that render text, keyed
 *   navigation, dedup, or HTTP calls. A value missing them is dropped
 *   (`filterItems`) or rejected (`parseStrict`), each with a logged reason.
 * - Optional fields are consumed but legitimately absent (year, thumb,
 *   viewCount, …). Fields nothing consumes are omitted from the schemas —
 *   loose-object parsing keeps them in the parsed data, so adding one back
 *   later is just re-declaring it.
 */
import { z } from "zod";

/** Parsed JSON values accepted at the Plex response boundary. */
export const parseStrict = <T>(
  schema: z.ZodType<T>,
  // This function is the parser boundary for untrusted Plex responses.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Zod validates the payload here
  payload: unknown,
  context: string
): T | null => {
  const result = schema.safeParse(payload);
  if (result.success) {
    return result.data;
  }
  console.error(
    `Plex response failed validation (${context}):`,
    result.error.issues
  );
  return null;
};

/**
 * Strict array validation: each item is validated individually; invalid
 * items are dropped (with the reason and the item logged), valid ones kept.
 * Never throws — one malformed item must not wipe a whole list.
 */
export const filterItems = <T>(
  schema: z.ZodType<T>,
  items: unknown[],
  context: string
): T[] => {
  const valid: T[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      console.error(
        `Plex item failed validation (${context}); dropped:`,
        result.error.issues,
        item
      );
    }
  }
  return valid;
};

/**
 * Unwrap the top-level `MediaContainer` envelope. A missing/invalid envelope
 * is logged and yields `{}` so callers degrade to empty results.
 */
interface MediaContainerEnvelope<T> {
  MediaContainer?: T;
}

export const container = <T>(
  // This function is the parser boundary for untrusted Plex responses.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Zod validates the payload here
  payload: unknown,
  context: string
): MediaContainerEnvelope<T> => {
  const parsed = parseStrict(
    z.object({ MediaContainer: z.record(z.string(), z.unknown()) }),
    payload,
    context
  );
  if (!parsed) {
    return {};
  }
  // SAFETY: The envelope shape is validated here; callers supply T for the
  // response-specific fields they read from Plex's loose object payload.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the validated envelope is intentionally generic
  return parsed as MediaContainerEnvelope<T>;
};

// ---- plex.tv PIN flow (/api/v2/pins) ----

export const pinSchema = z.looseObject({
  authToken: z.string().nullable().optional(),
  clientIdentifier: z.string(),
  code: z.string(),
  // plex.tv returns `id` as a JSON number; coerce to string so the poll
  // URL templating and the `PlexPin.id: string` type stay consistent.
  expiresIn: z.number(),
  id: z.coerce.string(),
});

/** Poll responses: only `authToken` is consumed; anything else is tolerated. */
export const pinPollSchema = z.looseObject({
  authToken: z.string().nullable().optional(),
});

// ---- plex.tv resources (/api/v2/resources) ----
// Server Selection + sidebar dropdown show host (from the URI) and online
// (from /identity). `local` picks the best URI; `accessToken` is the
// per-server token; `provides`/`owned` filter to owned media servers.

const connectionSchema = z.looseObject({
  IPv6: z.boolean().optional(),
  address: z.string().optional(),
  local: z.boolean(),
  port: z.number().optional(),
  protocol: z.string().optional(),
  relay: z.boolean().optional(),
  uri: z.string(),
});

export const serverResourceSchema = z.looseObject({
  /** null on non-server devices (e.g. Plexamp clients); servers may also omit it. */
  accessToken: z.string().nullable().optional(),
  clientIdentifier: z.string(),
  connections: z.array(connectionSchema).optional(),
  name: z.string(),
  owned: z.boolean(),
  provides: z.string().optional(),
});

// ---- plex.tv account (/api/v2/user) ----
// Wire shape of /api/v2/user. The Connected card's "verified" badge is
// plex.tv's `confirmed`; the app maps it to `verified` (see getPlexAccount).

export const plexAccountSchema = z.looseObject({
  confirmed: z.boolean().optional(),
  email: z.string(),
  thumb: z.string().optional(),
  username: z.string(),
});

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

const genreSchema = z.looseObject({ tag: z.string() });

const partSchema = z.looseObject({
  key: z.string().optional(),
});

const mediaSchema = z.looseObject({
  Part: z.array(partSchema),
});

export const sectionSchema = z.looseObject({
  key: z.string(),
  title: z.string(),
  type: z.string(),
});

export const artistSchema = z.looseObject({
  Genre: z.array(genreSchema).optional(),
  art: z.string().optional(),
  childCount: z.number().optional(),
  key: z.string(),
  leafCount: z.number().optional(),
  ratingKey: z.string(),
  thumb: z.string().optional(),
  title: z.string(),
  type: z.literal("artist"),
});

export const albumSchema = z.looseObject({
  key: z.string(),
  leafCount: z.number().optional(),
  parentRatingKey: z.string().optional(),
  parentTitle: z.string().optional(),
  ratingKey: z.string(),
  thumb: z.string().optional(),
  title: z.string(),
  type: z.literal("album"),
  viewCount: z.number().optional(),
  year: z.number().optional(),
});

export const trackSchema = z.looseObject({
  Media: z.array(mediaSchema).optional(),
  duration: z.number().optional(),
  grandparentRatingKey: z.string().optional(),
  grandparentTitle: z.string().optional(),
  index: z.number().optional(),
  key: z.string(),
  parentRatingKey: z.string().optional(),
  parentTitle: z.string().optional(),
  ratingKey: z.string(),
  thumb: z.string().optional(),
  title: z.string(),
  type: z.literal("track"),
  viewCount: z.number().optional(),
});

export const playlistSchema = z.looseObject({
  composite: z.string().optional(),
  duration: z.number().optional(),
  key: z.string(),
  leafCount: z.number().optional(),
  playlistType: z.string().optional(),
  ratingKey: z.string(),
  title: z.string(),
  type: z.literal("playlist"),
  year: z.number().optional(),
});

export const hubItemSchema = z.looseObject({
  addedAt: z.number().optional(),
  art: z.string().optional(),
  childCount: z.number().optional(),
  composite: z.string().optional(),
  duration: z.number().optional(),
  grandparentRatingKey: z.string().optional(),
  grandparentTitle: z.string().optional(),
  key: z.string(),
  lastViewedAt: z.number().optional(),
  leafCount: z.number().optional(),
  parentRatingKey: z.string().optional(),
  parentTitle: z.string().optional(),
  playlistType: z.string().optional(),
  ratingKey: z.string(),
  thumb: z.string().optional(),
  title: z.string(),
  type: z.string(),
  updatedAt: z.number().optional(),
  viewCount: z.number().optional(),
  viewedAt: z.number().optional(),
  year: z.number().optional(),
});

/** A server-provided Home row and the media items displayed inside it. */
export const hubSchema = z.looseObject({
  Metadata: z.array(hubItemSchema).optional(),
  context: z.string().optional(),
  hubIdentifier: z.string().optional(),
  key: z.string().optional(),
  size: z.number().optional(),
  title: z.string().optional(),
  totalSize: z.number().optional(),
  type: z.string().optional(),
});

/** Totals carried on single-metadata `MediaContainer` envelopes ("N songs, M min"). */
const metadataTotalsSchema = z.looseObject({
  duration: z.number().optional(),
  leafCount: z.number().optional(),
  size: z.number().optional(),
});

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
