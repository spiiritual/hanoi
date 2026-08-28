import type { ServerViewSummary } from "../bun/plex/rpc-schema.ts";
import type { PlexAccount } from "../bun/plex/types.ts";

export type Account = Pick<PlexAccount, "username" | "email"> & {
  thumb?: string;
  verified: boolean;
};

export type Server = ServerViewSummary;
