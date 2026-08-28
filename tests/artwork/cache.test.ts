import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { ArtworkCache } from "../../src/bun/plex/artwork/cache.ts";
import type {
  ArtworkCacheOptions,
  ArtworkFetchResponse,
  ArtworkRequest,
  ArtworkVariant,
} from "../../src/bun/plex/artwork/types.ts";

const roots: string[] = [];
const caches: ArtworkCache[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join("/tmp", "hanoi-artwork-cache-"));
  roots.push(root);
  return root;
};

const removeRoots = async (): Promise<void> => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    })
  );
};

const disposeCaches = async (): Promise<void> => {
  await Promise.all(
    caches.splice(0).map(async (cache) => {
      await cache.disposeAsync();
    })
  );
  await removeRoots();
};

afterEach(disposeCaches);

const makeCache = (
  root: string,
  options?: ArtworkCacheOptions
): ArtworkCache => {
  const cache = new ArtworkCache(root, options);
  caches.push(cache);
  return cache;
};

const image = (body: string, etag?: string): ArtworkFetchResponse => ({
  body: new TextEncoder().encode(body),
  contentType: "image/png; charset=binary",
  etag,
});

const encodeRepeated = (value: string, depth: number): string => {
  let encoded = value;
  for (let index = 0; index < depth; index += 1) {
    encoded = encodeURIComponent(encoded);
  }
  return encoded;
};

const expectRejected = async (
  promise: Promise<unknown>,
  message: string
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    expect(String(error)).toContain(message);
  }
};

const namespace = { accountId: "account-1", serverId: "server-1" };

test("isolates account, server, source, and variant keys without token material", async () => {
  const cache = makeCache(await makeRoot());
  const first = await cache.put(
    { namespace, source: "/photo?b=2&a=1", variant: { height: 64, width: 64 } },
    image("one")
  );
  const otherAccount = await cache.put(
    {
      namespace: { accountId: "account-2", serverId: "server-1" },
      source: "/photo?a=1&b=2",
      variant: { height: 64, width: 64 },
    },
    image("two")
  );
  const otherVariant = await cache.put(
    {
      namespace,
      source: "/photo?a=1&b=2",
      variant: { height: 128, width: 128 },
    },
    image("three")
  );

  expect(first.key).not.toBe(otherAccount.key);
  expect(first.key).not.toBe(otherVariant.key);
  expect(first.source).toBe("/photo?a=1&b=2");
  expect(first.variant).toEqual({ height: 64, width: 64 });
  expect(first.key).not.toContain("plex-token");
  const normalizedEntry = await cache.get({
    namespace,
    source: "/photo?a=1&b=2",
    variant: { height: 64, width: 64 },
  });
  expect(normalizedEntry?.data).toEqual(new TextEncoder().encode("one"));
});

test("serves memory and disk hits and leaves only completed atomic objects", async () => {
  const root = await makeRoot();
  const request = { namespace, source: "/photo", variant: { width: 32 } };
  const cache = makeCache(root);
  await cache.put(request, image("disk"));
  const memoryEntry = await cache.get(request);
  expect(memoryEntry?.data).toEqual(new TextEncoder().encode("disk"));
  const files = await readdir(path.join(root, "objects"));
  expect(files).toHaveLength(1);
  expect(files[0]).toEndWith(".bin");
  cache.dispose();

  const reopened = makeCache(root);
  const diskEntry = await reopened.get(request);
  expect(diskEntry?.data).toEqual(new TextEncoder().encode("disk"));
  reopened.dispose();
});

test("deduplicates concurrent fetches", async () => {
  const cache = makeCache(await makeRoot());
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await Bun.sleep(10);
    return image("shared");
  };
  const request = { namespace, source: "/photo", variant: {} };
  const results = await Promise.all([
    cache.getOrFetch(request, fetcher),
    cache.getOrFetch(request, fetcher),
    cache.getOrFetch(request, fetcher),
  ]);

  expect(calls).toBe(1);
  expect(
    results.map((result) => new TextDecoder().decode(result.data))
  ).toEqual(["shared", "shared", "shared"]);
});

