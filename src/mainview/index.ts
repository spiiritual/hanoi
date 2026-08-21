import { plex } from "./plex.ts";
import { hydrateAccountIfMissing } from "./account-hydration.ts";
import {
	createAppState,
	shellViews,
	type AppStateSnapshot,
	type ShellView,
} from "./app-state.ts";
import {
	createHomeState,
	filterMusicHomeHubs,
	type HomeStateSnapshot,
} from "./home-state.ts";
import {
	HOME_HUB_PREVIEW_SIZE,
	homeCategoryItemMeta,
	homeHubItemMeta,
	homeHubItemInteraction,
	shouldShowHomeHubSeeAll,
} from "./home-display.ts";
import { serverStatusClass, serverStatusLabel } from "./server-status.ts";
import type { PlexHub, PlexHubItem } from "../bun/plex/types.ts";

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

const screens = ["welcome", "oauth", "connected", "servers", "home"] as const;
type ScreenName = (typeof screens)[number];
type ShellSearchResults = Awaited<ReturnType<typeof plex.search>>;

const shellViewCopy: Record<ShellView, { eyebrow: string; title: string; copy: string }> = {
	home: {
		eyebrow: "HANOI",
		title: "Home is ready.",
		copy: "The music surface will land here next.",
	},
	albums: {
		eyebrow: "YOUR LIBRARY",
		title: "Albums are next.",
		copy: "Album browsing will be connected in the next app slice.",
	},
	artists: {
		eyebrow: "YOUR LIBRARY",
		title: "Artists are next.",
		copy: "Artist browsing will be connected in the next app slice.",
	},
	songs: {
		eyebrow: "YOUR LIBRARY",
		title: "Songs are next.",
		copy: "Song browsing will be connected in the next app slice.",
	},
	playlists: {
		eyebrow: "YOUR LIBRARY",
		title: "Playlists are next.",
		copy: "Playlist browsing will be connected in the next app slice.",
	},
	search: {
		eyebrow: "SEARCH",
		title: "Search your library.",
		copy: "Type a song, album, or artist above to search Plex.",
	},
};
type Account = {
	username: string;
	email: string;
	thumb?: string;
	verified: boolean;
};
type Server = {
	name: string;
	clientIdentifier: string;
	url: string;
	local?: boolean;
	online?: boolean;
};

let current: ScreenName = "welcome";
let shellSearchRun = 0;
let shellSearchTimer: number | null = null;
let renderedShellView: ShellView = "home";
const appState = createAppState({
	loadMusicSections: () => plex.getMusicSections(),
});
const homeState = createHomeState({
	loadHomeHubs: () => plex.getHomeHubs(),
});
let observedSearchGeneration = appState.getSnapshot().searchGeneration;
let observedHomeServer = appState.getSnapshot().selectedServer;
type HomeCategoryView = {
	hub: PlexHub;
	items: PlexHubItem[];
	status: "loading" | "ready" | "error";
	error: string | null;
};

let homeCategoryView: HomeCategoryView | null = null;
let homeCategoryRequest = 0;

// ---- Slide + fade transition engine ----

const DURATION_MS = 420;
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

function el(name: ScreenName): HTMLElement {
	return document.getElementById(`screen-${name}`)!;
}

function reset(section: HTMLElement) {
	section.style.transition = "none";
	section.style.transform = "none";
	section.style.opacity = "1";
	section.classList.remove("is-hidden");
}

/** Transition from `from` to `to` using slide+fade (direction-aware). */
function goTo(to: ScreenName) {
	if (to === current) return;
	const from = current;
	const leave = el(from);
	const enter = el(to);

	// Reset both screens to their natural state, hide-classes off.
	reset(leave);
	reset(enter);

	leave.style.zIndex = "1";
	enter.style.zIndex = "2";

	const fwd = screens.indexOf(to) > screens.indexOf(from);

	// Entering screen starts offset + transparent.
	enter.style.transition = "none";
	enter.style.transform = fwd ? "translateX(40px)" : "translateX(-40px)";
	enter.style.opacity = "0";

	// Force a reflow so the start pose applies before transitioning.
	void enter.offsetWidth;

	// Animate both.
	enter.style.transition = `transform ${DURATION_MS}ms ${EASE}, opacity ${DURATION_MS}ms ${EASE}`;
	leave.style.transition = `transform ${DURATION_MS}ms ${EASE}, opacity ${DURATION_MS}ms ${EASE}`;
	enter.style.transform = "translateX(0)";
	enter.style.opacity = "1";
	leave.style.transform = fwd ? "translateX(-24px)" : "translateX(24px)";
	leave.style.opacity = "0";

	current = to;

	setTimeout(() => {
		leave.style.transition = "none";
		leave.style.transform = "none";
		leave.style.opacity = "1";
		leave.classList.add("is-hidden");
		leave.style.zIndex = "";
		enter.style.zIndex = "";
	}, DURATION_MS + 30);
}

