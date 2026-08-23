import { useEffect, useState } from "react";
import { initials } from "../utils.ts";
import { plex } from "../plex.ts";
import type { Account } from "../types.ts";

export function AccountCard({ account }: { account: Account | null }) {
  const name = account?.username || "Plex account";
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setAvatar(null);
    if (account)
      void plex
        .getAccountAvatarUrl()
        .then((value) => {
          if (active) setAvatar(value);
        })
        .catch((error: unknown) => console.error("Failed to load the Plex profile image:", error));
    return () => {
      active = false;
    };
  }, [account]);

  return (
    <div className="account-card">
      <div className="avatar">
        {!avatar && <span>{initials(name)}</span>}
        {avatar && <img src={avatar} alt="" onError={() => setAvatar(null)} />}
      </div>
      <div className="card-info">
        <div className="card-name">{name}</div>
        <div className="card-sub">{account?.email || "Account details unavailable"}</div>
      </div>
    </div>
  );
}
