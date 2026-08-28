import { plex } from "../plex.ts";
import { AuthLayout, AuthSpacer } from "./auth-layout.tsx";

export const WelcomeScreen = ({ onSignIn }: { onSignIn: () => void }) => (
  <AuthLayout className="welcome-inner">
    <div className="logo-mark">H</div>
    <AuthSpacer height={12} />
    <h1 className="app-name">Hanoi</h1>
    <AuthSpacer height={21} />
    <p className="tagline">A desktop music player for Plex.</p>
    <AuthSpacer height={40} />
    <button className="btn-signin" type="button" onClick={onSignIn}>
      <span className="plex-icon">▶</span>
      <span>Sign in with Plex</span>
    </button>
    <AuthSpacer height={16} />
    <button
      className="link-muted"
      type="button"
      onClick={() => {
        void plex.openExternal("https://www.plex.tv/sign-up/");
      }}
    >
      Don&apos;t have an account?&nbsp; Create one
    </button>
    <AuthSpacer height={64} />
  </AuthLayout>
);
