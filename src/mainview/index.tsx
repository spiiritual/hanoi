import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthFlow, type AuthCompletion, type AuthStage } from "./auth/AuthFlow.tsx";
import { HomeScreen } from "./home/HomeScreen.tsx";
import { appState } from "./view-state.ts";
import type { Account, Server } from "./types.ts";

type AppView = "auth" | "home";
type AppTransition = {
  from: AppView;
  direction: "forward" | "backward";
};

const APP_TRANSITION_MS = 420;

function App() {
  const [view, setView] = useState<AppView>("auth");
  const [authStartStage, setAuthStartStage] = useState<AuthStage>("welcome");
  const [account, setAccount] = useState<Account | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [authSession, setAuthSession] = useState(0);
  const [transition, setTransition] = useState<AppTransition | null>(null);
  const viewRef = useRef(view);
  const transitionTimer = useRef<number | null>(null);

  const navigate = useCallback((next: AppView) => {
    const current = viewRef.current;
    if (next === current) return;
    if (transitionTimer.current !== null) {
      window.clearTimeout(transitionTimer.current);
    }
    viewRef.current = next;
    setTransition({
      from: current,
      direction: next === "home" ? "forward" : "backward",
    });
    setView(next);
    transitionTimer.current = window.setTimeout(() => {
      setTransition(null);
      transitionTimer.current = null;
    }, APP_TRANSITION_MS + 30);
  }, []);

  useEffect(() => {
    return () => {
      if (transitionTimer.current !== null) {
        window.clearTimeout(transitionTimer.current);
      }
    };
  }, []);

  const startAuth = useCallback(() => {
    setAuthStartStage("oauth");
    setAuthSession((session) => session + 1);
    navigate("auth");
  }, [navigate]);

  const completeAuth = useCallback(
    (completion: AuthCompletion) => {
      setAccount(completion.account);
      setServers(completion.servers);
      appState.setSelectedServer(completion.selectedServer);
      navigate("home");
    },
    [navigate],
  );

  const authClassName = transition
    ? transition.from === "auth"
      ? `screen app-transition-exit-${transition.direction}`
      : `screen app-transition-enter-${transition.direction}`
    : view === "auth"
      ? "screen"
      : "screen is-hidden";
  const homeClassName = transition
    ? transition.from === "home"
      ? `screen app-screen app-transition-exit-${transition.direction}`
      : `screen app-screen app-transition-enter-${transition.direction}`
    : view === "home"
      ? "screen app-screen"
      : "screen app-screen is-hidden";

  return (
    <main className="app">
      <section className={authClassName} id="screen-auth">
        <AuthFlow
          key={`auth-${authSession}`}
          initialStage={authStartStage}
          onComplete={completeAuth}
        />
      </section>
      <section className={homeClassName} id="screen-home">
        <HomeScreen
          account={account}
          servers={servers}
          onServers={setServers}
          onAddServer={startAuth}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