// ---- App state ----

let account: Account | null = null;
let servers: Server[] = [];
let serverLoadRun = 0;

// ---- Startup routing ----

async function init() {
	try {
		const state = await plex.getAuthState();
		account = state.account ?? null;
		if (state.hasServer && state.authenticated) {
			if (!account) {
				try {
					account = await hydrateAccountIfMissing(account, () => plex.getAccount());
				} catch (error) {
					console.error("Failed to load the saved Plex account:", error);
				}
			}
			const serverIdentifier = state.server?.clientIdentifier ?? null;
			appState.setSelectedServer(serverIdentifier);
			current = "home";
			renderHomeScreen(account, state.server?.name, state.server?.online);
			if (serverIdentifier) {
				void loadShellMusicSections();
				void loadHomeHubs();
			}
		} else if (state.authenticated) {
			// Match the Pen flow: an authenticated account lands on the
			// confirmation card before choosing a media server.
			if (!account) {
				try {
					account = await hydrateAccountIfMissing(account, () => plex.getAccount());
				} catch (error) {
					console.error("Failed to load the saved Plex account:", error);
				}
			}
			current = "connected";
			await renderConnectedScreen(account);
		} else {
			current = "welcome";
		}
	} catch {
		current = "welcome";
	}
	// Show the routed screen, hide the rest.
	for (const name of screens) {
		el(name).classList.toggle("is-hidden", name !== current);
	}
}

// ---- Welcome + authorization polling ----

let pollTimer: number | null = null;
let authRun = 0;

function stopAuthPolling(): void {
	if (pollTimer !== null) {
		window.clearTimeout(pollTimer);
		pollTimer = null;
	}
}

function scheduleAuthPoll(run: number): void {
	if (run !== authRun) return;
	pollTimer = window.setTimeout(() => void pollForApproval(run), 2000);
}

$<HTMLButtonElement>("btn-signin").addEventListener("click", startAuth);
$<HTMLAnchorElement>("btn-create").addEventListener("click", (e) => {
	e.preventDefault();
	void plex.openExternal("https://www.plex.tv/sign-up/");
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-shell-view]")) {
	button.addEventListener("click", () => {
		const view = button.dataset.shellView;
		if (isShellView(view)) setShellView(view);
	});
}

$<HTMLButtonElement>("sidebar-library-toggle").addEventListener("click", () => {
	const toggle = $<HTMLButtonElement>("sidebar-library-toggle");
	const items = $<HTMLDivElement>("sidebar-library-items");
	const expanded = toggle.getAttribute("aria-expanded") === "true";
	toggle.setAttribute("aria-expanded", String(!expanded));
	items.toggleAttribute("hidden", expanded);
});

$<HTMLInputElement>("shell-search-input").addEventListener("input", () => {
	const input = $<HTMLInputElement>("shell-search-input");
	const query = input.value.trim();
	appState.setSearchQuery(query);
	if (shellSearchTimer !== null) window.clearTimeout(shellSearchTimer);
	if (!query) {
		++shellSearchRun;
		setShellView("home");
		return;
	}
	setShellView("search", { preserveSearch: true });
	renderShellSearchStatus(`Searching for “${query}”…`);
	shellSearchTimer = window.setTimeout(() => void runShellSearch(query), 260);
});

$<HTMLInputElement>("shell-search-input").addEventListener("keydown", (event) => {
	if (event.key !== "Enter") return;
	event.preventDefault();
	const query = $<HTMLInputElement>("shell-search-input").value.trim();
	if (shellSearchTimer !== null) window.clearTimeout(shellSearchTimer);
	if (query) void runShellSearch(query);
});

$<HTMLButtonElement>("sidebar-server-selector").addEventListener("click", () => {
	void toggleSidebarServerMenu();
});

$<HTMLButtonElement>("sidebar-add-server").addEventListener("click", () => {
	closeSidebarServerMenu();
	void startAuth();
});

$<HTMLButtonElement>("home-retry").addEventListener("click", () => {
	void loadHomeHubs();
});

