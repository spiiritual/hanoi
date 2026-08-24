/** Plex account authentication (plex.tv PIN flow) and server discovery. */

import {
  filterItems,
  parseStrict,
  pinSchema,
  pinPollSchema,
  serverResourceSchema,
} from "./schemas.ts";

export interface PlexPin {
  id: string;
  code: string;
  clientIdentifier: string;
  expiresIn: number;
  /** Set only once the user authorizes; null/absent before that. */
  authToken?: string | null;
}

export interface PlexConnection {
  /** Connection URI used for the dropdown host display. */
  uri: string;
  /** Picks the best connection (local preferred). */
  local: boolean;
  protocol?: string;
  address?: string;
  port?: number;
  /** Relay connections are a last-resort fallback. */
  relay?: boolean;
  IPv6?: boolean;
}

export interface PlexServerResource {
  name: string;
  clientIdentifier: string;
  /** null on non-server devices; servers may also omit it. */
  accessToken?: string | null;
  owned: boolean;
  provides?: string;
  connections?: PlexConnection[];
}

const DEFAULT_PLEX_TV_URL = "https://plex.tv";

const DEVICE_HEADERS = {
  "X-Plex-Product": "hanoi",
  "X-Plex-Device-Name": "hanoi",
  "X-Plex-Platform": process.platform,
} as const;

/** Create a PIN the user authorizes at app.plex.tv. */
export async function createPin(
  clientIdentifier: string,
  plexTvUrl: string = DEFAULT_PLEX_TV_URL,
  signal?: AbortSignal,
): Promise<PlexPin> {
  const res = await fetch(`${plexTvUrl}/api/v2/pins?strong=true`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "X-Plex-Client-Identifier": clientIdentifier,
      ...DEVICE_HEADERS,
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`Failed to create Plex PIN: ${res.status} ${res.statusText}`);
  }
  const parsed = parseStrict(pinSchema, await res.json(), "plex.tv /api/v2/pins (create)");
  if (!parsed) {
    throw new Error(`Failed to create Plex PIN: unexpected response from plex.tv`);
  }
  return parsed;
}

/** Browser URL the user opens to authorize the app. */
export function buildAuthUrl(pin: PlexPin): string {
  const params = new URLSearchParams({
    clientID: pin.clientIdentifier,
    code: pin.code,
    "context[device][product]": "hanoi",
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

export interface WaitForPinOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Abort the poll; the pending wait rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Called after each poll that has not yet authorized, so callers can surface progress. */
  onPoll?: (pin: PlexPin) => void;
}

/**
 * Poll the PIN until the user authorizes; resolves to the account token.
 * Cancellable via `signal` so `cancelAuth` can stop the poll cleanly.
 */
export async function waitForPin(
  pin: PlexPin,
  plexTvUrl: string = DEFAULT_PLEX_TV_URL,
  { intervalMs = 2000, timeoutMs = 5 * 60_000, signal, onPoll }: WaitForPinOptions = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await fetch(`${plexTvUrl}/api/v2/pins/${pin.id}`, {
      headers: {
        Accept: "application/json",
        "X-Plex-Client-Identifier": pin.clientIdentifier,
      },
      signal,
    });
    if (!res.ok) {
      throw new Error(`Failed to check Plex PIN: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as unknown;
    // Only `authToken` is consumed from poll responses; a poll response
    // missing it is simply not authorized yet, so treat any shape that
    // lacks a usable token as "not yet authorized" and keep polling.
    const parsed = parseStrict(pinPollSchema, data, "plex.tv /api/v2/pins poll");
    const pinState = parsed ?? { authToken: null };
    if (pinState.authToken) return pinState.authToken;
    onPoll?.(pin);
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, intervalMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await promise;
    } finally {
      // Remove the listener so a cancelled poll does not accumulate one
      // handler per interval tick.
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    }
  }
  throw new Error("Timed out waiting for Plex authorization");
}

/** Servers on the account that the user owns and that provide a media server. */
export async function discoverServers(
  token: string,
  clientIdentifier: string,
  plexTvUrl: string = DEFAULT_PLEX_TV_URL,
): Promise<PlexServerResource[]> {
  const res = await fetch(
    `${plexTvUrl}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`,
    {
      headers: {
        Accept: "application/json",
        "X-Plex-Token": token,
        "X-Plex-Client-Identifier": clientIdentifier,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to discover Plex servers: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as unknown;
  const resources = Array.isArray(data)
    ? filterItems(serverResourceSchema, data, "plex.tv /api/v2/resources")
    : [];
  return resources.filter((s) => s.owned && s.provides?.includes("server"));
}

/**
 * Order server connections by the policy Plex clients need here: local direct
 * first, then other direct connections (such as Tailscale), then relay.
 * Preserve Plex's order within each tier because it already reflects the
 * server's advertised preference.
 */
export function connectionCandidates(resource: PlexServerResource): PlexConnection[] {
  const candidates = (resource.connections ?? []).reduce<
    { connection: PlexConnection; index: number }[]
  >((items, connection, index) => {
    if (connection.uri.length > 0) items.push({ connection, index });
    return items;
  }, []);
  candidates.sort((a, b) => {
    const priority = (connection: PlexConnection): number =>
      connection.relay ? 2 : connection.local ? 0 : 1;
    return priority(a.connection) - priority(b.connection) || a.index - b.index;
  });
  return candidates.map(({ connection }) => connection);
}
