import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  ArtworkCacheEntry,
  ArtworkCacheOptions,
  ArtworkFetchRequest,
  ArtworkFetchResponse,
  ArtworkFetcher,
  ArtworkNamespace,
  ArtworkRequest,
  ArtworkVariant,
  ArtworkVariantValue,
} from "./artwork-types.ts";

const DEFAULT_MEMORY_MAX_ENTRIES = 100;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const DEFAULT_FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_STALE_WHILE_REVALIDATE_MS = 30 * 24 * 60 * 60 * 1_000;
const OBJECTS_DIRECTORY = "objects";
const DATABASE_FILENAME = "metadata.sqlite";
const TOKEN_PARAMETER = /(?:^|[?&])x-plex-token=/i;
const TOKEN_TEXT = /x-plex-token/i;
const MAX_TOKEN_DECODE_DEPTH = 32;
const IMAGE_MIME_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jp2",
  "image/jxl",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

interface ArtworkRow {
  key: string;
  account_id: string;
  server_id: string;
  source: string;
  variant: string;
  object_name: string;
  byte_size: number;
  content_type: string;
  etag: string | null;
  last_modified: string | null;
  fetched_at: number;
  validated_at: number;
  last_accessed_at: number;
  access_sequence: number;
}

interface NormalizedRequest {
  key: string;
  namespace: ArtworkNamespace;
  source: string;
  variant: ArtworkVariant;
  objectName: string;
}

interface StoredArtwork {
  row: ArtworkRow;
  data: Uint8Array;
}

interface InFlightArtwork {
  promise: Promise<ArtworkCacheEntry>;
  namespaceKey: string;
  epoch: number;
}

interface NamespaceLifecycle {
  generation: number;
  active: number;
  clearing: boolean;
  idleResolvers: Array<() => void>;
  clearPromise?: Promise<void>;
}

interface NamespaceLease {
  generation: number;
  release: () => void;
}

/**
 * A token-free, content-addressed artwork cache for the main process.
 *
 * The caller owns the root directory. The cache creates `metadata.sqlite` and
 * an `objects/` directory below it, and never consults Electrobun's userData.
 * Network access is deliberately supplied through an injected fetcher; a
 * Plex token can therefore remain in the caller's closure and out of every
 * cache key, filename, and metadata column.
 */
export class ArtworkCache {
  private readonly objectsDirectory: string;
  private readonly database: Database;
  private readonly memory = new Map<string, StoredArtwork>();
  private readonly inFlight = new Map<string, InFlightArtwork>();
  private readonly namespaceLifecycles = new Map<string, NamespaceLifecycle>();
  private readonly memoryMaxEntries: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxObjectBytes: number;
  private readonly freshTtlMs: number;
  private readonly staleWhileRevalidateMs: number;
  private readonly now: () => number;
  private readonly defaultFetcher?: ArtworkFetcher;
  private readonly ready: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private accessSequence: number;
  private disposed = false;
  private closed = false;