document.addEventListener("click", (event) => {
	const target = event.target;
	const wrap = $("sidebar-server-selector").closest(".sidebar-server-wrap");
	if (wrap && target instanceof Node && !wrap.contains(target)) closeSidebarServerMenu();
});

async function startAuth() {
	const run = ++authRun;
	stopAuthPolling();
	goTo("oauth");
	const status = $("status-text");
	const linkCode = $("link-code");
	try {
		status.textContent = "Waiting for authorization…";
		linkCode.textContent = "…";
		delete linkCode.dataset.url;
		delete linkCode.dataset.copyUrl;
		const { authUrl, pinCode } = await plex.beginAuth();
		if (run !== authRun) return;
		// The Pen screen renders the friendly shorthand link while the
		// browser button uses Plex's full authorization URL.
		linkCode.textContent = pinCode;
		linkCode.dataset.url = authUrl;
		// Copy the actual auth URL, not the display-only shorthand. Plex's
		// strong PIN flow is authorized through app.plex.tv/auth.
		linkCode.dataset.copyUrl = authUrl;
		void pollForApproval(run);
	} catch (error) {
		if (run !== authRun) return;
		status.textContent = `Something went wrong: ${(error as Error).message}`;
	}
}

async function pollForApproval(run: number): Promise<void> {
	if (run !== authRun) return;
	pollTimer = null;
	try {
		const state = await plex.getAuthState();
		if (run !== authRun) return;
		if (state.authError) {
			$("status-text").textContent = `Something went wrong: ${state.authError}`;
			return;
		}
		// A retry may run while an older token is still in config. Wait for
		// this PIN attempt instead of treating that old token as approval.
		if (!state.authenticated || state.authenticating) {
			scheduleAuthPoll(run);
			return;
		}

		$("status-text").textContent = "Authorization approved — loading…";
		account = state.account ?? null;
		if (!account) {
			try {
				account = await plex.getAccount();
			} catch (error) {
				console.error("Failed to load the authorized Plex account:", error);
			}
		}
		if (run !== authRun) return;
		await renderConnectedScreen(account, run);
		if (run !== authRun) return;
		goTo("connected");
	} catch (error) {
		if (run !== authRun) return;
		console.error("Failed to check Plex authorization:", error);
		$("status-text").textContent = "Still waiting for authorization…";
		scheduleAuthPoll(run);
	}
}

$<HTMLButtonElement>("btn-cancel").addEventListener("click", () => {
	++authRun;
	stopAuthPolling();
	void plex.cancelAuth();
	goTo("welcome");
});

// ---- Link card actions ----

$<HTMLButtonElement>("btn-open").addEventListener("click", () => {
	const url = $("link-code").dataset.url;
	if (url) void plex.openExternal(url);
});

$<HTMLButtonElement>("btn-copy").addEventListener("click", () => {
	const text = $("link-code").dataset.copyUrl;
	if (!text) return;
	void plex.clipboardWriteText(text);
});

// ---- Connected ----

$<HTMLButtonElement>("btn-continue").addEventListener("click", async (event) => {
	const button = event.currentTarget as HTMLButtonElement;
	button.disabled = true;
	button.textContent = "Loading servers…";
	showServerLoading();
	goTo("servers");
	await loadServers();
	button.disabled = false;
	button.textContent = "Continue";
});

// ---- Server selection ----

$<HTMLAnchorElement>("btn-again").addEventListener("click", (e) => {
	e.preventDefault();
	++authRun;
	++serverLoadRun;
	stopAuthPolling();
	void (async () => {
		await plex.cancelAuth();
		await startAuth();
	})();
});

$<HTMLButtonElement>("btn-start").addEventListener("click", async () => {
	const serverIdentifier = appState.getSnapshot().selectedServer;
	if (!serverIdentifier) return;
	const button = $("btn-start");
	button.disabled = true;
	try {
		await plex.selectServer(serverIdentifier);
		const server = servers.find((item) => item.clientIdentifier === serverIdentifier);
		appState.setSelectedServer(serverIdentifier);
		renderHomeScreen(account, server?.name, server?.online);
		void loadShellMusicSections();
		void loadHomeHubs();
		goTo("home");
	} catch (error) {
		console.error("Failed to select server:", error);
		$("server-error").textContent = `Couldn't connect to that server: ${(error as Error).message}`;
		$("server-error").removeAttribute("hidden");
		button.disabled = false;
	}
});

