# Hanoi auth flow - gpui rewrite spec

This crate re-implements the Electrobun/React authentication flow from
`../src/mainview/auth/*` natively in [gpui](https://gpui.rs) (crate `gpui`
0.2.2 from crates.io). The goal is **pixel-for-pixel the same visuals and the
same behaviour**. The React + CSS sources are the ground truth for anything
this document leaves out:

**The screen the flow lands on has its own spec: `HOME.md`** covers the
authenticated shell (sidebar + topbar), the Plex Home dashboard and the
artwork cache. This document stops where that one starts.

| Concern | Reference file |
| --- | --- |
| Flow state machine, transitions, startup check | `../src/mainview/auth/auth-flow.tsx` |
| Shared layout, spacers, logo, titles, buttons | `../src/mainview/auth/AuthLayout.css`, `auth-layout.tsx` |
| Welcome screen | `welcome-screen.tsx` |
| OAuth screen (PIN + link card + steps + status) | `oauth-screen.tsx`, `OAuthScreen.css` |
| Connected screen + account card | `connected-screen.tsx`, `account-card.tsx`, `ConnectedScreen.css` |
| Server selection | `server-selection-screen.tsx`, `ServerSelection.css` |
| Icons | `../src/mainview/components/icon.tsx`, `server-icon.tsx` |
| Design tokens + fonts | `../src/mainview/styles/global.css` |
| Backend semantics (PIN flow, config, discovery) | `../src/bun/index.ts`, `../src/bun/plex/{auth,client,config,server-selection}.ts` |

The original Pen design (`plex.pen`) is not in this worktree; the CSS was
transcribed from it and is treated as the source of truth here.

## Running it

```sh
cd hanoi-gpui
cargo run                      # live app: startup check -> welcome / connected / home
HANOI_PREVIEW=oauth cargo run  # one stage with sample data, no network, no config
HANOI_PREVIEW=servers HANOI_SCREENSHOT=/tmp/servers.png cargo run   # capture + quit
```

* Requires the Xcode Metal toolchain (gpui compiles its shaders at build time):
  `xcodebuild -downloadComponent MetalToolchain` if the build reports a missing
  `metal` tool.
* Session file: `~/Library/Application Support/hanoi-gpui/plex-config.json`
  (same JSON as the Electrobun app's `plex-config.json`; override the path with
  `HANOI_CONFIG=/path/to/file.json`). Written with mode 0600.
* `cargo test` covers the backend (PIN flow parsing, URL encoding, config
  round-trips, server ordering) and the easing curve; `cargo test -- --ignored`
  also creates a real, unauthorised PIN against plex.tv.

## Crate layout

```
hanoi-gpui/
  Cargo.toml
  DESIGN.md              this file
  assets/fonts/          Inter (Regular/Medium/SemiBold/Bold/ExtraBold) + JetBrains Mono Bold, OFL
  assets/icons/          SVG icons (server, check-circle, spinner ring, ...)
  src/main.rs            entry point: `env_logger::init(); ui::run()`
  src/plex/              backend (blocking HTTP via ureq, config file). Public API in `plex/mod.rs`.
  src/artwork/           token-free artwork cache (memory LRU + disk). See `HOME.md`.
  src/ui/                gpui views: theme, fonts, components, auth screens, flow
  src/ui/home/           the authenticated shell + Plex Home dashboard. See `HOME.md`.
```

Ownership while the two implementation agents run in parallel:

* **Backend agent** owns `src/plex/**` only. Keep the public API in
  `src/plex/mod.rs` exactly as declared (types, signatures, constants).
* **UI agent** owns `src/ui/**`, `src/main.rs`, `assets/icons/**`, and may
  add dependencies to `Cargo.toml` (append only). It codes against the
  `plex` API and must compile against the stubs.

## Design tokens (from `global.css`)

| Token | Value |
| --- | --- |
| bg | `#141419` |
| sidebar-bg | `#0e0e13` |
| surface | `#1d1d24` |
| surface-2 | `#272730` |
| accent | `#e5a00d` |
| accent-2 | `#c86b3f` |
| text-primary | `#f2f2f4` |
| text-secondary | `#9d9da8` |
| text-tertiary | `#6e6e79` |
| success-bg | `#1d2b1e` |
| success | `#4ade80` |
| copied-bg | `#1c2a21` |
| copied-border | `#3a6b4a` |
| copied-fg | `#5fd48a` |
| on-accent text | `#141419` |
| badge check glyph | `#0b0b0e` |
| spinner track | `#33333c` |
| server row hover border | `#3a3a44` |
| error text | `#f0a0a0` |

