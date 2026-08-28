import { randomUUID } from "node:crypto";
import nodePath from "node:path";

import { BrowserView, BrowserWindow, Utils } from "electrobun/main";

import { ArtworkCache } from "./plex/artwork/cache.ts";
import {
  artworkNamespace,
  createArtworkFetcher,
  isSameArtworkSession,
  toArtworkRpcResult,
} from "./plex/artwork/fetcher.ts";
import type { ArtworkVariant } from "./plex/artwork/types.ts";
import { buildAuthUrl, createPin, waitForPin } from "./plex/auth.ts";
import type { PlexPin } from "./plex/auth.ts";
import {
  PlexClient,
  checkPlexServerStatus,
  discoverPlexServers,
  getPlexAccount,
} from "./plex/client.ts";
import { deleteConfig, loadConfig, saveConfig } from "./plex/config.ts";
import type { PlexConfig } from "./plex/config.ts";
import type { PlexRpc, ServerViewSummary } from "./plex/rpc-schema.ts";
import {
  findPersistedServer,
  savedServerNeedsRefresh,
} from "./plex/server-selection.ts";
import type { PlexAccount, PlexServerInfo, PlexTrack } from "./plex/types.ts";
import { streamUrl as resolveStreamUrl } from "./plex/url.ts";

let config = loadConfig();
const PLEX_TV_URL = "https://plex.tv";
const PLEX_TV_HOST = "plex.tv";
const artworkCache = new ArtworkCache(
  nodePath.join(Utils.paths.userCache, "artwork")
);
let client: PlexClient | null =
  config?.server && config.token
    ? new PlexClient({
        clientIdentifier: config.clientIdentifier,
        token: config.server.token,
        url: config.server.url,
      })
    : null;

/** The active auth attempt; its id prevents an old cancelled attempt from
 * clearing or overwriting a newer retry. */
interface AuthAttempt {
  id: number;
  clientIdentifier: string;
  abort: AbortController;
}

let nextAuthAttemptId = 0;
let authAttempt: AuthAttempt | null = null;
let authError: string | null = null;

const SERVER_DISCOVERY_CACHE_TTL_MS = 10_000;

interface ServerDiscoveryCache {
  token: string;
  clientIdentifier: string;
  expiresAt: number;
  servers: PlexServerInfo[];
}

interface PendingServerDiscovery {
  token: string;
  clientIdentifier: string;
  promise: Promise<PlexServerInfo[]>;
}

let serverDiscoveryCache: ServerDiscoveryCache | null = null;
let pendingServerDiscovery: PendingServerDiscovery | null = null;

const isCurrentAuthAttempt = (attempt: AuthAttempt): boolean =>
  authAttempt?.id === attempt.id && !attempt.abort.signal.aborted;

const errorMessage = (error: Error | string): string =>
  error instanceof Error ? error.message : error;

const requireClient = (): PlexClient => {
  if (!client) {
    throw new Error("Not connected to a Plex server");
  }
  return client;
};

const hydrateAccount = async (token: string): Promise<PlexAccount> => {
  const account = await getPlexAccount(token);
  if (config?.token === token) {
    config = { ...config, account };
    saveConfig(config);
  }
  return account;
};

const discoverServersCached = async (
  token: string,
  clientIdentifier: string
): Promise<PlexServerInfo[]> => {
  const cached = serverDiscoveryCache;
  if (
    cached &&
    cached.token === token &&
    cached.clientIdentifier === clientIdentifier &&
    cached.expiresAt > Date.now()
  ) {
    return cached.servers;
  }

  const pending = pendingServerDiscovery;
  if (
    pending &&
    pending.token === token &&
    pending.clientIdentifier === clientIdentifier
  ) {
    return await pending.promise;
  }

  const promise = discoverPlexServers(token, clientIdentifier);
  pendingServerDiscovery = { clientIdentifier, promise, token };
  try {
    const servers = await promise;
    serverDiscoveryCache = {
      clientIdentifier,
      expiresAt: Date.now() + SERVER_DISCOVERY_CACHE_TTL_MS,
      servers,
      token,
    };
    return servers;
  } finally {
    if (pendingServerDiscovery?.promise === promise) {
      pendingServerDiscovery = null;
    }
  }
};