function showServerLoading(): void {
	++serverLoadRun;
	appState.setSelectedServer(null);
	const list = $("server-list");
	list.innerHTML = "";
	const loading = document.createElement("div");
	loading.className = "server-loading";
	const spinner = document.createElement("div");
	spinner.className = "spinner";
	const label = document.createElement("span");
	label.textContent = "Loading your Plex servers…";
	loading.append(spinner, label);
	list.append(loading);
	$("btn-start").disabled = true;
	const error = $("server-error");
	error.textContent = "";
	error.setAttribute("hidden", "");
}

async function loadServers(): Promise<boolean> {
	const loadRun = ++serverLoadRun;
	const error = $("server-error");
	error.textContent = "";
	error.setAttribute("hidden", "");
	try {
		const list = await plex.getServers();
		if (loadRun !== serverLoadRun) return false;
		servers = list;
		appState.setSelectedServer(servers.find((server) => server.url)?.clientIdentifier ?? null);
		renderServerList();
		if (!servers.some((server) => server.url)) {
			error.textContent = "No owned Plex media servers were found on this account.";
			error.removeAttribute("hidden");
			return false;
		}
		return true;
	} catch (error) {
		if (loadRun !== serverLoadRun) return false;
		console.error("Failed to load servers:", error);
		$("server-list").innerHTML = "";
		$("server-error").textContent = `Couldn't load your Plex servers: ${(error as Error).message}`;
		$("server-error").removeAttribute("hidden");
		return false;
	}
}

function renderServerList() {
	const list = $("server-list");
	list.innerHTML = "";
	const selectedServer = appState.getSnapshot().selectedServer;
	for (const server of servers) {
		const row = document.createElement("div");
		row.className = "server";
		const icon = document.createElement("div");
		icon.className = "server-icon";
		icon.append(
			createLucideIcon(
				'<rect width="20" height="8" x="2" y="2" rx="2" ry="2"></rect><rect width="20" height="8" x="2" y="14" rx="2" ry="2"></rect><line x1="6" x2="6.01" y1="6" y2="6"></line><line x1="6" x2="6.01" y1="18" y2="18"></line>',
			),
		);
		const info = document.createElement("div");
		info.className = "server-info";
		const name = document.createElement("div");
		name.className = "server-name";
		name.textContent = server.name;
		const host = document.createElement("div");
		host.className = "server-host";
		const owner = account?.username ? ` · ${account.username}` : "";
		host.textContent = `${server.url || "No connection available"}${owner}`;
		info.append(name, host);
		const check = document.createElement("div");
		check.className = "server-check";
		check.append(
			createLucideIcon('<circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path>'),
		);
		row.append(icon, info, check);
		const usable = Boolean(server.url);
		row.classList.toggle("is-unavailable", !usable);
		row.classList.toggle("sel", usable && server.clientIdentifier === selectedServer);
		if (!usable) row.title = "No server connection is available";
		row.addEventListener("click", () => {
			if (!usable) return;
			for (const s of list.children) s.classList.remove("sel");
			row.classList.add("sel");
			appState.setSelectedServer(server.clientIdentifier);
			$<HTMLButtonElement>("btn-start").disabled = false;
		});
		list.append(row);
	}
	$<HTMLButtonElement>("btn-start").disabled = appState.getSnapshot().selectedServer === null;
}

function createLucideIcon(markup: string): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.innerHTML = markup;
	return svg;
}

// ---- Authenticated app shell ----

function isShellView(value: string | undefined): value is ShellView {
	return value !== undefined && (shellViews as readonly string[]).includes(value);
}

function setShellView(view: ShellView, options: { preserveSearch?: boolean } = {}): void {
	if (view === "home" || homeCategoryView !== null) {
		homeCategoryRequest += 1;
		homeCategoryView = null;
	}
	if (view !== "search" && !options.preserveSearch) {
		$<HTMLInputElement>("shell-search-input").value = "";
		if (shellSearchTimer !== null) window.clearTimeout(shellSearchTimer);
		++shellSearchRun;
		appState.setSearchQuery("");
	}
	appState.setActiveView(view);
	renderShellView(appState.getSnapshot());
}

function renderShellView(state: AppStateSnapshot): void {
	const view = state.activeView;
	renderedShellView = view;
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-shell-view]")) {
		const selected = button.dataset.shellView === view;
		button.classList.toggle("is-active", selected);
		if (selected) button.setAttribute("aria-current", "page");
		else button.removeAttribute("aria-current");
	}

	if (view === "home") {
		$("home-dashboard").removeAttribute("hidden");
		$("shell-placeholder").setAttribute("hidden", "");
		$("shell-search-results").setAttribute("hidden", "");
		$("shell-search-results").replaceChildren();
		renderHomeState(homeState.getSnapshot());
		return;
	}

	$("home-dashboard").setAttribute("hidden", "");
	$("home-category").setAttribute("hidden", "");
	const copy = shellViewCopy[view];
	$("shell-placeholder-eyebrow").textContent = copy.eyebrow;
	$("shell-placeholder-title").textContent = copy.title;
	$("shell-placeholder-copy").textContent = copy.copy;
	$("shell-placeholder").removeAttribute("hidden");
	$("shell-search-results").setAttribute("hidden", "");
	$("shell-search-results").replaceChildren();
}