Hover `filter: brightness(1.05)` on accent buttons -> use `#f0a80e`.
Hover `filter: brightness(1.1)` on surface-2 buttons -> use `#2b2b35`.

The home screen adds the translucent and one-off colours its CSS spells out
literally (all in `theme.rs`, built with the alpha-capable `hexa` helper):

| Token | Value | Used by |
| --- | --- | --- |
| panel bg | `rgba(29,29,36,0.42)` | `.home-state`, `.home-empty`, `.home-category-status`, `.home-shell-placeholder` |
| error border | `rgba(214,103,103,0.45)` | `.home-state.is-error` |
| retry hover | `#30303a` | `.home-retry:hover` |
| accent light | `#f3c34d` | `.home-hub-see-all:hover`, `.home-hub-card-play:hover` |
| sidebar row hover | `rgba(255,255,255,0.06)` | every sidebar row |
| card art hairline | `rgba(255,255,255,0.08)` | `.home-hub-card-art::after` |
| card art gradient | `#363640` -> `#1f1f27` | `.home-hub-card-art` |
| menu shadow | `rgba(0,0,0,0.36)` | `.sidebar-server-menu` |

Fonts: body = **Inter** (weights 400, 500, 600, 700, 800), mono = **JetBrains
Mono Bold** (700). Load them from `assets/fonts` at startup with
`cx.text_system().add_fonts(...)` (bundle with `include_bytes!`). gpui on macOS
matches weights across the loaded static faces, so ship the static TTFs (already
in `assets/fonts`), not the variable font.

gpui has no `letter-spacing`. For `code-value` (2px tracking) render each
character in its own element inside a flex row with a 2px gap —
`components::tracked_text` does this for any tracking, and the home screen
reuses it for `.home-shell-eyebrow` (0.16em) and `.sidebar-server-menu-title`
(0.04em). Ignore the slightly negative tracking on headings (-0.5px / -0.3px).

Two other gpui limits worth knowing before transcribing a rule:

