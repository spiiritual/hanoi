import type { Account } from "../types.ts";
import { AccountCard } from "./account-card.tsx";
import { AuthLayout, AuthSpacer } from "./auth-layout.tsx";

export const ConnectedScreen = ({
  account,
  onContinue,
}: {
  account: Account | null;
  onContinue: () => void;
}) => (
  <AuthLayout>
    <div className="badge">
      <div className="badge-check">✓</div>
    </div>
    <AuthSpacer height={28} />
    <h2 className="title">You&apos;re signed in!</h2>
    <AuthSpacer height={40} />
    <AccountCard account={account} />
    <AuthSpacer height={40} />
    <button className="btn-primary" type="button" onClick={onContinue}>
      Continue
    </button>
  </AuthLayout>
);
