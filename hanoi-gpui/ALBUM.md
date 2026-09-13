# Hanoi album screens - gpui port spec

`DESIGN.md` covers the auth flow and `HOME.md` the shell and the Home dashboard.
This document covers the two album screens: the sidebar's **Albums** view
(`AlbumLibrary`) and the **album detail** screen (`AlbumDetail`), plus the album
half of the shell's back/forward navigation.

As before, the React + CSS sources are the ground truth for anything this spec
leaves out. Never eyeball a measurement — transcribe it.

| Concern | Reference file |
| --- | --- |
| Both screens, copy, formatters | `../src/mainview/album/album-screen.tsx` |
| Every measurement | `../src/mainview/album/AlbumScreen.css` |
| Navigation (`openDetail`, `closeDetail`, `reopenDetail`, `changeView`), topbar back/forward | `../src/mainview/home/home-screen.tsx`, `HomeScreen.css` (`.topbar-icon`) |
| Album cards (`MediaCard` with `category`) | `../src/mainview/home/home-content.tsx` |
| `getAlbums`, `getAlbum`, `buildBrowsePath`, `parseMetadata` | `../src/bun/plex/client.ts` |
| `albumSchema`, `trackSchema` | `../src/bun/plex/schemas.ts` |
| Design tokens | `../src/mainview/styles/global.css` |

## Scope

**In:** the Albums view (filter tabs, "Recently added" grid of album cards with
cached artwork, loading / error / empty / retry), the album detail screen
(cover, title, artist, meta line, action row, track list, loading / error /
empty / retry), opening an album from any album card (Home rows, a "See all"
category, the Albums grid), the topbar's Back and Forward buttons for albums,
and the backend calls behind them.

**Out:**

* **The player.** Play, Shuffle and the track rows render with full visual
  parity (hover states, disabled state when there are no tracks) but only log
  the request (`Root::play_album`, `Root::play_album_track`). The states that
  need a player — "Playing", the pause glyph, the accent current row and the
  spectrum bars — are never shown.
* Like and "More album actions" are inert (they are inert in React too).
* The sort control is a static label (it is in React too).
* Artist and playlist detail screens: artist and playlist cards still do not
  open anything; the Artists / Songs / Playlists tabs switch to those views'
  placeholders.
* Search, and therefore opening an album from search results.

## Backend contract — `src/plex/library.rs`

Signatures are fixed (see the file); all blocking, called from
`cx.background_spawn`. Reuse `hubs.rs`'s `request` (the `Accept` /
`X-Plex-Token` headers and the reference's error messages), `parse_container`
(per-item validation that drops and logs a malformed item) and the
`lenient_*` number deserialisers, which are `pub(super)` for this.

* `Album` mirrors `albumSchema`, `Track` mirrors `trackSchema`: `key`,
  `ratingKey`, `title` and the `type` literal are required; everything else is
  optional and numbers are read leniently (`1.0` is a valid `year`). An item
  whose `type` is not the literal is dropped, not an error.
* `get_albums(server, section_key, sort)` —
  `GET /library/sections/{key}/all?type=9&sort={sort}`, the query encoded exactly
  as `URLSearchParams` would (`addedAt:desc` -> `sort=addedAt%3Adesc`), omitting
  `sort` when it is `None` or empty. `Metadata[]` validated as albums.
* `get_album(server, rating_key)` — `getAlbum`:
  1. `GET /library/metadata/{ratingKey}`. Like `parseMetadata`, the first
     item's `type` decides the schema; only when it is `"album"` are the items
     validated as albums, and the first valid one is the album.
  2. `GET /library/metadata/{ratingKey}/children`, `Metadata[]` validated as
     tracks (non-tracks dropped), in Plex's order.
  3. With no album found, the album is the reference's placeholder:
     `{ key: "", ratingKey, title: "", type: "album" }` and nothing else.

  The two requests may run concurrently (`std::thread::scope`); either failing
  fails the call.
* `get_library_albums(server, sections)` — `AlbumLibrary`'s load:
  `get_albums(section.key, Some(RECENTLY_ADDED_SORT))` for every section, in
  parallel; any failure fails the whole load (`Promise.all`). Results are
  merged the way a JS `Map<ratingKey, album>` merges them: **order of first
  occurrence, value of the last occurrence**. No sections -> `Ok(vec![])`
  without a request.
