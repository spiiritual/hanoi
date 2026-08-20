import { expect, test } from "bun:test";

const html = await Bun.file(
	new URL("../src/mainview/index.html", import.meta.url),
).text();
const css = await Bun.file(
	new URL("../src/mainview/index.css", import.meta.url),
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

test("Pen active and closed selector states have explicit visual rules", () => {
	expect(html).toContain('id="sidebar-server-chevron"');
	expect(css).toContain(".sidebar-server-menu[hidden]");
	expect(css).toContain(".sidebar-nav-item.is-active .sidebar-icon");
	expect(css).toContain(".sidebar-subnav-item.is-active .sidebar-subnav-icon");
	expect(css).toContain(".sidebar-server-selector.is-open");
});
