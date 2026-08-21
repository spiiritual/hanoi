# Plex API Client — Implementation Plan

A Plex API client for **hanoi**, an Electrobun desktop music player. Reference: `~/Documents/plexamp-cli/src/plex/*` (read-only). UI specs: `/Users/andrew/Documents/plex.pen` (19 top-level frames).

## Decisions

- **Fresh implementation** in `hanoi/src/bun/plex/`, using `plexamp-cli` only as reference. `plexamp-cli` keeps its own copy.
- Client lives in the **main process** (`src/bun/`); the view reaches it over **Electrobun RPC** (`defineElectrobunRPC`). Token never crosses into the renderer.
- Scope: **browse + playback** endpoints so the Player Bar can actually play music.
- **Generic `sort`/`filter`/`limit` option object** on browse calls covers every library screen's "Recently added" / alphabetical / by-play-count needs.
- Server online/offline dot refreshes **on-demand** (app focus/visibility change + when dropdown opens). No background polling.

## Screens the .pen defines (data needs)

Auth flow:
1. **Auth - Welcome** (`p19pw`) — branding, "Sign in with Plex" button. Static.
2. **Auth - Plex OAuth** (`ENh1o`) — 6-char PIN code, `plex.tv/link` URL, copy/open buttons, "Waiting for authorization…" spinner, Cancel.
3. **Auth - Server Selection** (`zNEof`) — server list (name + host + "· Alex Rivera"), check on selected.
4. **Auth - Connected** (`kuVdC`) — "Signed in as {username} · {server}", account card (avatar/name/email/verified badge), "Start listening", "Disconnect account".
5. **Sidebar - Server Selector Open** (`ulMII`) — dropdown: servers with name + "● Online"/"○ Offline" + check on current + "Add a server…" row.
6. **Sidebar** (`XW0DC`) — new Server selector button (`lj0BM`) showing current server + "● Online" + chevron.

Main app:
7. **Home** (`u5JUT`) — "Recently Played" row, "Most Played in December" row.
8. **Library - Albums** (`kyYc8`) — album grid, "Recently added" sort.
9. **Library - Artists** (`CHlhF`) — artist grid with avatars, "Recently added" sort.
10. **Library - Songs** (`yTrtY`) — song list with art + artist + duration, count ("128 songs").
11. **Library - Playlists** (`ihxfy`) — playlist cards with "Focus · 42 songs" subtitles.
12. **Search** (`PUB0k`) — split Songs/Albums/Artists columns.
13. **Album detail** (`wpD45`, + Hover `ja658`, + Playing `c5EEyi`) — header ("Album · 2025 · 7 songs, 17 min 56 sec"), track list with #/title/artist/duration.
14. **Playlist detail** (`sXOyv`, + Hover `Q6qOW`, + Playing `pq8Cr`) — header ("Playlist · 2026 · 42 songs, 2 hr 18 min"), track list.
15. **Artist detail** (`fsy1m`) — header with genres + "Artist · 20 albums · 110 songs", "Your Top Songs" with "X plays", albums row with "year · X plays".

## File layout

```
src/bun/plex/
  index.ts          # public exports
  config.ts         # load/save config JSON (Electrobun Paths API, mode 0o600)
  auth.ts           # PIN flow + server discovery (cancellable waitForPin)
  types.ts          # response types + domain types
  client.ts         # PlexClient class — all HTTP calls
  url.ts            # imageUrl / transcodedImageUrl / streamUrl helpers
  rpc-schema.ts     # Electrobun RPC schema (bun + webview sides)
src/bun/
  index.ts          # existing — wire window, create client, register RPC handlers
src/mainview/
  plex.ts           # thin view-side RPC wrapper (typed)
  index.ts          # existing — eventual UI wiring (out of scope here)
```

## Step 1 — `types.ts`

Re-implement from `plexamp-cli/src/plex/types.ts`, then add fields the screens require.

Type additions vs. plexamp-cli:

