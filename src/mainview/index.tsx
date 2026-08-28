import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { AuthFlow } from "./auth/auth-flow.tsx";
import type { AuthCompletion, AuthStage } from "./auth/auth-flow.tsx";
import { HomeScreen } from "./home/home-screen.tsx";
import type { Account, Server } from "./types.ts";
import { appState } from "./view-state.ts";

type AppView = "auth" | "home";
interface AppTransition {
  direction: "forward" | "backward";
  from: AppView;
}

const APP_TRANSITION_MS = 420;

const screenClassName = (
  screen: AppView,
  view: AppView,
  transition: AppTransition | null
): string => {
  const baseClassName = screen === "home" ? "screen app-screen" : "screen";
  if (transition === null) {
    return view === screen ? baseClassName : `${baseClassName} is-hidden`;
  }
  const transitionType = transition.from === screen ? "exit" : "enter";
  return `${baseClassName} app-transition-${transitionType}-${transition.direction}`;
};

const App = () => {
  const [view, setView] = useState<AppView>("auth");
  const [authStartStage, setAuthStartStage] = useState<AuthStage>("welcome");
  const [account, setAccount] = useState<Account | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [authSession, setAuthSession] = useState(0);
  const [transition, setTransition] = useState<AppTransition | null>(null);
  const viewRef = useRef(view);
  const transitionTimer = useRef<number | null>(null);

  const navigate = (next: AppView): void => {
    const { current } = viewRef;
    if (next === current) {
      return;
    }
    if (transitionTimer.current !== null) {
      window.clearTimeout(transitionTimer.current);
    }
    viewRef.current = next;
    setTransition({
      direction: next === "home" ? "forward" : "backward",
      from: current,
    });
    setView(next);
    transitionTimer.current = window.setTimeout(() => {
      setTransition(null);
      transitionTimer.current = null;
    }, APP_TRANSITION_MS + 30);
  };

  useEffect(
    () => (): void => {
      if (transitionTimer.current !== null) {
        window.clearTimeout(transitionTimer.current);
      }
    },
    []
  );

  const startAuth = (): void => {
    setAuthStartStage("oauth");
    setAuthSession((session) => session + 1);
    navigate("auth");
  };

  const completeAuth = (completion: AuthCompletion): void => {
    setAccount(completion.account);
    setServers(completion.servers);
    appState.setSelectedServer(completion.selectedServer);
    navigate("home");
  };

  const authClassName = screenClassName("auth", view, transition);
  const homeClassName = screenClassName("home", view, transition);

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
};

const appRoot = document.querySelector("#app");
if (appRoot === null) {
  throw new Error("The app root element is missing");
}
createRoot(appRoot).render(<App />);