homeState.subscribe(renderHomeState);

appState.subscribe((state) => {
	if (state.searchGeneration !== observedSearchGeneration) {
		observedSearchGeneration = state.searchGeneration;
		invalidateShellSearch();
		if (state.activeView === "search" && state.searchQuery) {
			renderShellSearchStatus(`Searching for “${state.searchQuery}”…`);
			void runShellSearch(state.searchQuery);
		}
	}
	if (state.selectedServer !== observedHomeServer) {
		observedHomeServer = state.selectedServer;
		homeState.setServer(state.selectedServer);
	}
	if (state.activeView !== renderedShellView) renderShellView(state);
	renderMusicSectionsState(state);
});

function renderMusicSectionsState(state: AppStateSnapshot): void {
	const status = $("shell-library-status");
	if (state.musicSectionsStatus === "idle") {
		status.textContent = "";
		status.setAttribute("hidden", "");
		return;
	}

	status.removeAttribute("hidden");
	if (state.musicSectionsStatus === "loading") {
		status.textContent = "Loading your Plex music library…";
	} else if (state.musicSectionsStatus === "ready") {
		const count = state.musicSections.length;
		status.textContent = `${count} music librar${count === 1 ? "y" : "ies"} connected`;
	} else {
		status.textContent = state.musicSectionsError
			? `Music library unavailable: ${state.musicSectionsError}`
			: "Music library unavailable";
	}
}

async function loadShellMusicSections(): Promise<void> {
	try {
		await appState.loadMusicSections();
	} catch (error) {
		console.error("Failed to load Plex music sections:", error);
	}
}

async function loadHomeHubs(): Promise<void> {
	try {
		await homeState.loadHomeHubs();
	} catch (error) {
		console.error("Failed to load Plex home hubs:", error);
	}
}

function renderHomeState(state: HomeStateSnapshot): void {
	const status = $("home-state");
	const retry = $<HTMLButtonElement>("home-retry");
	const rows = $("home-hub-rows");
	const empty = $("home-empty");
	const dashboard = $("home-dashboard");
	const category = $("home-category");
	if (state.status === "idle") {
		homeCategoryRequest += 1;
		homeCategoryView = null;
	}
	rows.replaceChildren();
	$("home-category-cards").replaceChildren();
	status.classList.toggle("is-error", state.status === "error");
	retry.setAttribute("hidden", "");
	empty.setAttribute("hidden", "");
	dashboard.removeAttribute("hidden");
	category.setAttribute("hidden", "");

	if (state.status === "idle") {
		status.textContent = "";
		status.setAttribute("hidden", "");
		return;
	}
	if (state.status === "loading") {
		status.textContent = "Loading your Plex home…";
		status.removeAttribute("hidden");
		return;
	}
	if (homeCategoryView) {
		dashboard.setAttribute("hidden", "");
		category.removeAttribute("hidden");
		renderHomeCategory(homeCategoryView);
		return;
	}
	if (state.status === "error") {
		status.textContent = state.error
			? `Couldn't load your Plex home: ${state.error}`
			: "Couldn't load your Plex home.";
		status.removeAttribute("hidden");
		retry.removeAttribute("hidden");
		return;
	}

	status.textContent = "";
	status.setAttribute("hidden", "");
	const hubs = filterMusicHomeHubs(state.hubs);
	if (hubs.length === 0) {
		empty.removeAttribute("hidden");
		return;
	}
	for (const hub of hubs) rows.append(renderHomeHub(hub));
}

