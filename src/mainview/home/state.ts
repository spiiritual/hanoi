import type { PlexHub } from "../../bun/plex/types.ts";

export type HomeStatus = "idle" | "loading" | "ready" | "error";

export interface HomeStateSnapshot {
  hubs: PlexHub[];
  status: HomeStatus;
  error: string | null;
}

export interface HomeState {
  getSnapshot(this: void): HomeStateSnapshot;
  subscribe(this: void, listener: (snapshot: HomeStateSnapshot) => void): () => void;
  setServer(clientIdentifier: string | null): void;
  loadHomeHubs(): Promise<PlexHub[]>;
}

interface HomeStateOptions {
  loadHomeHubs: () => Promise<PlexHub[]>;
}

export function createHomeState({ loadHomeHubs }: HomeStateOptions): HomeState {
  let state: HomeStateSnapshot = {
    hubs: [],
    status: "idle",
    error: null,
  };
  let selectedServer: string | null = null;
  let requestGeneration = 0;
  let homeHubsPromise: Promise<PlexHub[]> | null = null;
  const listeners = new Set<(snapshot: HomeStateSnapshot) => void>();
  let stableSnapshot: HomeStateSnapshot = { ...state, hubs: [] };

  const snapshot = (): HomeStateSnapshot => stableSnapshot;

  const notify = (): void => {
    stableSnapshot = { ...state, hubs: [...state.hubs] };
    for (const listener of listeners) listener(stableSnapshot);
  };

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setServer(clientIdentifier) {
      if (selectedServer === clientIdentifier) return;
      selectedServer = clientIdentifier;
      requestGeneration += 1;
      homeHubsPromise = null;
      state = {
        hubs: [],
        status: "idle",
        error: null,
      };
      notify();
    },
    loadHomeHubs() {
      if (state.status === "ready") return Promise.resolve([...state.hubs]);
      if (homeHubsPromise) return homeHubsPromise;
      if (selectedServer === null) {
        const error = new Error("No Plex server selected");
        state = { ...state, status: "error", error: error.message };
        notify();
        return Promise.reject(error);
      }

      const generation = requestGeneration;
      const server = selectedServer;
      state = { ...state, status: "loading", error: null };
      notify();

      const request = loadHomeHubs()
        .then((hubs) => {
          if (generation === requestGeneration && selectedServer === server) {
            state = {
              hubs: [...hubs],
              status: "ready",
              error: null,
            };
            notify();
          }
          return hubs;
        })
        .catch((cause: unknown) => {
          if (generation === requestGeneration && selectedServer === server) {
            const message =
              cause instanceof Error ? cause.message : "Failed to load Plex home hubs";
            state = { ...state, status: "error", error: message };
            homeHubsPromise = null;
            notify();
          }
          throw cause;
        });
      homeHubsPromise = request;
      return request;
    },
  };
}
