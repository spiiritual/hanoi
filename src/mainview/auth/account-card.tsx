import { ArtworkImage } from "../artwork/artwork-image.tsx";
import type { Account } from "../types.ts";
import { initials } from "../utils.ts";

export const AccountCard = ({ account }: { account: Account | null }) => {
  const name = account?.username ?? "Plex account";

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
        <div className="card-sub">
          {account?.email ?? "Account details unavailable"}
        </div>
      </div>
    </div>
  );
};
