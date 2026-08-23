import { ArtworkImage } from "../ArtworkImage.tsx";
import { initials } from "../utils.ts";
import type { Account } from "../types.ts";

export function AccountCard({ account }: { account: Account | null }) {
  const name = account?.username || "Plex account";

  return (
    <div className="account-card">
      <div className="avatar">
        <ArtworkImage
          source={account ? { kind: "account" } : null}
          priority
          alt=""
          fallback={initials(name)}
        />
      </div>
      <div className="card-info">
        <div className="card-name">{name}</div>
        <div className="card-sub">{account?.email || "Account details unavailable"}</div>
      </div>
    </div>
  );
}
