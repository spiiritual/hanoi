import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
type SearchResultItem = {
  title: string;
  meta: string;
  onClick?: () => void;
};

function playHomeItem(item: PlexHubItem) {
  if (item.type !== "track") return;
  void playerState.playTrack(item);
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
      items: result.tracks.slice(0, 6).map((item) => ({
        title: item.title,
        meta: item.grandparentTitle ?? item.parentTitle ?? "Song",
        onClick: () => void playerState.playTrack(item),
      })),
    },
    {
      label: "Albums",
      items: result.albums.slice(0, 6).map((item) => ({
        title: item.title,
        meta: [item.parentTitle, item.year ? String(item.year) : "Album"]
          .filter(Boolean)
          .join(" · "),
        onClick: () => onAlbum(item),
      })),
    },
    {
      label: "Artists",
      items: result.artists.slice(0, 6).map((item) => ({
        title: item.title,
        meta: "Artist",
        onClick: () => onArtist(item),
      })),
    },
  ];
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <div className="shell-search-results" id="shell-search-results">
      <p className="shell-search-status">
        {total === 0
          ? `No results for “${query}”.`
          : `${total} result${total === 1 ? "" : "s"} for “${query}”`}
      </p>
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
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

export function HomeScreen({ account, servers, onServers, onAddServer }: HomeScreenProps) {
  const app = useSyncExternalStore(appState.subscribe, appState.getSnapshot, appState.getSnapshot);
  const home = useSyncExternalStore(
    homeState.subscribe,
    homeState.getSnapshot,
    homeState.getSnapshot,
  );
  const [category, setCategory] = useState<HomeCategoryView | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const searchRun = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const categoryRun = useRef(0);
  type AlbumNavigation = {
    ratingKey: string;
    returnView: ShellView;
  };
  const [selectedAlbum, setSelectedAlbum] = useState<AlbumNavigation | null>(null);
  const [forwardAlbum, setForwardAlbum] = useState<AlbumNavigation | null>(null);
  const [selectedArtist, setSelectedArtist] = useState<AlbumNavigation | null>(null);
  const [forwardArtist, setForwardArtist] = useState<AlbumNavigation | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<AlbumNavigation | null>(null);
  const [forwardPlaylist, setForwardPlaylist] = useState<AlbumNavigation | null>(null);

  const issueSearch = (query: string, generation: number) => {
    const run = ++searchRun.current;
    setSearchStatus(`Searching for “${query}”…`);
    void plex
      .search(query)
      .then((result) => {
        const state = appState.getSnapshot();
        if (
          run === searchRun.current &&
          state.searchGeneration === generation &&
          state.activeView === "search" &&
          state.searchQuery === query
        ) {
          setSearchResult(result);
          setSearchStatus(null);
        }
      })
      .catch((error: unknown) => {
        const state = appState.getSnapshot();
        if (
          run === searchRun.current &&
          state.searchGeneration === generation &&
          state.activeView === "search" &&
          state.searchQuery === query
        )
          setSearchStatus(`Search failed: ${(error as Error).message}`);
      });
  };

  useEffect(() => {
    homeState.setServer(app.selectedServer);
    categoryRun.current += 1;
    setCategory(null);
    setSelectedAlbum(null);
    setForwardAlbum(null);
    setSelectedArtist(null);
    setForwardArtist(null);
    setSelectedPlaylist(null);
    setForwardPlaylist(null);
    searchRun.current += 1;
    setSearchResult(null);
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
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    if (!query) {
      setSearchResult(null);
      setSearchStatus(null);
      return;
    }
    setSearchStatus(`Searching for “${query}”…`);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      issueSearch(query, generation);
    }, 260);
    return () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
    };
  }, [app.searchQuery, app.searchGeneration]);

  const changeView = (view: ShellView) => {
    setSelectedAlbum(null);
    setForwardAlbum(null);
    setSelectedArtist(null);
    setForwardArtist(null);
    setSelectedPlaylist(null);
    setForwardPlaylist(null);
    if (view !== "home") {
      categoryRun.current += 1;
      setCategory(null);
    }
    if (view !== "search") appState.setSearchQuery("");
    appState.setActiveView(view);
  };

  const openAlbum = (item: PlexAlbum | PlexHubItem) => {
    if (!item.ratingKey) return;
    const returnView = app.activeView;
    setSelectedArtist(null);
    setForwardArtist(null);
    setSelectedPlaylist(null);
    setForwardPlaylist(null);
    setForwardAlbum(null);
    setSelectedAlbum({ ratingKey: item.ratingKey, returnView });
    if (returnView !== "albums") appState.setActiveView("albums");
  };

  const openPlaylist = (playlist: PlexPlaylist | PlexHubItem) => {
    if (!playlist.ratingKey) return;
    const returnView = app.activeView;
    setSelectedAlbum(null);
    setForwardAlbum(null);
    setSelectedArtist(null);
    setForwardArtist(null);
    setForwardPlaylist(null);
    setSelectedPlaylist({ ratingKey: playlist.ratingKey, returnView });
    if (returnView !== "playlists") appState.setActiveView("playlists");
  };

  const openArtist = (item: PlexArtist | PlexHubItem) => {
    if (!item.ratingKey) return;
    const returnView = app.activeView;
    setSelectedAlbum(null);
    setForwardAlbum(null);
    setSelectedPlaylist(null);
    setForwardPlaylist(null);
    setForwardArtist(null);
    setSelectedArtist({ ratingKey: item.ratingKey, returnView });
    if (returnView !== "artists") appState.setActiveView("artists");
  };

  const closeAlbum = () => {
    if (selectedAlbum) {
      setForwardAlbum(selectedAlbum);
      setSelectedAlbum(null);
      if (appState.getSnapshot().activeView !== selectedAlbum.returnView) {
        appState.setActiveView(selectedAlbum.returnView);
      }
      return;
    }
    if (selectedArtist) {
      setForwardArtist(selectedArtist);
      setSelectedArtist(null);
      if (appState.getSnapshot().activeView !== selectedArtist.returnView) {
        appState.setActiveView(selectedArtist.returnView);
      }
      return;
    }
    if (selectedPlaylist) {
      setForwardPlaylist(selectedPlaylist);
      setSelectedPlaylist(null);
      if (appState.getSnapshot().activeView !== selectedPlaylist.returnView) {
        appState.setActiveView(selectedPlaylist.returnView);
      }
    }
  };

  const reopenAlbum = () => {
    if (forwardAlbum) {
      setSelectedAlbum(forwardAlbum);
      setForwardAlbum(null);
      if (appState.getSnapshot().activeView !== "albums") {
        appState.setActiveView("albums");
      }
      return;
    }
    if (forwardArtist) {
      setSelectedArtist(forwardArtist);
      setForwardArtist(null);
      if (appState.getSnapshot().activeView !== "artists") {
        appState.setActiveView("artists");
      }
      return;
    }
    if (forwardPlaylist) {
      setSelectedPlaylist(forwardPlaylist);
      setForwardPlaylist(null);
      if (appState.getSnapshot().activeView !== "playlists") {
        appState.setActiveView("playlists");
      }
    }
  };

  const openCategory = async (hub: PlexHub) => {
    const run = ++categoryRun.current;
    const server = app.selectedServer;
    setCategory({ hub, items: [], status: "loading", error: null });
    try {
      const rawItems = hub.hubIdentifier?.startsWith("music.recent.played.")
        ? (hub.Metadata ?? [])
        : hub.key
          ? await plex.getHomeHubItems(hub.key)
          : (hub.Metadata ?? []);
      const [filtered] = filterMusicHomeHubs([{ ...hub, Metadata: rawItems }]);
      if (run !== categoryRun.current || appState.getSnapshot().selectedServer !== server) return;
      setCategory({
        hub: filtered ?? { ...hub, Metadata: [] },
        items: filtered?.Metadata ?? [],
        status: "ready",
        error: null,
      });
    } catch (error) {
      if (run === categoryRun.current && appState.getSnapshot().selectedServer === server)
        setCategory({
          hub,
          items: [],
          status: "error",
          error: error instanceof Error ? error.message : "Failed to load category",
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

  const copy = shellViewCopy[app.activeView];
  return (
    <div className="app-shell" id="home-shell">
      <Sidebar
        account={account}
        servers={servers}
        selectedServer={app.selectedServer}
        activeView={app.activeView}
        onView={changeView}
        onSelectServer={selectServer}
        onAddServer={onAddServer}
        onServers={onServers}
      />
      <main className="home-main">
        <header className="home-topbar">
          <button
            className="topbar-icon"
            type="button"
            aria-label="Back"
            disabled={!selectedAlbum && !selectedArtist && !selectedPlaylist}
            onClick={closeAlbum}
          >
            <Icon>
              <path d="m15 18-6-6 6-6" />
            </Icon>
          </button>
          <button
            className="topbar-icon"
            type="button"
            aria-label="Forward"
            disabled={!forwardAlbum && !forwardArtist && !forwardPlaylist}
            onClick={reopenAlbum}
          >
            <Icon>
              <path d="m9 18 6-6-6-6" />
            </Icon>
          </button>
          <label className="topbar-search" htmlFor="shell-search-input">
            <Icon>
              <circle cx="11" cy="11" r="6" />
              <path d="m16 16 4 4" />
            </Icon>
            <input
              id="shell-search-input"
              type="search"
              placeholder="Search songs, albums, artists"
              autoComplete="off"
              spellCheck={false}
              value={app.searchQuery}
              onChange={(event) => {
                const query = event.currentTarget.value.trim();
                setSelectedAlbum(null);
                setForwardAlbum(null);
                setSelectedArtist(null);
                setForwardArtist(null);
                setSelectedPlaylist(null);
                setForwardPlaylist(null);
                appState.setSearchQuery(query);
                appState.setActiveView(query ? "search" : "home");
                categoryRun.current += 1;
                setCategory(null);
                if (!query) setSearchResult(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && app.searchQuery) {
                  event.preventDefault();
                  if (searchTimer.current !== null) {
                    window.clearTimeout(searchTimer.current);
                    searchTimer.current = null;
                  }
                  issueSearch(app.searchQuery, app.searchGeneration);
                }
              }}
            />
          </label>
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
        <div className="home-content" id="home-content">
          {selectedAlbum ? (
            <AlbumDetail ratingKey={selectedAlbum.ratingKey} />
          ) : selectedArtist ? (
            <ArtistDetail ratingKey={selectedArtist.ratingKey} onAlbum={openAlbum} />
          ) : selectedPlaylist ? (
            <PlaylistDetail ratingKey={selectedPlaylist.ratingKey} />
          ) : app.activeView === "home" ? (
            category ? (
              <HomeCategory
                view={category}
                onAlbum={openAlbum}
                onArtist={openArtist}
                onPlaylist={openPlaylist}
                onPlay={playHomeItem}
              />
            ) : (
              <HomeDashboard
                state={home}
                onRetry={() => void homeState.loadHomeHubs().catch(() => undefined)}
                onCategory={(hub) => void openCategory(hub)}
                onAlbum={openAlbum}
                onArtist={openArtist}
                onPlaylist={openPlaylist}
                onPlay={playHomeItem}
              />
            )
          ) : app.activeView === "albums" ? (
            <AlbumLibrary
              sections={app.musicSections}
              sectionsStatus={app.musicSectionsStatus}
              sectionsError={app.musicSectionsError}
              onAlbum={openAlbum}
              onView={changeView}
            />
          ) : app.activeView === "artists" ? (
            <ArtistLibrary
              sections={app.musicSections}
              sectionsStatus={app.musicSectionsStatus}
              sectionsError={app.musicSectionsError}
              onArtist={openArtist}
              onView={changeView}
            />
          ) : app.activeView === "songs" ? (
            <SongsLibrary
              sections={app.musicSections}
              sectionsStatus={app.musicSectionsStatus}
              sectionsError={app.musicSectionsError}
              onView={changeView}
            />
          ) : app.activeView === "search" ? (
            <SearchResults
              query={app.searchQuery}
              result={searchResult}
              status={searchStatus}
              onAlbum={openAlbum}
              onArtist={openArtist}
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
      </main>
      <PlayerBar />
    </div>
  );
}
