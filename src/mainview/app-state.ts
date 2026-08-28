import type { PlexSection } from "../bun/plex/types.ts";

const shellViews = [
  "home",
  "albums",
  "artists",
  "songs",
  "playlists",
  "search",
] as const;
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
  getSnapshot: () => AppStateSnapshot;
  subscribe: (listener: (snapshot: AppStateSnapshot) => void) => () => void;
  setActiveView: (view: ShellView) => void;
  setSearchQuery: (query: string) => void;
  setSelectedServer: (clientIdentifier: string | null) => void;
  loadMusicSections: () => Promise<PlexSection[]>;
}

interface AppStateOptions {
  loadMusicSections: () => Promise<PlexSection[]>;
}

export const createAppState = ({
  loadMusicSections,
}: AppStateOptions): AppState => {
  let state: AppStateSnapshot = {
    activeView: "home",
    musicSections: [],
    musicSectionsError: null,
    musicSectionsStatus: "idle",
    searchGeneration: 0,
    searchQuery: "",
    selectedServer: null,
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
    for (const listener of listeners) {
      listener(stableSnapshot);
    }
  };

  return {
    getSnapshot: snapshot,
    loadMusicSections: async () => {
      if (state.musicSectionsStatus === "ready") {
        return [...state.musicSections];
      }
      if (musicSectionsPromise) {
        const sections = await musicSectionsPromise;
        return sections;
      }
      if (state.selectedServer === null) {
        const error = new Error("No Plex server selected");
        state = {
          ...state,
          musicSectionsError: error.message,
          musicSectionsStatus: "error",
        };
        notify();
        throw error;
      }

      const generation = requestGeneration;
      const server = state.selectedServer;
      state = {
        ...state,
        musicSectionsError: null,
        musicSectionsStatus: "loading",
      };
      notify();

      const request = (async (): Promise<PlexSection[]> => {
        try {
          const sections = await loadMusicSections();
          if (
            generation === requestGeneration &&
            state.selectedServer === server
          ) {
            state = {
              ...state,
              musicSections: [...sections],
              musicSectionsError: null,
              musicSectionsStatus: "ready",
            };
            notify();
          }
          return sections;
        } catch (error: unknown) {
          if (
            generation === requestGeneration &&
            state.selectedServer === server
          ) {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to load Plex music sections";
            state = {
              ...state,
              musicSectionsError: message,
              musicSectionsStatus: "error",
            };
            musicSectionsPromise = null;
            notify();
          }
          throw error;
        }
      })();
      musicSectionsPromise = request;
      const sections = await request;
      return sections;
    },
    setActiveView(view) {
      if (state.activeView === view) {
        return;
      }
      state = { ...state, activeView: view };
      notify();
    },
    setSearchQuery(query) {
      if (state.searchQuery === query) {
        return;
      }
      state = { ...state, searchQuery: query };
      notify();
    },
    setSelectedServer(clientIdentifier) {
      if (state.selectedServer === clientIdentifier) {
        return;
      }
      requestGeneration += 1;
      musicSectionsPromise = null;
      state = {
        ...state,
        musicSections: [],
        musicSectionsError: null,
        musicSectionsStatus: "idle",
        searchGeneration: state.searchGeneration + 1,
        selectedServer: clientIdentifier,
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