  constructor(rootDirectory: string, options: ArtworkCacheOptions = {}) {
    if (!rootDirectory.trim()) throw new Error("Artwork cache root directory is required");
    mkdirSync(rootDirectory, { recursive: true });
    this.objectsDirectory = join(rootDirectory, OBJECTS_DIRECTORY);
    this.memoryMaxEntries = positiveInteger(
      options.memoryMaxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES,
      "memoryMaxEntries",
    );
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    this.maxObjectBytes = positiveInteger(
      options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES,
      "maxObjectBytes",
    );
    this.freshTtlMs = nonNegativeNumber(options.freshTtlMs ?? DEFAULT_FRESH_TTL_MS, "freshTtlMs");
    this.staleWhileRevalidateMs = nonNegativeNumber(
      options.staleWhileRevalidateMs ?? DEFAULT_STALE_WHILE_REVALIDATE_MS,
      "staleWhileRevalidateMs",
    );
    this.now = options.now ?? Date.now;
    this.defaultFetcher = options.fetcher;

    this.database = new Database(join(rootDirectory, DATABASE_FILENAME));
    this.database.run(`
      CREATE TABLE IF NOT EXISTS artwork (
        key TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        source TEXT NOT NULL,
        variant TEXT NOT NULL,
        object_name TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        fetched_at INTEGER NOT NULL,
        validated_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        access_sequence INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.database.run(
      "CREATE INDEX IF NOT EXISTS artwork_namespace_access ON artwork(account_id, server_id, last_accessed_at)",
    );
    this.database.run("CREATE INDEX IF NOT EXISTS artwork_access ON artwork(last_accessed_at)");
    try {
      this.database.run(
        "ALTER TABLE artwork ADD COLUMN access_sequence INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      // Existing databases already have the logical access sequence.
    }
    this.removeUnsafeMetadata();
    this.accessSequence =
      this.database
        .query<{ maximum: number | null }, []>(
          "SELECT MAX(access_sequence) AS maximum FROM artwork",
        )
        .get()?.maximum ?? 0;

    this.ready = this.prepareDirectoriesAndCleanup();
  }

  /** Read an object without making a network request. Stale entries are returned. */
  async get(request: ArtworkRequest): Promise<ArtworkCacheEntry | null> {
    const normalized = normalizeRequest(request);
    const lease = this.acquireNamespace(normalized.namespace);
    try {
      await this.ensureReady();
      const stored = await this.readStored(normalized);
      if (!stored) return null;
      this.assertCurrentEpoch(normalized, lease.generation);
      return this.touchAndReturn(normalized, stored);
    } finally {
      lease.release();
    }
  }

  /**
   * Return an object according to fresh/stale-while-revalidate policy. A stale
   * object is returned immediately during the SWR window while one background
   * refresh is deduplicated. Once outside that window, refresh is awaited;
   * refresh failures serve the stale object instead.
   */
  async getOrFetch(
    request: ArtworkRequest,
    fetcher: ArtworkFetcher = this.defaultFetcher as ArtworkFetcher,
  ): Promise<ArtworkCacheEntry> {
    const normalized = normalizeRequest(request);
    const lease = this.acquireNamespace(normalized.namespace);
    const requestEpoch = lease.generation;
    try {
      await this.ensureReady();
      this.assertCurrentEpoch(normalized, requestEpoch);
      const existing = await this.readStored(normalized);
      this.assertCurrentEpoch(normalized, requestEpoch);
      if (existing) {
        const entry = this.touchAndReturn(normalized, existing);
        const age = Math.max(0, this.now() - entry.validatedAt);
        if (age <= this.freshTtlMs) return entry;
        if (age <= this.freshTtlMs + this.staleWhileRevalidateMs) {
          if (fetcher) {
            void this.fetchAndStore(normalized, fetcher, existing, requestEpoch).catch(
              () => undefined,
            );
          }
          return entry;
        }
        if (!fetcher) return entry;
        try {
          return await this.fetchAndStore(normalized, fetcher, existing, requestEpoch);
        } catch {
          this.assertCurrentEpoch(normalized, requestEpoch);
          return entry;
        }
      }

      if (!fetcher) throw new Error("No artwork fetcher was supplied");
      return this.fetchAndStore(normalized, fetcher, undefined, requestEpoch);
    } finally {
      lease.release();
    }
  }

  /** Validate and atomically persist a fetched image. Useful for tests and custom fetchers. */
  async put(request: ArtworkRequest, response: ArtworkFetchResponse): Promise<ArtworkCacheEntry> {
    const normalized = normalizeRequest(request);
    const lease = this.acquireNamespace(normalized.namespace);
    try {
      await this.ensureReady();
      return this.persistResponse(normalized, response, lease.generation);
    } finally {
      lease.release();
    }
  }

  /** Remove all memory and disk entries belonging to one account/server pair. */
  async clearNamespace(namespace: ArtworkNamespace): Promise<void> {
    const normalized = normalizeNamespace(namespace);
    const namespaceKey = getNamespaceKey(normalized);
    const lifecycle = this.getNamespaceLifecycle(namespaceKey);
    if (lifecycle.clearPromise) return lifecycle.clearPromise;

    let clearPromise!: Promise<void>;
    clearPromise = (async () => {
      lifecycle.clearing = true;
      lifecycle.generation += 1;
      try {
        await this.waitForNamespaceIdle(lifecycle);
        await this.ensureReady();
        this.assertUsable();
        await this.withMutationLock(async () => {
          this.assertUsable();
          const rows = this.database
            .query<Pick<ArtworkRow, "key" | "object_name">, [string, string]>(
              "SELECT key, object_name FROM artwork WHERE account_id = ? AND server_id = ?",
            )
            .all(normalized.accountId, normalized.serverId);
          this.database.run("DELETE FROM artwork WHERE account_id = ? AND server_id = ?", [
            normalized.accountId,
            normalized.serverId,
          ]);
          for (const [key, stored] of this.memory) {
            if (
              stored.row.account_id === normalized.accountId &&
              stored.row.server_id === normalized.serverId
            ) {
              this.memory.delete(key);
            }
          }
          await Promise.all(
            rows.map((row) => removeIfPresent(join(this.objectsDirectory, row.object_name))),
          );
        });
      } finally {
        lifecycle.clearing = false;
        if (lifecycle.clearPromise === clearPromise) lifecycle.clearPromise = undefined;
      }
    })();
    lifecycle.clearPromise = clearPromise;
    return clearPromise;
  }

  /** Remove temporary writes and object files no longer referenced by SQLite. */
  async cleanup(): Promise<void> {
    await this.ensureReady();
    await this.withMutationLock(() => this.cleanupOrphans());
  }

  /** Close SQLite and release this cache's resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.memory.clear();
    this.closePromise ??= this.closeWhenReady();
  }

  /** Await initialization and all in-flight fetches before closing SQLite. */
  async disposeAsync(): Promise<void> {
    this.dispose();
    await this.closePromise;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.disposeAsync();
  }

  private async fetchAndStore(
    request: NormalizedRequest,
    fetcher: ArtworkFetcher,
    existing?: StoredArtwork,
    expectedEpoch?: number,
  ): Promise<ArtworkCacheEntry> {
    const lease = this.acquireNamespace(request.namespace);
    try {
      const epoch = expectedEpoch ?? lease.generation;
      if (epoch !== lease.generation) {
        throw new Error("Artwork fetch was invalidated by namespace clear");
      }
      const current = this.inFlight.get(request.key);
      if (current && current.epoch === epoch) {
        return current.promise.finally(lease.release);
      }
      if (current) this.inFlight.delete(request.key);

      const fetchRequest: ArtworkFetchRequest = {
        source: request.source,
        variant: request.variant,
        ...(existing?.row.etag ? { etag: existing.row.etag } : {}),
        ...(existing?.row.last_modified ? { lastModified: existing.row.last_modified } : {}),
      };
      let resolvePromise!: (entry: ArtworkCacheEntry) => void;
      let rejectPromise!: (error: unknown) => void;
      const promise = new Promise<ArtworkCacheEntry>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      const flight: InFlightArtwork = {
        promise,
        namespaceKey: getNamespaceKey(request.namespace),
        epoch,
      };
      this.inFlight.set(request.key, flight);
      void (async () => {
        try {
          const response = await fetcher(fetchRequest);
          this.assertCurrentEpoch(request, epoch);
          if (isNotModified(response)) {
            if (!existing) throw new Error("Artwork fetch returned 304 without a cached object");
            resolvePromise(await this.refreshNotModified(request, existing, response, epoch));
          } else {
            resolvePromise(await this.persistResponse(request, response, epoch));
          }
        } catch (error) {
          rejectPromise(error);
        } finally {
          this.clearInFlight(request.key, promise);
        }
      })();
      return promise.finally(lease.release);
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private clearInFlight(key: string, promise: Promise<ArtworkCacheEntry>): void {
    if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
  }

  private async persistResponse(
    request: NormalizedRequest,
    response: ArtworkFetchResponse | Response,
    epoch: number,
  ): Promise<ArtworkCacheEntry> {
    this.assertUsable();
    this.assertCurrentEpoch(request, epoch);
    const normalizedResponse = await normalizeResponse(response, this.maxObjectBytes);
    return this.withMutationLock(async () => {
      this.assertUsable();
      this.assertCurrentEpoch(request, epoch);
      const now = this.now();
      const row: ArtworkRow = {
        key: request.key,
        account_id: request.namespace.accountId,
        server_id: request.namespace.serverId,
        source: request.source,
        variant: JSON.stringify(request.variant),
        object_name: request.objectName,
        byte_size: normalizedResponse.data.byteLength,
        content_type: normalizedResponse.contentType,
        etag: normalizedResponse.etag ?? null,
        last_modified: normalizedResponse.lastModified ?? null,
        fetched_at: now,
        validated_at: now,
        last_accessed_at: now,
        access_sequence: ++this.accessSequence,
      };
      let committed = false;
      try {
        await this.writeObjectAtomically(request.objectName, normalizedResponse.data);
        this.assertCurrentEpoch(request, epoch);
        this.assertUsable();
        this.database.run(
          `INSERT OR REPLACE INTO artwork
           (key, account_id, server_id, source, variant, object_name, byte_size,
            content_type, etag, last_modified, fetched_at, validated_at, last_accessed_at,
            access_sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.key,
            row.account_id,
            row.server_id,
            row.source,
            row.variant,
            row.object_name,
            row.byte_size,
            row.content_type,
            row.etag,
            row.last_modified,
            row.fetched_at,
            row.validated_at,
            row.last_accessed_at,
            row.access_sequence,
          ],
        );
        committed = true;
        this.remember({ row, data: normalizedResponse.data });
        await this.evictIfNeeded();
        this.assertCurrentEpoch(request, epoch);
        return toPublicEntry({ row, data: normalizedResponse.data });
      } catch (error) {
        if (committed) {
          this.database.run("DELETE FROM artwork WHERE key = ?", [request.key]);
          this.memory.delete(request.key);
        }
        await removeIfPresent(join(this.objectsDirectory, request.objectName));
        throw error;
      }
    });
  }

  private async refreshNotModified(
    request: NormalizedRequest,
    existing: StoredArtwork,
    response: ArtworkFetchResponse | Response,
    epoch: number,
  ): Promise<ArtworkCacheEntry> {
    return this.withMutationLock(async () => {
      this.assertUsable();
      this.assertCurrentEpoch(request, epoch);
      const now = this.now();
      const etag = getResponseHeader(response, "etag") ?? existing.row.etag;
      const lastModified =
        getResponseHeader(response, "last-modified") ?? existing.row.last_modified;
      const accessSequence = ++this.accessSequence;
      this.database.run(
        "UPDATE artwork SET validated_at = ?, last_accessed_at = ?, access_sequence = ?, etag = ?, last_modified = ? WHERE key = ?",
        [now, now, accessSequence, etag, lastModified, request.key],
      );
      const row: ArtworkRow = {
        ...existing.row,
        etag: etag ?? null,
        last_modified: lastModified ?? null,
        validated_at: now,
        last_accessed_at: now,
        access_sequence: accessSequence,
      };
      const stored = { row, data: existing.data };
      this.remember(stored);
      this.assertCurrentEpoch(request, epoch);
      return toPublicEntry(stored);
    });
  }

  private async readStored(request: NormalizedRequest): Promise<StoredArtwork | null> {
    this.assertUsable();
    const memory = this.memory.get(request.key);
    if (memory) {
      assertStoredRowSafe(memory.row);
      return memory;
    }

    const row = this.database
      .query<ArtworkRow, [string]>("SELECT * FROM artwork WHERE key = ?")
      .get(request.key);
    if (!row) return null;
    const objectPath = join(this.objectsDirectory, row.object_name);
    try {
      assertStoredRowSafe(row);
      const data = new Uint8Array(await readFile(objectPath));
      this.assertUsable();
      if (data.byteLength !== row.byte_size || data.byteLength > this.maxObjectBytes) {
        throw new Error("Artwork object size does not match metadata");
      }
      const stored = { row, data };
      this.remember(stored);
      return stored;
    } catch (error) {
      if (this.disposed) throw error;
      await this.withMutationLock(async () => {
        const current = this.database
          .query<Pick<ArtworkRow, "object_name">, [string]>(
            "SELECT object_name FROM artwork WHERE key = ?",
          )
          .get(request.key);
        if (current?.object_name !== row.object_name) return;
        this.database.run("DELETE FROM artwork WHERE key = ?", [request.key]);
        await removeIfPresent(objectPath);
      });
      return null;
    }
  }

  private touchAndReturn(request: NormalizedRequest, stored: StoredArtwork): ArtworkCacheEntry {
    this.assertUsable();
    const now = this.now();
    const accessSequence = ++this.accessSequence;
    this.database.run(
      "UPDATE artwork SET last_accessed_at = ?, access_sequence = ? WHERE key = ?",
      [now, accessSequence, request.key],
    );
    stored.row = { ...stored.row, last_accessed_at: now, access_sequence: accessSequence };
    this.remember(stored);
    return toPublicEntry(stored);
  }

  private remember(stored: StoredArtwork): void {
    this.memory.delete(stored.row.key);
    this.memory.set(stored.row.key, stored);
    while (this.memory.size > this.memoryMaxEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  private async evictIfNeeded(): Promise<void> {
    while (true) {
      this.assertUsable();
      const totals = this.database
        .query<{ count: number; bytes: number }, []>(
          "SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM artwork",
        )
        .get();
      if (!totals || (totals.count <= this.maxEntries && totals.bytes <= this.maxBytes)) return;
      const oldest = this.database
        .query<Pick<ArtworkRow, "key" | "object_name">, []>(
          "SELECT key, object_name FROM artwork ORDER BY access_sequence ASC, fetched_at ASC, key ASC LIMIT 1",
        )
        .get();
      if (!oldest) return;
      this.database.run("DELETE FROM artwork WHERE key = ?", [oldest.key]);
      this.memory.delete(oldest.key);
      await removeIfPresent(join(this.objectsDirectory, oldest.object_name));
    }
  }

  private removeUnsafeMetadata(): void {
    const rows = this.database.query<ArtworkRow, []>("SELECT * FROM artwork").all();
    for (const row of rows) {
      try {
        assertStoredRowSafe(row);
      } catch {
        this.database.run("DELETE FROM artwork WHERE key = ?", [row.key]);
      }
    }
  }

  private async prepareDirectoriesAndCleanup(): Promise<void> {
    await mkdir(this.objectsDirectory, { recursive: true });
    this.assertUsable();
    await this.withMutationLock(() => this.cleanupOrphans());
  }

  private async cleanupOrphans(): Promise<void> {
    const referenced = new Set(
      this.database
        .query<Pick<ArtworkRow, "object_name">, []>("SELECT object_name FROM artwork")
        .all()
        .map((row) => row.object_name),
    );
    let files: string[] = [];
    try {
      files = await readdir(this.objectsDirectory);
    } catch {
      return;
    }
    await Promise.all(
      files
        .filter((file) => file.endsWith(".tmp") || (file.endsWith(".bin") && !referenced.has(file)))
        .map((file) => removeIfPresent(join(this.objectsDirectory, file))),
    );
  }

  private async writeObjectAtomically(objectName: string, data: Uint8Array): Promise<void> {
    await mkdir(this.objectsDirectory, { recursive: true });
    const temporaryName = `${objectName}.${randomUUID()}.tmp`;
    const temporaryPath = join(this.objectsDirectory, temporaryName);
    const objectPath = join(this.objectsDirectory, objectName);
    try {
      await writeFile(temporaryPath, data);
      await rename(temporaryPath, objectPath);
    } catch (error) {
      await removeIfPresent(temporaryPath);
      throw error;
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private getNamespaceLifecycle(namespaceOrKey: ArtworkNamespace | string): NamespaceLifecycle {
    const key =
      typeof namespaceOrKey === "string" ? namespaceOrKey : getNamespaceKey(namespaceOrKey);
    let lifecycle = this.namespaceLifecycles.get(key);
    if (!lifecycle) {
      lifecycle = { generation: 0, active: 0, clearing: false, idleResolvers: [] };
      this.namespaceLifecycles.set(key, lifecycle);
    }
    return lifecycle;
  }

  private acquireNamespace(namespace: ArtworkNamespace): NamespaceLease {
    const lifecycle = this.getNamespaceLifecycle(namespace);
    if (lifecycle.clearing) throw new Error("Artwork namespace is being cleared");
    lifecycle.active += 1;
    let released = false;
    return {
      generation: lifecycle.generation,
      release: () => {
        if (released) return;
        released = true;
        lifecycle.active -= 1;
        if (lifecycle.active === 0) {
          const resolvers = lifecycle.idleResolvers.splice(0);
          for (const resolve of resolvers) resolve();
        }
      },
    };
  }

  private async waitForNamespaceIdle(lifecycle: NamespaceLifecycle): Promise<void> {
    if (lifecycle.active === 0) return;
    await new Promise<void>((resolve) => lifecycle.idleResolvers.push(resolve));
  }

  private namespaceEpoch(requestOrKey: NormalizedRequest | string): number {
    const key =
      typeof requestOrKey === "string" ? requestOrKey : getNamespaceKey(requestOrKey.namespace);
    return this.getNamespaceLifecycle(key).generation;
  }

  private assertCurrentEpoch(request: NormalizedRequest, epoch: number): void {
    if (this.namespaceEpoch(request) !== epoch) {
      throw new Error("Artwork fetch was invalidated by namespace clear");
    }
  }

  private async closeWhenReady(): Promise<void> {
    try {
      await this.ready;
    } catch {
      // Initialization is intentionally fenced by disposal.
    }
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()].map((flight) => flight.promise));
    }
    if (!this.closed) {
      this.closed = true;
      this.database.close();
    }
  }

  private async ensureReady(): Promise<void> {
    this.assertUsable();
    await this.ready;
    this.assertUsable();
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Artwork cache has been disposed");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function getNamespaceKey(namespace: ArtworkNamespace): string {
  return `${namespace.accountId}\u0000${namespace.serverId}`;
}

function normalizeNamespace(namespace: ArtworkNamespace): ArtworkNamespace {
  if (!namespace || typeof namespace !== "object") {
    throw new Error("Artwork namespace is required");
  }
  const accountId = normalizeIdentity(namespace.accountId, "accountId");
  const serverId = normalizeIdentity(namespace.serverId, "serverId");
  return { accountId, serverId };
}

function normalizeIdentity(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (containsTokenMaterial(normalized) || hasControlCharacters(normalized)) {
    throw new Error(`${name} must be a non-secret identifier`);
  }
  return normalized;
}

function normalizeRequest(request: ArtworkRequest): NormalizedRequest {
  const namespace = normalizeNamespace(request.namespace);
  const source = canonicalSource(request.source);
  const variant = canonicalVariant(request.variant === undefined ? {} : request.variant);
  const canonicalKey = [
    namespace.accountId,
    namespace.serverId,
    source,
    serializeVariant(variant),
  ].join("\u0000");
  const key = createHash("sha256").update(canonicalKey).digest("hex");
  return { key, namespace, source, variant, objectName: `${key}.bin` };
}

function canonicalSource(source: string): string {
  if (typeof source !== "string" || !source.trim()) throw new Error("Artwork source is required");
  const input = source.trim();
  if (containsTokenMaterial(input) || TOKEN_PARAMETER.test(input)) {
    throw new Error("Artwork source must not contain a Plex token");
  }
  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error("Artwork source is invalid");
    }
    assertSafeSourceQuery(url);
    if (url.username || url.password)
      throw new Error("Artwork source must not contain credentials");
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  }
  if (hasControlCharacters(input) || input.startsWith("//")) {
    throw new Error("Artwork source is invalid");
  }
  const relative = new URL(input, "https://artwork.invalid");
  assertSafeSourceQuery(relative);
  relative.hash = "";
  relative.searchParams.sort();
  return `${relative.pathname}${relative.search}`;
}

