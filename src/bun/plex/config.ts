import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Utils } from "electrobun/main";
import { z } from "zod";
import type { PlexAccount } from "./types.ts";

export interface PlexServerConfig {
  /** Plex resource identifier; optional for configs written before server switching. */
  clientIdentifier?: string;
  name: string;
  /** Best connection URI (local connection preferred). */
  url: string;
  /** Per-server access token. */
  token: string;
}

export interface PlexConfig {
  clientIdentifier: string;
  /** Account token from the plex.tv PIN flow. */
  token: string;
  /** Persisted account profile (Sidebar user row, Connected card). */
  account?: PlexAccount;
  /** Selected server only; the full list is re-discovered each session. */
  server?: PlexServerConfig;
}

const serverSchema = z.object({
  // Optional keeps older persisted configs readable; new selections always write it.
  clientIdentifier: z.string().min(1).optional(),
  name: z.string().min(1),
  url: z.string().min(1),
  token: z.string().min(1),
});

/** Persisted account profile — the app-domain shape written by getPlexAccount. */
const accountSchema = z.looseObject({
  username: z.string().min(1),
  email: z.string().min(1),
  thumb: z.string().optional(),
  verified: z.boolean(),
});

/** Runtime shape of the persisted config; `loadConfig` validates against it. */
export const plexConfigSchema = z.object({
  clientIdentifier: z.string().min(1),
  token: z.string().min(1),
  account: accountSchema.optional(),
  server: serverSchema.optional(),
});

export function configPath(): string {
  return join(Utils.paths.userData, "plex-config.json");
}

export function loadConfig(): PlexConfig | null {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = plexConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.error(
        "plex-config.json failed validation; treating as unconfigured",
        parsed.error.issues,
      );
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/** Write config with mode 0o600 (owner read/write only). */
export function saveConfig(config: PlexConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when creating the file; a pre-existing
  // config would keep its old (possibly permissive) permissions without this.
  chmodSync(path, 0o600);
}

/** Remove the saved config file, if present. */
export function deleteConfig(): void {
  rmSync(configPath(), { force: true });
}
