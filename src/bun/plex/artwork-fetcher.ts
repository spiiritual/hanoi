import type {
  ArtworkCacheEntry,
  ArtworkCacheStatus,
  ArtworkFetcher,
  ArtworkNamespace,
  ArtworkRpcResult,
  ArtworkVariant,
} from "./artwork-types.ts";

export interface ArtworkFetcherSource {
  baseUrl: string;
  token: string;
}

type ArtworkFetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ArtworkNamespaceIdentityInput {
  accountUsername?: string;
  fallbackAccountId: string;
  serverClientIdentifier?: string;
  serverUrl: string;
}

interface ArtworkSessionSnapshot<Config, Client> {
  config: Config | null;
  client: Client | null;
  namespace: ArtworkNamespace | null;
}

/** Require exact session objects and a matching cache namespace. */
export function isSameArtworkSession<Config, Client>(
  captured: ArtworkSessionSnapshot<Config, Client>,
  current: ArtworkSessionSnapshot<Config, Client>,
): boolean {
  return (
    captured.config !== null &&
    captured.client !== null &&
    captured.namespace !== null &&
    captured.config === current.config &&
    captured.client === current.client &&
    captured.namespace.accountId === current.namespace?.accountId &&
    captured.namespace.serverId === current.namespace?.serverId
  );
}

export function createArtworkFetcher(
  source: ArtworkFetcherSource,
  fetchImplementation: ArtworkFetchImplementation = fetch,
): ArtworkFetcher {
  return (request) => fetchArtwork(source, request, fetchImplementation);
}

export async function fetchArtwork(
  source: ArtworkFetcherSource,
  request: Parameters<ArtworkFetcher>[0],
  fetchImplementation: ArtworkFetchImplementation = fetch,
): Promise<Response> {
  const absoluteSource = /^https?:\/\//i.test(request.source);
  const url = buildArtworkUrl(source.baseUrl, request.source, request.variant);
  const headers = new Headers({ Accept: "image/*" });
  if (!absoluteSource) headers.set("X-Plex-Token", source.token);
  if (request.etag) headers.set("If-None-Match", request.etag);
  if (request.lastModified) headers.set("If-Modified-Since", request.lastModified);
  return fetchImplementation(url, { headers });
}

/** Resolve token-free Plex paths without ever putting authentication in a URL. */
export function buildArtworkUrl(
  baseUrl: string,
  path: string,
  variant: ArtworkVariant = {},
): string {
  if (isTranscodedVariant(variant)) {
    try {
      const url = new URL(`${baseUrl.replace(/\/+$/, "")}/photo/:/transcode`);
      url.searchParams.set("width", String(variant["width"]));
      url.searchParams.set("height", String(variant["height"]));
      url.searchParams.set("url", path);
      return url.toString();
    } catch {
      return "";
    }
  }
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}${path.startsWith("/") ? path : `/${path}`}`;
}

export function isTranscodedVariant(
  variant: ArtworkVariant,
): variant is ArtworkVariant & { width: number; height: number } {
  const kind = variant["kind"] ?? variant["type"];
  const width = variant["width"];
  const height = variant["height"];
  return (
    kind === "transcoded" &&
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

export function artworkNamespace(input: ArtworkNamespaceIdentityInput): {
  accountId: string;
  serverId: string;
} {
  const accountId = input.accountUsername?.trim() || input.fallbackAccountId.trim();
  if (!accountId) throw new Error("A stable Plex account identity is required");

  const serverId = input.serverClientIdentifier?.trim() || serverIdentityFromUrl(input.serverUrl);
  if (!serverId) throw new Error("A stable Plex server identity is required");
  return { accountId, serverId };
}

export function serverIdentityFromUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function toArtworkRpcResult(
  entry: ArtworkCacheEntry | null,
  cacheStatus: ArtworkCacheStatus,
): ArtworkRpcResult {
  if (!entry) return null;
  return {
    dataBase64: Buffer.from(entry.data).toString("base64"),
    contentType: entry.contentType,
    cacheStatus,
  };
}

export type { ArtworkRpcResult };