* **Hover cannot move anything.** `hover` / `group_hover` refinements are
  resolved during paint, after layout has already run, so only paint-time
  properties (colours, opacity) react to a hover — a hovered `inset`, size or
  margin is silently ignored. Where the CSS animates geometry (the play
  button's `translateY(4px)`), render the settled position and let opacity do
  the reveal.
* **`.truncate()` does not truncate.** gpui caches the measured size of
  `nowrap` text, so the ellipsis width never lands once the flex pass shrinks
  the column. Use `components::ellipsis` (`overflow_hidden` +
  `whitespace_normal` + `text_ellipsis` + `line_clamp(1)`) inside a
  `flex_1().min_w_0()` column instead.

Window: 1200 x 800, title "Hanoi", background `bg`. Everything is centred in
the window like the CSS (`.auth-stage` is a full-window flex box that centres
its child; the inner column is `flex-col`, `items-center`, `text-center`,
`max-width 640px`, `width 100%`).

## Screens (exact measurements from the CSS)

"Spacer N" = a fixed-height gap of N px.

### Shared pieces

* **logo-mark**: 72x72, bg accent, radius 20, glyph "H" 44px weight 800
  colour on-accent, line-height 1, centred.
* **app-name**: "Hanoi", 40px, weight 700, line-height 1.1.
* **title**: 32px, weight 700, line-height 1.1, text-primary.
* **subtitle**: 15px, weight 400, text-secondary, max-width 460, line-height 1.4.
* **status-row**: flex row, gap 8, items centre: **spinner** + **status-text**
  (13px, text-tertiary).
* **spinner**: 16x16 ring, 2px stroke, track `#33333c`, top quarter accent,
  rotating 360deg every 1s, linear, infinite. Implement as an SVG asset
  animated with `with_animation` + `Transformation::rotate(percentage(delta))`
  (see gpui `examples/animation.rs`).
* **btn-primary**: 320x52, bg accent, text on-accent, 15px weight 600, radius 26,
  hover `#f0a80e`; disabled: opacity 0.45, no hover, default cursor.
* **link-muted**: 13px weight 400 text-secondary, underlined, pointer cursor.
* Buttons use the pointer cursor on hover.

### 0. Startup (`AuthStartupScreen`, shown while the saved session is checked)

logo-mark, spacer 12, app-name, spacer 36, status-row "Checking your Plex account…".
Shown for at least 700 ms.

### 1. Welcome

logo-mark, spacer 12, app-name, spacer 21,
**tagline** "A desktop music player for Plex." (17px, 400, text-secondary),
spacer 40,
**btn-signin**: 320x52, bg accent, on-accent text, 15px 600, radius 26,
flex row gap 10, centred; content = **plex-icon** (20x20 box, glyph "▶" at
14px) + "Sign in with Plex"; hover `#f0a80e`.
spacer 16,
link-muted "Don't have an account?  Create one" (opens
`https://www.plex.tv/sign-up/` in the browser),
spacer 64.

### 2. OAuth ("Link your Plex account")

title "Link your Plex account", spacer 8,
subtitle "Secure OAuth — your Plex password never touches this app.",
spacer 36,
**link-card**: 600x150, bg surface, 1px border surface-2, radius 14, flex col
centred, gap 14:
  * **card-label** "Your link" 12px text-tertiary
  * **link-row** (row, items centre, gap 6): **link-prefix** "plex.tv/link/"
    22px weight 600 text-tertiary Inter; **code-value** the PIN code, 22px
    weight 700 accent, JetBrains Mono, 2px letter spacing.
  * **card-actions** (row, gap 10):
    * **btn-open**: h 40, padding 0 18, radius 20, 14px 600, bg accent,
      on-accent text, row gap 8: **open-icon** "↗" 12px + "Open in Browser".
      hover `#f0a80e`.
    * **btn-copy**: same box, bg surface-2, text-primary, label "Copy link",
      hover `#2b2b35`. **Copied state** (2000 ms after a successful copy):
      bg copied-bg, text copied-fg, 1px border copied-border (inside the same
      40px box), content "✓" (12px) + "Copied!", no hover change.
spacer 28,
**steps**: width 600, column, gap 14, left-aligned. Each **step** = row, gap 14,
items start: **step-num** (32x32, radius 16, bg surface-2, 14px 600
text-primary, centred) + **step-info** (**step-title** 14px 600 text-primary;
**step-desc** 12px text-tertiary, 2px below).
  1. "Open the link" / "Tap Open in Browser or copy the link — sign in with your Plex account"
  2. "Approve and you're connected" / "No code to type — this app finishes the handshake automatically"
spacer 28,
status-row (status text starts as "Waiting for authorization…"),
spacer 20,
**btn-cancel**: h 40, padding 0 18, bg surface-2, radius 20, 14px 600
text-primary, row gap 8: **cancel-icon** "✕" 13px text-secondary + "Cancel";
hover `#2b2b35`.

### 3. Connected ("You're signed in!")

**badge**: 88x88 circle bg success-bg, centred **badge-check**: 40x40 circle
bg success with "✓" 24px weight 800 colour `#0b0b0e`.
spacer 28, title "You're signed in!", spacer 40,
**account-card**: row, items centre, gap 16, padding 15px 20px, width
fit-content, min-height 82, bg surface, 1px border surface-2, radius 14:
  * **avatar**: 52x52 circle, background linear-gradient 135deg accent ->
    accent-2, initials (first letters of up to two words, upper-cased) 18px
    weight 700 on-accent; when the account thumb image loads it fills the
    circle (cover) instead.
  * **card-info**: column, gap 3, left-aligned: **card-name** 15px 600
    text-primary (username, or "Plex account"); **card-sub** 12px 400
    text-tertiary (email, or "Account details unavailable").
spacer 40, btn-primary "Continue".

### 4. Server selection ("Choose your server")

title "Choose your server", spacer 8,
subtitle "Select the Plex server that hosts your music library.", spacer 36,
**server-list**: width 520, column, gap 12.
  * loading: **server-loading** row centred, gap 10, h 76, bg surface, 1px
    border surface-2, radius 12, 13px text-secondary: spinner + "Loading your
    Plex servers…".
  * otherwise one **server** row per server: row, items centre, gap 14,
    padding 0 18, h 76, bg surface, 1px border surface-2, radius 12,
    pointer cursor; hover border `#3a3a44`; **selected**: bg surface-2 and a
    1.5px accent border; **unavailable** (empty url): opacity 0.55,
    not-allowed cursor, not clickable, tooltip "No server connection is available".
    * **server-icon**: 44x44 radius 10 bg accent, centred 22x22 stroke icon
      (two rounded 20x8 rects at y=2 and y=14 plus two dots, stroke on-accent,
      stroke width 2, round caps/joins; see `server-icon.tsx`).
    * **server-info** (flex 1, left): **server-name** 15px 600 text-primary;
      **server-host** 12px 400 text-tertiary, 1px below, single line with
      ellipsis: `{url or "No connection available"} · {username}` (the
      " · username" suffix only when the account has a username).
    * **server-check**: pushed right (margin-left auto), 20x20 check-circle
      icon (circle r=10 + check path `m9 12 2 2 4-4`, stroke 2), colour
      text-tertiary, accent when selected.
spacer 28,
**server-error** (only when set): max-width 520, 13px, line-height 1.4, `#f0a0a0`.
**hint**: 13px text-secondary "Can't find your server?  " + link-muted
"Sign in again" (disabled while starting).
spacer 28, btn-primary "Start listening" (disabled when nothing is selected
or while starting).

### 5. After the flow

The flow hands off to `Screen::Home`, the authenticated shell in
`src/ui/home/` — sidebar, topbar and the Plex Home dashboard. Its layout,
behaviour and preview stages are specified in `HOME.md`.

`Root::enter_home` is the hand-off: it fills in the account name and the
server label, points both loads at the selected server, and starts the hub,
music-section and server-discovery requests. `Root::disconnect` (deletes the
config and returns to Welcome) still exists but nothing calls it — the
sidebar's settings button, the only place the design signs out from, is inert
until that surface is ported.

Card artwork is gated and bounded the way the renderer's `ArtworkImage` and
`RendererArtworkStore` are, because a category can run to hundreds of cards:

* **Only cards near the viewport load.** `Root::ensure_artwork` runs once per
  render pass, before the tree is built, and tests every card's laid out bounds
  against `.home-content`'s viewport grown by 400px — `ArtworkImage`'s
  `IntersectionObserver` `rootMargin: "400px 0px"`. Bounds come from
  `ScrollHandle`s: one on `.home-content` (the observer root) and one per
  `.home-hub-cards` strip plus one on `.home-category-cards`, which is tracked
  purely to read its children's bounds. A card clipped away by its own strip's
  horizontal scroll is skipped with no margin, matching how the browser clips
  the intersection rectangle against every ancestor scroll container. When the
  strips have not been laid out yet — the frame a view or its contents change —
  nothing loads and `window.request_animation_frame()` asks again next frame.
* **Decoded frames are capped at 128, least-recently-needed first**, matching
  `RendererArtworkStore`. Every visible card is touched each frame, so what is
  on screen is never the eviction victim, and a slot still `Loading` is never
  evicted. Dropping a frame is cheap: `ArtworkStore` still holds it in its own
  memory LRU and on disk. Finished tasks are dropped in the same pass (only
  from the render pass, never from inside a running task).

## Stage transitions

Stages in order: `welcome`, `oauth`, `connected`, `servers`. Moving to a stage
with a higher-or-equal index is **forward**, otherwise **backward**. During a
transition both stages are rendered stacked (absolute, full window) for 420 ms
with easing cubic-bezier(0.32, 0.72, 0, 1):

| | opacity | translateX |
| --- | --- | --- |
| enter forward | 0 -> 1 | +40px -> 0 |
| enter backward | 0 -> 1 | -40px -> 0 |
| exit forward | 1 -> 0 | 0 -> -24px |
| exit backward | 1 -> 0 | 0 -> +24px |

Implement with `with_animation` on each stage container (opacity + a left
offset). Implement the cubic-bezier as a proper easing function (solve the
parametric curve for x, evaluate y), not a lookup approximation. If a new
transition starts mid-flight, the previous exit stage is dropped and the
current stage becomes the exiting one (see `transitionStage` in
`auth-flow.tsx`).

## Behaviour (mirror `auth-flow.tsx` + `src/bun/index.ts`)

* **Startup**: show the startup screen, `load_config()` on a background
  thread. If a token exists and `account` is missing, fetch it (best effort,
  save into the config). Enforce a 700 ms minimum. Then: token + server ->
  placeholder home; token only -> `connected`; no config -> `welcome`.
  Any failure -> `welcome`.
* **Welcome** "Sign in with Plex" -> `oauth`. "Create one" -> open sign-up URL.
* **OAuth** on entry: client identifier = existing config's or a new UUID v4;
  `create_pin` on a background thread; show the code (until it arrives show a
  placeholder code `A1B2C3`, like the reference); then poll `poll_pin` every
  2000 ms. Network error while polling -> status "Still waiting for
  authorization…" and keep polling. Hard failure (create_pin error, timeout
  after 5 minutes) -> status "Something went wrong: {message}" and stop.
  On `Authorized(token)`: status "Authorization approved — loading…", save
  `Config { client_identifier, token, account: None, server: None }`, fetch
  the account (best effort; persist it when it succeeds), then -> `connected`.
  "Open in Browser" opens the auth URL (`cx.open_url`). "Copy link" writes it
  to the clipboard (`cx.write_to_clipboard(ClipboardItem::new_string(..))`)
  and shows the copied state for 2 s; a copy before the URL exists does
  nothing. "Cancel" stops polling (drop the task), -> `welcome`.
  Leaving the stage for any reason must cancel the poll; a stale poll must
  never mutate state (use a run counter like `runRef` in the reference).