function renderHomeHub(hub: PlexHub): HTMLElement {
	const row = document.createElement("section");
	row.className = "home-hub-row";
	if (hub.hubIdentifier) row.dataset.hubIdentifier = hub.hubIdentifier;

	const heading = document.createElement("div");
	heading.className = "home-hub-heading";
	const title = document.createElement("h3");
	title.className = "home-hub-title";
	title.textContent = hub.title ?? hub.hubIdentifier ?? "Plex Home";
	heading.append(title);
	const hubKey = homeHubKey(hub);
	if (shouldShowHomeHubSeeAll(hub) && hubKey) {
		const seeAll = document.createElement("button");
		seeAll.className = "home-hub-see-all";
		seeAll.type = "button";
		seeAll.textContent = "See all";
		seeAll.addEventListener("click", () => void openHomeCategory(hub));
		heading.append(seeAll);
	}

	const cards = document.createElement("div");
	cards.className = "home-hub-cards";
	cards.setAttribute("role", "list");
	const items = (hub.Metadata ?? []).slice(0, HOME_HUB_PREVIEW_SIZE);
	for (const item of items) cards.append(renderHomeHubItem(item));
	row.append(heading, cards);
	return row;
}

function homeHubKey(hub: PlexHub): string | null {
	return hub.hubIdentifier ?? hub.key ?? null;
}

async function openHomeCategory(hub: PlexHub): Promise<void> {
	const request = ++homeCategoryRequest;
	homeCategoryView = { hub, items: [], status: "loading", error: null };
	renderHomeState(homeState.getSnapshot());
	try {
		const rawItems = hub.hubIdentifier?.startsWith("music.recent.played.")
			? hub.Metadata ?? []
			: hub.key
				? await plex.getHomeHubItems(hub.key)
				: hub.Metadata ?? [];
		const [filtered] = filterMusicHomeHubs([{ ...hub, Metadata: rawItems }]);
		if (request !== homeCategoryRequest) return;
		homeCategoryView = {
			hub: filtered ?? { ...hub, Metadata: [] },
			items: filtered?.Metadata ?? [],
			status: "ready",
			error: null,
		};
	} catch (error) {
		console.error("Failed to load the full Plex Home category:", error);
		if (request === homeCategoryRequest) {
			homeCategoryView = {
				hub,
				items: [],
				status: "error",
				error: error instanceof Error ? error.message : "Failed to load category",
			};
		}
	} finally {
		if (request === homeCategoryRequest) renderHomeState(homeState.getSnapshot());
	}
}

function renderHomeCategory(view: HomeCategoryView): void {
	const title = $("home-category-title");
	const status = $("home-category-status");
	const cards = $("home-category-cards");
	title.textContent = view.hub.title ?? view.hub.hubIdentifier ?? "Plex category";
	cards.replaceChildren();
	status.setAttribute("hidden", "");
	if (view.status === "loading") {
		status.textContent = "Loading…";
		status.removeAttribute("hidden");
		return;
	}
	if (view.status === "error") {
		status.textContent = `Couldn't load this category${view.error ? `: ${view.error}` : "."}`;
		status.removeAttribute("hidden");
		return;
	}
	if (view.items.length === 0) {
		status.textContent = "No items in this category.";
		status.removeAttribute("hidden");
		return;
	}
	for (const item of view.items) cards.append(renderHomeHubItem(item, true));
}

function renderHomeHubItem(item: PlexHubItem, category = false): HTMLElement {
	const card = document.createElement("article");
	card.className = category ? "home-hub-card home-category-card" : "home-hub-card";
	card.setAttribute("role", "listitem");
	const interaction = homeHubItemInteraction(item);
	if (interaction) card.classList.add(`home-hub-card-${interaction}`);

	const art = document.createElement("div");
	art.className = "home-hub-card-art";
	const fallback = document.createElement("span");
	fallback.className = "home-hub-card-art-fallback";
	fallback.textContent = item.title.charAt(0).toUpperCase() || "♪";
	art.append(fallback);

	const imagePath = item.thumb ?? item.composite ?? item.art;
	if (imagePath) {
		const image = document.createElement("img");
		image.alt = "";
		image.hidden = true;
		image.onload = () => {
			fallback.hidden = true;
			image.hidden = false;
		};
		image.onerror = () => {
			image.hidden = true;
			fallback.hidden = false;
		};
		art.append(image);
		void plex.imageUrl(imagePath).then((url) => {
			if (url && image.isConnected) image.src = url;
		}).catch(() => {
			if (image.isConnected) {
				image.hidden = true;
				fallback.hidden = false;
			}
		});
	}
	if (interaction === "track") {
		const play = document.createElement("button");
		play.className = "home-hub-card-play";
		play.type = "button";
		play.setAttribute("aria-label", `Play ${item.title}`);
		play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"></path></svg>';
		art.append(play);
	}

	const title = document.createElement("span");
	title.className = "home-hub-card-title";
	title.textContent = item.title;
	const meta = document.createElement("span");
	meta.className = "home-hub-card-meta";
	meta.textContent = category ? homeCategoryItemMeta(item) : homeHubItemMeta(item);
	const text = document.createElement("div");
	text.className = "home-hub-card-text";
	text.append(title, meta);
	card.append(art, text);
	return card;
}

