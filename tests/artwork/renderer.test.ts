import { expect, test } from "bun:test";
import {
  artworkAttemptKey,
  artworkRequestKey,
  artworkUrlForKey,
  normalizeArtworkSource,
  RendererArtworkStore,
} from "../src/mainview/artwork.ts";

const result = {
  dataBase64: "AQID",
  contentType: "image/png",
  cacheStatus: "miss" as const,
};

test("normalizes token-free sources and makes source/variant keys stable", () => {
  const source = { kind: "server" as const, path: "  /library/metadata/1/thumb  " };
  expect(normalizeArtworkSource(source)).toEqual({
    kind: "server",
    path: "/library/metadata/1/thumb",
  });
  expect(normalizeArtworkSource({ kind: "server", path: "/thumb?X-Plex-Token=secret" })).toBeNull();
  expect(artworkRequestKey(source, { width: 512, height: 512 })).toBe(
    artworkRequestKey(source, { height: 512, width: 512 }),
  );
  expect(artworkRequestKey(source, {})).not.toBe(
    artworkRequestKey(source, { kind: "transcoded", width: 512, height: 512 }),
  );
  expect(artworkRequestKey({ kind: "account" }, {})).not.toBe(artworkRequestKey(source, {}));
  expect(artworkAttemptKey(source, { width: 512 }, 0)).not.toBe(
    artworkAttemptKey(source, { width: 512 }, 1),
  );
  expect(artworkAttemptKey(source, { width: 512 }, 0)).not.toBe(
    artworkAttemptKey(source, { width: 256 }, 0),
  );
  const nativeKey = artworkAttemptKey(source, { width: 512 }, 0);
  const fallbackKey = artworkAttemptKey(source, { width: 512 }, 1);
  expect(artworkUrlForKey({ key: nativeKey, url: "blob:old" }, fallbackKey)).toBeNull();
  expect(artworkUrlForKey({ key: fallbackKey, url: "blob:current" }, fallbackKey)).toBe(
    "blob:current",
  );
});

test("deduplicates requests and releases bounded object URLs", async () => {
  let requests = 0;
  let objectUrls = 0;
  const revoked: string[] = [];
  const store = new RendererArtworkStore(
    async () => {
      requests += 1;
      await Promise.resolve();
      return result;
    },
    {
      maxEntries: 1,
      createObjectUrl: () => `blob:${++objectUrls}`,
      revokeObjectUrl: (url) => revoked.push(url),
      makeBlob: (data, contentType) => {
        expect(Array.from(data)).toEqual([1, 2, 3]);
        expect(contentType).toBe("image/png");
        return {} as Blob;
      },
    },
  );

  const first = store.acquire({ kind: "server", path: "/one" });
  const second = store.acquire({ kind: "server", path: "/one" });
  expect(await first.promise).toBe("blob:1");
  expect(await second.promise).toBe("blob:1");
  expect(requests).toBe(1);
  first.release();
  second.release();

  const other = store.acquire({ kind: "server", path: "/two" });
  expect(await other.promise).toBe("blob:2");
  other.release();
  expect(revoked).toEqual(["blob:1"]);

  store.clear();
  expect(revoked).toEqual(["blob:1", "blob:2"]);
});

test("clear defers revocation while an artwork URL is referenced", async () => {
  const revoked: string[] = [];
  const store = new RendererArtworkStore(async () => result, {
    createObjectUrl: () => "blob:active",
    revokeObjectUrl: (url) => revoked.push(url),
    makeBlob: () => ({}) as Blob,
  });
  const acquired = store.acquire({ kind: "server", path: "/active" });

  expect(await acquired.promise).toBe("blob:active");
  store.clear();
  expect(revoked).toEqual([]);
  expect(store.size).toBe(1);

  acquired.release();
  expect(revoked).toEqual(["blob:active"]);
  expect(store.size).toBe(0);
});

test("bounded eviction leaves active object URLs valid", async () => {
  const revoked: string[] = [];
  const store = new RendererArtworkStore(async () => result, {
    maxEntries: 1,
    createObjectUrl: (() => {
      let count = 0;
      return () => `blob:${++count}`;
    })(),
    revokeObjectUrl: (url) => revoked.push(url),
    makeBlob: () => ({}) as Blob,
  });
  const active = store.acquire({ kind: "server", path: "/active" });
  const evicted = store.acquire({ kind: "server", path: "/evicted" });

  expect(await active.promise).toBe("blob:1");
  expect(await evicted.promise).toBe("blob:2");
  expect(revoked).toEqual([]);

  evicted.release();
  expect(revoked).toEqual(["blob:2"]);
  active.release();
});

test("does not require browser object URL APIs", async () => {
  const store = new RendererArtworkStore(async () => result, {
    createObjectUrl: undefined,
    makeBlob: () => null,
  });
  const acquired = store.acquire({ kind: "account" });
  expect(await acquired.promise).toBeNull();
  acquired.release();
});