test("serves stale artwork during revalidation and on errors", async () => {
  let now = 0;
  const cache = makeCache(await makeRoot(), {
    freshTtlMs: 10,
    now: () => now,
    staleWhileRevalidateMs: 50,
  });
  const request = { namespace, source: "/photo", variant: {} };
  await cache.put(request, image("old", "v1"));
  now = 20;
  let calls = 0;
  const refreshed = await cache.getOrFetch(request, async (input) => {
    calls += 1;
    expect(input.etag).toBe("v1");
    return await Promise.resolve(image("new", "v2"));
  });
  expect(new TextDecoder().decode(refreshed.data)).toBe("old");
  await Bun.sleep(5);
  expect(calls).toBe(1);
  const refreshedEntry = await cache.get(request);
  expect(
    new TextDecoder().decode(refreshedEntry?.data ?? new Uint8Array())
  ).toBe("new");

  now = 100;
  const staleOnError = await cache.getOrFetch(request, async () => {
    await Promise.resolve();
    throw new Error("offline");
  });
  expect(new TextDecoder().decode(staleOnError.data)).toBe("new");
});

test("evicts least recently used entries and rejects non-images and oversized images", async () => {
  let now = 0;
  const cache = makeCache(await makeRoot(), {
    maxBytes: 6,
    maxEntries: 2,
    maxObjectBytes: 4,
    now: () => {
      now += 1;
      return now;
    },
  });
  const request = (source: string) => ({ namespace, source, variant: {} });
  await cache.put(request("/a"), image("aa"));
  await cache.put(request("/b"), image("bb"));
  await cache.get(request("/a"));
  await cache.put(request("/c"), image("cc"));
  expect(await cache.get(request("/a"))).not.toBeNull();
  expect(await cache.get(request("/b"))).toBeNull();
  expect(await cache.get(request("/c"))).not.toBeNull();

  await Promise.all(
    ["", "text/html", "image/x-plex-token=secret"].map(async (contentType) => {
      await expectRejected(
        cache.put(request(`/invalid-${contentType.length}`), {
          body: new Uint8Array([1]),
          contentType,
        }),
        "image content type"
      );
    })
  );
  await expectRejected(
    cache.put(request("/large"), image("12345")),
    "byte limit"
  );
});

test("clears one namespace without affecting another", async () => {
  const cache = makeCache(await makeRoot());
  const other = { accountId: "account-2", serverId: "server-2" };
  await cache.put({ namespace, source: "/photo", variant: {} }, image("one"));
  await cache.put(
    { namespace: other, source: "/photo", variant: {} },
    image("two")
  );
  await cache.clearNamespace(namespace);
  expect(
    await cache.get({ namespace, source: "/photo", variant: {} })
  ).toBeNull();
  expect(
    await cache.get({ namespace: other, source: "/photo", variant: {} })
  ).not.toBeNull();
});

test("serializes a clear with a write in another namespace", async () => {
  const root = await makeRoot();
  const cache = makeCache(root);
  const other = { accountId: "account-2", serverId: "server-2" };
  const bodyStarted = Promise.withResolvers<undefined>();
  const releaseBody = Promise.withResolvers<undefined>();
  const blockedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await releaseBody.promise;
      controller.enqueue(new TextEncoder().encode("other namespace"));
      controller.close();
    },
    start() {
      bodyStarted.resolve();
    },
  });
  const write = cache.put(
    { namespace: other, source: "/write", variant: {} },
    { body: blockedBody, contentType: "image/png" }
  );
  await bodyStarted.promise;
  await cache.clearNamespace(namespace);
  releaseBody.resolve();
  await write;

  const otherEntry = await cache.get({
    namespace: other,
    source: "/write",
    variant: {},
  });
  expect(new TextDecoder().decode(otherEntry?.data)).toBe("other namespace");
  expect(
    await cache.get({ namespace, source: "/write", variant: {} })
  ).toBeNull();
});

test("fences an in-flight fetch when its namespace is cleared", async () => {
  const root = await makeRoot();
  const cache = makeCache(root);
  const started = Promise.withResolvers<null>();
  const release = Promise.withResolvers<null>();
  const request = { namespace, source: "/slow", variant: {} };
  const fetchPromise = cache.getOrFetch(request, async () => {
    started.resolve(null);
    await release.promise;
    return image("must-not-return");
  });
  await started.promise;
  const clearPromise = cache.clearNamespace(namespace);
  release.resolve();
  await expectRejected(fetchPromise, "invalidated");
  await clearPromise;
  expect(await cache.get(request)).toBeNull();
  expect(await readdir(path.join(root, "objects"))).toEqual([]);
  await cache.disposeAsync();
});

