import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { ShellView } from "../app-state.ts";
import { Icon } from "../components/icon.tsx";
import { ServerIcon } from "../components/server-icon.tsx";
import { plex } from "../plex.ts";
import type { Account, Server } from "../types.ts";
import { initials } from "../utils.ts";
import { serverStatusClass, serverStatusLabel } from "./utils.ts";

const libraryItems = [
  ["albums", "Albums"],
  ["artists", "Artists"],
  ["songs", "Songs"],
  ["playlists", "Playlists"],
] as const;
type LibraryView = (typeof libraryItems)[number][0];

const libraryIcons = {
  albums: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  artists: (
    <>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2" />
      <path d="M3 20a6 6 0 0 1 12 0M15 19a4 4 0 0 1 6 0" />
    </>
  ),
  playlists: <path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01" />,
  songs: (
    <>
      <path d="M9 18V5l10-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
    </>
  ),
} satisfies Record<LibraryView, ReactNode>;

const refreshServers = async ({
  selectedServer,
  onServers,
  setServerStatus,
  setMenuError,
}: {
  selectedServer: string | null;
  onServers: (servers: Server[]) => void;
  setServerStatus: (status: boolean | undefined) => void;
  setMenuError: (error: string | null) => void;
}): Promise<void> => {
  try {
    const found = await plex.getServers();
    onServers(found);
    setServerStatus(
      found.find((server) => server.clientIdentifier === selectedServer)?.online
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setMenuError(`Couldn't load servers: ${message}`);
  }
};

export const Sidebar = ({
  account,
  servers,
  selectedServer,
  activeView,
  onView,
  onSelectServer,
  onAddServer,
  onServers,
}: {
  account: Account | null;
  servers: Server[];
  selectedServer: string | null;
  activeView: ShellView;
  onView: (view: ShellView) => void;
  onSelectServer: (server: Server) => void;
  onAddServer: () => void;
  onServers: (servers: Server[]) => void;
}): ReactNode => {
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [serverOpen, setServerOpen] = useState(false);
  const [serverStatus, setServerStatus] = useState<boolean | undefined>();
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const selected = servers.find(
    (server) => server.clientIdentifier === selectedServer
  );
  const loadServers = async (): Promise<void> => {
    setServerOpen(true);
    setMenuLoading(true);
    setMenuError(null);
    try {
      await refreshServers({
        onServers,
        selectedServer,
        setMenuError,
        setServerStatus,
      });
    } catch (error: unknown) {
      setMenuLoading(false);
      throw error;
    }
    setMenuLoading(false);
  };
  useEffect(() => {
    void refreshServers({
      onServers,
      selectedServer,
      setMenuError,
      setServerStatus,
    });
  }, [onServers, selectedServer]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      const { target } = event;
      if (
        target instanceof Element &&
        target.closest(".sidebar-server-wrap") === null
      ) {
        setServerOpen(false);
      }
    };
    document.addEventListener("click", close);
    return () => {
      document.removeEventListener("click", close);
    };
  }, []);
  const name = account?.username ?? "Plex account";
  let serverMenuContent: ReactNode;
  if (menuLoading) {
    serverMenuContent = (
      <div className="sidebar-server-option-status">Loading servers…</div>
    );
  } else if (menuError !== null) {
    serverMenuContent = (
      <div className="sidebar-server-option-status">{menuError}</div>
    );
  } else if (servers.length === 0) {
    serverMenuContent = (
      <div className="sidebar-server-option-status">No servers found</div>
    );
  } else {
    serverMenuContent = servers.map((server) => (
      <button
        className="sidebar-server-option"
        type="button"
        key={server.clientIdentifier}
        onClick={() => {
          onSelectServer(server);
          setServerOpen(false);
        }}
      >
        <span className="sidebar-server-option-copy">
          <span className="sidebar-server-option-name">{server.name}</span>
          <span
            className={`sidebar-server-option-status ${serverStatusClass(server.online)}`}
          >
            {serverStatusLabel(server.online)}
          </span>
        </span>
        {server.clientIdentifier === selectedServer && (
          <span className="sidebar-server-option-check">✓</span>
        )}
      </button>
    ));
  }
  return (
    <aside className="app-sidebar" aria-label="Main navigation">
      <nav className="sidebar-nav">
        <button
          className={`sidebar-nav-item${activeView === "home" ? " is-active" : ""}`}
          type="button"
          id="sidebar-home"
          data-shell-view="home"
          aria-current={activeView === "home" ? "page" : undefined}
          onClick={() => {
            onView("home");
          }}
        >
          <Icon className="sidebar-icon">
            <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
          </Icon>
          <span>Home</span>
        </button>
        <div className="sidebar-library">
          <button
            className="sidebar-nav-item sidebar-library-toggle"
            type="button"
            id="sidebar-library-toggle"
            aria-expanded={libraryOpen}
            onClick={() => {
              setLibraryOpen(!libraryOpen);
            }}
          >
            <Icon className="sidebar-icon is-accent">
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <path d="M8 7h8M8 11h8M8 15h5" />
            </Icon>
            <span>Your Library</span>
          </button>
          <div className="sidebar-library-items" hidden={!libraryOpen}>
            {libraryItems.map(([view, label]) => (
              <button
                className={`sidebar-subnav-item${activeView === view ? " is-active" : ""}`}
                type="button"
                key={view}
                data-shell-view={view}
                onClick={() => {
                  onView(view);
                }}
              >
                <Icon className="sidebar-subnav-icon">
                  {libraryIcons[view]}
                </Icon>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-server-wrap">
        <button
          className={`sidebar-server-selector${serverOpen ? " is-open" : ""}`}
          type="button"
          id="sidebar-server-selector"
          aria-expanded={serverOpen}
          aria-controls="sidebar-server-menu"
          onClick={() => {
            if (serverOpen) {
              setServerOpen(false);
            } else {
              void loadServers();
            }
          }}
        >
          <span className="sidebar-server-icon">
            <ServerIcon />
          </span>
          <span className="sidebar-server-copy">
            <span className="sidebar-server-name">
              {selected?.name ?? "your server"}
            </span>
            <span
              className={`sidebar-server-status ${serverStatusClass(serverStatus)}`}
            >
              {serverStatusLabel(serverStatus)}
            </span>
          </span>
          <Icon className="sidebar-chevron">
            <path d={serverOpen ? "m6 9 6 6 6-6" : "m6 15 6-6 6 6"} />
          </Icon>
        </button>
        <div
          className="sidebar-server-menu"
          id="sidebar-server-menu"
          hidden={!serverOpen}
        >
          <div className="sidebar-server-menu-title">Your servers</div>
          <div className="sidebar-server-options" id="sidebar-server-options">
            {serverMenuContent}
          </div>
          <button
            className="sidebar-add-server"
            type="button"
            id="sidebar-add-server"
            onClick={onAddServer}
          >
            Add a server…
          </button>
        </div>
      </div>
      <div className="sidebar-user">
        <div className="sidebar-avatar" aria-hidden="true">
          {initials(name)}
        </div>
        <span className="sidebar-user-name">{name}</span>
        <span className="sidebar-user-spacer" />
        <button
          className="sidebar-settings"
          type="button"
          aria-label="Settings"
        >
          <Icon>
            <circle cx="12" cy="12" r="3.5" />
            <path d="m19.4 15 .1.1a2 2 0 1 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4v.3a2 2 0 1 1-4 0v-.2a2 2 0 0 0-3.4-1.5l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 3.6 11H3.3a2 2 0 1 1 0-4h.2A2 2 0 0 0 5 3.6" />
          </Icon>
        </button>
      </div>
    </aside>
  );
};