function assertSafeSourceQuery(url: URL): void {
  for (const [name, value] of url.searchParams) {
    if (containsTokenMaterial(name) || containsTokenMaterial(value)) {
      throw new Error("Artwork source must not contain a Plex token");
    }
  }
}

function canonicalVariant(variant: ArtworkVariant): ArtworkVariant {
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
    throw new Error("Artwork variant must be an object");
  }
  const keys = Object.keys(variant).sort();
  const normalized = Object.create(null) as Record<string, ArtworkVariantValue>;
  for (const key of keys) {
    if (!key || containsTokenMaterial(key))
      throw new Error("Artwork variant must not contain a token");
    const value = variant[key];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean" &&
      value !== null
    ) {
      throw new Error(`Artwork variant value for ${key} is not serialisable`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Artwork variant value for ${key} must be finite`);
    }
    if (typeof value === "string" && containsTokenMaterial(value)) {
      throw new Error("Artwork variant must not contain a token");
    }
    normalized[key] = value;
  }
  return normalized;
}

function serializeVariant(variant: ArtworkVariant): string {
  return JSON.stringify(
    Object.keys(variant)
      .sort()
      .map((key) => [key, variant[key]]),
  );
}

function isNotModified(response: ArtworkFetchResponse | Response): boolean {
  return response instanceof Response
    ? response.status === 304
    : response.notModified === true || response.status === 304;
}

async function normalizeResponse(
  response: ArtworkFetchResponse | Response,
  maxObjectBytes: number,
): Promise<{
  data: Uint8Array;
  contentType: string;
  etag?: string;
  lastModified?: string;
}> {
  if (isNotModified(response)) throw new Error("304 requires an existing artwork object");
  if (response instanceof Response) {
    if (!response.ok) throw new Error(`Artwork request failed: ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    assertImageContentType(contentType);
    const length = response.headers.get("content-length");
    if (length && Number(length) > maxObjectBytes) {
      throw new Error(`Artwork exceeds the ${maxObjectBytes}-byte limit`);
    }
    if (!response.body) throw new Error("Artwork response has no body");
    const data = await toBytes(response.body, maxObjectBytes);
    return {
      data,
      contentType: normalizeContentType(contentType),
      etag: safeHeader(response.headers.get("etag")),
      lastModified: safeHeader(response.headers.get("last-modified")),
    };
  }

  const status = response.status ?? 200;
  if (status < 200 || status >= 300) throw new Error(`Artwork request failed: ${status}`);
  const contentType = response.contentType ?? "";
  assertImageContentType(contentType);
  if (!response.body) throw new Error("Artwork response has no body");
  const data = await toBytes(response.body, maxObjectBytes);
  assertObjectSize(data, maxObjectBytes);
  return {
    data,
    contentType: normalizeContentType(contentType),
    etag: safeHeader(response.etag),
    lastModified: safeHeader(response.lastModified),
  };
}

