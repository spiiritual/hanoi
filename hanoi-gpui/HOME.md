# Hanoi home screen - gpui port spec

`DESIGN.md` covers the auth flow. This document covers the screen the app
lands on after sign-in: the authenticated shell (sidebar + topbar) and the
Plex **Home** dashboard, plus the artwork cache that feeds every card.

Like `DESIGN.md`, the React + CSS sources are the ground truth for anything
this spec leaves out. Never eyeball a measurement — transcribe it.

| Concern | Reference file |
| --- | --- |
| Shell layout, topbar, view placeholders | `../src/mainview/home/home-screen.tsx`, `HomeScreen.css` |
| Dashboard, hub rows, cards, category view | `../src/mainview/home/home-content.tsx`, `HomeContent.css` |
| Row/card copy helpers, music filtering | `../src/mainview/home/utils.ts` (tests: `../tests/home/utils.test.ts`) |
| Load/generation semantics | `../src/mainview/home/state.ts` (tests: `../tests/home/state.test.ts`) |
| Sidebar | `../src/mainview/sidebar/sidebar.tsx`, `Sidebar.css`, `utils.ts` |
| Icons | `../src/mainview/components/icon.tsx`, `server-icon.tsx` |
| Hub endpoints and composition | `../src/bun/plex/client.ts` |
| Artwork cache semantics | `../src/bun/plex/artwork/{cache,fetcher,types}.ts`, `../src/mainview/artwork/index.ts`, `../src/bun/index.ts` (`getArtwork`, `getAccountArtwork`) |
| Design tokens | `../src/mainview/styles/global.css` |

## Scope

**In:** the shell chrome (sidebar, topbar), the Home dashboard (hub rows,
cards with cached artwork, "See all" category view) and its loading / error /
empty / retry states, the server switcher in the sidebar, and the artwork
cache.

**Out (keep the placeholders the React app already shows for them):** search
results and text entry, the Artists / Songs / Playlists library screens, the
artist and playlist detail screens, and the player bar. Selecting one of those
views renders `.home-shell-placeholder` with the copy from `shellViewCopy`
in `home-screen.tsx`, exactly as the React app does before those slices land.
Track cards still render their hover play button (visual parity) but clicking
it does nothing until the player is ported.

The Albums view, the album detail screen, opening an album from any album
card and the topbar's Back / Forward have landed since; `ALBUM.md` is their
spec.

## Backend contract

Already declared in the crate; the signatures are fixed:

* `crate::plex::{Hub, HubItem, Section, get_home_hubs, get_home_hub_items, get_music_sections}`
  — `src/plex/hubs.rs`.
* `crate::artwork::{ArtworkStore, ArtworkKey, Namespace, Source, Variant, Credentials, FALLBACK_VARIANT}`
  — `src/artwork/`.

Both are blocking; the UI calls them from `cx.background_spawn`.

### Hubs

`get_home_hubs` reproduces `PlexClient.getHomeHubs()` with no identifiers:

1. `GET /hubs` (global) and `GET /library/sections` -> music sections
   (`type == "artist"`).
2. No music sections -> return the global hubs.
3. Otherwise `GET /hubs/sections/{key}` per music section, plus the mixed
   recently-played preview (`getRecentlyPlayedForSections`: per section, types
   8/9/10 from `/library/sections/{key}/all?viewCount%3E=1&type=N&sort=lastViewedAt:desc`,
   de-duplicated by `ratingKey`, sorted by `lastViewedAt` descending).
4. `composeHomeHubs(sectionHubs, globalHubs)` then
   `replaceRecentlyPlayedPreview(...)` — port both functions verbatim,
   including the `music.recent.played.` prefix rule.

Requests carry `Accept: application/json` and `X-Plex-Token: {server token}`;
a non-2xx status or a non-JSON content type raises
`Plex request failed: {status} {reason} for {path}` — the message
`client.ts` throws. Items that fail validation are dropped with a log line,
never propagated as an error (`filterItems`).

