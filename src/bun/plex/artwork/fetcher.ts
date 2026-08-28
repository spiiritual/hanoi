import type {
  ArtworkCacheEntry,
  ArtworkCacheStatus,
  ArtworkFetcher,
  ArtworkNamespace,
  ArtworkRpcResult,
  ArtworkVariant,
  ArtworkVariantValue,
} from "./types.ts";

export interface ArtworkFetcherSource {
  baseUrl: string;
  token: string;
}

type ArtworkFetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit
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

interface TranscodedArtworkVariant extends ArtworkVariant {
  height: number;
  kind: "transcoded";
  width: number;
}

const isFiniteNumber = (value: ArtworkVariantValue): value is number =>
  // SAFETY: Artwork variants are validated JSON-safe primitives before this
  // guard narrows a value for numeric transcoding parameters.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- this is the value guard for validated variant data
  typeof value === "number" && Number.isFinite(value);

export const isTranscodedVariant = (
  variant: ArtworkVariant
): variant is TranscodedArtworkVariant => {
  const kind = variant["kind"] ?? variant["type"];
  const { height, width } = variant;
  if (kind !== "transcoded") {
    return false;
  }
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) {
    return false;
  }
  return width > 0 && height > 0;
};

/** Resolve token-free Plex paths without ever putting authentication in a URL. */
export const buildArtworkUrl = (
  baseUrl: string,
  path: string,
  variant: ArtworkVariant = {}
): string => {
  if (isTranscodedVariant(variant)) {
    try {
      const url = new URL(`${baseUrl.replace(/\/+$/u, "")}/photo/:/transcode`);
      url.searchParams.set("width", String(variant.width));
      url.searchParams.set("height", String(variant.height));
      url.searchParams.set("url", path);
      return url.toString();
    } catch {
      return "";
    }
  }
  if (/^https?:\/\//iu.test(path)) {
    return path;
  }
  const normalizedBase = baseUrl.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

export const fetchArtwork = async (
  source: ArtworkFetcherSource,
  request: Parameters<ArtworkFetcher>[0],
  fetchImplementation: ArtworkFetchImplementation = fetch
): Promise<Response> => {
  const absoluteSource = /^https?:\/\//iu.test(request.source);
  const url = buildArtworkUrl(source.baseUrl, request.source, request.variant);
  const headers = new Headers({ Accept: "image/*" });
  if (!absoluteSource) {
    headers.set("X-Plex-Token", source.token);
  }
  if (request.etag !== undefined && request.etag.length > 0) {
    headers.set("If-None-Match", request.etag);
  }
  if (request.lastModified !== undefined && request.lastModified.length > 0) {
    headers.set("If-Modified-Since", request.lastModified);
  }
  return await fetchImplementation(url, { headers });
};

export const createArtworkFetcher =
  (
    source: ArtworkFetcherSource,
    fetchImplementation: ArtworkFetchImplementation = fetch
  ): ArtworkFetcher =>
  async (request) => {
    const response = await fetchArtwork(source, request, fetchImplementation);
    return response;
  };

/** Require exact session objects and a matching cache namespace. */
export const isSameArtworkSession = <Config, Client>(
  captured: ArtworkSessionSnapshot<Config, Client>,
  current: ArtworkSessionSnapshot<Config, Client>
): boolean => {
  if (
    captured.config === null ||
    captured.client === null ||
    captured.namespace === null
  ) {
    return false;
  }
  if (
    captured.config !== current.config ||
    captured.client !== current.client
  ) {
    return false;
  }
  const currentNamespace = current.namespace;
  if (currentNamespace === null) {
    return false;
  }
  return (
    captured.namespace.accountId === currentNamespace.accountId &&
    captured.namespace.serverId === currentNamespace.serverId
  );
};

export const serverIdentityFromUrl = (serverUrl: string): string => {
  try {
    const url = new URL(serverUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return "";
  }
};

export const artworkNamespace = (
  input: ArtworkNamespaceIdentityInput
): ArtworkNamespace => {
  const accountUsername = input.accountUsername?.trim();
  const accountId =
    accountUsername !== undefined && accountUsername.length > 0
      ? accountUsername
      : input.fallbackAccountId.trim();
  if (accountId.length === 0) {
    throw new Error("A stable Plex account identity is required");
  }

  const serverClientIdentifier = input.serverClientIdentifier?.trim();
  const serverId =
    serverClientIdentifier !== undefined && serverClientIdentifier.length > 0
      ? serverClientIdentifier
      : serverIdentityFromUrl(input.serverUrl);
  if (serverId.length === 0) {
    throw new Error("A stable Plex server identity is required");
  }
  return { accountId, serverId };
};

export const toArtworkRpcResult = (
  entry: ArtworkCacheEntry | null,
  cacheStatus: ArtworkCacheStatus
): ArtworkRpcResult => {
  if (!entry) {
    return null;
  }
  return {
    cacheStatus,
    contentType: entry.contentType,
    dataBase64: Buffer.from(entry.data).toString("base64"),
  };
};