async function toBytes(
  body: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
  maxObjectBytes: number,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    assertObjectSize(body, maxObjectBytes);
    if (body.byteLength === 0) throw new Error("Artwork response has an empty body");
    return body.slice();
  }
  if (body instanceof ArrayBuffer) {
    assertObjectSize(new Uint8Array(body), maxObjectBytes);
    if (body.byteLength === 0) throw new Error("Artwork response has an empty body");
    return new Uint8Array(body.slice(0));
  }
  if (body instanceof Blob) {
    if (body.size > maxObjectBytes) {
      throw new Error(`Artwork exceeds the ${maxObjectBytes}-byte limit`);
    }
    const data = new Uint8Array(await body.arrayBuffer());
    if (data.byteLength === 0) throw new Error("Artwork response has an empty body");
    return data;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > maxObjectBytes) {
        await reader.cancel();
        throw new Error(`Artwork exceeds the ${maxObjectBytes}-byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("Artwork response has an empty body");
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function assertStoredRowSafe(row: ArtworkRow): void {
  const metadata = [
    row.key,
    row.account_id,
    row.server_id,
    row.source,
    row.variant,
    row.object_name,
    row.content_type,
    row.etag,
    row.last_modified,
  ];
  if (
    metadata.some(
      (value) => value !== null && (hasControlCharacters(value) || containsTokenMaterial(value)),
    )
  ) {
    throw new Error("Artwork metadata contains unsafe token material");
  }
  if (!/^[a-f0-9]{64}\.bin$/.test(row.object_name)) {
    throw new Error("Artwork metadata contains an invalid object name");
  }
  assertImageContentType(row.content_type);
  let variant: unknown;
  try {
    variant = JSON.parse(row.variant);
  } catch {
    throw new Error("Artwork metadata contains an invalid variant");
  }
  canonicalVariant(variant as ArtworkVariant);
}

function assertImageContentType(contentType: string): void {
  if (typeof contentType !== "string") {
    throw new Error("Artwork response must have an image content type");
  }
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!IMAGE_MIME_TYPES.has(mime)) {
    throw new Error("Artwork response must have an image content type");
  }
}

function normalizeContentType(contentType: string): string {
  assertImageContentType(contentType);
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function assertObjectSize(data: Uint8Array, maxObjectBytes: number): void {
  if (data.byteLength > maxObjectBytes) {
    throw new Error(`Artwork exceeds the ${maxObjectBytes}-byte limit`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function containsTokenMaterial(value: string): boolean {
  if (typeof value !== "string") return true;
  let candidate = value;
  for (let attempt = 0; attempt <= MAX_TOKEN_DECODE_DEPTH; attempt += 1) {
    if (TOKEN_TEXT.test(candidate) || TOKEN_PARAMETER.test(candidate)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  return true;
}

function safeHeader(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (hasControlCharacters(value) || containsTokenMaterial(value)) {
    throw new Error("Artwork response contains an unsafe validator");
  }
  return value;
}

function getResponseHeader(
  response: ArtworkFetchResponse | Response,
  name: string,
): string | undefined {
  if (response instanceof Response) return safeHeader(response.headers.get(name));
  return safeHeader(name === "etag" ? response.etag : response.lastModified);
}

function toPublicEntry(stored: StoredArtwork): ArtworkCacheEntry {
  let variant: ArtworkVariant;
  try {
    variant = JSON.parse(stored.row.variant) as ArtworkVariant;
  } catch {
    throw new Error("Artwork metadata contains an invalid variant");
  }
  return {
    key: stored.row.key,
    namespace: {
      accountId: stored.row.account_id,
      serverId: stored.row.server_id,
    },
    source: stored.row.source,
    variant,
    data: new Uint8Array(stored.data),
    contentType: stored.row.content_type,
    etag: stored.row.etag ?? undefined,
    lastModified: stored.row.last_modified ?? undefined,
    fetchedAt: stored.row.fetched_at,
    validatedAt: stored.row.validated_at,
    lastAccessedAt: stored.row.last_accessed_at,
  };
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export type {
  ArtworkCacheEntry,
  ArtworkCacheOptions,
  ArtworkFetchRequest,
  ArtworkFetchResponse,
  ArtworkFetcher,
  ArtworkNamespace,
  ArtworkRequest,
  ArtworkVariant,
};
