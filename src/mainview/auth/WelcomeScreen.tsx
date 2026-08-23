import { plex } from "../plex.ts";
import { AuthLayout, AuthSpacer } from "./AuthLayout.tsx";

export function WelcomeScreen({ onSignIn }: { onSignIn: () => void }) {
	return (
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
			<a
				className="link-muted"
				href="https://www.plex.tv/sign-up/"
				onClick={(event) => {
					event.preventDefault();
					void plex.openExternal("https://www.plex.tv/sign-up/");
				}}
			>
				Don't have an account?&nbsp; Create one
			</a>
			<AuthSpacer height={64} />
		</AuthLayout>
	);
}
