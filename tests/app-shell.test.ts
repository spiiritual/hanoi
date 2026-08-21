import { expect, test } from "bun:test";

const html = await Bun.file(
	new URL("../src/mainview/index.html", import.meta.url),
).text();
const css = await Bun.file(
	new URL("../src/mainview/index.css", import.meta.url),
).text();
const mainview = await Bun.file(
	new URL("../src/mainview/index.ts", import.meta.url),
).text();

test("authenticated home exposes the Pen app shell regions", () => {
	expect(html).toContain('id="home-shell"');
	expect(html).toContain('class="app-sidebar"');
	expect(html).toContain('class="home-topbar"');
	expect(html).toContain('class="home-content"');
	expect(html).toContain('class="player-bar"');
});

test("shell controls expose navigation and search targets", () => {
	expect(html).toContain('id="sidebar-home"');
	expect(html).toContain('data-shell-view="albums"');
	expect(html).toContain('data-shell-view="artists"');
	expect(html).toContain('data-shell-view="songs"');
	expect(html).toContain('data-shell-view="playlists"');
	expect(html).toContain('id="shell-search-input"');
	expect(html).toContain('id="shell-search-results"');
});

test("shell exposes a live status target for the shared music-section state", () => {
	expect(html).toContain('id="shell-library-status"');
	expect(html).toContain('aria-live="polite"');
});

test("home exposes dynamic Plex hub row targets", () => {
	expect(html).toContain('id="home-dashboard"');
	expect(html).toContain('id="home-state"');
	expect(html).toContain('id="home-hub-rows"');
	expect(html).not.toContain('class="home-dashboard-heading"');
	expect(html).not.toContain("Listen from your Plex home");
	expect(css).toContain(".home-hub-row");
	expect(css).toContain(".home-hub-card");
	expect(css).toContain(".home-hub-see-all");
	expect(css).not.toContain(".home-dashboard-heading");
	expect(css).not.toContain(".home-hub-count");
	expect(mainview).not.toContain("home-hub-count");
	expect(mainview).not.toContain("const itemCount");
	expect(mainview).toContain('"See all"');
});

test("home exposes the Pen category surface for See all navigation", () => {
	expect(html).toContain('id="home-category"');
	expect(html).toContain('id="home-category-title"');
	expect(html).toContain('id="home-category-cards"');
	expect(mainview).toContain("openHomeCategory");
	expect(mainview).not.toContain('textContent = expandedItems ? "Show less" : "See all"');
	expect(mainview).not.toContain("home-category-filter");
	expect(mainview).not.toContain("home-category-sort");
});

test("home cards preserve the Pen card geometry", () => {
	expect(mainview).toContain('className = "home-hub-card-text"');
	expect(css).toMatch(/\.home-hub-cards\s*\{[\s\S]*?grid-auto-columns: 150px;/);
	expect(css).toMatch(/\.home-hub-card\s*\{[\s\S]*?width: 150px;[\s\S]*?gap: 10px;/);
	expect(css).toMatch(/\.home-hub-card-text\s*\{[\s\S]*?width: 140px;[\s\S]*?gap: 2px;/);
	expect(css).toMatch(/\.home-hub-card-title\s*\{[\s\S]*?font-size: 14px;[\s\S]*?line-height: 1\.25;/);
	expect(css).toMatch(/\.home-hub-card-meta\s*\{[\s\S]*?font-size: 12px;[\s\S]*?line-height: 1\.3;/);
});

test("home cards expose Pen hover affordances by media type", () => {
	expect(mainview).toContain("homeHubItemInteraction");
	expect(mainview).toContain("home-hub-card-play");
	expect(css).toContain(".home-hub-card:hover::before");
	expect(css).toContain(".home-hub-card-other");
	expect(css).toContain(".home-hub-card-track:hover .home-hub-card-play");
	expect(css).toContain(".home-hub-card-track:focus-within .home-hub-card-play");
});

test("home card rows reserve space for the Pen hover backdrop", () => {
	expect(css).toMatch(
		/\.home-hub-cards\s*\{[\s\S]*?padding: 8px 3px 16px;[\s\S]*?margin: -8px -3px -8px;/,
	);
});

test("home card hover surfaces fit their content and the track play chip is clickable", () => {
	expect(css).toMatch(
		/\.home-hub-card\s*\{[\s\S]*?height: auto;[\s\S]*?align-self: start;/,
	);
	expect(css).toMatch(/\.home-hub-card-play\s*\{[\s\S]*?cursor: pointer;/);
});

test("home card rows keep horizontal scrolling without exposing native scrollbars", () => {
	expect(css).toMatch(
		/\.home-hub-cards\s*\{[\s\S]*?overflow-x: auto;[\s\S]*?scrollbar-width: none;/,
	);
	expect(css).toContain(".home-hub-cards::-webkit-scrollbar");
});

test("Pen active and closed selector states have explicit visual rules", () => {
	expect(html).toContain('id="sidebar-server-chevron"');
	expect(css).toContain(".sidebar-server-menu[hidden]");
	expect(css).toContain(".sidebar-server-status.is-online");
	expect(css).toContain(".sidebar-server-status.is-offline");
	expect(css).toContain(".sidebar-nav-item.is-active .sidebar-icon");
	expect(css).toContain(".sidebar-subnav-item.is-active .sidebar-subnav-icon");
	expect(css).toContain(".sidebar-server-selector.is-open");
});
