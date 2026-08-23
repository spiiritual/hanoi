import { expect, test } from "bun:test";
import { connectionCandidates, type PlexServerResource } from "../../src/bun/plex/auth.ts";
import { selectReachableConnection } from "../../src/bun/plex/client.ts";
import {
  findPersistedServer,
  savedServerNeedsRefresh,
} from "../../src/bun/plex/server-selection.ts";
import type { PlexServerInfo } from "../../src/bun/plex/types.ts";

const servers: PlexServerInfo[] = [
  {
    name: "Home Server",
    clientIdentifier: "resource-home",
    url: "http://home.local",
    token: "server-token-home",
    local: true,
    online: false,
  },
  {
    name: "Remote Server",
    clientIdentifier: "resource-remote",
    url: "https://remote.example",
    token: "server-token-remote",
    local: false,
    online: true,
  },
];

const resource: PlexServerResource = {
  name: "SekiNAS",
  clientIdentifier: "resource-sekinas",
  owned: true,
  provides: "server",
  connections: [
    { uri: "https://lan.example", local: true, relay: false },
    { uri: "https://tailscale.example", local: false, relay: false },
    { uri: "https://public.example", local: false, relay: false },
    { uri: "https://relay.example", local: false, relay: true },
  ],
};

test("persisted resource identifier wins over stale URL and name", () => {
  const server = findPersistedServer(
    {
      clientIdentifier: "resource-remote",
      name: "Old Remote Name",
      url: "https://old-remote.example",
    },
    servers,
  );

  expect(server?.clientIdentifier).toBe("resource-remote");
});

test("legacy persisted servers still match by URL", () => {
  const server = findPersistedServer(
    {
      name: "Home Server",
      url: "http://home.local",
    },
    servers,
  );

  expect(server?.clientIdentifier).toBe("resource-home");
});

test("connection candidates prefer local, then direct, then relay URLs", () => {
  expect(connectionCandidates(resource).map((connection) => connection.uri)).toEqual([
    "https://lan.example",
    "https://tailscale.example",
    "https://public.example",
    "https://relay.example",
  ]);
});

test("reachable connection selection falls back from a dead local URL", async () => {
  const probes: string[] = [];
  const selected = await selectReachableConnection(resource, "server-token", async (url) => {
    probes.push(url);
    return url === "https://tailscale.example";
  });

  expect(selected?.uri).toBe("https://tailscale.example");
  expect(probes).toEqual([
    "https://lan.example",
    "https://tailscale.example",
    "https://public.example",
    "https://relay.example",
  ]);
});

test("unreachable connection selection returns no online candidate", async () => {
  const selected = await selectReachableConnection(resource, "server-token", async () => false);

  expect(selected).toBeUndefined();
});

test("reachable discovery detects a stale persisted server URL", () => {
  const selected: PlexServerInfo = {
    name: "SekiNAS",
    clientIdentifier: "resource-sekinas",
    url: "https://tailscale.example",
    token: "new-server-token",
    local: false,
    online: true,
  };

  expect(
    savedServerNeedsRefresh(
      {
        name: "SekiNAS",
        clientIdentifier: "resource-sekinas",
        url: "https://lan.example",
        token: "old-server-token",
      },
      selected,
    ),
  ).toBe(true);
  expect(savedServerNeedsRefresh(selected, selected)).toBe(false);
});
