import { randomUUID } from "node:crypto";
import { BrowserView, BrowserWindow, Utils } from "electrobun/main";
import type { PlexRpc } from "./plex/rpc-schema.ts";
import { buildAuthUrl, createPin, waitForPin, type PlexPin } from "./plex/auth.ts";
import { deleteConfig, loadConfig, saveConfig, type PlexConfig } from "./plex/config.ts";
import {
	PlexClient,
	checkPlexServerStatus,
	discoverPlexServers,
	getPlexAccount,
} from "./plex/client.ts";
import {
	accountImageUrl as buildAccountImageUrl,
	imageUrl as buildImageUrl,
	streamUrl as resolveStreamUrl,
	transcodedImageUrl as buildTranscodedImageUrl,
} from "./plex/url.ts";
import type { PlexAccount, PlexTrack } from "./plex/types.ts";

let config = loadConfig();
let client: PlexClient | null =
	config?.server && config.token
		? new PlexClient({
				url: config.server.url,
				token: config.server.token,
				clientIdentifier: config.clientIdentifier,
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

function isCurrentAuthAttempt(attempt: AuthAttempt): boolean {
	return authAttempt?.id === attempt.id && !attempt.abort.signal.aborted;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requireClient(): PlexClient {
	if (!client) throw new Error("Not connected to a Plex server");
	return client;
}

async function beginAuth(): Promise<{ authUrl: string; pinCode: string }> {
	if (authAttempt) throw new Error("An authorization flow is already in progress");
	const clientIdentifier = config?.clientIdentifier ?? randomUUID();
	const attempt: AuthAttempt = {
		id: ++nextAuthAttemptId,
		clientIdentifier,
		abort: new AbortController(),
	};
	authAttempt = attempt;
	authError = null;

	let pin: PlexPin;
	try {
		pin = await createPin(clientIdentifier, "https://plex.tv", attempt.abort.signal);
		if (!isCurrentAuthAttempt(attempt)) {
			throw new DOMException("Aborted", "AbortError");
		}
	} catch (error) {
		if (authAttempt?.id === attempt.id) authAttempt = null;
		throw error;
	}

	// Background poll; resolves when the user authorizes at app.plex.tv.
	void (async () => {
		try {
			const token = await waitForPin(pin, "https://plex.tv", {
				signal: attempt.abort.signal,
				onPoll: () => {
					// The view shows the "Waiting for authorization…" spinner; nothing to push.
				},
			});
			if (!isCurrentAuthAttempt(attempt)) return;

			// Persist the token as soon as Plex approves the PIN. Account hydration
			// is best-effort here; the renderer retries it before showing the
			// connected screen, so a temporary /user failure cannot lose auth.
			config = { clientIdentifier, token };
			authError = null;
			saveConfig(config);
			// The PIN attempt is complete once the token is persisted. Do not
			// make the auth screen depend on the separate account request.
			if (authAttempt?.id === attempt.id) authAttempt = null;
			try {
				await hydrateAccount(token);
			} catch (error) {
				console.error("Failed to hydrate Plex account after authorization:", error);
			}
		} catch (error) {
			// Aborted (cancelAuth) or a stale retry: leave config untouched.
			if (isCurrentAuthAttempt(attempt) && (error as Error)?.name !== "AbortError") {
				authError = errorMessage(error);
				console.error("Plex auth failed:", error);
			}
		} finally {
			if (authAttempt?.id === attempt.id) authAttempt = null;
		}
	})();

	return { authUrl: buildAuthUrl(pin), pinCode: pin.code };
}

function cancelAuth(): void {
	const attempt = authAttempt;
	authAttempt = null;
	authError = null;
	attempt?.abort.abort();
}

async function hydrateAccount(token: string): Promise<PlexAccount> {
	const account = await getPlexAccount(token);
	if (config?.token === token) {
		config = { ...config, account };
		saveConfig(config);
	}
	return account;
}

async function selectServer(params: { clientIdentifier: string }): Promise<void> {
	const cfg = config;
	if (!cfg?.token) throw new Error("Not authenticated");
	// Re-discover fresh each selection (the list is never persisted).
	const servers = await discoverPlexServers(cfg.token, cfg.clientIdentifier);
	if (config?.token !== cfg.token || config?.clientIdentifier !== cfg.clientIdentifier) {
		throw new Error("Authentication state changed while loading servers");
	}
	const server = servers.find((s) => s.clientIdentifier === params.clientIdentifier);
	if (!server) throw new Error(`Unknown server: ${params.clientIdentifier}`);
	if (!server.url) throw new Error(`Server "${server.name}" has no usable connection`);
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
	cancelAuth();
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
					authenticating: Boolean(authAttempt),
					authError: authError ?? undefined,
					account: cfg?.account,
					server,
				};
			},
			disconnect() {
				disconnect();
			},
			async getAccount() {
				if (!config?.token) throw new Error("Not authenticated");
				return hydrateAccount(config.token);
			},
			async getAccountAvatarUrl() {
				const cfg = config;
				if (!cfg?.token) return null;
				const account = cfg.account?.thumb ? cfg.account : await hydrateAccount(cfg.token);
				if (config?.token !== cfg.token) return null;
				return buildAccountImageUrl(account.thumb, cfg.token);
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
			openExternal(params) {
				Utils.openExternal(params.url);
			},
			clipboardWriteText(params) {
				Utils.clipboardWriteText(params.text);
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
