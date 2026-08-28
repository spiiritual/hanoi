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
  "X-Plex-Device-Name": "hanoi",
  "X-Plex-Platform": process.platform,
  "X-Plex-Product": "hanoi",
} as const;

/** Create a PIN the user authorizes at app.plex.tv. */
export const createPin = async (
  clientIdentifier: string,
  plexTvUrl: string = DEFAULT_PLEX_TV_URL,
  signal?: AbortSignal
): Promise<PlexPin> => {
  const res = await fetch(`${plexTvUrl}/api/v2/pins?strong=true`, {
    headers: {
      Accept: "application/json",
      "X-Plex-Client-Identifier": clientIdentifier,
      ...DEVICE_HEADERS,
    },
    method: "POST",
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `Failed to create Plex PIN: ${res.status} ${res.statusText}`
    );
  }
  const parsed = parseStrict(
    pinSchema,
    await res.json(),
    "plex.tv /api/v2/pins (create)"
  );
  if (!parsed) {
    throw new Error(
      `Failed to create Plex PIN: unexpected response from plex.tv`
    );
  }
  return parsed;
};

/** Browser URL the user opens to authorize the app. */
export const buildAuthUrl = (pin: PlexPin): string => {
  const params = new URLSearchParams({
    clientID: pin.clientIdentifier,
    code: pin.code,
    "context[device][product]": "hanoi",
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
};

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
export const waitForPin = async (
  pin: PlexPin,
  plexTvUrl: string = DEFAULT_PLEX_TV_URL,
  {
    intervalMs = 2000,
    timeoutMs = 5 * 60_000,
    signal,
    onPoll,
  }: WaitForPinOptions = {}
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted === true) {
      throw new DOMException("Aborted", "AbortError");
    }
    // Polling must remain sequential so each request observes the latest PIN state.
    // eslint-disable-next-line no-await-in-loop -- authorization polling is intentionally sequential
    const res = await fetch(`${plexTvUrl}/api/v2/pins/${pin.id}`, {
      headers: {
        Accept: "application/json",
        "X-Plex-Client-Identifier": pin.clientIdentifier,
      },
      signal,
    });
    if (!res.ok) {
      throw new Error(
        `Failed to check Plex PIN: ${res.status} ${res.statusText}`
      );
    }
    // The response is parsed by pinPollSchema before any fields are read.
    // eslint-disable-next-line no-await-in-loop -- polling reads each response sequentially
    const data: unknown = await res.json();
    // Only `authToken` is consumed from poll responses; a poll response
    // missing it is simply not authorized yet, so treat any shape that
    // lacks a usable token as "not yet authorized" and keep polling.
    const parsed = parseStrict(
      pinPollSchema,
      data,
      "plex.tv /api/v2/pins poll"
    );
    const pinState = parsed ?? { authToken: null };
    const { authToken } = pinState;
    if (authToken !== null && authToken !== undefined && authToken.length > 0) {
      return authToken;
    }
    onPoll?.(pin);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      resolve(true);
    }, intervalMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // A poll waits for either the interval or cancellation before continuing.
      // eslint-disable-next-line no-await-in-loop -- authorization polling is intentionally sequential
      await promise;
    } finally {
      // Remove the listener so a cancelled poll does not accumulate one
      // handler per interval tick.
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    }
  }
  throw new Error("Timed out waiting for Plex authorization");
};

/** Servers on the account that the user owns and that provide a media server. */
export const discoverServers = async (
  token: string,
  clientIdentifier: string,
  plexTvUrl: string = DEFAULT_PLEX_TV_URL
): Promise<PlexServerResource[]> => {
  const res = await fetch(
    `${plexTvUrl}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`,
    {
      headers: {
        Accept: "application/json",
        "X-Plex-Client-Identifier": clientIdentifier,
        "X-Plex-Token": token,
      },
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to discover Plex servers: ${res.status} ${res.statusText}`
    );
  }
  const data: unknown = await res.json();
  const resources = Array.isArray(data)
    ? filterItems(serverResourceSchema, data, "plex.tv /api/v2/resources")
    : [];
  return resources.filter(
    (server) => server.owned && server.provides?.includes("server") === true
  );
};

/**
 * Order server connections by the policy Plex clients need here: local direct
 * first, then other direct connections (such as Tailscale), then relay.
 * Preserve Plex's order within each tier because it already reflects the
 * server's advertised preference.
 */
const connectionPriority = (connection: PlexConnection): number => {
  if (connection.relay === true) {
    return 2;
  }
  if (connection.local) {
    return 0;
  }
  return 1;
};

export const connectionCandidates = (
  resource: PlexServerResource
): PlexConnection[] => {
  const candidates: {
    connection: PlexConnection;
    index: number;
  }[] = [];
  let index = 0;
  for (const connection of resource.connections ?? []) {
    if (connection.uri.length > 0) {
      candidates.push({ connection, index });
    }
    index += 1;
  }
  return candidates
    .toSorted(
      (left, right) =>
        connectionPriority(left.connection) -
          connectionPriority(right.connection) || left.index - right.index
    )
    .map(({ connection }) => connection);
};