The per-section fan-out may run on `std::thread::scope` so a library with
several sections does not serialise every request.

### Artwork cache

Mirror `cache.ts`'s semantics with these constants:

| | value |
| --- | --- |
| memory LRU (weak refs to decoded frames) | 100 entries |
| disk entries | 1000 |
| disk bytes | 100 MB |
| max object bytes | 25 MB |
| fresh TTL | 7 days |
| stale-while-revalidate | 30 days |

* **Key**: `sha256(account_id \0 server_id \0 canonical source \0 canonical variant)`,
  hex. `canonical source` trims, rejects control characters and anything
  matching `x-plex-token` (including percent-decoded forms, as
  `containsTokenMaterial` / `assertSafeSourceQuery` do) — a rejected source
  yields `None`, never a fetch. Tokens never reach a key, a filename or a URL.
* **Disk layout**: `<root>/objects/<key>.bin` for the bytes and
  `<root>/objects/<key>.json` for `{namespace, source, variant, byte_size,
  content_type, etag, last_modified, fetched_at, validated_at,
  last_accessed_at}`. Write both atomically (temp file + rename). Build the
  LRU accounting from a directory scan the first time the store is used; a
  sidecar without its object (or vice versa) is deleted.
* **Lookup**: memory -> disk. Fresh (`now - validated_at < 7d`) serves without
  the network. Stale but inside the SWR window serves the cached bytes and
  revalidates in the background. Past the SWR window revalidates inline:
  `If-None-Match` / `If-Modified-Since`; 304 refreshes `validated_at` and
  keeps the object, 200 replaces it.
* **Fetch**: `Variant::Native` -> `{base}{path}` (or the path itself when it
  is already absolute); `Variant::Transcoded` ->
  `{base}/photo/:/transcode?width=W&height=H&url={path}` with the path
  percent-encoded, matching `buildArtworkUrl`. Headers: `Accept: image/*`,
  `X-Plex-Token` only for relative sources (an absolute URL is fetched
  without it, exactly like `fetchArtwork`), plus the conditional validators.
  `Source::Account` fetches from plex.tv with the account token, reusing the
  `accountArtworkSource` normalisation.
* **Validation**: the response must carry an `image/*` content type from the
  `IMAGE_MIME_TYPES` allowlist and a non-empty body no larger than the object
  cap; anything else is an error and nothing is cached.
* **Eviction**: least-recently-accessed first, until both the entry count and
  the byte budget fit. `clear_namespace` drops every object of one namespace
  (used on sign-out and on a server switch).
* **Dedupe**: concurrent loads of the same key must collapse onto one fetch —
  a per-key lock is enough since every caller is already on a background
  thread; the loser re-checks the memory cache after acquiring it.
* **Decode**: to the BGRA frame gpui renders, exactly like `decode_avatar` in
  `src/ui/auth/mod.rs` (`image::load_from_memory(..).into_rgba8()`, swap
  channels 0 and 2, `RenderImage::new(vec![Frame::new(rgba)])`). Decoded
  frames — not the raw bytes — are what the memory LRU holds, and it holds them
  **weakly** (`Weak<RenderImage>`): `peek` upgrades and reports a miss for a
  frame whose owner has released it, dead entries are pruned as they are
  noticed, and the 100-entry cap is only a bound on the map, not a memory
  budget. See **Artwork size and memory budgets** for why there can be exactly
  one owner.

Cache root: `HANOI_ARTWORK_CACHE` when set, otherwise
`<cache dir>/hanoi-gpui/artwork` (macOS: `~/Library/Caches/hanoi-gpui/artwork`).