test("rejects writes during a namespace clear and reopens the next generation", async () => {
  const root = await makeRoot();
  const cache = makeCache(root);
  const request = { namespace, source: "/racing", variant: {} };
  await cache.put(request, image("before"));

  const bodyStarted = Promise.withResolvers<undefined>();
  const releaseBody = Promise.withResolvers<undefined>();
  const blockedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await releaseBody.promise;
      controller.enqueue(new TextEncoder().encode("during"));
      controller.close();
    },
    start() {
      bodyStarted.resolve();
    },
  });
  const blockedPut = cache.put(
    { namespace, source: "/blocked", variant: {} },
    { body: blockedBody, contentType: "image/png" }
  );
  await bodyStarted.promise;

  const clearPromise = cache.clearNamespace(namespace);
  await expectRejected(
    cache.put(
      { namespace, source: "/during-clear", variant: {} },
      image("rejected")
    ),
    "being cleared"
  );
  releaseBody.resolve();
  await expectRejected(blockedPut, "invalidated");
  await clearPromise;

  await cache.put(request, image("after"));
  const afterEntry = await cache.get(request);
  expect(new TextDecoder().decode(afterEntry?.data)).toBe("after");
  const objectFiles = await readdir(path.join(root, "objects"));
  expect(objectFiles.every((file) => file.endsWith(".bin"))).toBe(true);
  await cache.disposeAsync();
});

test("does not return stale bytes when clear invalidates revalidation", async () => {
  let now = 0;
  const root = await makeRoot();
  const cache = makeCache(root, {
    freshTtlMs: 1,
    now: () => now,
    staleWhileRevalidateMs: 0,
  });
  const request = { namespace, source: "/stale", variant: {} };
  await cache.put(request, image("before-clear"));
  now = 10;
  const started = Promise.withResolvers<null>();
  const release = Promise.withResolvers<null>();
  const fetchPromise = cache.getOrFetch(request, async () => {
    started.resolve(null);
    await release.promise;
    return image("must-not-return");
  });
  await started.promise;
  const clearPromise = cache.clearNamespace(namespace);
  release.resolve();
  await expectRejected(fetchPromise, "invalidated");
  await clearPromise;
  expect(await cache.get(request)).toBeNull();
});

test("rejects encoded token query names and token-like variant values before persistence", async () => {
  const root = await makeRoot();
  const cache = makeCache(root);
  await expectRejected(
    cache.put(
      { namespace, source: "/photo?%78-plex-token=secret", variant: {} },
      image("unsafe")
    ),
    "token"
  );
  await expectRejected(
    cache.put(
      {
        namespace,
        source: "/photo",
        variant: { resize: "x-plex-token=secret" },
      },
      image("unsafe")
    ),
    "token"
  );

  const database = new Database(path.join(root, "metadata.sqlite"));
  expect(
    database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM artwork")
      .get()?.count
  ).toBe(0);
  database.close();
  expect(await readdir(path.join(root, "objects"))).toEqual([]);
  await cache.disposeAsync();
});