* `Album::to_hub_item` — the `HubItem` `MediaCard` receives: same
  `rating_key`, `key`, `title`, `thumb`, `parent_title`, `parent_rating_key`,
  `year`, `leaf_count`, `view_count`, and `item_type: "album"`.
* `Album::from_hub_item` — its inverse: the album a clicked album card already
  describes (the same nine fields; hub-only fields are dropped). It seeds the
  detail screen (see "Album detail").

Unit tests: payload parsing (required fields, lenient numbers, wrong `type`
dropped), the browse path encoding, the metadata-type rule, the placeholder
album, and the merge order. An `#[ignore]`d live smoke test like
`live_home_hubs_load_from_the_configured_server` (never print the token).

## UI

`src/ui/album/`: `mod.rs` (dispatch), `library.rs`, `detail.rs`, `state.rs`,
`actions.rs`, `utils.rs`, `preview.rs`. `home/mod.rs` renders
`album::render` for `View::Albums`; it shows the detail when
`root.home.albums.selected` is set and the library grid otherwise.

**Loading states are a spinner, not copy.** Wherever the reference renders a
loading line ("Loading albums…", "Loading album…"), the port draws
`components::loading_state` instead: `loading_spinner` — the `Loading Spinner`
component in `plex.pen`, a 28px `SPINNER_TRACK` ring with an `ACCENT` quarter
arc (3px stroke) turning once a second — centred in whatever height its column
has left. Every ancestor up to `.home-content` grows (`flex_1`) while it is
shown, and only then. The Pen frames `Plex Music Library - Albums - Loading`
and `Plex Music Album - Loading` are the reference. Error and empty states keep
their copy.

**The spinner is delayed.** `components::delayed_loading_spinner` (what
`loading_state` centres) is invisible for the first **300ms** after it first
renders, then fades in over **150ms** — a one-shot gpui `with_animation` on
its wrapper's opacity, keyed by an id derived from the caller's (distinct from
the rotation's). It occupies its 28px from the first frame, so nothing moves
when it appears; a load that settles sooner never shows a spinner at all. The
animation's start is element state: it holds its final value for as long as
the spinner keeps rendering, and a spinner that was not rendered last frame (a
new load, a retry, another screen) starts the delay over.

Text defaults: everything not given a `line-height` below uses
`LINE_HEIGHT_NORMAL`. Colours come from `theme.rs` only: `SURFACE_2`,
`PANEL_BG` (`rgba(29,29,36,.42)`), `ERROR_BORDER` (`rgba(214,103,103,.45)`),
`ERROR` (`#f0a0a0`), `RETRY_HOVER` (`#30303a`), `ACCENT_LIGHT` (`#f3c34d`),
`CARD_ART_FROM`/`CARD_ART_TO`, `CARD_ART_HAIRLINE`. Single-line ellipses use
`components::ellipsis` inside a `flex_1().min_w_0()` column (never
`.truncate()`).

### Navigation (`home-screen.tsx`, album half)

State lives in `root.home.albums` (`AlbumsState`):

* `open_album(seed: Album)` — `openDetail("Album", item)`: the card passes
  `Album::from_hub_item(item)` (and `HANOI_START=album` the library's first
  item). Ignore an empty `seed.rating_key`; record `AlbumNavigation {
  rating_key, return_view: <current view>, return_offset: <content scroll
  offset>, seed: Some(seed) }`; clear `selected` **and** `forward`; set
  `selected`; switch the view to `Albums` **without** `change_view` (a
  category open on Home survives, exactly like the reference); scroll
  `.home-content` to the top; start the detail load.
* `close_album` (Back) — `closeDetail`: `forward = selected.take()`; view =
  its `return_view`; restore its `return_offset`. If the detail had loaded,
  the navigation's `seed` is refreshed to the loaded album (with
  `leaf_count ?? tracks.len()` filled in), so Forward's header is the freshest
  one seen; otherwise the seed it had is kept.
