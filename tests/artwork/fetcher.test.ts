import { expect, test } from "bun:test";

import {
  artworkNamespace,
  buildArtworkUrl,
  createArtworkFetcher,
  isSameArtworkSession,
  toArtworkRpcResult,
} from "../../src/bun/plex/artwork/fetcher.ts";
import type { ArtworkCacheEntry } from "../../src/bun/plex/artwork/types.ts";

const imageResponse = (): Response =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "image/png" },
  });

const requestUrl = (input: RequestInfo | URL): string => {
  if (input instanceof Request) {
    return input.url;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input;
};

test("relative artwork paths use the server URL and header token", async () => {
  let requestedUrl = "";
  let requestedHeaders: Headers | undefined;
  const fetcher = createArtworkFetcher(
    { baseUrl: "https://plex.example:32400", token: "secret" },
    async (input, init) => {
      await Promise.resolve();
      requestedUrl = requestUrl(input);
      requestedHeaders = new Headers(init?.headers);
      return imageResponse();
    }
  );

  await fetcher({ source: "/library/metadata/1/thumb", variant: {} });

  expect(requestedUrl).toBe(
    "https://plex.example:32400/library/metadata/1/thumb"
  );
  expect(requestedHeaders?.get("X-Plex-Token")).toBe("secret");
});

test("absolute artwork sources do not receive the Plex token", async () => {
  let requestedHeaders: Headers | undefined;
  const fetcher = createArtworkFetcher(
    { baseUrl: "https://plex.example:32400", token: "secret" },
    async (_input, init) => {
      await Promise.resolve();
      requestedHeaders = new Headers(init?.headers);
      return imageResponse();
    }
  );

  await fetcher({ source: "https://cdn.example/art.png", variant: {} });

  expect(requestedHeaders?.has("X-Plex-Token")).toBe(false);
});

test("artwork namespaces prefer account and server identities", () => {
  expect(
    artworkNamespace({
      accountUsername: "alice",
      fallbackAccountId: "install-id",
      serverClientIdentifier: "server-id",
      serverUrl: "https://plex.example:32400",
    })
  ).toEqual({ accountId: "alice", serverId: "server-id" });
  expect(
    artworkNamespace({
      fallbackAccountId: "install-id",
      serverUrl: "https://plex.example:32400/",
    })
  ).toEqual({
    accountId: "install-id",
    serverId: "https://plex.example:32400",
  });
});

test("artwork session identity requires exact config, client, and namespace", () => {
  const config = {};
  const client = {};
  const session = {
    client,
    config,
    namespace: { accountId: "account-1", serverId: "server-1" },
  };

  expect(isSameArtworkSession(session, session)).toBe(true);
  expect(
    isSameArtworkSession(session, {
      ...session,
      config: {},
    })
  ).toBe(false);
  expect(
    isSameArtworkSession(session, {
      ...session,
      client: {},
    })
  ).toBe(false);
  expect(
    isSameArtworkSession(session, {
      ...session,
      namespace: { accountId: "account-2", serverId: "server-1" },
    })
  ).toBe(false);
  expect(
    isSameArtworkSession(session, {
      ...session,
      namespace: null,
    })
  ).toBe(false);
});

test("artwork RPC mapping exposes JSON-safe bytes, content type, and cache status", () => {
  const entry: ArtworkCacheEntry = {
    contentType: "image/jpeg",
    data: new Uint8Array([4, 5]),
    fetchedAt: 0,
    key: "artwork-key",
    lastAccessedAt: 0,
    namespace: { accountId: "account", serverId: "server" },
    source: "/thumb",
    validatedAt: 0,
    variant: {},
  };
  const result = toArtworkRpcResult(entry, "hit");
  expect(result).toEqual({
    cacheStatus: "hit",
    contentType: "image/jpeg",
    dataBase64: "BAU=",
  });
  expect(structuredClone(result)).toEqual(result);
  expect(toArtworkRpcResult(null, "miss")).toBeNull();
});

test("transcoded artwork URLs contain dimensions and no token", () => {
  const url = buildArtworkUrl("https://plex.example:32400", "/library/thumb", {
    height: 240,
    kind: "transcoded",
    width: 320,
  });
  expect(url).toContain("/photo/:/transcode?");
  expect(url).toContain("width=320");
  expect(url).toContain("height=240");
  expect(url).toContain("url=%2Flibrary%2Fthumb");
  expect(url).not.toContain("X-Plex-Token");
});
