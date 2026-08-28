import { createAppState } from "./app-state.ts";
import { createHomeState } from "./home/state.ts";
import { createPlayerState } from "./player/state.ts";
import { plex } from "./plex.ts";

export const appState = createAppState({
  loadMusicSections: plex.getMusicSections,
});

export const homeState = createHomeState({
  loadHomeHubs: plex.getHomeHubs,
});

export const playerState = createPlayerState({
  onPlaybackMetric: (metric) => {
    globalThis.performance?.mark(`hanoi.playback.${metric.event}`, {
      detail: metric,
    });
  },
  scrobble: plex.scrobble,
  streamUrl: plex.streamUrl,
});
