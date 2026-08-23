import { expect, test } from "bun:test";

const html = await Bun.file(
	new URL("../src/mainview/index.html", import.meta.url),
).text();
const css = (
	await Promise.all(
		[
			"index.css",
			"styles/global.css",
			"auth/AuthLayout.css",
			"auth/OAuthScreen.css",
			"auth/ConnectedScreen.css",
			"auth/ServerSelection.css",
			"home/HomeScreen.css",
			"home/HomeContent.css",
			"sidebar/Sidebar.css",
			"player/PlayerBar.css",
			"player/NowPlaying.css",
			"player/PlaybackControls.css",
			"player/VolumeControls.css",
		].map((file) =>
			Bun.file(new URL(`../src/mainview/${file}`, import.meta.url)).text(),
		),
	)
).join("\n");
const mainview = await Bun.file(
	new URL("../src/mainview/index.tsx", import.meta.url),
).text();
const homeContent = await Bun.file(
	new URL("../src/mainview/home/HomeContent.tsx", import.meta.url),
).text();
const homeScreen = await Bun.file(
	new URL("../src/mainview/home/HomeScreen.tsx", import.meta.url),
).text();
const sidebar = await Bun.file(
	new URL("../src/mainview/sidebar/Sidebar.tsx", import.meta.url),
).text();
const playerBar = await Bun.file(
	new URL("../src/mainview/player/PlayerBar.tsx", import.meta.url),
).text();

test("renderer bootstraps React from a minimal app root", () => {
	expect(html).toContain('<div id="app"></div>');
	expect(html).toContain('<link rel="stylesheet" href="index.css" />');
	expect(mainview).toContain(
		'createRoot(document.getElementById("app")!).render(<App />)',
	);
	expect(mainview).not.toContain("dangerouslySetInnerHTML");
});

test("React app owns the Pen shell regions and navigation controls", () => {
	expect(homeScreen).toContain('id="home-shell"');
	expect(sidebar).toContain('className="app-sidebar"');
	expect(homeScreen).toContain('className="home-topbar"');
	expect(homeScreen).toContain('id="home-content"');
	expect(playerBar).toContain('id="player-bar"');
	expect(sidebar).toContain('["albums", "Albums"]');
	expect(sidebar).toContain('["artists", "Artists"]');
	expect(sidebar).toContain('["songs", "Songs"]');
	expect(sidebar).toContain('["playlists", "Playlists"]');
	expect(homeScreen).toContain('id="shell-search-input"');
	expect(homeScreen).toContain('id="shell-search-results"');
});

test("shell exposes a live status target for shared music sections", () => {
	expect(homeScreen).toContain('id="shell-library-status"');
	expect(homeScreen).toContain('aria-live="polite"');
});

test("home renders dynamic Plex hubs and category cards", () => {
	expect(homeContent).toContain('id="home-dashboard"');
	expect(homeContent).toContain('id="home-state"');
	expect(homeContent).toContain('id="home-hub-rows"');
	expect(homeContent).toContain('id="home-category"');
	expect(homeContent).toContain('id="home-category-cards"');
	expect(homeContent).toContain("homeHubItemInteraction");
	expect(homeContent).toContain('className="home-hub-see-all"');
	expect(homeContent).not.toContain("dangerouslySetInnerHTML");
	expect(css).toContain(".home-hub-row");
	expect(css).toContain(".home-hub-card");
	expect(css).toContain(".home-hub-see-all");
});

test("home cards preserve Pen geometry and hover affordances", () => {
	expect(css).toMatch(/\.home-hub-cards\s*\{[\s\S]*?grid-auto-columns: 150px;/);
	expect(css).toMatch(
		/\.home-hub-card\s*\{[\s\S]*?width: 150px;[\s\S]*?gap: 10px;/,
	);
	expect(css).toMatch(
		/\.home-hub-card-text\s*\{[\s\S]*?width: 140px;[\s\S]*?gap: 2px;/,
	);
	expect(css).toMatch(
		/\.home-hub-card-title\s*\{[\s\S]*?font-size: 14px;[\s\S]*?line-height: 1\.25;/,
	);
	expect(css).toContain(".home-hub-card:hover::before");
	expect(css).toContain(".home-hub-card-other");
	expect(css).toContain(".home-hub-card-track:hover .home-hub-card-play");
	expect(css).toContain(".home-hub-card-track:focus-within .home-hub-card-play");
});

test("home card rows retain Pen scrolling and selector states", () => {
	expect(css).toMatch(
		/\.home-hub-cards\s*\{[\s\S]*?padding: 8px 3px 16px;[\s\S]*?margin: -8px -3px -8px;/,
	);
	expect(css).toMatch(
		/\.home-hub-cards\s*\{[\s\S]*?overflow-x: auto;[\s\S]*?scrollbar-width: none;/,
	);
	expect(css).toContain(".home-hub-cards::-webkit-scrollbar");
	expect(css).toContain(".sidebar-server-menu[hidden]");
	expect(css).toContain(".sidebar-server-status.is-online");
	expect(css).toContain(".sidebar-server-status.is-offline");
	expect(css).toContain(".sidebar-nav-item.is-active .sidebar-icon");
	expect(css).toContain(".sidebar-subnav-item.is-active .sidebar-subnav-icon");
	expect(css).toContain(".sidebar-server-selector.is-open");
});
