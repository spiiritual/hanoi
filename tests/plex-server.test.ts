import { expect, test } from "bun:test";
import { findPersistedServer } from "../src/bun/plex/server-selection.ts";
import type { PlexServerInfo } from "../src/bun/plex/types.ts";

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