* `reopen_album` (Forward) — `reopenDetail`: `selected = forward.take()`
  (seed included); view = `Albums`; scroll to the top; start the detail load
  again (the reference remounts `AlbumDetail`, which refetches). The header
  renders from the seed at once, as on a first open.
* `change_view(view)` — `changeView` now also clears `selected` and `forward`,
  and scrolls `.home-content` to the top.
* A server switch clears `selected`, `forward` and the detail, and resets the
  library load (`set_server`).

**Scroll offsets are an adaptation.** The browser keeps one `scrollTop` on
`.home-content` across views (clamped to the new content); here opening a
screen starts at the top and Back returns to where you were, which is what the
reference's user actually sees when the grid is taller than the detail.

Every album card opens the album: `card::render` takes a click handler for
`item_type == "album"` items (`home-hub-card-album`), in Home rows, "See all"
categories and the Albums grid. Artist, playlist and track cards stay inert.

### Topbar (`.home-topbar`)

Back is enabled while `selected` is set and calls `close_album`; Forward is
enabled while `forward` is set and calls `reopen_album`. Enabled:
`.topbar-icon` — `TEXT_SECONDARY`, `cursor: pointer`. Disabled (unchanged):
`TEXT_TERTIARY`, default cursor. There is no hover rule in the CSS.

### Albums view — `AlbumLibrary`

`.album-library`: column, gap 20, `padding-bottom` 28, `min-width: 0`.

1. `.album-filter-tabs` — row, items centred, full width, `min-height` 32,
   gap 8:
   * four `.album-filter-tab`s, "Albums", "Artists", "Songs", "Playlists":
     height 32, `padding: 0 14px`, radius 16, `SURFACE_2` background,
     `TEXT_SECONDARY` 13px/400. The active one (Albums) is `TEXT_PRIMARY`
     background with `BG` text at 600. A non-active tab hovers to
     `RETRY_HOVER` with `TEXT_PRIMARY` text. Each calls `change_view(view)`.
   * `.album-filter-spacer` (`flex: 1`),
   * the sort icon (`icons::SORT`, 18px, `TEXT_SECONDARY`) and
     `.album-sort-label` "Recently added" (13px, `TEXT_SECONDARY`), with the
     row's 8px gap between them. Inert.
2. `.album-library-section` — column, gap 12:
   * `.album-library-title` "Recently added" — 20px/600, `TEXT_PRIMARY`.
   * the status banner, when there is a message (below),
   * `.album-grid` — the album cards, wrapping, `gap: 24px 12px` (`gap_y` 24,
     `gap_x` 12), left-aligned like `repeat(auto-fill, ...)`. Cards are
     `card::render(root, item, /* category */ true)`, so the meta line is
     `homeCategoryItemMeta` ("Album · Radiohead") and the card keeps
     `HOME.md`'s 140px / 130px sizing. The grid is `.id(..)` +
     `.track_scroll(&root.artwork.album_grid_scroll)` purely so the artwork
     gate can read each card's bounds, exactly like `.home-category-cards`.

**Status banner** (`.album-library-status`): row, items centred,
`justify-content: space-between`, gap 14, `padding: 14px 16px`, 1px
`SURFACE_2` border, radius 10, `PANEL_BG`, 13px `TEXT_SECONDARY`. Error
variant (`.is-error`): `ERROR_BORDER` border and `ERROR` text, plus the
`.album-library-retry` button on the right: `min-height` 30, `padding: 0 12px`,
radius 15, `SURFACE_2`, `TEXT_PRIMARY` 12px/600, hover `RETRY_HOVER`,
"Try again".

**Messages** — the reference derives these in a way that flashes the empty
copy while the first load is in flight (it never sets `loading` before the
first request) and styles a sections failure as an error that says "No albums
found". The port shows what those branches intend:

| sections | albums | banner |
| --- | --- | --- |
| idle / loading | any | the loading spinner (below) |
| error | any | error: "Couldn’t load your albums: {sections error}" (or "…albums." when empty); Try again re-runs the music sections load, which then loads the albums |
| ready, none | any | "No albums found in this library." |
| ready | idle / loading | the loading spinner |
| ready | error | error: "Couldn’t load your albums: {error}" / "Couldn’t load your albums."; Try again re-runs the album load |
| ready | ready, none | "No albums found in this library." |
| ready | ready, some | no banner; the grid |