const artworkNamespaceForConfig = (cfg: PlexConfig) => {
  if (!cfg.server) {
    return null;
  }
  return artworkNamespace({
    accountUsername: cfg.account?.username,
    fallbackAccountId: cfg.clientIdentifier,
    serverClientIdentifier: cfg.server.clientIdentifier,
    serverUrl: cfg.server.url,
  });
};

const accountArtworkNamespaceForConfig = (cfg: PlexConfig) =>
  artworkNamespace({
    accountUsername: cfg.account?.username,
    fallbackAccountId: cfg.clientIdentifier,
    serverClientIdentifier: "plex-account",
    serverUrl: PLEX_TV_URL,
  });

const artworkSessionSnapshot = () => {
  const currentConfig = config;
  return {
    client,
    config: currentConfig,
    namespace: currentConfig ? artworkNamespaceForConfig(currentConfig) : null,
  };
};

const getArtwork = async (params: {
  path: string;
  variant?: ArtworkVariant;
}) => {
  if (!params.path.trim()) {
    return null;
  }
  const session = artworkSessionSnapshot();
  const cfg = session.config;
  const activeClient = session.client;
  const { namespace } = session;
  if (cfg === null || cfg.token === undefined || cfg.token.length === 0) {
    return null;
  }
  if (cfg.server === undefined || activeClient === null || namespace === null) {
    return null;
  }
  const request = { namespace, source: params.path, variant: params.variant };
  const cached = await artworkCache.get(request);
  if (!isSameArtworkSession(session, artworkSessionSnapshot())) {
    return null;
  }
  const entry = await artworkCache.getOrFetch(
    request,
    createArtworkFetcher({
      baseUrl: activeClient.baseUrl,
      token: activeClient.token,
    })
  );
  if (!isSameArtworkSession(session, artworkSessionSnapshot())) {
    return null;
  }
  return toArtworkRpcResult(entry, cached ? "hit" : "miss");
};

const accountArtworkSource = (sourcePath: string): string => {
  const input = sourcePath.trim();
  if (!/^https?:\/\//iu.test(input)) {
    return input;
  }
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() === PLEX_TV_HOST) {
      return `${url.pathname}${url.search}`;
    }
  } catch {
    return "";
  }
  return input;
};

const getAccountArtwork = async (params: { variant?: ArtworkVariant }) => {
  const session = artworkSessionSnapshot();
  const cfg = session.config;
  if (cfg === null || cfg.token === undefined || cfg.token.length === 0) {
    return null;
  }
  const account =
    cfg.account?.thumb !== undefined && cfg.account.thumb.length > 0
      ? cfg.account
      : await hydrateAccount(cfg.token);
  if (
    config?.token !== cfg.token ||
    account.thumb === undefined ||
    account.thumb.length === 0
  ) {
    return null;
  }
  const source = accountArtworkSource(account.thumb);
  const namespace = accountArtworkNamespaceForConfig(cfg);
  if (!source) {
    return null;
  }
  const request = { namespace, source, variant: params.variant };
  const cached = await artworkCache.get(request);
  if (config?.token !== cfg.token) {
    return null;
  }
  const entry = await artworkCache.getOrFetch(
    request,
    createArtworkFetcher({ baseUrl: PLEX_TV_URL, token: cfg.token })
  );
  if (config?.token !== cfg.token) {
    return null;
  }
  return toArtworkRpcResult(entry, cached ? "hit" : "miss");
};

