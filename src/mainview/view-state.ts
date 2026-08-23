import { plex } from "./plex.ts";
import { createAppState } from "./app-state.ts";
import { createHomeState } from "./home/state.ts";
import { createPlayerState } from "./player/state.ts";

export const appState = createAppState({
  loadMusicSections: () => plex.getMusicSections(),
});

export const homeState = createHomeState({
  loadHomeHubs: () => plex.getHomeHubs(),
});

export const playerState = createPlayerState({
  streamUrl: plex.streamUrl,
  scrobble: plex.scrobble,
  onPlaybackMetric: (metric) => {
    globalThis.performance?.mark(`hanoi.playback.${metric.event}`, {
      detail: metric,
    });
  },
});