Loading renders no banner: the tabs and the "Recently added" title stay, and
`loading_state` fills the space below the title where the grid will be (the
grid itself is not rendered). Copy uses the reference's typographic
apostrophe (`’`).

**Load** (`Root::load_albums`): `AlbumsState::library` is a `Load<HubItem>`
with the Home hubs' guards — one load per server, `ready` never refetched,
in-flight shared, a stale response dropped. It starts when the Albums view is
entered (`change_view(View::Albums)`, `close_album` back to Albums) and, if the
Albums view is showing, when the music sections finish loading. It does
nothing until the sections are `ready`; with no sections it finishes `ready`
and empty without a request. The work is `plex::get_library_albums`, mapped
through `Album::to_hub_item`.

Caching per server is itself an adaptation (the reference refetches whenever
`AlbumLibrary` mounts): it matches how the Home rows already behave, and it is
what makes Back from an album land on the grid instantly and where you left it.

### Album detail — `AlbumDetail`

`.album-detail`: column, gap 20, `padding-bottom` 28, `min-width: 0`.

**Loading** — an adaptation. The reference shows "Loading album…" on an
otherwise empty screen, which flashes on every open; the port renders what the
clicked card already knows instead. While the detail is idle or loading (or
has no state yet) and the navigation carries a seed
(`AlbumsState::loading_seed`), `.album-detail` is laid out exactly like the
ready screen:

* the real header (below) drawn from the seed: `album_title(seed)`,
  `album_artist(seed, &[])`, the cover tile, and the meta line
  `album_meta_loading(seed)` — `Album · 2007 · 10 songs`, with no duration
  (it needs the tracks) and no count when the seed has none;
* Play, Shuffle, Like and More at **full opacity** with their hover and
  cursor — a disabled look that lifts when the tracks arrive would be a flash
  of its own — but Play and Shuffle do nothing when clicked until the detail
  is ready;
* `.album-track-list` with the same column header row and divider as the
  ready list, over a body that reserves `leaf_count × ROW_HEIGHT` (52px, the
  row height `track_row` uses), or 160px when the seed has no count, so
  neither the header above nor the page's height jumps when the rows arrive.
  The delayed spinner is centred in a box of `min(reserved, 160px)` at the top
  of that body, not in the middle of what can be a very tall box.

When the tracks arrive, only the meta line's duration and the rows appear;
title, artist, cover, buttons, list header and divider stay put.

Without a seed (a defensive path; every card seeds its album, and only the
`album-loading-bare` preview builds one without) the screen is nothing but
`loading_state`, centred in the whole content area. Both spinners are delayed
(above).

**Error** — `.album-detail-error`: the error banner, "Couldn’t load this
album: {error}" (or "…album." when empty) and a "Try again" button styled like
`.album-library-retry` that calls `retry_album` (which resets the detail to
loading and refetches).

**Ready** — the header, then the track list.

`.album-detail-header`: row, items centred, full width, `min-width: 0`, gap 24.

* `.album-detail-art`: 200x200 (**168x168** when `root.compact`, i.e. the
  window is at most 1040px wide), `flex: none`, radius 12, `overflow: hidden`,
  `linear-gradient(135deg, CARD_ART_FROM, CARD_ART_TO)`. The cover
  (`root.album_cover_slot()`) fills it with `ObjectFit::Cover`. Until it
  arrives, the clicked card's own 280px frame of the same artwork
  (`root.album_cover_placeholder_slot()`), if the slot map still holds it, is
  drawn scaled to the tile the same way; with neither, the fallback glyph —
  the title's first character upper-cased, or `♪` — sits centred at 48px/700
  `TEXT_TERTIARY`. A 1px `CARD_ART_HAIRLINE` inner border with the same radius
  is painted on top (`::after`).
