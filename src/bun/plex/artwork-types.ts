/** Stable, non-secret identity for a Plex artwork cache namespace. */
export interface ArtworkNamespace {
  /** The Plex account identity, never an authentication token. */
  accountId: string;
  /** The Plex server identity, never an authentication token or URL credential. */
  serverId: string;
}

export type ArtworkVariantValue = string | number | boolean | null;

export type ArtworkCacheStatus = "hit" | "miss";

/** The intentionally small, JSON-safe payload exposed by the artwork RPC. */
export interface ArtworkRpcPayload {
  /** Base64-encoded image bytes; RPC transport serializes messages as JSON. */
  dataBase64: string;
  contentType: string;
  cacheStatus: ArtworkCacheStatus;
}

export type ArtworkRpcResult = ArtworkRpcPayload | null;

/**
 * Rendering/transcoding parameters that distinguish one artwork object from
 * another. Keep this limited to serialisable, non-secret values.
 */
export type ArtworkVariant = Readonly<Record<string, ArtworkVariantValue>>;

/** Token-free input used to address an artwork object. */
export interface ArtworkRequest {
  namespace: ArtworkNamespace;
  /** Plex's source path or a token-free absolute URL. */
  source: string;
  variant?: ArtworkVariant;
}

/** Inputs supplied to the injectable network layer. Tokens stay in its closure. */
export interface ArtworkFetchRequest {
  source: string;
  variant: ArtworkVariant;
  etag?: string;
  lastModified?: string;
}

export interface ArtworkFetchResponse {
  /** HTTP status when the fetcher is backed by HTTP. Defaults to 200. */
  status?: number;
  /** Set for a conditional request that received HTTP 304. */
  notModified?: boolean;
  body?: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

export type ArtworkFetcher = (
  request: ArtworkFetchRequest,
) => Promise<ArtworkFetchResponse | Response>;

/** A validated object returned by the cache. `data` contains image bytes. */
export interface ArtworkCacheEntry {
  key: string;
  namespace: ArtworkNamespace;
  source: string;
  variant: ArtworkVariant;
  data: Uint8Array;
  contentType: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
  validatedAt: number;
  lastAccessedAt: number;
}

export interface ArtworkCacheOptions {
  memoryMaxEntries?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxObjectBytes?: number;
  /** How long an object is fresh before revalidation is considered. */
  freshTtlMs?: number;
  /** How long a stale object may be served while a refresh runs. */
  staleWhileRevalidateMs?: number;
  /** Injectable clock, primarily useful for deterministic tests. */
  now?: () => number;
  /** Default fetcher used by `getOrFetch` when one is not passed. */
  fetcher?: ArtworkFetcher;
}
