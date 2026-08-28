import type { PlexServerInfo } from "./types.ts";

export interface PersistedServerReference {
  name: string;
  url: string;
  clientIdentifier?: string;
}

/** Find the current resource for a persisted server, including legacy configs. */
export const findPersistedServer = (
  persisted: PersistedServerReference,
  discovered: PlexServerInfo[]
): PlexServerInfo | undefined => {
  const persistedClientIdentifier = persisted.clientIdentifier;
  const byIdentifier =
    persistedClientIdentifier !== undefined &&
    persistedClientIdentifier.length > 0
      ? discovered.find(
          (server) => server.clientIdentifier === persistedClientIdentifier
        )
      : undefined;
  return (
    byIdentifier ??
    discovered.find((server) => server.url === persisted.url) ??
    discovered.find((server) => server.name === persisted.name)
  );
};

/** Whether discovery found a different server endpoint or per-server token. */
export const savedServerNeedsRefresh = (
  persisted: PersistedServerReference & { token?: string },
  discovered: PlexServerInfo
): boolean =>
  persisted.clientIdentifier !== discovered.clientIdentifier ||
  persisted.name !== discovered.name ||
  persisted.url !== discovered.url ||
  persisted.token !== discovered.token;
