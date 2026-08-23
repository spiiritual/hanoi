import type { PlexSection } from "../bun/plex/types.ts";

export const shellViews = ["home", "albums", "artists", "songs", "playlists", "search"] as const;
export type ShellView = (typeof shellViews)[number];

export type MusicSectionsStatus = "idle" | "loading" | "ready" | "error";

export interface AppStateSnapshot {
  activeView: ShellView;
  searchQuery: string;
  searchGeneration: number;
  selectedServer: string | null;
  musicSections: PlexSection[];
  musicSectionsStatus: MusicSectionsStatus;
  musicSectionsError: string | null;
}

export interface AppState {
  getSnapshot(): AppStateSnapshot;
  subscribe(listener: (snapshot: AppStateSnapshot) => void): () => void;
  setActiveView(view: ShellView): void;
  setSearchQuery(query: string): void;
  setSelectedServer(clientIdentifier: string | null): void;
  loadMusicSections(): Promise<PlexSection[]>;
}

interface AppStateOptions {
  loadMusicSections: () => Promise<PlexSection[]>;
}

export function createAppState({ loadMusicSections }: AppStateOptions): AppState {
  let state: AppStateSnapshot = {
    activeView: "home",
    searchQuery: "",
    searchGeneration: 0,
    selectedServer: null,
    musicSections: [],
    musicSectionsStatus: "idle",
    musicSectionsError: null,
  };
  let requestGeneration = 0;
  let musicSectionsPromise: Promise<PlexSection[]> | null = null;
  const listeners = new Set<(snapshot: AppStateSnapshot) => void>();
  let stableSnapshot: AppStateSnapshot = {
    ...state,
    musicSections: [],
  };

  const snapshot = (): AppStateSnapshot => stableSnapshot;

  const notify = (): void => {
    stableSnapshot = { ...state, musicSections: [...state.musicSections] };
    for (const listener of listeners) listener(stableSnapshot);
  };

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setActiveView(view) {
      if (state.activeView === view) return;
      state = { ...state, activeView: view };
      notify();
    },
    setSearchQuery(query) {
      if (state.searchQuery === query) return;
      state = { ...state, searchQuery: query };
      notify();
    },
    setSelectedServer(clientIdentifier) {
      if (state.selectedServer === clientIdentifier) return;
      requestGeneration += 1;
      musicSectionsPromise = null;
      state = {
        ...state,
        searchGeneration: state.searchGeneration + 1,
        selectedServer: clientIdentifier,
        musicSections: [],
        musicSectionsStatus: "idle",
        musicSectionsError: null,
      };
      notify();
    },
    loadMusicSections() {
      if (state.musicSectionsStatus === "ready") {
        return Promise.resolve([...state.musicSections]);
      }
      if (musicSectionsPromise) return musicSectionsPromise;
      if (state.selectedServer === null) {
        const error = new Error("No Plex server selected");
        state = {
          ...state,
          musicSectionsStatus: "error",
          musicSectionsError: error.message,
        };
        notify();
        return Promise.reject(error);
      }

      const generation = requestGeneration;
      const server = state.selectedServer;
      state = {
        ...state,
        musicSectionsStatus: "loading",
        musicSectionsError: null,
      };
      notify();

      const request = loadMusicSections()
        .then((sections) => {
          if (generation === requestGeneration && state.selectedServer === server) {
            state = {
              ...state,
              musicSections: [...sections],
              musicSectionsStatus: "ready",
              musicSectionsError: null,
            };
            notify();
          }
          return sections;
        })
        .catch((cause: unknown) => {
          if (generation === requestGeneration && state.selectedServer === server) {
            const message =
              cause instanceof Error ? cause.message : "Failed to load Plex music sections";
            state = {
              ...state,
              musicSectionsStatus: "error",
              musicSectionsError: message,
            };
            musicSectionsPromise = null;
            notify();
          }
          throw cause;
        });
      musicSectionsPromise = request;
      return request;
    },
  };
}
