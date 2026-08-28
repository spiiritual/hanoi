import { expect, test } from "bun:test";

import { connectionCandidates } from "../../src/bun/plex/auth.ts";
import type { PlexServerResource } from "../../src/bun/plex/auth.ts";
import { selectReachableConnection } from "../../src/bun/plex/client.ts";
import {
  findPersistedServer,
  savedServerNeedsRefresh,
} from "../../src/bun/plex/server-selection.ts";
import type { PlexServerInfo } from "../../src/bun/plex/types.ts";

const servers: PlexServerInfo[] = [
  {
    clientIdentifier: "resource-home",
    local: true,
    name: "Home Server",
    online: false,
    token: "server-token-home",
    url: "https://home.local",
  },
  {
    clientIdentifier: "resource-remote",
    local: false,
    name: "Remote Server",
    online: true,
    token: "server-token-remote",
    url: "https://remote.example",
  },
];

const resource: PlexServerResource = {
  clientIdentifier: "resource-sekinas",
  connections: [
    { local: true, relay: false, uri: "https://lan.example" },
    { local: false, relay: false, uri: "https://tailscale.example" },
    { local: false, relay: false, uri: "https://public.example" },
    { local: false, relay: true, uri: "https://relay.example" },
  ],
  name: "SekiNAS",
  owned: true,
  provides: "server",
};

test("persisted resource identifier wins over stale URL and name", () => {
  const server = findPersistedServer(
    {
      clientIdentifier: "resource-remote",
      name: "Old Remote Name",
      url: "https://old-remote.example",
    },
    servers
  );

  expect(server?.clientIdentifier).toBe("resource-remote");
});

test("legacy persisted servers still match by URL", () => {
  const server = findPersistedServer(
    {
      name: "Home Server",
      url: "https://home.local",
    },
    servers
  );

  expect(server?.clientIdentifier).toBe("resource-home");
});

test("connection candidates prefer local, then direct, then relay URLs", () => {
  expect(
    connectionCandidates(resource).map((connection) => connection.uri)
  ).toEqual([
    "https://lan.example",
    "https://tailscale.example",
    "https://public.example",
    "https://relay.example",
  ]);
});

test("reachable connection selection falls back from a dead local URL", async () => {
  const probes: string[] = [];
  const selected = await selectReachableConnection(
    resource,
    "server-token",
    async (url) => {
      await Promise.resolve();
      probes.push(url);
      return url === "https://tailscale.example";
    }
  );

  expect(selected?.uri).toBe("https://tailscale.example");
  expect(probes).toEqual([
    "https://lan.example",
    "https://tailscale.example",
    "https://public.example",
    "https://relay.example",
  ]);
});

test("unreachable connection selection returns no online candidate", async () => {
  const selected = await selectReachableConnection(
    resource,
    "server-token",
    async () => {
      await Promise.resolve();
      return false;
    }
  );

  expect(selected).toBeUndefined();
});

test("reachable connection selection does not wait for slower candidates", async () => {
  const slowProbe = Promise.withResolvers<boolean>();
  const selected = await selectReachableConnection(
    resource,
    "server-token",
    async (url) => {
      if (url === "https://lan.example") {
        return await slowProbe.promise;
      }
      return url === "https://tailscale.example";
    }
  );

  expect(selected?.uri).toBe("https://tailscale.example");
  slowProbe.resolve(false);
});

test("reachable discovery detects a stale persisted server URL", () => {
  const selected: PlexServerInfo = {
    clientIdentifier: "resource-sekinas",
    local: false,
    name: "SekiNAS",
    online: true,
    token: "new-server-token",
    url: "https://tailscale.example",
  };

  expect(
    savedServerNeedsRefresh(
      {
        clientIdentifier: "resource-sekinas",
        name: "SekiNAS",
        token: "old-server-token",
        url: "https://lan.example",
      },
      selected
    )
  ).toBe(true);
  expect(savedServerNeedsRefresh(selected, selected)).toBe(false);
});
