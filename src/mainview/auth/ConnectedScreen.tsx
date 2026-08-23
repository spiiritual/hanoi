import type { Account } from "../types.ts";
import { AuthLayout, AuthSpacer } from "./AuthLayout.tsx";
import { AccountCard } from "./AccountCard.tsx";

export function ConnectedScreen({
  account,
  onContinue,
}: {
  account: Account | null;
  onContinue: () => void;
}) {
  return (
    <AuthLayout>
      <div className="badge">
        <div className="badge-check">✓</div>
      </div>
      <AuthSpacer height={28} />
      <h2 className="title">You're signed in!</h2>
      <AuthSpacer height={40} />
      <AccountCard account={account} />
      <AuthSpacer height={40} />
      <button className="btn-primary" type="button" onClick={onContinue}>
        Continue
      </button>
    </AuthLayout>
  );
}
