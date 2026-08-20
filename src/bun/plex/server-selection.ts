import type { PlexServerInfo } from "./types.ts";

export interface PersistedServerReference {
	name: string;
	url: string;
	clientIdentifier?: string;
}

/** Find the current resource for a persisted server, including legacy configs. */
export function findPersistedServer(
	persisted: PersistedServerReference,
	discovered: PlexServerInfo[],
): PlexServerInfo | undefined {
	return (
		(persisted.clientIdentifier
			? discovered.find((server) => server.clientIdentifier === persisted.clientIdentifier)
			: undefined) ??
		discovered.find((server) => server.url === persisted.url) ??
		discovered.find((server) => server.name === persisted.name)
	);
}
