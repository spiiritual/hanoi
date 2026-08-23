import { plex } from "./plex.ts";
import { createAppState } from "./app-state.ts";
import { createHomeState } from "./home/state.ts";

export const appState = createAppState({
	loadMusicSections: () => plex.getMusicSections(),
});

export const homeState = createHomeState({
	loadHomeHubs: () => plex.getHomeHubs(),
});
