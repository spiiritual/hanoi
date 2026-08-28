import { useEffect, useRef, useState } from "react";

import { plex } from "../plex.ts";
import type { Account, Server } from "../types.ts";
import { appState } from "../view-state.ts";
import { AuthLayout, AuthSpacer } from "./auth-layout.tsx";
import { ConnectedScreen } from "./connected-screen.tsx";
import { OAuthScreen } from "./oauth-screen.tsx";
import { ServerSelectionScreen } from "./server-selection-screen.tsx";
import { hydrateAccountIfMissing } from "./utils.ts";
import { WelcomeScreen } from "./welcome-screen.tsx";

const authStages = ["welcome", "oauth", "connected", "servers"] as const;
export type AuthStage = (typeof authStages)[number];

const AUTH_TRANSITION_MS = 420;
const AUTH_STARTUP_MIN_MS = 700;

export interface AuthCompletion {
  account: Account | null;
  servers: Server[];
  selectedServer: string | null;
}

type AuthState = Awaited<ReturnType<typeof plex.getAuthState>>;

interface TransitionState {
  stageRef: { current: AuthStage };
  transitionTimer: { current: number | null };
  setExitingStage: (stage: AuthStage | null) => void;
  setStage: (stage: AuthStage) => void;
}

const transitionStage = (next: AuthStage, state: TransitionState): void => {
  const { current } = state.stageRef;
  if (next === current) {
    return;
  }
  if (state.transitionTimer.current !== null) {
    window.clearTimeout(state.transitionTimer.current);
  }
  state.setExitingStage(current);
  state.stageRef.current = next;
  state.setStage(next);
  state.transitionTimer.current = window.setTimeout(() => {
    state.setExitingStage(null);
    state.transitionTimer.current = null;
  }, AUTH_TRANSITION_MS + 30);
};

const AuthStartupScreen = () => (
  <div className="auth-stage-stack">
    <div className="auth-stage" aria-busy="true">
      <AuthLayout>
        <div className="logo-mark" aria-hidden="true">
          H
        </div>
        <AuthSpacer height={12} />
        <h1 className="app-name">Hanoi</h1>
        <AuthSpacer height={36} />
        <div className="status-row" aria-live="polite">
          <div className="spinner" />
          <div className="status-text">Checking your Plex account…</div>
        </div>
      </AuthLayout>
    </div>
  </div>
);

interface AuthStageViewProps {
  account: Account | null;
  servers: Server[];
  serverLoading: boolean;
  serverStarting: boolean;
  serverError: string | null;
  selectedServer: string | null;
  active: boolean;
  stage: AuthStage;
  onCancel: () => void;
  onApproved: (account: Account | null) => void;
  onContinue: () => void;
  onSelectServer: (id: string) => void;
  onStart: () => void;
  onAgain: () => void;
  onSignIn: () => void;
}

const AuthStageView = ({
  account,
  servers,
  serverLoading,
  serverStarting,
  serverError,
  selectedServer,
  active,
  stage,
  onCancel,
  onApproved,
  onContinue,
  onSelectServer,
  onStart,
  onAgain,
  onSignIn,
}: AuthStageViewProps) => {
  switch (stage) {
    case "oauth": {
      return (
        <OAuthScreen
          active={active}
          onCancel={onCancel}
          onApproved={onApproved}
        />
      );
    }
    case "connected": {
      return <ConnectedScreen account={account} onContinue={onContinue} />;
    }
    case "servers": {
      return (
        <ServerSelectionScreen
          account={account}
          servers={servers}
          loading={serverLoading}
          starting={serverStarting}
          error={serverError}
          selected={selectedServer}
          onSelect={onSelectServer}
          onStart={onStart}
          onAgain={onAgain}
        />
      );
    }
    case "welcome": {
      return <WelcomeScreen onSignIn={onSignIn} />;
    }
    default: {
      return null;
    }
  }
};

interface AuthStageStackProps {
  stage: AuthStage;
  exitingStage: AuthStage | null;
  transitionDirection: "forward" | "backward";
  viewProps: AuthStageViewProps;
}

const AuthStageStack = ({
  stage,
  exitingStage,
  transitionDirection,
  viewProps,
}: AuthStageStackProps) => {
  const enterClassName =
    exitingStage === null
      ? "auth-stage"
      : `auth-stage auth-stage-enter-${transitionDirection}`;
  return (
    <div className="auth-stage-stack">
      {exitingStage !== null && (
        <div
          className={`auth-stage auth-stage-exit-${transitionDirection}`}
          key={`exit-${exitingStage}`}
        >
          <AuthStageView {...viewProps} active={false} stage={exitingStage} />
        </div>
      )}
      <div className={enterClassName} key={`enter-${stage}`}>
        <AuthStageView {...viewProps} active stage={stage} />
      </div>
    </div>
  );
};

