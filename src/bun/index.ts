import { randomUUID } from "node:crypto";
import { BrowserView, BrowserWindow } from "electrobun/main";
import type { PlexRpc } from "./plex/rpc-schema.ts";
import { buildAuthUrl, createPin, waitForPin } from "./plex/auth.ts";
import { deleteConfig, loadConfig, saveConfig, type PlexConfig } from "./plex/config.ts";
import {
	PlexClient,
	checkPlexServerStatus,
	discoverPlexServers,
	getPlexAccount,
} from "./plex/client.ts";
import {
	imageUrl as buildImageUrl,
	streamUrl as resolveStreamUrl,
	transcodedImageUrl as buildTranscodedImageUrl,
} from "./plex/url.ts";
import type { PlexTrack } from "./plex/types.ts";

let config = loadConfig();
let client: PlexClient | null =
	config?.server && config.token
		? new PlexClient({
				url: config.server.url,
				token: config.server.token,
				clientIdentifier: config.clientIdentifier,
			})
		: null;

/** True while a PIN is waiting for authorization (single auth flow at a time). */
let authPending = false;
let authAbort: AbortController | null = null;

function requireClient(): PlexClient {
	if (!client) throw new Error("Not connected to a Plex server");
	return client;
}

async function beginAuth(): Promise<{ authUrl: string; pinCode: string }> {
	if (authPending) throw new Error("An authorization flow is already in progress");
	const clientIdentifier = config?.clientIdentifier ?? randomUUID();
	const pin = await createPin(clientIdentifier);
	const abort = new AbortController();
	authPending = true;
	authAbort = abort;

	// Background poll; resolves when the user authorizes at app.plex.tv.
	void (async () => {
		try {
			const token = await waitForPin(pin, "https://plex.tv", {
				signal: abort.signal,
				onPoll: () => {
					// The view shows the "Waiting for authorization…" spinner; nothing to push.
				},
			});
			config = { clientIdentifier, token };
			saveConfig(config);
			// Warm the account profile for the Server Selection screen.
			void getPlexAccount(token).then((account) => {
				if (!config || config.token !== token) return;
				config = { ...config, account };
				saveConfig(config);
			});
		} catch (error) {
			// Aborted (cancelAuth) or timed out: leave config untouched.
			if ((error as Error)?.name !== "AbortError") {
				console.error("Plex auth failed:", error);
			}
		} finally {
			authPending = false;
			authAbort = null;
		}
	})();

	return { authUrl: buildAuthUrl(pin), pinCode: pin.code };
}

function cancelAuth(): void {
	authAbort?.abort();
	authPending = false;
	authAbort = null;
}

async function selectServer(params: { clientIdentifier: string }): Promise<void> {
	const cfg = config;
	if (!cfg?.token) throw new Error("Not authenticated");
	// Re-discover fresh each selection (the list is never persisted).
	const servers = await discoverPlexServers(cfg.token, cfg.clientIdentifier);
	const server = servers.find((s) => s.clientIdentifier === params.clientIdentifier);
	if (!server) throw new Error(`Unknown server: ${params.clientIdentifier}`);
	const next: PlexConfig = {
		...cfg,
		server: { name: server.name, url: server.url, token: server.token },
	};
	config = next;
	saveConfig(next);
	client = new PlexClient({
		url: server.url,
		token: server.token,
		clientIdentifier: cfg.clientIdentifier,
	});
}

function disconnect(): void {
	authAbort?.abort();
	authPending = false;
	authAbort = null;
	client = null;
	config = null;
	deleteConfig();
}

function currentServer() {
	if (!config?.server) return undefined;
	return {
		name: config.server.name,
		url: config.server.url,
		token: config.server.token,
		clientIdentifier: config.clientIdentifier,
	};
}

const rpc = BrowserView.defineRPC<PlexRpc>({
	maxRequestTime: 60_000,
	handlers: {
		requests: {
			async beginAuth() {
				return beginAuth();
			},
			cancelAuth() {
				cancelAuth();
			},
			selectServer(params) {
				return selectServer(params);
			},
			getAuthState() {
				const cfg = config;
				const server =
					cfg?.server && cfg.token
						? {
								name: cfg.server.name,
								clientIdentifier: cfg.clientIdentifier,
								url: cfg.server.url,
							}
						: undefined;
				return {
					authenticated: Boolean(cfg?.token),
					hasServer: Boolean(server),
					account: cfg?.account,
					server,
				};
			},
			disconnect() {
				disconnect();
			},
			getAccount() {
				if (!config?.token) throw new Error("Not authenticated");
				return getPlexAccount(config.token);
			},
			async getServers() {
				if (!config?.token) return [];
				const servers = await discoverPlexServers(config.token, config.clientIdentifier);
				return servers.map((server) => ({
					name: server.name,
					clientIdentifier: server.clientIdentifier,
					url: server.url,
					local: server.local,
					online: server.online,
				}));
			},
			async checkServerStatus() {
				const server = currentServer();
				if (!server) return false;
				return checkPlexServerStatus(server.url, server.token);
			},
			getMusicSections() {
				return requireClient().getMusicSections();
			},
			getArtists(params) {
				return requireClient().getArtists(params.sectionKey, params.opts);
			},
			getAlbums(params) {
				return requireClient().getAlbums(params.sectionKey, params.opts);
			},
			getTracks(params) {
				return requireClient().getTracks(params.sectionKey, params.opts);
			},
			getPlaylists() {
				return requireClient().getMusicPlaylists();
			},
			getAlbum(params) {
				return requireClient().getAlbum(params.ratingKey);
			},
			getPlaylist(params) {
				return requireClient().getPlaylist(params.key);
			},
			getArtist(params) {
				return requireClient().getArtist(params.ratingKey);
			},
			getRecentlyPlayed() {
				return requireClient().getRecentlyPlayed();
			},
			getMostPlayed(params) {
				return requireClient().getMostPlayed(params.sinceMs);
			},
			search(params) {
				return requireClient().search(params.query);
			},
			async streamUrl(params) {
				const c = requireClient();
				const { items } = await c.getMetadata<PlexTrack>(params.ratingKey);
				const track = items.find((i) => i.type === "track");
				return resolveStreamUrl({ baseUrl: c.baseUrl, token: c.token }, track);
			},
			imageUrl(params) {
				const c = requireClient();
				return buildImageUrl({ baseUrl: c.baseUrl, token: c.token }, params.path);
			},
			transcodedImageUrl(params) {
				const c = requireClient();
				return buildTranscodedImageUrl(
					{ baseUrl: c.baseUrl, token: c.token },
					params.path,
					params.width,
					params.height,
				);
			},
			scrobble(params) {
				return requireClient().scrobble(params.key);
			},
		},
	},
});

new BrowserWindow({
	title: "Hanoi",
	url: "views://mainview/index.html",
	frame: {
		width: 1200,
		height: 800,
		x: 200,
		y: 200,
	},
	rpc,
});

console.log("Hanoi started");