| Screen need | Field | Source |
|---|---|---|
| Album header "7 songs, 17 min 56 sec" | `leafCount`, total duration | `MediaContainer.leafCount` + sum of track `duration`; album metadata via `/library/metadata/{ratingKey}` |
| Playlist header "42 songs, 2 hr 18 min" | `leafCount`, `duration` | already on `PlexPlaylist`; expose explicitly |
| Artist header "20 albums · 110 songs", genres | album/song counts, `Genre[]` | `/library/metadata/{artistKey}` returns `Genre[]`; counts via filtered `getAllAlbums`/`getAllTracks` or `childCount`/`leafCount` |
| Artist "Your Top Songs" with "X plays" | `viewCount` | already on tracks; expose explicitly on `PlexTrack`/`PlexHubItem` |
| Home "Most Played in December" | time-windowed top by `viewCount` | `/library/sections/{key}/all?type=10&viewCount>=1&sort=viewCount:desc&addedAt>=…` |
| Library "Recently added" sort | sort param | `…&sort=addedAt:desc` |
| Search split columns | grouped results | extend `search` to return `{artists, albums, tracks}` |
| Sidebar user "Alex Rivera" | account username | `/myplex/account` or Plex.tv `/api/v2/user` → `username`, `thumb` |
| Connected card email + verified | `email`, `verified` | Plex.tv `/api/v2/user` |
| Server online/offline | reachability | GET `/identity` with token, short timeout |

Concrete types:

```ts
interface PlexTrack    { viewCount?: number; /* + existing fields */ }
interface PlexAlbum    { viewCount?: number; leafCount?: number; }
interface PlexArtist   { viewCount?: number; childCount?: number; }
interface PlexGenre    { tag: string }
// Genre?: PlexGenre[] on artist/album/track

interface PlexAccount {
  username: string;
  email: string;
  thumb?: string;
  verified: boolean;   // drives Connected card's verified badge
}

interface PlexServerInfo {
  name: string;
  clientIdentifier: string;
  url: string;         // best connection URI
  token: string;       // per-server access token
  local: boolean;
  online: boolean;     // from /identity reachability check
}

interface PlexMetadata { size?: number; leafCount?: number; duration?: number }
// covers MediaContainer totals from single-metadata calls
```

## Step 2 — `config.ts`

Same shape as plexamp-cli (`PlexConfig` with `clientIdentifier`, `token`, optional `server`), plus persisted `account`. Replace `node:fs` with Electrobun's `Paths` API. File mode `0o600`.

```ts
interface PlexConfig {
  clientIdentifier: string;
  token: string;                  // account token
  account?: { username: string; email: string; thumb?: string; verified: boolean };
  server?: PlexServerConfig;      // selected server only; full list re-discovered each session
}
```

The full server list is **not** persisted — `getServers()` re-discovers fresh each time the dropdown opens.

## Step 3 — `auth.ts`

Re-implement the plex.tv PIN flow:

- `createPin(clientIdentifier)` → POST `/api/v2/pins?strong=true`
- `buildAuthUrl(pin)` → `https://app.plex.tv/auth#?…`
- `waitForPin(pin, { onPoll, signal })` → poll GET `/api/v2/pins/{id}` until `authToken` set (5 min timeout, 2 s interval). **Cancellable** via AbortSignal/flag so `cancelAuth` can stop the poll cleanly.
- `discoverServers(token, clientIdentifier)` → GET `/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`
- `connectionCandidates(resource)` → local direct first, other direct connections next, relay last

Device headers: `X-Plex-Product: hanoi`, `X-Plex-Device-Name: hanoi`, `X-Plex-Platform: process.platform`.

`waitForPin`'s `onPoll` powers the "Waiting for authorization…" spinner. `createPin` returns `PlexPin.code` (6-char string shown in the OAuth screen's PIN card). Optionally open `buildAuthUrl` via Electrobun `Utils.openExternal`.

## Step 4 — `client.ts`

Re-implement `PlexClient` with the same `request<T>` core (fetch + `X-Plex-Token` header + `MediaContainer<T>` unwrap), then add methods. **All browse methods take an options object**:

```ts
interface BrowseOptions {
  sort?: "addedAt:desc" | "titleSort:asc" | "viewCount:desc" | "year:desc" | "lastViewedAt:desc";
  filter?: string;            // raw Plex filter expression, e.g. "genre=Soundtrack"
  limit?: number;
  offset?: number;
}
```

### Auth/account support (new vs plexamp-cli)

| Method | Endpoint | Used by |
|---|---|---|
| `getAccount()` | Plex.tv `/api/v2/user` with X-Plex-Token | Sidebar user, Connected card |
| `discoverServers(token, clientIdentifier)` | Plex.tv `/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1` | Server Selection, sidebar dropdown |
| `checkServerStatus(url, token)` | GET `${url}/identity`, ~3s timeout → boolean | Sidebar dot, dropdown |
| `getServers()` | `discoverServers` + parallel `/identity` probes for every candidate, selecting the first reachable connection → `PlexServerInfo[]` | Sidebar dropdown, Server Selection |

### Browse

