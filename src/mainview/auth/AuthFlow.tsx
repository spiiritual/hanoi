import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { hydrateAccountIfMissing } from "../account-hydration.ts";
import { appState } from "../view-state.ts";
import { plex } from "../plex.ts";
import type { Account, Server } from "../types.ts";
import { ConnectedScreen } from "./ConnectedScreen.tsx";
import { OAuthScreen } from "./OAuthScreen.tsx";
import { ServerSelectionScreen } from "./ServerSelectionScreen.tsx";
import { WelcomeScreen } from "./WelcomeScreen.tsx";

export const authStages = ["welcome", "oauth", "connected", "servers"] as const;
export type AuthStage = (typeof authStages)[number];

const AUTH_TRANSITION_MS = 420;

export type AuthCompletion = {
	account: Account | null;
	servers: Server[];
	selectedServer: string | null;
};

export function AuthFlow({
	initialStage = "welcome",
	onComplete,
}: {
	initialStage?: AuthStage;
	onComplete: (completion: AuthCompletion) => void;
}) {
	const [stage, setStage] = useState<AuthStage>(initialStage);
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

	const transitionTo = useCallback((next: AuthStage) => {
		const current = stageRef.current;
		if (next === current) return;
		if (transitionTimer.current !== null) {
			window.clearTimeout(transitionTimer.current);
		}
		setExitingStage(current);
		stageRef.current = next;
		setStage(next);
		transitionTimer.current = window.setTimeout(() => {
			setExitingStage(null);
			transitionTimer.current = null;
		}, AUTH_TRANSITION_MS + 30);
	}, []);

	useEffect(() => {
		return () => {
			if (transitionTimer.current !== null) {
				window.clearTimeout(transitionTimer.current);
			}
		};
	}, []);

	useEffect(() => {
		if (initialStage !== "welcome") return;
		let cancelled = false;
		void (async () => {
			try {
				const state = await plex.getAuthState();
				const foundAccount =
					state.account ??
					(state.authenticated
						? await hydrateAccountIfMissing(null, () => plex.getAccount()).catch(
								() => null,
							)
						: null);
				if (cancelled || stageRef.current !== "welcome") return;
				setAccount(foundAccount);
				if (state.hasServer && state.authenticated) {
					const server = state.server ?? null;
					const identifier = server?.clientIdentifier ?? null;
					setServers(server ? [server] : []);
					setSelectedServer(identifier);
					appState.setSelectedServer(identifier);
					onComplete({
						account: foundAccount,
						servers: server ? [server] : [],
						selectedServer: identifier,
					});
				} else if (state.authenticated) {
					transitionTo("connected");
				}
			} catch {
				if (!cancelled && stageRef.current === "welcome") transitionTo("welcome");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [initialStage, onComplete, transitionTo]);

	const startAuth = useCallback(() => {
		transitionTo("oauth");
	}, [transitionTo]);

	const continueToServers = useCallback(async () => {
		const run = ++serverRun.current;
		setServerLoading(true);
		setServerError(null);
		setServers([]);
		setSelectedServer(null);
		appState.setSelectedServer(null);
		transitionTo("servers");
		try {
			const found = await plex.getServers();
			if (run !== serverRun.current) return;
			setServers(found);
			const first = found.find((server) => server.url)?.clientIdentifier ?? null;
			setSelectedServer(first);
			appState.setSelectedServer(first);
			setServerError(
				first === null
					? "No owned Plex media servers were found on this account."
					: null,
			);
		} catch (error: unknown) {
			if (run !== serverRun.current) return;
			const message = error instanceof Error ? error.message : String(error);
			setServerError(`Couldn't load your Plex servers: ${message}`);
		} finally {
			if (run === serverRun.current) setServerLoading(false);
		}
	}, []);

	const startListening = useCallback(async () => {
		if (!selectedServer || serverStarting) return;
		const run = ++serverRun.current;
		const server = selectedServer;
		setServerStarting(true);
		try {
			await plex.selectServer(server);
			if (run !== serverRun.current) return;
			appState.setSelectedServer(server);
			onComplete({ account, servers, selectedServer: server });
		} catch (error: unknown) {
			if (run !== serverRun.current) return;
			const message = error instanceof Error ? error.message : String(error);
			setServerError(`Couldn't connect to that server: ${message}`);
		} finally {
			if (run === serverRun.current) setServerStarting(false);
		}
	}, [account, onComplete, selectedServer, servers, serverStarting]);

	const again = useCallback(async () => {
		const run = ++serverRun.current;
		try {
			await plex.cancelAuth();
		} catch (error: unknown) {
			console.error("Failed to cancel the previous Plex authorization:", error);
		} finally {
			if (run === serverRun.current) transitionTo("oauth");
		}
	}, []);

	const handleApproved = useCallback(
		(nextAccount: Account | null) => {
			setAccount(nextAccount);
			transitionTo("connected");
		},
		[transitionTo],
	);

	const transitionDirection =
		exitingStage !== null &&
		authStages.indexOf(stage) >= authStages.indexOf(exitingStage)
			? "forward"
			: "backward";
	const renderStage = (stageToRender: AuthStage, active: boolean): ReactNode => {
		switch (stageToRender) {
			case "oauth":
				return (
					<OAuthScreen
						active={active}
						onCancel={() => transitionTo("welcome")}
						onApproved={handleApproved}
					/>
				);
			case "connected":
				return (
					<ConnectedScreen
						account={account}
						onContinue={() => void continueToServers()}
					/>
				);
			case "servers":
				return (
					<ServerSelectionScreen
						account={account}
						servers={servers}
						loading={serverLoading}
						starting={serverStarting}
						error={serverError}
						selected={selectedServer}
						onSelect={(id) => {
							if (serverStarting) return;
							setSelectedServer(id);
							appState.setSelectedServer(id);
						}}
						onStart={() => void startListening()}
						onAgain={() => void again()}
					/>
				);
			case "welcome":
			default:
				return <WelcomeScreen onSignIn={startAuth} />;
		}
	};

	return (
		<div className="auth-stage-stack">
			{exitingStage && (
				<div
					className={`auth-stage auth-stage-exit-${transitionDirection}`}
					key={`exit-${exitingStage}`}
				>
					{renderStage(exitingStage, false)}
				</div>
			)}
			<div
				className={`auth-stage${exitingStage ? ` auth-stage-enter-${transitionDirection}` : ""}`}
				key={`enter-${stage}`}
			>
				{renderStage(stage, true)}
			</div>
		</div>
	);
}