const beginAuth = async (): Promise<{
  authUrl: string;
  pinCode: string;
}> => {
  if (authAttempt) {
    throw new Error("An authorization flow is already in progress");
  }
  const clientIdentifier = config?.clientIdentifier ?? randomUUID();
  const attempt: AuthAttempt = {
    abort: new AbortController(),
    clientIdentifier,
    id: nextAuthAttemptId,
  };
  authAttempt = attempt;
  authError = null;
  nextAuthAttemptId += 1;

  let pin: PlexPin;
  try {
    pin = await createPin(clientIdentifier, PLEX_TV_URL, attempt.abort.signal);
    if (!isCurrentAuthAttempt(attempt)) {
      throw new DOMException("Aborted", "AbortError");
    }
  } catch (error) {
    if (authAttempt?.id === attempt.id) {
      authAttempt = null;
    }
    throw error;
  }

  // Background poll; resolves when the user authorizes at app.plex.tv.
  void (async () => {
    try {
      const token = await waitForPin(pin, PLEX_TV_URL, {
        onPoll: () => {
          // The view shows the "Waiting for authorization…" spinner; nothing to push.
        },
        signal: attempt.abort.signal,
      });
      if (!isCurrentAuthAttempt(attempt)) {
        return;
      }

      // Persist the token as soon as Plex approves the PIN. Account hydration
      // is best-effort here; the renderer retries it before showing the
      // connected screen, so a temporary /user failure cannot lose auth.
      config = { clientIdentifier, token };
      authError = null;
      saveConfig(config);
      // The PIN attempt is complete once the token is persisted. Do not
      // make the auth screen depend on the separate account request.
      if (authAttempt?.id === attempt.id) {
        authAttempt = null;
      }
      try {
        await hydrateAccount(token);
      } catch (error) {
        console.error(
          "Failed to hydrate Plex account after authorization:",
          error
        );
      }
    } catch (error) {
      // Aborted (cancelAuth) or a stale retry: leave config untouched.
      const errorName =
        error instanceof Error || error instanceof DOMException
          ? error.name
          : undefined;
      if (isCurrentAuthAttempt(attempt) && errorName !== "AbortError") {
        authError =
          error instanceof Error ? errorMessage(error) : String(error);
        console.error("Plex auth failed:", error);
      }
    } finally {
      if (authAttempt?.id === attempt.id) {
        authAttempt = null;
      }
    }
  })();

  return { authUrl: buildAuthUrl(pin), pinCode: pin.code };
};

const cancelAuth = (): void => {
  const attempt = authAttempt;
  authAttempt = null;
  authError = null;
  attempt?.abort.abort();
};

const selectServer = async (params: {
  clientIdentifier: string;
}): Promise<void> => {
  const cfg = config;
  if (cfg === null || cfg.token === undefined || cfg.token.length === 0) {
    throw new Error("Not authenticated");
  }
  // Reuse the recent server list from the picker instead of probing every
  // connection a second time during selection.
  const servers = await discoverServersCached(cfg.token, cfg.clientIdentifier);
  if (
    config?.token !== cfg.token ||
    config?.clientIdentifier !== cfg.clientIdentifier
  ) {
    throw new Error("Authentication state changed while loading servers");
  }
  const server = servers.find(
    (s) => s.clientIdentifier === params.clientIdentifier
  );
  if (!server) {
    throw new Error(`Unknown server: ${params.clientIdentifier}`);
  }
  if (!server.url) {
    throw new Error(`Server "${server.name}" has no usable connection`);
  }
  const next: PlexConfig = {
    ...cfg,
    server: {
      clientIdentifier: server.clientIdentifier,
      name: server.name,
      token: server.token,
      url: server.url,
    },
  };
  config = next;
  saveConfig(next);
  client = new PlexClient({
    clientIdentifier: cfg.clientIdentifier,
    token: server.token,
    url: server.url,
  });
};