| Method | Endpoint | Used by |
|---|---|---|
| `getSections()` | `/library/sections` | all library screens |
| `getMusicSections()` | filter above | all music screens |
| `getArtists(sectionKey, opts?)` | `…/all?type=8` + opts | Library Artists, Search |
| `getAlbums(sectionKey, opts?)` | `…/all?type=9` + opts | Library Albums, Home, Search |
| `getTracks(sectionKey, opts?)` | `…/all?type=10` + opts | Library Songs, Search |
| `getItems<T>(sectionKey, type, opts?)` | generic — backs the above | internal |
| `getPlaylists()` / `getMusicPlaylists()` | `/playlists` | Library Playlists |

### Detail

| Method | Endpoint | Used by |
|---|---|---|
| `getMetadata(ratingKey)` | `/library/metadata/{ratingKey}` | Album/Playlist/Artist header (leafCount, duration, Genre[]) |
| `getAlbumTracks(ratingKey)` | `/library/metadata/{ratingKey}/children` | Album detail |
| `getArtistAlbums(ratingKey)` | filter `getAlbums` by `parentRatingKey`, or `/library/metadata/{ratingKey}/children` if Plex returns albums | Artist detail |
| `getPlaylistTracks(playlistKey)` | `/playlists/{id}/items` (new) | Playlist detail |

### Home

| Method | Endpoint | Used by |
|---|---|---|
| `getHomeHubs(identifiers?)` | `/hubs` plus `/library/sections`, `/hubs/sections/{key}`, and derived recent-play queries | Home's server-defined music row categories and audio playlists |
| `getRecentlyPlayed()` | derived library query | Mixed artist/album/track recent-play feed |
| `getMostPlayed(sinceMs?)` (new) | derived library query | Optional focused most-played view; not the Home row source |

The Home view consumes the ordered `Hub[]` response from `getHomeHubs()` so
Plex controls the row titles, identifiers, and category mix. Plex's global
`/hubs` response omits many music-library rows, so the default call combines
it with the ordered responses from `/hubs/sections/{key}` for every music
section, retaining global audio playlist rows as supplements. The section
`music.recent.played.*` hub is artist-only, so `getHomeHubs()` replaces its
preview metadata with the first mixed artist/album/track results from the
recent-play queries. Hanoi filters each row's metadata to music item types
(`artist`, `album`, `track`, and audio `playlist`) while preserving Plex's row
order. Home renders the hub cards as previews without treating Plex's preview
size as the category's total. `getHomeHubs()` is exposed through RPC; hub rows
carry `title`, `hubIdentifier`, `type`, `size`, and nested `Metadata` items.

### Search

| Method | Endpoint | Used by |
|---|---|---|
| `search(query)` → `{artists, albums, tracks}` | `/hubs/search?query=…&limit=20` then group by `type` | Search screen |

### Playback

| Method | Endpoint | Used by |
|---|---|---|
| `streamUrl(track)` (new) | resolves `Media[0].Part[0].key` to `${baseUrl}${key}?X-Plex-Token=…` | Player Bar audio src |
| `scrobble(key)` / `unscrobble(key)` (new) | `/:/scrobble?identifier=…&key=…` | "X plays" increment on track play |

### URL helpers (split into `url.ts` so the view can import pure fns without the client)

| Method | Purpose |
|---|---|
| `imageUrl(path)` | full thumb/art URL with token |
| `transcodedImageUrl(path, w, h)` | `/photo/:/transcode?width=&height=&url=` fallback |
| `streamUrl(track)` | audio URL for `<audio src>` |

Big binary blobs (cover art, audio) are **never** sent over RPC — the webview loads `http://…?X-Plex-Token=…` URLs directly as `<img src>` / `<audio src>` (no CORS issue for plain media GETs).

## Step 5 — `rpc-schema.ts`

Single Electrobun RPC schema both sides import. Bun handles requests; webview sends them. No webview→bun messages yet (slot reserved for later player events).