function renderShellSearchStatus(message: string): void {
	$("shell-placeholder").setAttribute("hidden", "");
	const results = $("shell-search-results");
	results.removeAttribute("hidden");
	results.replaceChildren();
	const status = document.createElement("p");
	status.className = "shell-search-status";
	status.textContent = message;
	results.append(status);
}

function invalidateShellSearch(): void {
	++shellSearchRun;
	if (shellSearchTimer !== null) {
		window.clearTimeout(shellSearchTimer);
		shellSearchTimer = null;
	}
}

async function runShellSearch(query: string): Promise<void> {
	const run = ++shellSearchRun;
	shellSearchTimer = null;
	renderShellSearchStatus(`Searching for “${query}”…`);
	try {
		const result = await plex.search(query);
		if (run !== shellSearchRun || appState.getSnapshot().activeView !== "search") return;
		renderShellSearchResults(query, result);
	} catch (error) {
		if (run !== shellSearchRun || appState.getSnapshot().activeView !== "search") return;
		console.error("Failed to search Plex:", error);
		renderShellSearchStatus(`Search failed: ${(error as Error).message}`);
	}
}

function renderShellSearchResults(query: string, result: ShellSearchResults): void {
	const results = $("shell-search-results");
	results.removeAttribute("hidden");
	results.replaceChildren();

	const groups = [
		{
			label: "Songs",
			items: result.tracks.slice(0, 6).map((item) => ({
				title: item.title,
				meta: item.grandparentTitle ?? item.parentTitle ?? "Song",
			})),
		},
		{
			label: "Albums",
			items: result.albums.slice(0, 6).map((item) => ({
				title: item.title,
				meta: [item.parentTitle, item.year ? String(item.year) : "Album"].filter(Boolean).join(" · "),
			})),
		},
		{
			label: "Artists",
			items: result.artists.slice(0, 6).map((item) => ({
				title: item.title,
				meta: "Artist",
			})),
		},
	];
	const total = groups.reduce((count, group) => count + group.items.length, 0);
	if (total === 0) {
		renderShellSearchStatus(`No results for “${query}”.`);
		return;
	}

	const heading = document.createElement("p");
	heading.className = "shell-search-status";
	heading.textContent = `${total} result${total === 1 ? "" : "s"} for “${query}”`;
	results.append(heading);

	for (const group of groups) {
		if (group.items.length === 0) continue;
		const section = document.createElement("section");
		section.className = "shell-search-group";
		const title = document.createElement("h3");
		title.textContent = group.label;
		const items = document.createElement("div");
		items.className = "shell-search-items";
		for (const item of group.items) {
			const card = document.createElement("div");
			card.className = "shell-search-item";
			card.setAttribute("role", "listitem");
			const itemTitle = document.createElement("span");
			itemTitle.className = "shell-search-item-title";
			itemTitle.textContent = item.title;
			const itemMeta = document.createElement("span");
			itemMeta.className = "shell-search-item-meta";
			itemMeta.textContent = item.meta;
			card.append(itemTitle, itemMeta);
			items.append(card);
		}
		section.append(title, items);
		results.append(section);
	}
}

function closeSidebarServerMenu(): void {
	const menu = $("sidebar-server-menu");
	menu.setAttribute("hidden", "");
	const selector = $("sidebar-server-selector");
	selector.classList.remove("is-open");
	selector.setAttribute("aria-expanded", "false");
	$("sidebar-server-chevron").querySelector("path")?.setAttribute("d", "m6 15 6-6 6 6");
}

async function toggleSidebarServerMenu(): Promise<void> {
	const menu = $("sidebar-server-menu");
	if (!menu.hasAttribute("hidden")) {
		closeSidebarServerMenu();
		return;
	}

	menu.removeAttribute("hidden");
	const selector = $("sidebar-server-selector");
	selector.classList.add("is-open");
	selector.setAttribute("aria-expanded", "true");
	$("sidebar-server-chevron").querySelector("path")?.setAttribute("d", "m6 9 6 6 6-6");
	const options = $("sidebar-server-options");
	options.replaceChildren();
	const loading = document.createElement("div");
	loading.className = "sidebar-server-option-status";
	loading.textContent = "Loading servers…";
	options.append(loading);

	try {
		servers = await plex.getServers();
		if (!menu.hasAttribute("hidden")) renderSidebarServerOptions(servers);
	} catch (error) {
		if (menu.hasAttribute("hidden")) return;
		options.replaceChildren();
		const message = document.createElement("div");
		message.className = "sidebar-server-option-status";
		message.textContent = `Couldn't load servers: ${(error as Error).message}`;
		options.append(message);
	}
}