* **Connected** "Continue" -> `servers` with loading = true, then
  `discover_servers` on a background thread. On success: servers = result,
  selected = first server with a non-empty url; if none, error "No owned Plex
  media servers were found on this account." On failure: error "Couldn't
  load your Plex servers: {message}". loading = false either way (unless a
  newer run superseded this one).
* **Servers** clicking a usable row selects it (ignored while starting).
  "Sign in again" -> cancel any poll, -> `oauth` (fresh PIN). "Start
  listening": starting = true; find the selected server in the list, require a
  non-empty url, save `config.server = ServerConfig { client_identifier, name,
  url, token }`, -> placeholder home. Failure: error "Couldn't connect to that
  server: {message}", starting = false.
* All network work happens off the main thread (`cx.background_spawn` /
  `cx.background_executor()`), results are applied through
  `cx.spawn(...)` + `this.update(cx, ..)` and `cx.notify()`.

## Preview mode (for screenshots and visual QA)

`HANOI_PREVIEW=<stage>` renders one stage with sample data and never touches
the network or the config file:

| value | state |
| --- | --- |
| `startup` | startup screen |
| `welcome` | welcome |
| `oauth` | code `A1B2C3`, status "Waiting for authorization…" |
| `oauth-copied` | same, copy button in its copied state |
| `connected` | account "Alex Rivera" / "alex@example.com" (initials avatar) |
| `servers-loading` | loading row |
| `servers` | "Home Server" `http://192.168.1.10:32400` (selected), "Studio NAS" `https://10-0-0-5.83588b0fc21c4e24a7b6e75bd8875faf.plex.direct:32400` (long enough to overflow, so the host line shows its ellipsis), "Offline Box" (no url, unavailable); account username "alexr" |
| `servers-error` | same list plus error "Couldn't load your Plex servers: fetch failed" |
| `home` | the Home dashboard with three sample rows |
| `home-loading` / `home-error` / `home-empty` | the dashboard's other states |
| `home-category` | the "See all" category view for "Recently Added" |
| `home-library` | the Albums placeholder, so the sidebar's active state shows |

The `home-*` stages are specified in `HOME.md`; like every other stage they
never touch the network, the config file or the artwork cache.

`HANOI_PREVIEW=servers HANOI_SCREENSHOT=/path/out.png` additionally captures
the window after ~1.5 s and exits: use `screencapture -x -l <window id>` via
`std::process::Command` (find the window id with the window's title through
`osascript`/`GetWindowID`, or simply capture the centred 1200x800 rect with
`screencapture -x -R x,y,w,h`). Any approach that yields an accurate PNG of the
window is fine.

## Non-goals

The home screen, the sidebar and the artwork cache are **in** scope — they are
specified in `HOME.md`, not here. Still out: the player bar, search results and
text entry, the Albums / Artists / Songs / Playlists library screens and every
detail screen (the shell renders `.home-shell-placeholder` for those). No
Windows/Linux testing either (keep the code portable; only macOS is verified
here).
