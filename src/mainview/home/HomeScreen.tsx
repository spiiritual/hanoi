import { useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { plex } from "../plex.ts";
import type { ShellView } from "../app-state.ts";
import { appState, homeState, playerState } from "../view-state.ts";
import { filterMusicHomeHubs } from "./utils.ts";
import { HomeCategory, HomeDashboard, type HomeCategoryView } from "./HomeContent.tsx";
import { AlbumDetail, AlbumLibrary } from "../album/AlbumScreen.tsx";
import { ArtistDetail, ArtistLibrary } from "../artist/ArtistScreen.tsx";
import { PlaylistDetail } from "../playlist/PlaylistScreen.tsx";
import { SongsLibrary } from "../songs/SongsScreen.tsx";
import { Icon } from "../components/Icon.tsx";
import { PlayerBar } from "../player/PlayerBar.tsx";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import type {
  PlexAlbum,
  PlexArtist,
  PlexHub,
  PlexHubItem,
  PlexPlaylist,
} from "../../bun/plex/types.ts";
import type { Account, Server } from "../types.ts";

const shellViewCopy: Record<ShellView, { eyebrow: string; title: string; copy: string }> = {
  home: {
    eyebrow: "HANOI",
    title: "Home is ready.",
    copy: "The music surface will land here next.",
  },
  albums: {
    eyebrow: "YOUR LIBRARY",
    title: "Albums are next.",
    copy: "Album browsing will be connected in the next app slice.",
  },
  artists: {
    eyebrow: "YOUR LIBRARY",
    title: "Artists are next.",
    copy: "Artist browsing will be connected in the next app slice.",
  },
  songs: {
    eyebrow: "YOUR LIBRARY",
    title: "Songs are next.",
    copy: "Song browsing will be connected in the next app slice.",
  },
  playlists: {
    eyebrow: "YOUR LIBRARY",
    title: "Playlists are next.",
    copy: "Playlist browsing will be connected in the next app slice.",
  },
  search: {
    eyebrow: "SEARCH",
    title: "Search your library.",
    copy: "Type a song, album, or artist above to search Plex.",
  },
};

type SearchResult = Awaited<ReturnType<typeof plex.search>>;
type SearchResultItem = { title: string; meta: string; onClick?: () => void };
function playHomeItem(item: PlexHubItem) {
  if (item.type === "track") void playerState.playTrack(item);
}

function SearchResults({
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
}) {
  if (status)
    return (
      <div className="shell-search-results" id="shell-search-results">
        <p className="shell-search-status">{status}</p>
      </div>
    );
  if (!result) return null;
  const groups: Array<{ label: string; items: SearchResultItem[] }> = [
    {
      label: "Songs",
      items: result.tracks
        .slice(0, 6)
        .map((item) => ({
          title: item.title,
          meta: item.grandparentTitle ?? item.parentTitle ?? "Song",
          onClick: () => void playerState.playTrack(item),
        })),
    },
    {
      label: "Albums",
      items: result.albums
        .slice(0, 6)
        .map((item) => ({
          title: item.title,
          meta: [item.parentTitle, item.year ? String(item.year) : "Album"]
            .filter(Boolean)
            .join(" · "),
          onClick: () => onAlbum(item),
        })),
    },
    {
      label: "Artists",
      items: result.artists
        .slice(0, 6)
        .map((item) => ({ title: item.title, meta: "Artist", onClick: () => onArtist(item) })),
    },
  ];
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const visibleGroups = groups.reduce<typeof groups>((visible, group) => {
    if (group.items.length) visible.push(group);
    return visible;
  }, []);
  return (
    <div className="shell-search-results" id="shell-search-results">
      <p className="shell-search-status">
        {total === 0
          ? `No results for “${query}”.`
          : `${total} result${total === 1 ? "" : "s"} for “${query}”`}
      </p>
      {visibleGroups.map((group) => (
        <section className="shell-search-group" key={group.label}>
          <h3>{group.label}</h3>
          <div className="shell-search-items">
            {group.items.map((item) => (
              <button
                className="shell-search-item"
                type="button"
                onClick={item.onClick}
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
}

export type HomeScreenProps = {
  account: Account | null;
  servers: Server[];
  onServers: (servers: Server[]) => void;
  onAddServer: () => void;
};
type AlbumNavigation = { ratingKey: string; returnView: ShellView };
type ScreenState = {
  category: HomeCategoryView | null;
  searchResult: SearchResult | null;
  searchStatus: string | null;
  selectedAlbum: AlbumNavigation | null;
  forwardAlbum: AlbumNavigation | null;
  selectedArtist: AlbumNavigation | null;
  forwardArtist: AlbumNavigation | null;
  selectedPlaylist: AlbumNavigation | null;
  forwardPlaylist: AlbumNavigation | null;
};
type ScreenAction = { type: "patch"; value: Partial<ScreenState> };
const initialScreenState: ScreenState = {
  category: null,
  searchResult: null,
  searchStatus: null,
  selectedAlbum: null,
  forwardAlbum: null,
  selectedArtist: null,
  forwardArtist: null,
  selectedPlaylist: null,
  forwardPlaylist: null,
};
function screenReducer(state: ScreenState, action: ScreenAction): ScreenState {
  return action.type === "patch" ? { ...state, ...action.value } : state;
}

type Controller = ReturnType<typeof useHomeController>;
function useHomeController(servers: Server[], onServers: (servers: Server[]) => void) {
  const app = useSyncExternalStore(appState.subscribe, appState.getSnapshot, appState.getSnapshot);
  const home = useSyncExternalStore(
    homeState.subscribe,
    homeState.getSnapshot,
    homeState.getSnapshot,
  );
  const [state, dispatch] = useReducer(screenReducer, initialScreenState);
  const searchRun = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const categoryRun = useRef(0);
  const patch = (value: Partial<ScreenState>) => dispatch({ type: "patch", value });
  const clearNavigation = () =>
    patch({
      selectedAlbum: null,
      forwardAlbum: null,
      selectedArtist: null,
      forwardArtist: null,
      selectedPlaylist: null,
      forwardPlaylist: null,
    });
  const issueSearch = (query: string, generation: number) => {
    const run = ++searchRun.current;
    patch({ searchStatus: `Searching for “${query}”…` });
    void plex
      .search(query)
      .then((result) => {
        const current = appState.getSnapshot();
        if (
          run === searchRun.current &&
          current.searchGeneration === generation &&
          current.activeView === "search" &&
          current.searchQuery === query
        )
          patch({ searchResult: result, searchStatus: null });
      })
      .catch((error: unknown) => {
        const current = appState.getSnapshot();
        if (
          run === searchRun.current &&
          current.searchGeneration === generation &&
          current.activeView === "search" &&
          current.searchQuery === query
        )
          patch({ searchStatus: `Search failed: ${(error as Error).message}` });
      });
  };
  useEffect(() => {
    homeState.setServer(app.selectedServer);
    categoryRun.current += 1;
    clearNavigation();
    patch({ category: null, searchResult: null });
    searchRun.current += 1;
  }, [app.selectedServer]);
  useEffect(() => {
    if (app.selectedServer) {
      void appState.loadMusicSections().catch(() => undefined);
      void homeState.loadHomeHubs().catch(() => undefined);
    }
  }, [app.selectedServer]);
  useEffect(() => {
    const query = app.searchQuery;
    const generation = app.searchGeneration;
    searchRun.current += 1;
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    if (!query) {
      patch({ searchResult: null, searchStatus: null });
      return;
    }
    patch({ searchStatus: `Searching for “${query}”…` });
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      issueSearch(query, generation);
    }, 260);
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, [app.searchQuery, app.searchGeneration]);
  const invalidateCategory = () => {
    categoryRun.current += 1;
  };
  const changeView = (view: ShellView) => {
    clearNavigation();
    if (view !== "home") {
      invalidateCategory();
      patch({ category: null });
    }
    if (view !== "search") appState.setSearchQuery("");
    appState.setActiveView(view);
  };
  const openDetail = (
    kind: "Album" | "Artist" | "Playlist",
    item: PlexAlbum | PlexArtist | PlexPlaylist | PlexHubItem,
  ) => {
    if (!item.ratingKey) return;
    const navigation = { ratingKey: item.ratingKey, returnView: app.activeView };
    clearNavigation();
    patch({ [`selected${kind}`]: navigation } as Partial<ScreenState>);
    const view = kind === "Playlist" ? "playlists" : `${kind.toLowerCase()}s`;
    if (app.activeView !== view) appState.setActiveView(view as ShellView);
  };
  const openAlbum = (item: PlexAlbum | PlexHubItem) => openDetail("Album", item);
  const openArtist = (item: PlexArtist | PlexHubItem) => openDetail("Artist", item);
  const openPlaylist = (item: PlexPlaylist | PlexHubItem) => openDetail("Playlist", item);
  const closeDetail = () => {
    if (state.selectedAlbum) {
      patch({ forwardAlbum: state.selectedAlbum, selectedAlbum: null });
      if (appState.getSnapshot().activeView !== state.selectedAlbum.returnView)
        appState.setActiveView(state.selectedAlbum.returnView);
    } else if (state.selectedArtist) {
      patch({ forwardArtist: state.selectedArtist, selectedArtist: null });
      if (appState.getSnapshot().activeView !== state.selectedArtist.returnView)
        appState.setActiveView(state.selectedArtist.returnView);
    } else if (state.selectedPlaylist) {
      patch({ forwardPlaylist: state.selectedPlaylist, selectedPlaylist: null });
      if (appState.getSnapshot().activeView !== state.selectedPlaylist.returnView)
        appState.setActiveView(state.selectedPlaylist.returnView);
    }
  };
  const reopenDetail = () => {
    if (state.forwardAlbum) {
      patch({ selectedAlbum: state.forwardAlbum, forwardAlbum: null });
      if (appState.getSnapshot().activeView !== "albums") appState.setActiveView("albums");
    } else if (state.forwardArtist) {
      patch({ selectedArtist: state.forwardArtist, forwardArtist: null });
      if (appState.getSnapshot().activeView !== "artists") appState.setActiveView("artists");
    } else if (state.forwardPlaylist) {
      patch({ selectedPlaylist: state.forwardPlaylist, forwardPlaylist: null });
      if (appState.getSnapshot().activeView !== "playlists") appState.setActiveView("playlists");
    }
  };
  const openCategory = async (hub: PlexHub) => {
    const run = ++categoryRun.current;
    const server = app.selectedServer;
    patch({ category: { hub, items: [], status: "loading", error: null } });
    try {
      const rawItems = hub.hubIdentifier?.startsWith("music.recent.played.")
        ? (hub.Metadata ?? [])
        : hub.key
          ? await plex.getHomeHubItems(hub.key)
          : (hub.Metadata ?? []);
      const [filtered] = filterMusicHomeHubs([{ ...hub, Metadata: rawItems }]);
      if (run !== categoryRun.current || appState.getSnapshot().selectedServer !== server) return;
      patch({
        category: {
          hub: filtered ?? { ...hub, Metadata: [] },
          items: filtered?.Metadata ?? [],
          status: "ready",
          error: null,
        },
      });
    } catch (error) {
      if (run === categoryRun.current && appState.getSnapshot().selectedServer === server)
        patch({
          category: {
            hub,
            items: [],
            status: "error",
            error: error instanceof Error ? error.message : "Failed to load category",
          },
        });
    }
  };
  const selectServer = async (server: Server) => {
    if (!server.url || server.clientIdentifier === app.selectedServer) return;
    try {
      await plex.selectServer(server.clientIdentifier);
      appState.setSelectedServer(server.clientIdentifier);
      onServers(
        [...servers, server].filter(
          (value, index, list) =>
            list.findIndex((item) => item.clientIdentifier === value.clientIdentifier) === index,
        ),
      );
    } catch (error) {
      console.error("Failed to select server:", error);
    }
  };
  return {
    app,
    home,
    state,
    patch,
    clearNavigation,
    invalidateCategory,
    issueSearch,
    searchTimer,
    changeView,
    openAlbum,
    openArtist,
    openPlaylist,
    closeDetail,
    reopenDetail,
    openCategory,
    selectServer,
  };
}

function HomeTopbar({
  app,
  state,
  controller,
}: {
  app: Controller["app"];
  state: ScreenState;
  controller: Controller;
}) {
  const onSearch = (query: string) => {
    controller.clearNavigation();
    controller.invalidateCategory();
    appState.setSearchQuery(query);
    appState.setActiveView(query ? "search" : "home");
    controller.patch({ category: null, searchResult: query ? state.searchResult : null });
  };
  return (
    <header className="home-topbar">
      <button
        className="topbar-icon"
        type="button"
        aria-label="Back"
        disabled={!state.selectedAlbum && !state.selectedArtist && !state.selectedPlaylist}
        onClick={controller.closeDetail}
      >
        <Icon>
          <path d="m15 18-6-6 6-6" />
        </Icon>
      </button>
      <button
        className="topbar-icon"
        type="button"
        aria-label="Forward"
        disabled={!state.forwardAlbum && !state.forwardArtist && !state.forwardPlaylist}
        onClick={controller.reopenDetail}
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
          onChange={(event) => onSearch(event.currentTarget.value.trim())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && app.searchQuery) {
              event.preventDefault();
              if (controller.searchTimer.current !== null)
                window.clearTimeout(controller.searchTimer.current);
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
      <button className="topbar-icon" type="button" aria-label="Notifications" disabled>
        <Icon>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </Icon>
      </button>
    </header>
  );
}

function HomeContent({
  app,
  home,
  state,
  controller,
}: {
  app: Controller["app"];
  home: Controller["home"];
  state: ScreenState;
  controller: Controller;
}) {
  const copy = shellViewCopy[app.activeView];
  return (
    <div className="home-content" id="home-content">
      {state.selectedAlbum ? (
        <AlbumDetail ratingKey={state.selectedAlbum.ratingKey} />
      ) : state.selectedArtist ? (
        <ArtistDetail ratingKey={state.selectedArtist.ratingKey} onAlbum={controller.openAlbum} />
      ) : state.selectedPlaylist ? (
        <PlaylistDetail ratingKey={state.selectedPlaylist.ratingKey} />
      ) : app.activeView === "home" ? (
        state.category ? (
          <HomeCategory
            view={state.category}
            onAlbum={controller.openAlbum}
            onArtist={controller.openArtist}
            onPlaylist={controller.openPlaylist}
            onPlay={playHomeItem}
          />
        ) : (
          <HomeDashboard
            state={home}
            onRetry={() => void homeState.loadHomeHubs().catch(() => undefined)}
            onCategory={(hub) => void controller.openCategory(hub)}
            onAlbum={controller.openAlbum}
            onArtist={controller.openArtist}
            onPlaylist={controller.openPlaylist}
            onPlay={playHomeItem}
          />
        )
      ) : app.activeView === "albums" ? (
        <AlbumLibrary
          sections={app.musicSections}
          sectionsStatus={app.musicSectionsStatus}
          sectionsError={app.musicSectionsError}
          onAlbum={controller.openAlbum}
          onView={controller.changeView}
        />
      ) : app.activeView === "artists" ? (
        <ArtistLibrary
          sections={app.musicSections}
          sectionsStatus={app.musicSectionsStatus}
          sectionsError={app.musicSectionsError}
          onArtist={controller.openArtist}
          onView={controller.changeView}
        />
      ) : app.activeView === "songs" ? (
        <SongsLibrary
          sections={app.musicSections}
          sectionsStatus={app.musicSectionsStatus}
          sectionsError={app.musicSectionsError}
          onView={controller.changeView}
        />
      ) : app.activeView === "search" ? (
        <SearchResults
          query={app.searchQuery}
          result={state.searchResult}
          status={state.searchStatus}
          onAlbum={controller.openAlbum}
          onArtist={controller.openArtist}
        />
      ) : (
        <div className="home-shell-placeholder" id="shell-placeholder">
          <span className="home-shell-eyebrow">{copy.eyebrow}</span>
          <h2>{copy.title}</h2>
          <p>{copy.copy}</p>
          <p className="home-shell-status" id="shell-library-status" aria-live="polite">
            {app.musicSectionsStatus === "loading"
              ? "Loading your Plex music library…"
              : app.musicSectionsStatus === "ready"
                ? `${app.musicSections.length} music librar${app.musicSections.length === 1 ? "y" : "ies"} connected`
                : app.musicSectionsStatus === "error"
                  ? `Music library unavailable: ${app.musicSectionsError ?? ""}`
                  : ""}
          </p>
        </div>
      )}
    </div>
  );
}

export function HomeScreen({ account, servers, onServers, onAddServer }: HomeScreenProps) {
  const controller = useHomeController(servers, onServers);
  const { app, home, state } = controller;
  return (
    <div className="app-shell" id="home-shell">
      <Sidebar
        account={account}
        servers={servers}
        selectedServer={app.selectedServer}
        activeView={app.activeView}
        onView={controller.changeView}
        onSelectServer={controller.selectServer}
        onAddServer={onAddServer}
        onServers={onServers}
      />
      <main className="home-main">
        <HomeTopbar app={app} state={state} controller={controller} />
        <HomeContent app={app} home={home} state={state} controller={controller} />
      </main>
      <PlayerBar />
    </div>
  );
}