test("rejects nested and malformed token encodings in every string input", async () => {
  const cache = makeCache(await makeRoot());
  const deeplyEncodedToken = encodeRepeated("x-plex-token=secret", 20);
  const deeplyEncodedName = encodeRepeated("x-plex-token", 20);

  await expectRejected(
    cache.put(
      {
        namespace: { accountId: deeplyEncodedName, serverId: "server-1" },
        source: "/photo",
        variant: {},
      },
      image("unsafe")
    ),
    "identifier"
  );
  await expectRejected(
    cache.put(
      { namespace, source: `/photo?safe=${deeplyEncodedToken}`, variant: {} },
      image("unsafe")
    ),
    "token"
  );
  await expectRejected(
    cache.put(
      { namespace, source: "/photo", variant: { [deeplyEncodedName]: "safe" } },
      image("unsafe")
    ),
    "token"
  );
  await expectRejected(
    cache.put(
      { namespace, source: "/photo", variant: { resize: deeplyEncodedToken } },
      image("unsafe")
    ),
    "token"
  );
  await expectRejected(
    cache.put(
      { namespace, source: "/photo", variant: {} },
      image("unsafe", deeplyEncodedName)
    ),
    "validator"
  );
  await expectRejected(
    cache.put(
      { namespace, source: "/photo?x=%E0%A4%A", variant: {} },
      image("unsafe")
    ),
    "token"
  );
  await expectRejected(
    cache.put(
      { namespace, source: "/photo", variant: { resize: "%" } },
      image("unsafe")
    ),
    "token"
  );
  await expectRejected(
    cache.put(
      {
        namespace,
        source: `/photo?safe=${encodeRepeated("safe value", 40)}`,
        variant: {},
      },
      image("unsafe")
    ),
    "token"
  );
});

test("keeps prototype-looking variant keys isolated and validates variants", async () => {
  const cache = makeCache(await makeRoot());
  const variant: ArtworkVariant = {};
  Object.defineProperty(variant, "__proto__", {
    configurable: true,
    enumerable: true,
    value: "safe",
    writable: true,
  });
  const entry = await cache.put(
    { namespace, source: "/photo", variant },
    image("safe")
  );
  expect(
    Object.getOwnPropertyDescriptor(entry.variant, "__proto__")?.value
  ).toBe("safe");
  expect(
    Object.getOwnPropertyDescriptor(Object.prototype, "polluted")?.value
  ).toBeUndefined();
  const emptyEntry = await cache.put(
    { namespace, source: "/photo", variant: {} },
    image("empty")
  );
  expect(entry.key).not.toBe(emptyEntry.key);
  // SAFETY: This deliberately invalid request exercises runtime variant validation.
  const invalidRequest: ArtworkRequest = {
    namespace,
    source: "/invalid",
    variant: {},
  };
  Object.assign(invalidRequest, { variant: null });
  await expectRejected(cache.put(invalidRequest, image("bad")), "variant");
});

test("uses access order rather than equal wall-clock timestamps for disk LRU", async () => {
  const cache = makeCache(await makeRoot(), {
    maxBytes: 6,
    maxEntries: 2,
    now: () => 1234,
  });
  const request = (source: string) => ({ namespace, source, variant: {} });
  await cache.put(request("/a"), image("aa"));
  await cache.put(request("/b"), image("bb"));
  await cache.get(request("/a"));
  await cache.put(request("/c"), image("cc"));
  expect(await cache.get(request("/a"))).not.toBeNull();
  expect(await cache.get(request("/b"))).toBeNull();
});

test("can dispose immediately while initialization is still pending", async () => {
  const root = await makeRoot();
  const cache = makeCache(root);
  cache.dispose();
  await cache.disposeAsync();
  const reopened = makeCache(root);
  await reopened.put(
    { namespace, source: "/after-dispose", variant: {} },
    image("ok")
  );
});

test("enforces the object limit while reading a response stream", async () => {
  const cache = makeCache(await makeRoot(), { maxObjectBytes: 4 });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    },
  });
  await expectRejected(
    cache.put(
      { namespace, source: "/stream", variant: {} },
      { body, contentType: "image/png" }
    ),
    "byte limit"
  );
});

test("deduplicates a reentrant getOrFetch call", async () => {
  const cache = makeCache(await makeRoot());
  const request = { namespace, source: "/reentrant", variant: {} };
  let calls = 0;
  let nested:
    | Promise<Awaited<ReturnType<ArtworkCache["getOrFetch"]>>>
    | undefined;
  const fetcher = async () => {
    calls += 1;
    nested = cache.getOrFetch(request, fetcher);
    return await Promise.resolve(image("reentrant"));
  };
  const result = await cache.getOrFetch(request, fetcher);
  expect(calls).toBe(1);
  expect(nested).toBeDefined();
  if (!nested) {
    throw new Error("Expected the reentrant fetch promise");
  }
  const nestedResult = await nested;
  expect(new TextDecoder().decode(nestedResult.data)).toBe("reentrant");
  expect(new TextDecoder().decode(result.data)).toBe("reentrant");
});
