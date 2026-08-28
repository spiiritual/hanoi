import type { PlexHub } from "../../bun/plex/types.ts";

export type HomeStatus = "idle" | "loading" | "ready" | "error";

export interface HomeStateSnapshot {
  hubs: PlexHub[];
  status: HomeStatus;
  error: string | null;
}

export interface HomeState {
  getSnapshot: () => HomeStateSnapshot;
  subscribe: (listener: (snapshot: HomeStateSnapshot) => void) => () => void;
  setServer: (clientIdentifier: string | null) => void;
  loadHomeHubs: () => Promise<PlexHub[]>;
}

interface HomeStateOptions {
  loadHomeHubs: () => Promise<PlexHub[]>;
}

export const createHomeState = ({
  loadHomeHubs,
}: HomeStateOptions): HomeState => {
  let state: HomeStateSnapshot = {
    error: null,
    hubs: [],
    status: "idle",
  };
  let selectedServer: string | null = null;
  let requestGeneration = 0;
  let homeHubsPromise: Promise<PlexHub[]> | null = null;
  const listeners = new Set<(snapshot: HomeStateSnapshot) => void>();
  let stableSnapshot: HomeStateSnapshot = { ...state, hubs: [] };

  const snapshot = (): HomeStateSnapshot => stableSnapshot;

  const notify = (): void => {
    stableSnapshot = { ...state, hubs: [...state.hubs] };
    for (const listener of listeners) {
      listener(stableSnapshot);
    }
  };

  return {
    getSnapshot: snapshot,
    loadHomeHubs: async () => {
      if (state.status === "ready") {
        return [...state.hubs];
      }
      if (homeHubsPromise) {
        return await homeHubsPromise;
      }
      if (selectedServer === null) {
        const error = new Error("No Plex server selected");
        state = { ...state, error: error.message, status: "error" };
        notify();
        throw error;
      }

      const generation = requestGeneration;
      const server = selectedServer;
      state = { ...state, error: null, status: "loading" };
      notify();

      const request = (async (): Promise<PlexHub[]> => {
        try {
          const hubs = await loadHomeHubs();
          if (generation === requestGeneration && selectedServer === server) {
            state = {
              error: null,
              hubs: [...hubs],
              status: "ready",
            };
            notify();
          }
          return hubs;
        } catch (error: unknown) {
          if (generation === requestGeneration && selectedServer === server) {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to load Plex home hubs";
            state = { ...state, error: message, status: "error" };
            homeHubsPromise = null;
            notify();
          }
          throw error;
        }
      })();
      homeHubsPromise = request;
      return await request;
    },
    setServer(clientIdentifier) {
      if (selectedServer === clientIdentifier) {
        return;
      }
      selectedServer = clientIdentifier;
      requestGeneration += 1;
      homeHubsPromise = null;
      state = {
        error: null,
        hubs: [],
        status: "idle",
      };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