* `.album-detail-info`: column, `flex: 1`, `min-width: 0`, gap 10:
  * `.album-detail-title` — `album_title`: 32px/600 (**28px** when compact),
    `TEXT_PRIMARY`, `line-height: 1.15`. Wraps. The CSS's
    `letter-spacing: -0.5px` has no gpui equivalent and is dropped.
  * `.album-detail-artist` — `album_artist`: 16px `TEXT_SECONDARY`. Wraps.
  * `.album-detail-meta` — `album_meta` (`album_meta_loading` while
    loading): 13px `TEXT_TERTIARY`.
  * `.album-detail-actions`: row, items centred, gap 14, `padding-top` 16:
    * `.album-detail-play`: height 40, `padding: 0 20px`, gap 8, radius 20,
      `ACCENT` background, `BG` text, 13px/600; `icons::PLAY_SOLID` at 16px
      tinted `BG`, then "Play". Hover `ACCENT_LIGHT`. With no tracks it is
      disabled: opacity 0.55, default cursor, no hover, no click. While the
      tracks load it looks enabled but a click does nothing (see Loading).
    * three `.album-detail-icon-action`s — Shuffle (`icons::SHUFFLE`, disabled
      like Play when there are no tracks), Like (`icons::HEART`), More
      (`icons::MORE`): a 20x20 box with a 20px icon, `TEXT_SECONDARY`, hover
      `TEXT_PRIMARY`, disabled opacity 0.55 without hover.

`.album-track-list`: column, gap 8, `min-width: 0`.

* `.album-track-list-header`: the row grid below, `min-height` 28, 12px/600
  `TEXT_TERTIARY`: "#", "Title", and "Duration" right-aligned.
* `.album-track-divider`: full width, 1px, `SURFACE_2`.
* With no tracks, `.album-track-empty` "This album has no tracks.":
  `padding: 20px 8px`, 13px `TEXT_TERTIARY`. Otherwise the rows, stacked with
  no gap.

**Row grid** (header and rows): `16px | minmax(0, 1fr) | 60px` with a 12px
column gap and `padding: 0 8px`, items centred — in gpui a flex row: a 16px
`flex: none` cell, a `flex_1().min_w_0()` cell, a 60px `flex: none` cell with
right-aligned text, gap 12.

**`.album-track-row`**: full width, `min-height` 52 (`ROW_HEIGHT`; a row's
content is shorter, so every row is exactly that tall), radius 8, transparent,
`TEXT_PRIMARY`, pointer; hover background `SURFACE_2`. The row is a hover
group. Click -> `play_album_track(index)`.

* `.album-track-number`: 16x20, centred, 13px `TEXT_TERTIARY`. It stacks the
  index (`track.index ?? position + 1`) and the play glyph
  (`icons::PLAY_SOLID`, 14px, `TEXT_PRIMARY`) in the same box; the row's hover
  swaps them (index opacity 1 -> 0, glyph 0 -> 1). gpui cannot toggle
  `display` on hover, so both are laid out and only opacity changes.
* `.album-track-copy`: column, gap 2, `min-width: 0`:
  `.album-track-title` — the title, 14px/600, ellipsis;
  `.album-track-artist` — `track.grandparentTitle ?? artist`, 12px
  `TEXT_SECONDARY`, ellipsis.
* `.album-track-duration`: `format_track_duration`, 13px `TEXT_TERTIARY`,
  right-aligned.

**Load** (`Root::open_album` / `reopen_album` / `retry_album`): bump
`detail_run`, set `detail` to `Loading` for the rating key, run
`plex::get_album` in the background, and apply the result only if the run, the
server key and `selected`'s rating key all still match. Result -> `Ready` with
the `AlbumDetail`, or `Error` with the message. The cover load does not wait
for it: it starts in the frame the album opens, from the seed's thumb (see
"Artwork").

### Copy helpers — `src/ui/album/utils.rs`

Ported verbatim from `album-screen.tsx`, with unit tests:

* `format_track_duration(ms)`: `None` or `0` -> `--:--`; else
  `floor(ms / 1000)` seconds as `m:ss` (minutes unpadded, can exceed 59).
* `format_album_duration(ms)`: `floor(ms / 1000)` seconds split into hours,
  minutes, seconds; push `"{h} hr"` if h > 0, `"{m} min"` if m > 0, and
  `"{s} sec"` if s > 0 **or nothing has been pushed**; join with spaces
  (`0` -> `0 sec`, `3_600_000` -> `1 hr`, `3_723_000` -> `1 hr 2 min 3 sec`).
