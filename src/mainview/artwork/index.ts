import type {
  ArtworkRpcResult,
  ArtworkVariant,
} from "../../bun/plex/artwork/types.ts";

export type ArtworkSource =
  | { kind: "server"; path: string }
  | { kind: "account" };
export type ArtworkRequestSource = ArtworkSource | null | undefined;

export const TRANSCODED_FALLBACK_VARIANT: ArtworkVariant = Object.freeze({
  height: 512,
  kind: "transcoded",
  width: 512,
});

export type ArtworkRequest = (
  source: ArtworkSource,
  variant: ArtworkVariant
) => Promise<ArtworkRpcResult>;

type CreateObjectUrl = (blob: Blob) => string;
type RevokeObjectUrl = (url: string) => void;
type MakeBlob = (data: Uint8Array, contentType: string) => Blob | null;

interface RendererArtworkEntry {
  key: string;
  refs: number;
  url: string | null;
  promise: Promise<string | null>;
  pendingClear: boolean;
}

interface RendererArtworkHandle {
  key: string;
  promise: Promise<string | null>;
  release: () => void;
}

const decodeBase64 = (value: string): Uint8Array | null => {
  if (!value) {
    return null;
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.codePointAt(index) ?? 0;
    }
    return bytes;
  } catch {
    return null;
  }
};

const containsTokenMaterial = (value: string): boolean =>
  /(?:x-plex-token|plex-token)/iu.test(value);

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be positive`);
  }
  return value;
};

export const normalizeArtworkSource = (
  source: ArtworkRequestSource
): ArtworkSource | null => {
  if (!source) {
    return null;
  }
  if (source.kind === "account") {
    return source;
  }
  const path = source.path.trim();
  if (!path || containsTokenMaterial(path)) {
    return null;
  }
  return { kind: "server", path };
};

export const normalizeArtworkVariant = (
  variant: ArtworkVariant = {}
): ArtworkVariant =>
  Object.fromEntries(
    Object.entries(variant).toSorted(([left], [right]) =>
      left.localeCompare(right)
    )
  );

export const artworkRequestKey = (
  source: ArtworkSource,
  variant: ArtworkVariant = {}
): string => {
  const normalizedSource = normalizeArtworkSource(source);
  if (!normalizedSource) {
    return "";
  }
  const normalizedVariant = normalizeArtworkVariant(variant);
  return JSON.stringify([
    normalizedSource.kind,
    normalizedSource.kind === "server" ? normalizedSource.path : "account",
    Object.keys(normalizedVariant)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => [key, normalizedVariant[key]]),
  ]);
};

/** Identifies the exact renderer load, including a native/fallback attempt. */
export const artworkAttemptKey = (
  source: ArtworkSource,
  variant: ArtworkVariant,
  attempt: number
): string => {
  const requestKey = artworkRequestKey(source, variant);
  return requestKey ? `${requestKey}|attempt:${attempt}` : "";
};

export const artworkUrlForKey = (
  loadedImage: { key: string; url: string } | null,
  currentKey: string
): string | null => (loadedImage?.key === currentKey ? loadedImage.url : null);

export interface RendererArtworkStoreOptions {
  maxEntries?: number;
  createObjectUrl?: CreateObjectUrl;
  revokeObjectUrl?: RevokeObjectUrl;
  makeBlob?: MakeBlob;
}

/**
 * Renderer-local artwork object URL cache. The request promise is shared by
 * every component using the same token-free source and variant. Object URLs
 * are retained only for a bounded number of least-recently-used entries.
 */
export class RendererArtworkStore {
  private readonly entries = new Map<string, RendererArtworkEntry>();
  private readonly requestArtwork: ArtworkRequest;
  private readonly maxEntries: number;
  private readonly createObjectUrl: CreateObjectUrl | null;
  private readonly revokeObjectUrl: RevokeObjectUrl;
  private readonly makeBlob: MakeBlob;

  constructor(
    requestArtwork: ArtworkRequest,
    options: RendererArtworkStoreOptions = {}
  ) {
    this.requestArtwork = requestArtwork;
    this.maxEntries = positiveInteger(options.maxEntries ?? 128, "maxEntries");
    const urlApi = globalThis.URL;
    this.createObjectUrl =
      options.createObjectUrl ??
      (urlApi === undefined ? null : (blob) => urlApi.createObjectURL(blob));
    this.revokeObjectUrl =
      options.revokeObjectUrl ??
      (urlApi === undefined
        ? () => null
        : (url) => {
            urlApi.revokeObjectURL(url);
          });
    this.makeBlob =
      options.makeBlob ??
      ((data, contentType) => {
        const BlobConstructor = globalThis.Blob;
        if (BlobConstructor === undefined) {
          return null;
        }
        const buffer = new ArrayBuffer(data.byteLength);
        const bytes = new Uint8Array(buffer);
        bytes.set(data);
        return new BlobConstructor([buffer], { type: contentType });
      });
  }

  acquire(
    source: ArtworkSource,
    variant: ArtworkVariant = {}
  ): RendererArtworkHandle {
    const normalizedSource = normalizeArtworkSource(source);
    const normalizedVariant = normalizeArtworkVariant(variant);
    if (!normalizedSource) {
      throw new Error("Artwork source is invalid");
    }
    const key = artworkRequestKey(normalizedSource, normalizedVariant);
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
    } else {
      entry = {
        key,
        pendingClear: false,
        promise: Promise.resolve(null),
        refs: 0,
        url: null,
      };
      entry.promise = this.load(entry, normalizedSource, normalizedVariant);
    }
    this.entries.set(key, entry);
    entry.refs += 1;
    let released = false;
    return {
      key,
      promise: entry.promise,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs === 0 && entry.pendingClear) {
          this.revoke(entry.url);
          if (this.entries.get(entry.key) === entry) {
            this.entries.delete(entry.key);
          }
          return;
        }
        this.trim();
      },
    };
  }

  /** Release renderer object URLs, deferring active entries until their last release. */
  clear(): void {
    for (const [key, entry] of this.entries) {
      if (entry.refs > 0) {
        entry.pendingClear = true;
        continue;
      }
      this.revoke(entry.url);
      this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private async load(
    entry: RendererArtworkEntry,
    source: ArtworkSource,
    variant: ArtworkVariant
  ): Promise<string | null> {
    try {
      const result = await this.requestArtwork(source, variant);
      if (!result || !this.createObjectUrl) {
        return null;
      }
      const data = decodeBase64(result.dataBase64);
      if (!data || data.byteLength === 0) {
        return null;
      }
      const blob = this.makeBlob(data, result.contentType);
      if (!blob) {
        return null;
      }
      const url = this.createObjectUrl(blob);
      if (this.entries.get(entry.key) !== entry) {
        this.revoke(url);
        return null;
      }
      entry.url = url;
      this.trim();
      return url;
    } catch {
      return null;
    }
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) {
        break;
      }
      if (entry.refs === 0) {
        this.revoke(entry.url);
        this.entries.delete(key);
      }
    }
  }

  private revoke(url: string | null): void {
    if (url !== null && url.length > 0) {
      this.revokeObjectUrl(url);
    }
  }
}