Namespaces follow `../src/bun/index.ts`: server artwork uses
`account.username` (falling back to the config's `clientIdentifier`) and the
server's `clientIdentifier` (falling back to its token-free, query-free URL);
account artwork uses the same account id with the server id `plex-account`.

## UI

The shell is `Screen::Home` in `src/ui/root.rs` — it replaces the placeholder
in `src/ui/home.rs`, which becomes the `src/ui/home/` module.

Layout (`.app-shell`): a full-window row, `bg`, min width 920, holding the
240px sidebar and `.home-main` (a column: the 64px topbar, then
`.home-content`, which scrolls vertically with 28px side padding and 28px at
the bottom). The player bar is out of scope, so `.home-main` takes the full
height rather than `calc(100% - 88px)`.

### Scrolling

Neither scrolling surface uses gpui's built-in overflow scrolling; both keep a
tracked `ScrollHandle`, clip with `overflow_hidden`, and are driven by
`ui::scroll`. gpui has no notion of a gesture — it applies every event to
whichever axis an element can scroll — so a two-finger swipe, which is never
perfectly axis-aligned, scrolled the page *and* nudged whichever
`.home-hub-cards` strip was under the pointer. `restrict_scroll_to_axis` does
not fix that: it only stops a delta being repurposed onto the other axis, while
the jitter comes from the gesture's real horizontal component.

`ui::scroll::Gesture` is the browser behaviour instead: the first event that
clearly favours one axis locks the whole gesture to it, released on
`TouchPhase::Ended` or after 150 ms of quiet (a mouse wheel reports no phases).
Both surfaces share one lock, so a sideways flick can never also creep the page.
The handle still gives gpui everything it clamps and records — `max_offset`,
`bounds` and each child's bounds — which is what the scrollbars and the artwork
viewport gate read.

### Artwork size and memory budgets

Cards request `Variant::Transcoded { width: 280, height: 280 }` — the 140px art
tile at 2x, transcoded by Plex — where `artwork-image.tsx` requests the native
object and only falls back to a transcode. The reference runs in a browser,
which decodes an image at the size it draws; gpui keeps the decoded frame *and*
its atlas texture at the image's own resolution, so a native 3000x3000 cover
costs ~36 MB of pixels to fill a 140px box. Measured on a real library, this
one change took the app's physical footprint from 389 MB to 126 MB.

**One owner per frame.** `RenderImage` has no `Drop`: its texture lives in the
window's sprite atlas until `Window::drop_image` removes it, so exactly one
place may own a decoded frame and decide when it dies — the shell's slot map in
`src/ui/home/state.rs`, bounded by `MAX_SLOTS` *and* `MAX_SLOT_BYTES` (64 MB).
It budgets in **bytes** (`crate::artwork::frame_bytes`) because a decoded cover
ranges from ~360 KB to ~36 MB, so an entry count bounds nothing. The store's
memory LRU holds `Weak<RenderImage>`, which is what makes the slot map's budget
the resident set rather than half of it, and what makes `Arc::strong_count == 1`
a trustworthy "nobody can paint this any more" test. The disk cache is the real
second tier: a 23 KB JPEG re-decodes in about a millisecond.

**Released a screen at a time.** The atlas hands out 1024x1024 BGRA slabs (4 MB)
and frees one only when every tile in it has been released. A 280x280 cover
tiles 3x3, so ~9 covers share a slab — and the covers that share one are the
ones that were loaded together, which is to say the ones on the same screen.
Evicting one frame here and one there therefore reclaims nothing: it leaves every
slab half full. So each slot is tagged with the `Surface` it was last needed on
(the Home dashboard, one "See all" category identified by its hub, a library
view — the Albums grid carries frames, the placeholders none — or one album's
detail screen identified by its rating key; artist and playlist screens will add
a variant each), stamped by every `insert` and `touch`. See `ALBUM.md`,
"Artwork", for the album cover's own variant and the grid -> album -> Back
cohorts. `ArtworkState` keeps the **current and previous** surfaces
warm — back and forward make a rapid return likely — and releases every older
cohort at once. The byte budget stays **global**: warmth is a policy about which
frames occupy the 64 MB, never a licence to exceed it, so a warm previous screen
costs nothing above the cap and yields its headroom to the current screen under
pressure.

**Draining the release queue.** `Window::drop_image` needs a `&mut Window` that
no eviction path has (a background load finishing, `clear()` on a server switch),
so all three release paths — cohort release on a transition, LRU/byte-budget
eviction in `prune`, and `ArtworkState::clear` — push the frame onto a queue on
`ArtworkState` instead. `ensure_artwork` drains it at the top of the render pass,
before the element tree is built, so nothing dropped can still be painted this
frame. Only a frame the queue holds the last reference to is dropped
(`Arc::strong_count == 1`); anything still shared stays queued and is offered
again on a later frame rather than being dropped blind.

Measured live on a real library, leaving Home for two library views releases the
dashboard's 26 covers and takes `vmmap -summary`'s `IOAccelerator (graphics)`
resident figure from **21.2 MB to 9.1 MB** (60 regions to 57). The same run with
the `drop_image` call skipped — every frame still dropped from the slot map —
stays at 21.2 MB and 60 regions: nothing reclaims an atlas tile on its own.

### Rows and cards

`.home-hub-rows` is a 30px-gapped column of rows. Each row: a 28px heading
(20px/600 title on the left, the accent "See all" button on the right when
`shouldShowHomeHubSeeAll`), then `.home-hub-cards` — a horizontally
scrolling strip of 150px columns, 12px gaps, `padding: 8px 3px 16px` with the
matching negative margins. The CSS hides the browser's scrollbar here
(`scrollbar-width: none`); this port draws its own instead — see
**Scrollbars** below.

**Card sizing is the one measurement that departs from the CSS.** Six 150px
cards overflow the 1200px window's strip by 56px, which bought a third of a
card's worth of scrolling and a scrollbar that looked like a divider. The card
box is 140px here and its art 130px, keeping the CSS's `card = art + 10`: that
10px is what gives `.home-hub-card::before` its 8px of clearance around the
artwork (it insets only 3px horizontally), so collapsing it makes the hover halo
hug the tile. The result fits — 6x140 + 5x12 gaps + 6px padding = 906px against a
910px viewport — with the halo geometry, the 22px between tiles and the 6px
between halos all identical to the reference. A narrower window still overflows,
and the strip scrolls and earns its bar again.

Each card is `CARD_WIDTH` wide: an `ART_SIZE` square art tile (radius 10, the
`linear-gradient(135deg, #363640, #1f1f27)` placeholder underneath, a
`rgba(255,255,255,0.08)` inner hairline on top, artwork drawn with
`ObjectFit::Cover`), then a 140px text column (14px/600 title over a
12px/400 tertiary meta line, both single-line with an ellipsis). Hovering a
card fades in the `surface-2` halo that `.home-hub-card::before` paints at
`inset: -8px -3px` with radius 8. Track cards additionally reveal the 34px
accent play button in the tile's bottom-right corner.

Card art requests `Variant::Native` first; if that load fails, retry once with
`FALLBACK_VARIANT`, mirroring the renderer's `attempt` logic. Until an image
arrives the fallback glyph is the title's first character upper-cased, or `♪`
for an empty title (28px/700, tertiary).

The meta line comes from `homeHubItemMeta` in a row and
`homeCategoryItemMeta` in the category view — port both (and
`filterMusicHomeHubs`, `homeHubItemInteraction`, `shouldShowHomeHubSeeAll`,
`HOME_HUB_PREVIEW_SIZE`) into `src/ui/home/utils.rs` with unit tests that
mirror `../tests/home/utils.test.ts`.

Single-line ellipsis in gpui needs
`.w_full().overflow_hidden().whitespace_normal().text_ellipsis().line_clamp(1)`
inside a `flex_1().min_w_0()` column — `.truncate()` only clips (this bit the
server-selection screen already).

### Scrollbars

**A deliberate deviation.** `HomeContent.css` hides the scrollbars a browser
would otherwise put on `.home-hub-cards` (`scrollbar-width: none` plus the
`::-webkit-scrollbar` rule) and `.home-content` never had one, because the
reference app is driven with a trackpad. A mouse wheel has no horizontal axis:
with the strips locked to the gesture's own axis (see **Scrolling** above), a
plain mouse can only move a row with shift+wheel. So the port
adds an overlay scrollbar to every `.home-hub-cards` strip and to
`.home-content`. There is no design source for it; it is built from `theme.rs`
tokens only (`SCROLLBAR_THUMB`, `SCROLLBAR_THUMB_ACTIVE` — the same neutral
white washes as `CARD_ART_HAIRLINE`) in the spirit of a macOS overlay bar.

`src/ui/scrollbar.rs` is the whole implementation; gpui core ships no scrollbar
element (Zed's lives in its own `ui` crate).

* **Only when there is something to scroll.** A thumb longer than
  `MAX_THUMB_FRACTION` (85%) of its track draws nothing at all. A six-card row
  overflows by 56px of 966px, so a proportional thumb would fill 94% of the
  track: a full-width rule between two rows, offering a third of a card's worth
  of travel. That is the same judgement `HomeContent.css` makes by hiding these
  bars outright, and it reverses by itself — give a row more cards (a larger
  `count` from Plex) and its bar appears. `.home-content`, whose thumb is
  typically about 46% of its track, always has one.
* **Overlay, never inline.** The bar is an absolutely positioned sibling of the
  scroll container inside a `relative()` wrapper, so revealing it cannot move a
  card. On a row it is drawn inside the 16px the strip already reserves for the
  hover halo. It hangs `ROW_TRACK_OFFSET` past that box rather than sitting
  inside it: drawn against the padding the 4px thumb ends up 8px under the meta
  text and reads as an underline for the row, where the 30px gap between rows
  leaves room to sit 14px below the text and 20px above the next heading. On `.home-content` it sits in the 28px side
  padding. The row's negative margins move from the strip to that wrapper so the
  wrapper's box is exactly the strip's border box — the bar then lines up with
  the viewport the scroll handle reports, and the row's height is unchanged.
* **Geometry** comes from the tracked `ScrollHandle`s the artwork gate already
  keeps (`root.artwork.row_scroll(index)` and `content_scroll`); no new handles.
  `metrics()` is pure: thumb = viewport²/content, floored at 28px, positioned at
  `offset / max_offset` of the leftover track. It is measured from the
  *previous* frame's `bounds()` / `max_offset()`, so `Root::ensure_scrollbars`
  asks for one more frame while any container is still unmeasured.
* **Hidden when the content fits** — `max_offset <= 0` renders nothing at all.
  A row that barely overflows gets a thumb that nearly fills its track, which is
  correct: with six 150px cards in a 1200px window a row overflows by ~56px and
  the thumb is ~857px of a 910px track.
* **Revealed on hover** of the whole row (or of the content area) with a
  `group_hover`, and pinned visible for as long as a drag lasts, even once the
  pointer has left. The track is not `occlude`d: a blocking hitbox would take
  the row's own hitbox out of the hover test and the bar would flicker off as
  soon as you pointed at it.
* **Dragging** maps the pointer's travel along the track onto the whole
  scrollable range; **clicking the bare track** pages one viewport toward the
  click. A `div`'s `on_mouse_move` only fires while its own hitbox is hovered,
  so the drag is resolved by the window-level listeners a `canvas` registers
  through `Window::on_mouse_event`, mounted only while a drag is in flight.
  Cursor is `pointer`, like every other control in the app.

### Sidebar

`Sidebar.css` verbatim: 240px wide, `--sidebar-bg` `#0e0e13`, 14px/16px
padding. Home nav item, the "Your Library" group (collapsible, remembers its
state for the session, default open) with Albums / Artists / Songs /
Playlists sub-items, a flexible spacer, the server selector (48px, `surface`,
opening a menu above it listing the discovered servers with their
online/offline status and a checkmark on the selected one, plus
"Add a server…"), and the account footer (32px gradient avatar or the loaded
account thumb, username, inert settings button).

Opening the menu runs `plex::discover_servers` on a background thread
(`refreshServers`); picking a server persists it as `config.server`, clears
the artwork namespace of the old server, and reloads the dashboard from
scratch. "Add a server…" returns to the auth flow's server-selection stage.

### Topbar

`.home-topbar`: 64px tall, 28px side padding, 16px gaps. Back and forward
icon buttons (enabled only while there is an album to go back from or forward
to — see `ALBUM.md`, "Topbar"; disabled otherwise), the 280px search pill (magnifier icon + "Search songs, albums, artists" placeholder,
`cursor: text`) rendered inert because text input is out of scope, a
flexible spacer, then the disabled queue and notification buttons.

### Icons

Every icon is a 24x24 stroke SVG transcribed from the `<Icon>` children in
the React sources (`fill=none`, `stroke=currentColor`, width 2, round caps and
joins), bundled in `assets/icons/` and registered in `Assets` in
`src/ui/mod.rs` like the existing four. gpui paints an SVG as a single-colour
mask, so tint with `.text_color(..)`.

### States

Straight from `HomeDashboard`, except loading:

* loading -> no copy: the dashboard grows to fill `.home-content` and centres
  the 28px loading spinner (`Loading Spinner` in `plex.pen`,
  `components::loading_state`) where the reference says "Loading your Plex
  home…". Every content area of the shell does the same while it loads. The
  spinner only appears once the load has lasted **300ms**, fading in over
  **150ms** (`components::delayed_loading_spinner`); it holds its place from
  the first frame, so nothing moves when it shows, and a faster load never
  shows it at all.
* error -> `.home-state.is-error` "Couldn't load your Plex home: {message}"
  plus the "Try again" button, which re-runs the load
* ready with no music rows -> `.home-empty` ("No music rows yet" / "Plex has
  not returned any music recommendations for this server.")
* ready -> the rows

"See all" replaces the dashboard with `HomeCategory`: the hub title, then
every item from `get_home_hub_items(hub.key)` as category cards — except for a
`music.recent.played.` hub, whose preview items are used as-is. While it
loads, the title stays and the centred spinner fills the space below it instead
of the reference's "Loading…" banner. Its empty ("No items in this category.")
and error ("Couldn't load this category: {message}") states live in
`.home-category-status`. Leaving Home (any sidebar nav) clears the category,
exactly like `changeView`.

### Load semantics

Port `state.ts`'s guards: a generation counter per server, a load started on
entering Home (and after a server switch), `ready` never re-fetched, in-flight
requests shared, and a stale response never mutating state. Everything runs
off the main thread and applies through `this.update(cx, ..)` + `cx.notify()`.

## Preview mode

Extend `HANOI_PREVIEW` (no network, no config file) with:

| value | state |
| --- | --- |
| `home` | the dashboard with sample rows: "Recently Played" (6 mixed items), "Recently Added" (6 albums), "Your Playlists" (3 playlists, so no "See all") |
| `home-loading` | the loading state: the centred spinner |
| `home-error` | "Couldn't load your Plex home: fetch failed" plus Try again |
| `home-empty` | the empty state |
| `home-category` | the "See all" category view for "Recently Added" |
| `home-category-loading` | that category still loading: its title over the centred spinner |
| `home-library` | the Artists placeholder, so the sidebar's active state is visible (Albums has its own stages in `ALBUM.md`) |
| `home-scrollbar` | the `home` dashboard with every overlay scrollbar pinned visible (they are hover-revealed, and a screenshot cannot hover) |

Sample cards have no artwork, so they exercise the fallback glyphs. The
`*-loading` stages only show their spinner once the capture delay is past its
300ms delay and 150ms fade; the default 1.5s is.
`HANOI_SCREENSHOT=/path.png` still captures and quits.

## Verification

* `cargo test` — utils, hub composition, cache keys/eviction/revalidation,
  namespace derivation.
* `HANOI_PREVIEW=home HANOI_SCREENSHOT=/tmp/home.png cargo run` and the other
  preview stages, compared against the CSS.
* A live run against a real server for the artwork path (cold cache, then a
  restart to prove the disk cache is hit).