/** Replace a stale active URL with the reachable connection selected by discovery. */
const syncActiveServer = (cfg: PlexConfig, selected: PlexServerInfo): void => {
  if (!selected.online || !selected.url) {
    return;
  }
  if (
    config?.token !== cfg.token ||
    config.clientIdentifier !== cfg.clientIdentifier
  ) {
    return;
  }

  const nextServer = {
    clientIdentifier: selected.clientIdentifier,
    name: selected.name,
    token: selected.token,
    url: selected.url,
  };
  const activeServer = config.server;
  const needsRefresh =
    !activeServer || savedServerNeedsRefresh(activeServer, selected);
  if (needsRefresh) {
    config = { ...config, server: nextServer };
    saveConfig(config);
  }
  if (
    needsRefresh ||
    !client ||
    client.baseUrl !== selected.url ||
    client.token !== selected.token
  ) {
    client = new PlexClient({
      clientIdentifier: cfg.clientIdentifier,
      token: selected.token,
      url: selected.url,
    });
  }
};

const getSavedServerSummary = async (
  cfg: PlexConfig
): Promise<ServerViewSummary | undefined> => {
  if (!cfg.server || !cfg.token) {
    return undefined;
  }

  const fallback: ServerViewSummary = {
    clientIdentifier: cfg.server.clientIdentifier ?? cfg.clientIdentifier,
    name: cfg.server.name,
    url: cfg.server.url,
  };

  try {
    const discovered = await discoverServersCached(
      cfg.token,
      cfg.clientIdentifier
    );
    const selected = findPersistedServer(cfg.server, discovered);
    if (!selected) {
      return fallback;
    }

    // Migrate configs written before the server resource identifier was stored.
    const hasServerIdentifier =
      cfg.server.clientIdentifier !== undefined &&
      cfg.server.clientIdentifier.length > 0;
    const currentConfig = config;
    const isCurrentServer =
      currentConfig !== null &&
      currentConfig.token === cfg.token &&
      currentConfig.clientIdentifier === cfg.clientIdentifier &&
      currentConfig.server?.url === cfg.server.url;
    if (!hasServerIdentifier && isCurrentServer) {
      config = {
        ...cfg,
        server: { ...cfg.server, clientIdentifier: selected.clientIdentifier },
      };
      saveConfig(config);
    }

    if (
      selected.online &&
      selected.url &&
      config?.token === cfg.token &&
      config.clientIdentifier === cfg.clientIdentifier
    ) {
      syncActiveServer(cfg, selected);
    }

    return {
      clientIdentifier: selected.clientIdentifier,
      local: selected.local,
      name: selected.name,
      online: selected.online,
      url: selected.url,
    };
  } catch (error) {
    console.error("Failed to refresh the saved Plex server:", error);
    return fallback;
  }
};

const disconnect = async (): Promise<void> => {
  cancelAuth();
  const session = artworkSessionSnapshot();
  if (session.namespace) {
    await artworkCache.clearNamespace(session.namespace);
    if (!isSameArtworkSession(session, artworkSessionSnapshot())) {
      return;
    }
  }
  client = null;
  config = null;
  deleteConfig();
};

const currentServer = ():
  | Pick<PlexServerInfo, "clientIdentifier" | "name" | "token" | "url">
  | undefined => {
  if (config?.server === undefined) {
    return undefined;
  }
  return {
    clientIdentifier: config.server.clientIdentifier ?? config.clientIdentifier,
    name: config.server.name,
    token: config.server.token,
    url: config.server.url,
  };
};

