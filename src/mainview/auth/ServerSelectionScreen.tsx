import { Icon } from "../components/Icon.tsx";
import { ServerIcon } from "../components/ServerIcon.tsx";
import type { Account, Server } from "../types.ts";
import { AuthLayout, AuthSpacer } from "./AuthLayout.tsx";

export function ServerSelectionScreen({
  account,
  servers,
  loading,
  starting,
  error,
  selected,
  onSelect,
  onStart,
  onAgain,
}: {
  account: Account | null;
  servers: Server[];
  loading: boolean;
  starting: boolean;
  error: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onStart: () => void;
  onAgain: () => void;
}) {
  return (
    <AuthLayout>
      <h2 className="title">Choose your server</h2>
      <AuthSpacer height={8} />
      <p className="subtitle">Select the Plex server that hosts your music library.</p>
      <AuthSpacer height={36} />
      <div className="server-list">
        {loading ? (
          <div className="server-loading">
            <div className="spinner" />
            <span>Loading your Plex servers…</span>
          </div>
        ) : (
          servers.map((server) => {
            const usable = Boolean(server.url);
            return (
              <button
                className={`server${usable && server.clientIdentifier === selected ? " sel" : ""}${usable ? "" : " is-unavailable"}`}
                title={usable ? undefined : "No server connection is available"}
                type="button"
                key={server.clientIdentifier}
                disabled={!usable || starting}
                onClick={() => onSelect(server.clientIdentifier)}
              >
                <div className="server-icon">
                  <ServerIcon />
                </div>
                <div className="server-info">
                  <div className="server-name">{server.name}</div>
                  <div className="server-host">
                    {server.url || "No connection available"}
                    {account?.username ? ` · ${account.username}` : ""}
                  </div>
                </div>
                <div className="server-check">
                  <Icon>
                    <circle cx="12" cy="12" r="10" />
                    <path d="m9 12 2 2 4-4" />
                  </Icon>
                </div>
              </button>
            );
          })
        )}
      </div>
      <AuthSpacer height={28} />
      {error && <p className="server-error">{error}</p>}
      <p className="hint">
        Can't find your server?&nbsp;{" "}
        <button className="link-muted" type="button" disabled={starting} onClick={onAgain}>
          Sign in again
        </button>
      </p>
      <AuthSpacer height={28} />
      <button
        className="btn-primary"
        type="button"
        disabled={!selected || starting}
        onClick={onStart}
      >
        Start listening
      </button>
    </AuthLayout>
  );
}
