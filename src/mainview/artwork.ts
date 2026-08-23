import type { ArtworkRpcResult, ArtworkVariant } from "../bun/plex/artwork-types.ts";

export type ArtworkSource = { kind: "server"; path: string } | { kind: "account" };
export type ArtworkRequestSource = ArtworkSource | null | undefined;

export const TRANSCODED_FALLBACK_VARIANT: ArtworkVariant = Object.freeze({
  kind: "transcoded",
  width: 512,
  height: 512,
});

export type ArtworkRequest = (
  source: ArtworkSource,
  variant: ArtworkVariant,
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
  private readonly maxEntries: number;
  private readonly createObjectUrl: CreateObjectUrl | null;
  private readonly revokeObjectUrl: RevokeObjectUrl;
  private readonly makeBlob: MakeBlob;

  constructor(
    private readonly requestArtwork: ArtworkRequest,
    options: RendererArtworkStoreOptions = {},
  ) {
    this.maxEntries = positiveInteger(options.maxEntries ?? 128, "maxEntries");
    this.createObjectUrl =
      options.createObjectUrl ??
      (typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? (blob) => URL.createObjectURL(blob)
        : null);
    this.revokeObjectUrl =
      options.revokeObjectUrl ??
      (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function"
        ? (url) => URL.revokeObjectURL(url)
        : () => undefined);
    this.makeBlob =
      options.makeBlob ??
      ((data, contentType) => {
        if (typeof Blob === "undefined") return null;
        const buffer = new ArrayBuffer(data.byteLength);
        new Uint8Array(buffer).set(data);
        return new Blob([buffer], { type: contentType });
      });
  }

  acquire(
    source: ArtworkSource,
    variant: ArtworkVariant = {},
  ): {
    key: string;
    promise: Promise<string | null>;
    release: () => void;
  } {
    const normalizedSource = normalizeArtworkSource(source);
    const normalizedVariant = normalizeArtworkVariant(variant);
    if (!normalizedSource) throw new Error("Artwork source is invalid");
    const key = artworkRequestKey(normalizedSource, normalizedVariant);
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else {
      entry = {
        key,
        refs: 0,
        url: null,
        promise: Promise.resolve(null),
        pendingClear: false,
      };
      const currentEntry = entry;
      entry.promise = this.load(currentEntry, normalizedSource, normalizedVariant);
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    let released = false;
    return {
      key,
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        entry!.refs = Math.max(0, entry!.refs - 1);
        if (entry!.refs === 0 && entry!.pendingClear) {
          this.revoke(entry!.url);
          if (this.entries.get(entry!.key) === entry) this.entries.delete(entry!.key);
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
    variant: ArtworkVariant,
  ): Promise<string | null> {
    try {
      const result = await this.requestArtwork(source, variant);
      if (!result || !this.createObjectUrl) return null;
      const data = decodeBase64(result.dataBase64);
      if (!data || data.byteLength === 0) return null;
      const blob = this.makeBlob(data, result.contentType);
      if (!blob) return null;
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
      if (this.entries.size <= this.maxEntries) break;
      if (entry.refs > 0) continue;
      this.revoke(entry.url);
      this.entries.delete(key);
    }
  }

  private revoke(url: string | null): void {
    if (url) this.revokeObjectUrl(url);
  }
}

export function normalizeArtworkSource(source: ArtworkRequestSource): ArtworkSource | null {
  if (!source) return null;
  if (source.kind === "account") return source;
  if (source.kind !== "server" || typeof source.path !== "string") return null;
  const path = source.path.trim();
  if (!path || containsTokenMaterial(path)) return null;
  return { kind: "server", path };
}

export function normalizeArtworkVariant(variant: ArtworkVariant = {}): ArtworkVariant {
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) return {};
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(variant).sort()) {
    const value = variant[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function artworkRequestKey(source: ArtworkSource, variant: ArtworkVariant = {}): string {
  const normalizedSource = normalizeArtworkSource(source);
  if (!normalizedSource) return "";
  const normalizedVariant = normalizeArtworkVariant(variant);
  return JSON.stringify([
    normalizedSource.kind,
    normalizedSource.kind === "server" ? normalizedSource.path : "account",
    Object.keys(normalizedVariant)
      .sort()
      .map((key) => [key, normalizedVariant[key]]),
  ]);
}

/** Identifies the exact renderer load, including a native/fallback attempt. */
export function artworkAttemptKey(
  source: ArtworkSource,
  variant: ArtworkVariant,
  attempt: number,
): string {
  const requestKey = artworkRequestKey(source, variant);
  return requestKey ? `${requestKey}|attempt:${attempt}` : "";
}

export function artworkUrlForKey(
  loadedImage: { key: string; url: string } | null,
  currentKey: string,
): string | null {
  return loadedImage?.key === currentKey ? loadedImage.url : null;
}

function decodeBase64(value: string): Uint8Array | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function containsTokenMaterial(value: string): boolean {
  return /(?:x-plex-token|plex-token)/i.test(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  return value;
}
