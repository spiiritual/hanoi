import { useEffect, useRef, useState } from "react";

import { plex } from "../plex.ts";
import type { Account } from "../types.ts";
import { AuthLayout, AuthSpacer } from "./auth-layout.tsx";

const stopPolling = (pollRef: { current: number | null }): void => {
  if (pollRef.current !== null) {
    window.clearTimeout(pollRef.current);
  }
  pollRef.current = null;
};

export const OAuthScreen = ({
  onCancel,
  onApproved,
  active = true,
}: {
  onCancel: () => void;
  onApproved: (account: Account | null) => void;
  active?: boolean;
}) => {
  const [code, setCode] = useState("A1B2C3");
  const urlRef = useRef<string | null>(null);
  const [status, setStatus] = useState("Waiting for authorization…");
  const runRef = useRef(0);
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (active) {
      runRef.current += 1;
      const run = runRef.current;
      stopPolling(pollRef);
      urlRef.current = null;
      const poll = async (): Promise<void> => {
        if (cancelled || run !== runRef.current) {
          return;
        }
        try {
          const state = await plex.getAuthState();
          if (cancelled || run !== runRef.current) {
            return;
          }
          if (state.authError !== null && state.authError !== "") {
            setStatus(`Something went wrong: ${state.authError}`);
            return;
          }
          if (!state.authenticated || state.authenticating) {
            pollRef.current = window.setTimeout(() => {
              void poll();
            }, 2000);
            return;
          }
          setStatus("Authorization approved — loading…");
          const { account: stateAccount } = state;
          let account: Account | null = stateAccount ?? null;
          if (!account) {
            try {
              account = await plex.getAccount();
            } catch {
              account = null;
            }
          }
          if (!cancelled && run === runRef.current) {
            onApproved(account);
          }
        } catch (error) {
          if (!cancelled) {
            console.error("Failed to check Plex authorization:", error);
            setStatus("Still waiting for authorization…");
            pollRef.current = window.setTimeout(() => {
              void poll();
            }, 2000);
          }
        }
      };
      const begin = async (): Promise<void> => {
        try {
          const { authUrl, pinCode } = await plex.beginAuth();
          if (cancelled || run !== runRef.current) {
            return;
          }
          setCode(pinCode);
          urlRef.current = authUrl;
          await poll();
        } catch (error) {
          if (!cancelled) {
            const message =
              error instanceof Error ? error.message : String(error);
            setStatus(`Something went wrong: ${message}`);
          }
        }
      };
      void begin();
    }
    return () => {
      cancelled = true;
      stopPolling(pollRef);
    };
  }, [active, onApproved]);

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
              if (urlRef.current !== null && urlRef.current !== "") {
                void plex.openExternal(urlRef.current);
              }
            }}
          >
            <span className="open-icon">↗</span>Open in Browser
          </button>
          <button
            className="btn-copy"
            type="button"
            onClick={() => {
              if (urlRef.current !== null && urlRef.current !== "") {
                void plex.clipboardWriteText(urlRef.current);
              }
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
              Tap Open in Browser or copy the link — sign in with your Plex
              account
            </div>
          </div>
        </div>
        <div className="step">
          <div className="step-num">2</div>
          <div className="step-info">
            <div className="step-title">Approve and you&apos;re connected</div>
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
          stopPolling(pollRef);
          void plex.cancelAuth();
          onCancel();
        }}
      >
        <span className="cancel-icon">✕</span>
        <span>Cancel</span>
      </button>
    </AuthLayout>
  );
};
