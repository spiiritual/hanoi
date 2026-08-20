import { plex } from "./plex.ts";

const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

const screens = ["welcome", "oauth", "connected", "servers", "home"] as const;
type ScreenName = (typeof screens)[number];
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
let selectedServer: string | null = null;
let serverLoadRun = 0;

// ---- Startup routing ----

async function init() {
	try {
		const state = await plex.getAuthState();
		account = state.account ?? null;
		if (state.hasServer && state.authenticated) {
			current = "home";
			renderHomeScreen(account, state.server?.name);
		} else if (state.authenticated) {
			// Match the Pen flow: an authenticated account lands on the
			// confirmation card before choosing a media server.
			if (!account) {
				try {
					account = await plex.getAccount();
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
	if (!selectedServer) return;
	const button = $("btn-start");
	button.disabled = true;
	try {
		await plex.selectServer(selectedServer);
		const server = servers.find((item) => item.clientIdentifier === selectedServer);
		renderHomeScreen(account, server?.name);
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
	selectedServer = null;
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
		selectedServer = servers.find((server) => server.url)?.clientIdentifier ?? null;
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
			selectedServer = server.clientIdentifier;
			$<HTMLButtonElement>("btn-start").disabled = false;
		});
		list.append(row);
	}
	$<HTMLButtonElement>("btn-start").disabled = selectedServer === null;
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

// ---- Post-auth placeholder ----

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

function renderHomeScreen(acct?: Account | null, serverName?: string): void {
	$("home-username").textContent = acct?.username || "Plex account";
	const resolvedServerName =
		serverName ?? servers.find((s) => s.clientIdentifier === selectedServer)?.name;
	$("home-server-name").textContent = resolvedServerName || "your server";
}

// Initial route: hide everything not current (handled above in init()).
void init();
