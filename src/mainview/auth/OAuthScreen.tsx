import { useCallback, useEffect, useRef, useState } from "react";
import { plex } from "../plex.ts";
import type { Account } from "../types.ts";
import { AuthLayout, AuthSpacer } from "./AuthLayout.tsx";

export function OAuthScreen({
	onCancel,
	onApproved,
	active = true,
}: {
	onCancel: () => void;
	onApproved: (account: Account | null) => void;
	active?: boolean;
}) {
	const [code, setCode] = useState("A1B2C3");
	const [url, setUrl] = useState<string | null>(null);
	const [status, setStatus] = useState("Waiting for authorization…");
	const runRef = useRef(0);
	const pollRef = useRef<number | null>(null);
	const stop = useCallback(() => {
		if (pollRef.current !== null) window.clearTimeout(pollRef.current);
		pollRef.current = null;
	}, []);

	useEffect(() => {
		if (!active) return;
		const run = ++runRef.current;
		stop();
		let cancelled = false;
		const poll = async (): Promise<void> => {
			if (cancelled || run !== runRef.current) return;
			try {
				const state = await plex.getAuthState();
				if (cancelled || run !== runRef.current) return;
				if (state.authError) {
					setStatus(`Something went wrong: ${state.authError}`);
					return;
				}
				if (!state.authenticated || state.authenticating) {
					pollRef.current = window.setTimeout(() => void poll(), 2000);
					return;
				}
				setStatus("Authorization approved — loading…");
				const account =
					state.account ?? (await plex.getAccount().catch(() => null));
				if (!cancelled && run === runRef.current) onApproved(account);
			} catch (error: unknown) {
				if (!cancelled) {
					console.error("Failed to check Plex authorization:", error);
					setStatus("Still waiting for authorization…");
					pollRef.current = window.setTimeout(() => void poll(), 2000);
				}
			}
		};
		void plex
			.beginAuth()
			.then(({ authUrl, pinCode }) => {
				if (cancelled || run !== runRef.current) return;
				setCode(pinCode);
				setUrl(authUrl);
				void poll();
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					const message = error instanceof Error ? error.message : String(error);
					setStatus(`Something went wrong: ${message}`);
				}
			});
		return () => {
			cancelled = true;
			stop();
		};
	}, [active, stop, onApproved]);

	return (
		<AuthLayout>
			<h2 className="title">Link your Plex account</h2>
			<AuthSpacer height={8} />
			<p className="subtitle">
				Secure OAuth — your Plex password never touches this app.
			</p>
			<AuthSpacer height={36} />
			<div className="link-card">
				<div className="card-label">Your link</div>
				<div className="link-row">
					<span className="link-prefix">plex.tv/link/</span>
					<span className="code-value">{code}</span>
				</div>
				<div className="card-actions">
					<button
						className="btn-open"
						type="button"
						onClick={() => {
							if (url) void plex.openExternal(url);
						}}
					>
						<span className="open-icon">↗</span>Open in Browser
					</button>
					<button
						className="btn-copy"
						type="button"
						onClick={() => {
							if (url) void plex.clipboardWriteText(url);
						}}
					>
						Copy link
					</button>
				</div>
			</div>
			<AuthSpacer height={28} />
			<div className="steps">
				<div className="step">
					<div className="step-num">1</div>
					<div className="step-info">
						<div className="step-title">Open the link</div>
						<div className="step-desc">
							Tap Open in Browser or copy the link — sign in with your Plex account
						</div>
					</div>
				</div>
				<div className="step">
					<div className="step-num">2</div>
					<div className="step-info">
						<div className="step-title">Approve and you're connected</div>
						<div className="step-desc">
							No code to type — this app finishes the handshake automatically
						</div>
					</div>
				</div>
			</div>
			<AuthSpacer height={28} />
			<div className="status-row">
				<div className="spinner" />
				<div className="status-text">{status}</div>
			</div>
			<AuthSpacer height={20} />
			<button
				className="btn-cancel"
				type="button"
				onClick={() => {
					stop();
					void plex.cancelAuth();
					onCancel();
				}}
			>
				<span className="cancel-icon">✕</span>
				<span>Cancel</span>
			</button>
		</AuthLayout>
	);
}