export const AuthFlow = ({
  initialStage = "welcome",
  onComplete,
}: {
  initialStage?: AuthStage;
  onComplete: (completion: AuthCompletion) => void;
}) => {
  const [stage, setStage] = useState<AuthStage>(initialStage);
  const [startupChecking, setStartupChecking] = useState(
    initialStage === "welcome"
  );
  const startupStartedAtRef = useRef<number | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverStarting, setServerStarting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [exitingStage, setExitingStage] = useState<AuthStage | null>(null);
  const stageRef = useRef(stage);
  const serverRun = useRef(0);
  const transitionTimer = useRef<number | null>(null);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  const transitionTo = (next: AuthStage): void => {
    transitionStage(next, {
      setExitingStage,
      setStage,
      stageRef,
      transitionTimer,
    });
  };

  useEffect(
    () => () => {
      if (transitionTimer.current !== null) {
        window.clearTimeout(transitionTimer.current);
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    if (initialStage !== "welcome") {
      return () => {
        cancelled = true;
      };
    }
    const startupStartedAt = startupStartedAtRef.current ?? Date.now();
    startupStartedAtRef.current = startupStartedAt;
    const checkStartup = async (): Promise<void> => {
      try {
        const state: AuthState = await plex.getAuthState();
        let foundAccount: Account | null = state.account ?? null;
        if (foundAccount === null && state.authenticated) {
          try {
            foundAccount = await hydrateAccountIfMissing(
              null,
              async () => await plex.getAccount()
            );
          } catch {
            foundAccount = null;
          }
        }
        const remaining = AUTH_STARTUP_MIN_MS - (Date.now() - startupStartedAt);
        window.setTimeout(
          () => {
            if (cancelled || stageRef.current !== "welcome") {
              return;
            }
            setAccount(foundAccount);
            if (state.hasServer && state.authenticated) {
              const server = state.server ?? null;
              const identifier = server?.clientIdentifier ?? null;
              const availableServers = server ? [server] : [];
              setServers(availableServers);
              setSelectedServer(identifier);
              appState.setSelectedServer(identifier);
              onComplete({
                account: foundAccount,
                selectedServer: identifier,
                servers: availableServers,
              });
            } else if (state.authenticated) {
              transitionStage("connected", {
                setExitingStage,
                setStage,
                stageRef,
                transitionTimer,
              });
              setStartupChecking(false);
            } else {
              setStartupChecking(false);
            }
          },
          Math.max(0, remaining)
        );
      } catch {
        const remaining = AUTH_STARTUP_MIN_MS - (Date.now() - startupStartedAt);
        window.setTimeout(
          () => {
            if (cancelled || stageRef.current !== "welcome") {
              return;
            }
            setStartupChecking(false);
            transitionStage("welcome", {
              setExitingStage,
              setStage,
              stageRef,
              transitionTimer,
            });
          },
          Math.max(0, remaining)
        );
      }
    };
    queueMicrotask(() => {
      void checkStartup();
    });
    return () => {
      cancelled = true;
    };
  }, [initialStage, onComplete]);

  const startAuth = (): void => {
    transitionTo("oauth");
  };

  const continueToServers = async (): Promise<void> => {
    serverRun.current += 1;
    const run = serverRun.current;
    setServerLoading(true);
    setServerError(null);
    setServers([]);
    setSelectedServer(null);
    appState.setSelectedServer(null);
    transitionTo("servers");
    try {
      const found = await plex.getServers();
      if (run !== serverRun.current) {
        return;
      }
      setServers(found);
      const first =
        found.find((server) => server.url !== null && server.url !== "")
          ?.clientIdentifier ?? null;
      setSelectedServer(first);
      appState.setSelectedServer(first);
      setServerError(
        first === null
          ? "No owned Plex media servers were found on this account."
          : null
      );
    } catch (error: unknown) {
      if (run !== serverRun.current) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setServerError(`Couldn't load your Plex servers: ${message}`);
    }
    if (run === serverRun.current) {
      setServerLoading(false);
    }
  };

  const startListening = async (): Promise<void> => {
    if (selectedServer === null || selectedServer === "" || serverStarting) {
      return;
    }
    serverRun.current += 1;
    const run = serverRun.current;
    const server = selectedServer;
    setServerStarting(true);
    try {
      await plex.selectServer(server);
      if (run !== serverRun.current) {
        return;
      }
      appState.setSelectedServer(server);
      onComplete({ account, selectedServer: server, servers });
    } catch (error: unknown) {
      if (run !== serverRun.current) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setServerError(`Couldn't connect to that server: ${message}`);
    }
    if (run === serverRun.current) {
      setServerStarting(false);
    }
  };

  const again = async (): Promise<void> => {
    serverRun.current += 1;
    const run = serverRun.current;
    try {
      await plex.cancelAuth();
    } catch (error: unknown) {
      console.error("Failed to cancel the previous Plex authorization:", error);
    }
    if (run === serverRun.current) {
      transitionTo("oauth");
    }
  };

  const handleApproved = (nextAccount: Account | null): void => {
    setAccount(nextAccount);
    transitionTo("connected");
  };

  const transitionDirection =
    exitingStage !== null &&
    authStages.indexOf(stage) >= authStages.indexOf(exitingStage)
      ? "forward"
      : "backward";
  if (startupChecking) {
    return <AuthStartupScreen />;
  }

  const stageViewProps: AuthStageViewProps = {
    account,
    active: true,
    onAgain: () => {
      queueMicrotask(() => {
        void again();
      });
    },
    onApproved: handleApproved,
    onCancel: () => {
      transitionTo("welcome");
    },
    onContinue: () => {
      queueMicrotask(() => {
        void continueToServers();
      });
    },
    onSelectServer: (id) => {
      if (serverStarting) {
        return;
      }
      setSelectedServer(id);
      appState.setSelectedServer(id);
    },
    onSignIn: startAuth,
    onStart: () => {
      queueMicrotask(() => {
        void startListening();
      });
    },
    selectedServer,
    serverError,
    serverLoading,
    serverStarting,
    servers,
    stage,
  };

  return (
    <AuthStageStack
      stage={stage}
      exitingStage={exitingStage}
      transitionDirection={transitionDirection}
      viewProps={stageViewProps}
    />
  );
};