```ts
export type PlexRpc = defineElectrobunRPC<{
  bun: {
    requests: {
      // auth lifecycle
      beginAuth:      { params: void; returns: { authUrl: string; pinCode: string } };
      cancelAuth:     { params: void; returns: void };
      selectServer:   { params: { clientIdentifier: string }; returns: void };
      getAuthState:   { params: void; returns: { authenticated: boolean; hasServer: boolean; account?: PlexAccount; server?: PlexServerInfo } };
      disconnect:     { params: void; returns: void };
      // account + servers
      getAccount:        { params: void; returns: PlexAccount };
      getServers:        { params: void; returns: PlexServerInfo[] };
      checkServerStatus: { params: void; returns: boolean };
      // browse
      getMusicSections: { params: void; returns: PlexSection[] };
      getArtists:       { params: { sectionKey: string; opts?: BrowseOptions }; returns: PlexArtist[] };
      getAlbums:        { params: { sectionKey: string; opts?: BrowseOptions }; returns: PlexAlbum[] };
      getTracks:        { params: { sectionKey: string; opts?: BrowseOptions }; returns: PlexTrack[] };
      getPlaylists:     { params: void; returns: PlexPlaylist[] };
      // detail
      getAlbum:    { params: { ratingKey: string }; returns: { album: PlexAlbum; tracks: PlexTrack[] } };
      getPlaylist: { params: { key: string }; returns: { playlist: PlexPlaylist; tracks: PlexTrack[] } };
      getArtist:   { params: { ratingKey: string }; returns: { artist: PlexArtist; genres: string[]; albumCount: number; songCount: number; topTracks: PlexTrack[]; albums: PlexAlbum[] } };
      // home
      getRecentlyPlayed: { params: void; returns: PlexHubItem[] };
      getMostPlayed:     { params: { sinceMs?: number }; returns: PlexHubItem[] };
      // search
      search: { params: { query: string }; returns: { artists: PlexArtist[]; albums: PlexAlbum[]; tracks: PlexTrack[] } };
      // playback
      streamUrl: { params: { ratingKey: string }; returns: string };
      scrobble:  { params: { key: string }; returns: void };
    };
    messages: {};
  };
  webview: { requests: {}; messages: {} };
}>;
```

## Step 6 — wire `src/bun/index.ts`

- On startup: `loadConfig()`; hold a null client if no server.
- Create the `BrowserWindow` (already exists), capture its webview for RPC transport.
- Build `rpc = createRPC({ requestHandler: { … } })` with one handler per schema entry; each delegates to a module-level `PlexClient` instance (lazily created after auth completes).
- `beginAuth`: create PIN, return `{authUrl, pinCode}`, start `waitForPin` in background with the cancellable signal. On resolve: save config, fetch `getAccount`, leave server selection to the user.
- `selectServer`: save to config, instantiate `PlexClient`, the view advances to main app.
- **Set `maxRequestTime` to ~60_000** on the RPC config — Plex calls can take >1 s on remote servers; the default 1000 ms will time out.
- Startup routing via `getAuthState`:
  - No config → Auth Welcome
  - `token` but no `server` → Auth Server Selection
  - `token` + `server` → main app

## Step 7 — `src/mainview/plex.ts`

Thin typed wrapper:

```ts
import { Electroview } from "electrobun/view";
import type { PlexRpc } from "../bun/plex/rpc-schema";
const rpc = Electroview.rpc<PlexRpc>();   // confirm exact API against Electroview docs at impl time
export const plex = {
  beginAuth: () => rpc.request.beginAuth(),
  getAccount: () => rpc.request.getAccount(),
  getAlbums: (sectionKey, opts) => rpc.request.getAlbums({ sectionKey, opts }),
  // …one line per schema request
};
```

If `Electroview.rpc` requires the schema at the preload boundary, add a preload entry — confirm against the Electroview class docs during implementation. The view already imports from `electrobun/view` per `llms.txt`.

## Out of scope (flag, don't block)

- **Player state machine** (queue, current track, shuffle, repeat, seek). UI concern; client provides `streamUrl` + `scrobble` only. Player state belongs in a separate `src/bun/player.ts` later.
- **Caching / offline.** Responses fetched fresh each time. In-memory cache can be layered into `client.ts` later without changing the schema.
- **Multiple simultaneous servers.** Auth discovers all owned servers; this plan auto-picks one via `selectServer`. A server-picker UI later can re-offer the list.
- **Webview RPC transport details.** Exact `Electroview.rpc` wiring should be confirmed against Electrobun docs (quick-start mentions RPC; deep API page 404s). If `Electroview` exposes a different shape, only `src/mainview/plex.ts` + `rpc-schema.ts` change — the client itself is transport-agnostic.

## Implementation order

1. `types.ts` (incl. `PlexAccount` with email/verified, `PlexServerInfo`) + `url.ts` — pure, no I/O; fastest to validate.
2. `config.ts` (persisting `account` + selected `server`).
3. `auth.ts` (cancellable `waitForPin`).
4. `client.ts` — auth support first (`getAccount`, `discoverServers`, `checkServerStatus`, `getServers`); then browse/detail; then search/home; then playback.
5. `rpc-schema.ts` (auth + server lifecycle RPCs included).
6. Wire `src/bun/index.ts` — auth state machine + all handlers; bump `maxRequestTime`.
7. `src/mainview/plex.ts` view-side wrapper.
8. Manual smoke test: launch app, auth, hit each RPC method from the view console.
