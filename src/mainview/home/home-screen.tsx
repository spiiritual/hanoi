import { useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import type {
  PlexAlbum,
  PlexArtist,
  PlexHub,
  PlexHubItem,
  PlexPlaylist,
} from "../../bun/plex/types.ts";
import { AlbumDetail, AlbumLibrary } from "../album/album-screen.tsx";
import type { ShellView } from "../app-state.ts";
import { ArtistDetail, ArtistLibrary } from "../artist/artist-screen.tsx";
import { Icon } from "../components/icon.tsx";
import { PlayerBar } from "../player/player-bar.tsx";
import {
  PlaylistDetail,
  PlaylistLibrary,
} from "../playlist/playlist-screen.tsx";
import { plex } from "../plex.ts";
import { Sidebar } from "../sidebar/sidebar.tsx";
import { SongsLibrary } from "../songs/songs-screen.tsx";
import type { Account, Server } from "../types.ts";
import { appState, homeState, playerState } from "../view-state.ts";
import { HomeCategory, HomeDashboard } from "./home-content.tsx";
import type { HomeCategoryView } from "./home-content.tsx";
import { filterMusicHomeHubs } from "./utils.ts";

const nextLibraryCopy =
  "Library browsing will be connected in the next app slice.";
const libraryEyebrow = "YOUR LIBRARY";
const detailViews = {
  Album: "albums",
  Artist: "artists",
  Playlist: "playlists",
} satisfies Record<"Album" | "Artist" | "Playlist", ShellView>;
type DetailKind = keyof typeof detailViews;
type DetailItem = Pick<PlexHubItem, "ratingKey">;
const shellViewCopy = {
  albums: {
    copy: nextLibraryCopy,
    eyebrow: libraryEyebrow,
    title: "Albums are next.",
  },
  artists: {
    copy: nextLibraryCopy,
    eyebrow: libraryEyebrow,
    title: "Artists are next.",
  },
  home: {
    copy: "The music surface will land here next.",
    eyebrow: "HANOI",
    title: "Home is ready.",
  },
  playlists: {
    copy: nextLibraryCopy,
    eyebrow: libraryEyebrow,
    title: "Playlists are next.",
  },
  search: {
    copy: "Type a song, album, or artist above to search Plex.",
    eyebrow: "SEARCH",
    title: "Search your library.",
  },
  songs: {
    copy: nextLibraryCopy,
    eyebrow: libraryEyebrow,
    title: "Songs are next.",
  },
} satisfies Record<ShellView, { eyebrow: string; title: string; copy: string }>;

type SearchResult = Awaited<ReturnType<typeof plex.search>>;
interface SearchResultItem {
  title: string;
  meta: string;
  handleClick?: () => void;
}
const playHomeItem = (item: PlexHubItem): void => {
  if (item.type === "track") {
    void playerState.playTrack(item);
  }
};
const loadSelectedServerData = async (): Promise<void> => {
  await Promise.allSettled([
    appState.loadMusicSections(),
    homeState.loadHomeHubs(),
  ]);
};
const retryHome = (): void => {
  void homeState.loadHomeHubs();
};

const SearchResults = ({
  query,
  result,
  status,
  onAlbum,
  onArtist,
}: {
  query: string;
  result: SearchResult | null;
  status: string | null;
  onAlbum: (album: PlexAlbum) => void;
  onArtist: (artist: PlexArtist) => void;
}) => {
  if (status !== null && status.length > 0) {
    return (
      <div className="shell-search-results" id="shell-search-results">
        <p className="shell-search-status">{status}</p>
      </div>
    );
  }
  if (!result) {
    return null;
  }
  const groups: { label: string; items: SearchResultItem[] }[] = [
    {
      items: result.tracks.slice(0, 6).map((item) => {
        let meta = "Song";
        if (
          item.grandparentTitle !== undefined &&
          item.grandparentTitle.length > 0
        ) {
          meta = item.grandparentTitle;
        } else if (
          item.parentTitle !== undefined &&
          item.parentTitle.length > 0
        ) {
          meta = item.parentTitle;
        }
        return {
          handleClick: () => {
            void playerState.playTrack(item);
          },
          meta,
          title: item.title,
        };
      }),
      label: "Songs",
    },
    {
      items: result.albums.slice(0, 6).map((item) => {
        const albumMeta: string[] = [];
        if (item.parentTitle !== undefined && item.parentTitle.length > 0) {
          albumMeta.push(item.parentTitle);
        }
        if (item.year !== undefined && item.year !== 0) {
          albumMeta.push(String(item.year));
        } else {
          albumMeta.push("Album");
        }
        return {
          handleClick: () => {
            onAlbum(item);
          },
          meta: albumMeta.join(" · "),
          title: item.title,
        };
      }),
      label: "Albums",
    },
    {
      items: result.artists.slice(0, 6).map((item) => ({
        handleClick: () => {
          onArtist(item);
        },
        meta: "Artist",
        title: item.title,
      })),
      label: "Artists",
    },
  ];
  let total = 0;
  const visibleGroups: typeof groups = [];
  for (const group of groups) {
    total += group.items.length;
    if (group.items.length > 0) {
      visibleGroups.push(group);
    }
  }
  let resultStatus = `${total} results for “${query}”`;
  if (total === 0) {
    resultStatus = `No results for “${query}”.`;
  } else if (total === 1) {
    resultStatus = `1 result for “${query}”`;
  }
  return (
    <div className="shell-search-results" id="shell-search-results">
      <p className="shell-search-status">{resultStatus}</p>
      {visibleGroups.map((group) => (
        <section className="shell-search-group" key={group.label}>
          <h3>{group.label}</h3>
          <div className="shell-search-items">
            {group.items.map((item) => (
              <button
                className="shell-search-item"
                type="button"
                onClick={item.handleClick}
                key={`${group.label}-${item.title}`}
              >
                <span className="shell-search-item-title">{item.title}</span>
                <span className="shell-search-item-meta">{item.meta}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

export interface HomeScreenProps {
  account: Account | null;
  servers: Server[];
  onServers: (servers: Server[]) => void;
  onAddServer: () => void;
}
interface AlbumNavigation {
  ratingKey: string;
  returnView: ShellView;
}
interface ScreenState {
  category: HomeCategoryView | null;
  searchResult: SearchResult | null;
  searchStatus: string | null;
  selectedAlbum: AlbumNavigation | null;
  forwardAlbum: AlbumNavigation | null;
  selectedArtist: AlbumNavigation | null;
  forwardArtist: AlbumNavigation | null;
  selectedPlaylist: AlbumNavigation | null;
  forwardPlaylist: AlbumNavigation | null;
}
interface ScreenAction {
  type: "patch";
  value: Partial<ScreenState>;
}
const runSearch = async (
  query: string,
  generation: number,
  searchRun: { current: number },
  dispatch: (action: ScreenAction) => void
): Promise<void> => {
  const run = searchRun.current + 1;
  searchRun.current = run;
  dispatch({
    type: "patch",
    value: { searchStatus: `Searching for “${query}”…` },
  });
  try {
    const result = await plex.search(query);
    const current = appState.getSnapshot();
    if (
      run === searchRun.current &&
      current.searchGeneration === generation &&
      current.activeView === "search" &&
      current.searchQuery === query
    ) {
      dispatch({
        type: "patch",
        value: { searchResult: result, searchStatus: null },
      });
    }
  } catch (error) {
    const current = appState.getSnapshot();
    if (
      run === searchRun.current &&
      current.searchGeneration === generation &&
      current.activeView === "search" &&
      current.searchQuery === query
    ) {
      const message =
        error instanceof Error ? error.message : "Unknown search error";
      dispatch({
        type: "patch",
        value: { searchStatus: `Search failed: ${message}` },
      });
    }
  }
};
const initialScreenState: ScreenState = {
  category: null,
  forwardAlbum: null,
  forwardArtist: null,
  forwardPlaylist: null,
  searchResult: null,
  searchStatus: null,
  selectedAlbum: null,
  selectedArtist: null,
  selectedPlaylist: null,
};
const screenReducer = (
  state: ScreenState,
  action: ScreenAction
): ScreenState => ({ ...state, ...action.value });

type Controller = ReturnType<typeof useHomeController>;
const useHomeController = (
  servers: Server[],
  onServers: (servers: Server[]) => void
) => {
  const app = useSyncExternalStore(
    appState.subscribe,
    appState.getSnapshot,
    appState.getSnapshot
  );
  const home = useSyncExternalStore(
    homeState.subscribe,
    homeState.getSnapshot,
    homeState.getSnapshot
  );
  const [state, dispatch] = useReducer(screenReducer, initialScreenState);
  const searchRun = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const categoryRun = useRef(0);
  const patch = (value: Partial<ScreenState>): void => {
    dispatch({ type: "patch", value });
  };
  const clearNavigation = (): void => {
    patch({
      forwardAlbum: null,
      forwardArtist: null,
      forwardPlaylist: null,
      selectedAlbum: null,
      selectedArtist: null,
      selectedPlaylist: null,
    });
  };
  const issueSearch = (query: string, generation: number): void => {
    void runSearch(query, generation, searchRun, dispatch);
  };
  useEffect(() => {
    homeState.setServer(app.selectedServer);
    categoryRun.current += 1;
    dispatch({
      type: "patch",
      value: {
        category: null,
        forwardAlbum: null,
        forwardArtist: null,
        forwardPlaylist: null,
        searchResult: null,
        selectedAlbum: null,
        selectedArtist: null,
        selectedPlaylist: null,
      },
    });
    searchRun.current += 1;
  }, [app.selectedServer]);
  useEffect(() => {
    if (app.selectedServer !== null && app.selectedServer.length > 0) {
      void loadSelectedServerData();
    }
  }, [app.selectedServer]);
  useEffect(() => {
    const query = app.searchQuery;
    const generation = app.searchGeneration;
    searchRun.current += 1;
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
    }
    if (query.length === 0) {
      dispatch({
        type: "patch",
        value: { searchResult: null, searchStatus: null },
      });
    } else {
      dispatch({
        type: "patch",
        value: { searchStatus: `Searching for “${query}”…` },
      });
      searchTimer.current = window.setTimeout(() => {
        searchTimer.current = null;
        void runSearch(query, generation, searchRun, dispatch);
      }, 260);
    }
    return () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
      }
    };
  }, [app.searchGeneration, app.searchQuery]);
  const invalidateCategory = () => {
    categoryRun.current += 1;
  };
  const changeView = (view: ShellView) => {
    clearNavigation();
    if (view !== "home") {
      invalidateCategory();
      patch({ category: null });
    }
    if (view !== "search") {
      appState.setSearchQuery("");
    }
    appState.setActiveView(view);
  };
  const openDetail = (kind: DetailKind, item: DetailItem): void => {
    if (item.ratingKey.length === 0) {
      return;
    }
    const navigation = {
      ratingKey: item.ratingKey,
      returnView: app.activeView,
    };
    clearNavigation();
    patch({ [`selected${kind}`]: navigation });
    const view = detailViews[kind];
    if (app.activeView !== view) {
      appState.setActiveView(view);
    }
  };
  const openAlbum = (item: PlexAlbum | PlexHubItem): void => {
    openDetail("Album", item);
  };
  const openArtist = (item: PlexArtist | PlexHubItem): void => {
    openDetail("Artist", item);
  };
  const openPlaylist = (item: PlexPlaylist | PlexHubItem): void => {
    openDetail("Playlist", item);
  };
  const closeDetail = () => {
    if (state.selectedAlbum) {
      patch({ forwardAlbum: state.selectedAlbum, selectedAlbum: null });
      if (
        appState.getSnapshot().activeView !== state.selectedAlbum.returnView
      ) {
        appState.setActiveView(state.selectedAlbum.returnView);
      }
    } else if (state.selectedArtist) {
      patch({ forwardArtist: state.selectedArtist, selectedArtist: null });
      if (
        appState.getSnapshot().activeView !== state.selectedArtist.returnView
      ) {
        appState.setActiveView(state.selectedArtist.returnView);
      }
    } else if (state.selectedPlaylist) {
      patch({
        forwardPlaylist: state.selectedPlaylist,
        selectedPlaylist: null,
      });
      if (
        appState.getSnapshot().activeView !== state.selectedPlaylist.returnView
      ) {
        appState.setActiveView(state.selectedPlaylist.returnView);
      }
    }
  };
  const reopenDetail = () => {
    if (state.forwardAlbum) {
      patch({ forwardAlbum: null, selectedAlbum: state.forwardAlbum });
      if (appState.getSnapshot().activeView !== "albums") {
        appState.setActiveView("albums");
      }
    } else if (state.forwardArtist) {
      patch({ forwardArtist: null, selectedArtist: state.forwardArtist });
      if (appState.getSnapshot().activeView !== "artists") {
        appState.setActiveView("artists");
      }
    } else if (state.forwardPlaylist) {
      patch({ forwardPlaylist: null, selectedPlaylist: state.forwardPlaylist });
      if (appState.getSnapshot().activeView !== "playlists") {
        appState.setActiveView("playlists");
      }
    }
  };
  const openCategory = async (hub: PlexHub): Promise<void> => {
    const run = categoryRun.current + 1;
    categoryRun.current = run;
    const server = app.selectedServer;
    patch({ category: { error: null, hub, items: [], status: "loading" } });
    try {
      const isRecentlyPlayed =
        hub.hubIdentifier?.startsWith("music.recent.played.") === true;
      let rawItems = hub.Metadata ?? [];
      if (!isRecentlyPlayed && hub.key !== undefined && hub.key.length > 0) {
        rawItems = await plex.getHomeHubItems(hub.key);
      }
      const [filtered] = filterMusicHomeHubs([{ ...hub, Metadata: rawItems }]);
      if (
        run !== categoryRun.current ||
        appState.getSnapshot().selectedServer !== server
      ) {
        return;
      }
      patch({
        category: {
          error: null,
          hub: filtered ?? { ...hub, Metadata: [] },
          items: filtered?.Metadata ?? [],
          status: "ready",
        },
      });
    } catch (error) {
      if (
        run === categoryRun.current &&
        appState.getSnapshot().selectedServer === server
      ) {
        patch({
          category: {
            error:
              error instanceof Error
                ? error.message
                : "Failed to load category",
            hub,
            items: [],
            status: "error",
          },
        });
      }
    }
  };
  const selectServerRequest = async (server: Server): Promise<void> => {
    try {
      await plex.selectServer(server.clientIdentifier);
      appState.setSelectedServer(server.clientIdentifier);
      onServers(
        [...servers, server].filter(
          (value, index, list) =>
            list.findIndex(
              (item) => item.clientIdentifier === value.clientIdentifier
            ) === index
        )
      );
    } catch (error) {
      console.error("Failed to select server:", error);
    }
  };
  const selectServer = (server: Server): void => {
    if (!server.url || server.clientIdentifier === app.selectedServer) {
      return;
    }
    void selectServerRequest(server);
  };
  return {
    app,
    changeView,
    clearNavigation,
    handleChangeView: changeView,
    handleCloseDetail: closeDetail,
    handleOpenAlbum: openAlbum,
    handleOpenArtist: openArtist,
    handleOpenCategory: openCategory,
    handleOpenPlaylist: openPlaylist,
    handleReopenDetail: reopenDetail,
    handleSelectServer: selectServer,
    home,
    invalidateCategory,
    issueSearch,
    openAlbum,
    openArtist,
    openCategory,
    openPlaylist,
    patch,
    reopenDetail,
    searchTimer,
    selectServer,
    state,
  };
};

const HomeTopbar = ({
  app,
  state,
  controller,
}: {
  app: Controller["app"];
  state: ScreenState;
  controller: Controller;
}) => {
  const onSearch = (query: string) => {
    controller.clearNavigation();
    controller.invalidateCategory();
    appState.setSearchQuery(query);
    appState.setActiveView(query ? "search" : "home");
    controller.patch({
      category: null,
      searchResult: query ? state.searchResult : null,
    });
  };
  return (
    <header className="home-topbar">
      <button
        className="topbar-icon"
        type="button"
        aria-label="Back"
        disabled={
          !state.selectedAlbum &&
          !state.selectedArtist &&
          !state.selectedPlaylist
        }
        onClick={controller.handleCloseDetail}
      >
        <Icon>
          <path d="m15 18-6-6 6-6" />
        </Icon>
      </button>
      <button
        className="topbar-icon"
        type="button"
        aria-label="Forward"
        disabled={
          !state.forwardAlbum && !state.forwardArtist && !state.forwardPlaylist
        }
        onClick={controller.handleReopenDetail}
      >
        <Icon>
          <path d="m9 18 6-6-6-6" />
        </Icon>
      </button>
      <div className="topbar-search">
        <Icon>
          <circle cx="11" cy="11" r="6" />
          <path d="m16 16 4 4" />
        </Icon>
        <input
          id="shell-search-input"
          aria-label="Search songs, albums, artists"
          type="search"
          placeholder="Search songs, albums, artists"
          autoComplete="off"
          spellCheck={false}
          value={app.searchQuery}
          onChange={(event) => {
            onSearch(event.currentTarget.value.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && app.searchQuery) {
              event.preventDefault();
              if (controller.searchTimer.current !== null) {
                window.clearTimeout(controller.searchTimer.current);
              }
              controller.issueSearch(app.searchQuery, app.searchGeneration);
            }
          }}
        />
      </div>
      <div className="topbar-spacer" />
      <button className="topbar-icon" type="button" aria-label="Queue" disabled>
        <Icon>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </Icon>
      </button>
      <button
        className="topbar-icon"
        type="button"
        aria-label="Notifications"
        disabled
      >
        <Icon>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </Icon>
      </button>
    </header>
  );
};

const getLibraryStatusMessage = (
  status: Controller["app"]["musicSectionsStatus"],
  count: number,
  error: string | null
): string => {
  if (status === "loading") {
    return "Loading your Plex music library…";
  }
  if (status === "ready") {
    const noun = count === 1 ? "library" : "libraries";
    return `${count} music ${noun} connected`;
  }
  if (status === "error") {
    return `Music library unavailable: ${error ?? ""}`;
  }
  return "";
};

const HomeContent = ({
  app,
  home,
  state,
  controller,
}: {
  app: Controller["app"];
  home: Controller["home"];
  state: ScreenState;
  controller: Controller;
}) => {
  const copy = shellViewCopy[app.activeView];
  let content: ReactNode;
  if (state.selectedAlbum) {
    content = <AlbumDetail ratingKey={state.selectedAlbum.ratingKey} />;
  } else if (state.selectedArtist) {
    content = (
      <ArtistDetail
        ratingKey={state.selectedArtist.ratingKey}
        onAlbum={controller.handleOpenAlbum}
      />
    );
  } else if (state.selectedPlaylist) {
    content = <PlaylistDetail ratingKey={state.selectedPlaylist.ratingKey} />;
  } else if (app.activeView === "home") {
    if (state.category) {
      content = (
        <HomeCategory
          view={state.category}
          onAlbum={controller.handleOpenAlbum}
          onArtist={controller.handleOpenArtist}
          onPlaylist={controller.handleOpenPlaylist}
          onPlay={playHomeItem}
        />
      );
    } else {
      const handleCategory = (hub: PlexHub): void => {
        void controller.handleOpenCategory(hub);
      };
      content = (
        <HomeDashboard
          state={home}
          onRetry={retryHome}
          onCategory={handleCategory}
          onAlbum={controller.handleOpenAlbum}
          onArtist={controller.handleOpenArtist}
          onPlaylist={controller.handleOpenPlaylist}
          onPlay={playHomeItem}
        />
      );
    }
  } else if (app.activeView === "albums") {
    content = (
      <AlbumLibrary
        sections={app.musicSections}
        sectionsStatus={app.musicSectionsStatus}
        sectionsError={app.musicSectionsError}
        onAlbum={controller.handleOpenAlbum}
        onView={controller.handleChangeView}
      />
    );
  } else if (app.activeView === "artists") {
    content = (
      <ArtistLibrary
        sections={app.musicSections}
        sectionsStatus={app.musicSectionsStatus}
        sectionsError={app.musicSectionsError}
        onArtist={controller.handleOpenArtist}
        onView={controller.handleChangeView}
      />
    );
  } else if (app.activeView === "songs") {
    content = (
      <SongsLibrary
        sections={app.musicSections}
        sectionsStatus={app.musicSectionsStatus}
        sectionsError={app.musicSectionsError}
        onView={controller.handleChangeView}
      />
    );
  } else if (app.activeView === "playlists") {
    content = (
      <PlaylistLibrary
        serverKey={app.selectedServer}
        onPlaylist={controller.handleOpenPlaylist}
        onView={controller.handleChangeView}
      />
    );
  } else if (app.activeView === "search") {
    content = (
      <SearchResults
        query={app.searchQuery}
        result={state.searchResult}
        status={state.searchStatus}
        onAlbum={controller.handleOpenAlbum}
        onArtist={controller.handleOpenArtist}
      />
    );
  } else {
    content = (
      <div className="home-shell-placeholder" id="shell-placeholder">
        <span className="home-shell-eyebrow">{copy.eyebrow}</span>
        <h2>{copy.title}</h2>
        <p>{copy.copy}</p>
        <p
          className="home-shell-status"
          id="shell-library-status"
          aria-live="polite"
        >
          {getLibraryStatusMessage(
            app.musicSectionsStatus,
            app.musicSections.length,
            app.musicSectionsError
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="home-content" id="home-content">
      {content}
    </div>
  );
};

export const HomeScreen = ({
  account,
  servers,
  onServers,
  onAddServer,
}: HomeScreenProps) => {
  const controller = useHomeController(servers, onServers);
  const { app, home, state } = controller;
  return (
    <div className="app-shell" id="home-shell">
      <Sidebar
        account={account}
        servers={servers}
        selectedServer={app.selectedServer}
        activeView={app.activeView}
        onView={controller.handleChangeView}
        onSelectServer={controller.handleSelectServer}
        onAddServer={onAddServer}
        onServers={onServers}
      />
      <main className="home-main">
        <HomeTopbar app={app} state={state} controller={controller} />
        <HomeContent
          app={app}
          home={home}
          state={state}
          controller={controller}
        />
      </main>
      <PlayerBar />
    </div>
  );
};