function renderSidebarServerOptions(availableServers: Server[]): void {
	const options = $("sidebar-server-options");
	options.replaceChildren();
	const selectedServer = appState.getSnapshot().selectedServer;
	if (availableServers.length === 0) {
		const empty = document.createElement("div");
		empty.className = "sidebar-server-option-status";
		empty.textContent = "No servers found";
		options.append(empty);
		return;
	}

	for (const server of availableServers) {
		const option = document.createElement("button");
		option.type = "button";
		option.className = "sidebar-server-option";
		const copy = document.createElement("span");
		copy.className = "sidebar-server-option-copy";
		const name = document.createElement("span");
		name.className = "sidebar-server-option-name";
		name.textContent = server.name;
		const status = document.createElement("span");
		status.className = "sidebar-server-option-status";
		status.classList.add(serverStatusClass(server.online));
		status.textContent = serverStatusLabel(server.online);
		copy.append(name, status);
		option.append(copy);
		if (server.clientIdentifier === selectedServer) {
			const check = document.createElement("span");
			check.className = "sidebar-server-option-check";
			check.textContent = "✓";
			option.append(check);
		}
		option.addEventListener("click", () => void selectSidebarServer(server));
		options.append(option);
	}
}

async function selectSidebarServer(server: Server): Promise<void> {
	const selectedServer = appState.getSnapshot().selectedServer;
	if (!server.url || server.clientIdentifier === selectedServer) {
		closeSidebarServerMenu();
		return;
	}
	try {
		await plex.selectServer(server.clientIdentifier);
		appState.setSelectedServer(server.clientIdentifier);
		renderHomeScreen(account, server.name, server.online);
		void loadShellMusicSections();
		void loadHomeHubs();
		closeSidebarServerMenu();
	} catch (error) {
		const options = $("sidebar-server-options");
		options.replaceChildren();
		const message = document.createElement("div");
		message.className = "sidebar-server-option-status";
		message.textContent = `Couldn't connect: ${(error as Error).message}`;
		options.append(message);
	}
}

async function renderConnectedScreen(acct: Account | null, run?: number): Promise<void> {
	const name = acct?.username || "Plex account";
	$("account-name").textContent = name;
	$("account-email").textContent = acct?.email || "Account details unavailable";
	const initials = name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part.charAt(0))
		.join("")
		.toUpperCase();
	const initialsElement = $("account-initials");
	const image = $<HTMLImageElement>("account-avatar-image");
	initialsElement.textContent = initials;
	initialsElement.hidden = false;
	image.hidden = true;
	image.removeAttribute("src");
	image.onerror = null;

	let avatarUrl: string | null = null;
	if (acct) {
		try {
			avatarUrl = await plex.getAccountAvatarUrl();
		} catch (error) {
			console.error("Failed to load the Plex profile image:", error);
		}
	}
	if (run !== undefined && run !== authRun) return;
	if (!avatarUrl) return;

	image.onerror = () => {
		image.hidden = true;
		initialsElement.hidden = false;
	};
	image.src = avatarUrl;
	image.hidden = false;
	initialsElement.hidden = true;
}

function renderHomeScreen(acct?: Account | null, serverName?: string, serverOnline?: boolean): void {
	const name = acct?.username || "Plex account";
	const selectedServer = appState.getSnapshot().selectedServer;
	const selectedServerInfo = servers.find((s) => s.clientIdentifier === selectedServer);
	const resolvedServerName = serverName ?? selectedServerInfo?.name;
	const resolvedServerOnline = serverOnline ?? selectedServerInfo?.online;
	const initials = name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part.charAt(0))
		.join("")
		.toUpperCase();

	$("sidebar-user-name").textContent = name;
	$("sidebar-avatar").textContent = initials;
	$("sidebar-server-name").textContent = resolvedServerName || "your server";
	const status = $("sidebar-server-status");
	status.classList.remove("is-online", "is-offline", "is-checking");
	status.classList.add(serverStatusClass(resolvedServerOnline));
	status.textContent = serverStatusLabel(resolvedServerOnline);
}

// Initial route: hide everything not current (handled above in init()).
void init();