* `album_title`: the title, or "Untitled album" when empty.
* `album_artist`: `parent_title` when it is `Some` (even `Some("")`, like
  `??`), else the first track with a non-empty `grandparent_title`, else
  "Unknown artist".
* `album_meta`: `["Album", year?, "{n} song{s}, {duration}"]` joined with
  " · ", where `n = leaf_count ?? tracks.len()`, `s` is empty when `n == 1`,
  and the duration is `format_album_duration` of the tracks' summed
  `duration` (missing counts as 0).
* `album_meta_loading` (an adaptation, for the seeded loading header):
  `["Album", year?, "{leaf_count} song{s}"?]` joined with " · " — no
  duration, and no count when `leaf_count` is `None`.

### Artwork

Two new consumers of the slot map in `home/state.rs`:

* **Grid cards** use the card variant (`CARD_VARIANT`, 280x280) and the same
  viewport gate as the category grid: `visible_artwork_paths` gains the Albums
  grid (`root.artwork.album_grid_scroll`, the library's items) when the view
  is `Albums`, no album is selected and the library is `ready`.
* **The detail cover** requests `Variant::Transcoded { width: 400, height: 400 }`
  (the 200px tile at 2x), falling back to `FALLBACK_VARIANT` like a card. It is
  not viewport-gated (`priority` in the reference). `AlbumsState::cover_path`
  is the seed's non-empty `thumb` while the detail is pending and the loaded
  album's once it is `ready`, so the load starts in the frame the album opens,
  in parallel with `get_album`. For an album opened from a card the two thumbs
  are the same path, so the key is identical and nothing reloads when the
  detail arrives.
* **The cover placeholder** is the clicked card's frame: the same path at
  `CARD_VARIANT` (`Root::album_cover_placeholder_key`, beside
  `album_cover_key`). When the album opens, the card's screen has just become
  the previous surface, so that frame is still in the slot map. While an album
  detail is showing, `ensure_artwork` `touch`es it if it is there, moving it
  into the album's cohort; it never **starts** a load for it — only a frame
  that is already present is reused.

**Cohorts.** `Surface` gains `Album(SharedString)` (the rating key), and
`home_surface()` returns it while an album is selected; the Albums grid is the
existing `Surface::Library(View::Albums)`, which now carries frames. Every
navigation above calls `enter_artwork_surface()`, so grid -> album -> Back
keeps both screens warm and a third screen releases the oldest.

## Preview mode

`HANOI_PREVIEW` gains (sample data, no network):

| value | state |
| --- | --- |
| `albums` | the Albums grid with 16 sample albums (three rows at 1200px) |
| `albums-loading` | the tabs and title over the centred loading spinner |
| `albums-error` | "Couldn’t load your albums: fetch failed" plus Try again |
| `albums-empty` | "No albums found in this library." |
| `album` | the detail screen for `album::preview::sample_detail()`, Back enabled |
| `album-loading` | the seeded loading state: the sample album's header from its card (`album::preview::sample_card()`), meta line `Album · 2007 · 10 songs`, the list header and divider over 10 reserved rows, and the delayed spinner near their top |
| `album-loading-bare` | loading with no seed: only the delayed spinner, centred in the content area |
| `album-error` | "Couldn’t load this album: fetch failed" plus Try again |
| `album-empty` | a ready album with no tracks: the empty list, Play and Shuffle disabled |

`home-library` now shows the Artists placeholder, since Albums is no longer
one.

For a live run, `HANOI_START=albums` enters the Albums view once the shell
opens, and `HANOI_START=album` also opens the first album of the library once
it has loaded — the app cannot be clicked by automation, so this is how the
live screens are reached for a screenshot.

## Verification

* `cargo test` — the backend parsing/merge tests, the copy helpers, the
  navigation and load guards in `album/state.rs`, and the artwork cohort tests.
* Each preview stage above, screenshotted and compared against the CSS. The
  `*-loading` stages need a capture delay past the spinner's 450ms delay and
  fade (the 1.5s default is); `album-loading`'s header should match `album`'s
  pixel for pixel apart from the meta line's duration.
* A live run (`HANOI_START=albums`, then `HANOI_START=album`, with
  `HANOI_SCREENSHOT_DELAY_MS`) against the real server.