const rpc = BrowserView.defineRPC<PlexRpc>({
  handlers: {
    requests: {
      async beginAuth() {
        return await beginAuth();
      },
      cancelAuth() {
        cancelAuth();
      },
      async checkServerStatus() {
        const server = currentServer();
        if (!server) {
          return false;
        }
        return await checkPlexServerStatus(server.url, server.token);
      },
      clipboardWriteText(params) {
        Utils.clipboardWriteText(params.text);
      },
      async disconnect() {
        await disconnect();
      },
      async getAccount() {
        if (
          config === null ||
          config.token === undefined ||
          config.token.length === 0
        ) {
          throw new Error("Not authenticated");
        }
        return await hydrateAccount(config.token);
      },
      async getAccountArtwork(params) {
        return await getAccountArtwork(params);
      },
      async getAlbum(params) {
        return await requireClient().getAlbum(params.ratingKey);
      },
      async getAlbums(params) {
        return await requireClient().getAlbums(params.sectionKey, params.opts);
      },
      async getArtist(params) {
        return await requireClient().getArtist(params.ratingKey);
      },
      async getArtists(params) {
        return await requireClient().getArtists(params.sectionKey, params.opts);
      },
      async getArtwork(params) {
        return await getArtwork(params);
      },
      getAuthState() {
        const cfg = config;
        // Auth state is local and should be available immediately. Do not make
        // startup wait for server discovery and its 3s reachability probes.
        const server =
          cfg?.server && cfg.token
            ? {
                clientIdentifier:
                  cfg.server.clientIdentifier ?? cfg.clientIdentifier,
                name: cfg.server.name,
                url: cfg.server.url,
              }
            : undefined;
        if (cfg?.server && cfg.token) {
          // Refresh the endpoint and active client in the background. The
          // persisted server is enough to choose the initial app view.
          void getSavedServerSummary(cfg);
        }
        return {
          account: cfg?.account,
          authError: authError ?? undefined,
          authenticated: Boolean(cfg?.token),
          authenticating: Boolean(authAttempt),
          hasServer: Boolean(server),
          server,
        };
      },
      async getHomeHubItems(params) {
        return await requireClient().getHomeHubItems(params.key);
      },
      async getHomeHubs(params) {
        return await requireClient().getHomeHubs(params.identifiers);
      },
      async getMostPlayed(params) {
        return await requireClient().getMostPlayed(params.sinceMs);
      },
      async getMusicSections() {
        return await requireClient().getMusicSections();
      },
      async getPlaylist(params) {
        return await requireClient().getPlaylist(params.key);
      },
      async getPlaylists() {
        return await requireClient().getMusicPlaylists();
      },
      async getRecentlyPlayed() {
        return await requireClient().getRecentlyPlayed();
      },
      async getServers() {
        const cfg = config;
        if (cfg === null || cfg.token === undefined || cfg.token.length === 0) {
          return [];
        }
        const servers = await discoverServersCached(
          cfg.token,
          cfg.clientIdentifier
        );
        const selected = cfg.server
          ? findPersistedServer(cfg.server, servers)
          : undefined;
        if (selected) {
          syncActiveServer(cfg, selected);
        }
        return servers.map((server) => ({
          clientIdentifier: server.clientIdentifier,
          local: server.local,
          name: server.name,
          online: server.online,
          url: server.url,
        }));
      },
      async getTracks(params) {
        return await requireClient().getTracks(params.sectionKey, params.opts);
      },
      openExternal(params) {
        Utils.openExternal(params.url);
      },
      async scrobble(params) {
        await requireClient().scrobble(params.key);
      },
      async search(params) {
        return await requireClient().search(params.query);
      },
      async selectServer(params) {
        await selectServer(params);
      },
      async streamUrl(params) {
        const c = requireClient();
        const { items } = await c.getMetadata(params.ratingKey);
        const track = items.find(
          (item): item is PlexTrack => item.type === "track"
        );
        return resolveStreamUrl({ baseUrl: c.baseUrl, token: c.token }, track);
      },
    },
  },
  maxRequestTime: 60_000,
});

const mainWindow = new BrowserWindow({
  frame: {
    height: 800,
    width: 1200,
    x: 200,
    y: 200,
  },
  rpc,
  title: "Hanoi",
  url: "views://mainview/index.html",
});
void mainWindow;

process.once("exit", () => {
  artworkCache.dispose();
});

console.log("Hanoi started");
