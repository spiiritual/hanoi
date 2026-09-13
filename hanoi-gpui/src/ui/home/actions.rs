//! The behaviour behind the shell: the loads `home-screen.tsx` kicks off, the
//! sidebar's server switcher, "See all" and the per-card artwork tasks.
//!
//! Everything blocking runs on `cx.background_spawn`; every result is applied
//! through `this.update(cx, ..)` + `cx.notify()` and is dropped unless the
//! generation guard in `state.rs` still recognises it.

use std::sync::Arc;

use gpui::{AsyncApp, Context, ScrollHandle, WeakEntity, Window, prelude::*, px};

use crate::artwork::{
    ArtworkKey, ArtworkStore, Credentials, FALLBACK_VARIANT, Namespace, Source, Variant,
};
use crate::plex::{self, Hub, HubItem, ServerConfig, ServerInfo};

use crate::ui::auth::Stage;
use crate::ui::root::{Root, Screen};

use super::state::{Begin, Category, Slot, Status, Surface, View};
use super::utils::{HOME_HUB_PREVIEW_SIZE, filter_music_home_hubs};

/// `RECENTLY_PLAYED_HUB_PREFIX` — these rows are previews of a mixed query, so
/// "See all" reuses the items Plex already returned.
const RECENTLY_PLAYED_PREFIX: &str = "music.recent.played.";

/// `rootMargin: "400px 0px"` on `ArtworkImage`'s `IntersectionObserver`: a card
/// starts loading this far before it scrolls into view, and no earlier.
const VIEWPORT_MARGIN: f32 = 400.;

/// What a card asks Plex for: the 140px art tile at 2x, transcoded server-side.
///
/// A deliberate departure from `artwork-image.tsx`, which requests the native
/// object first. A browser decodes to the size it draws; gpui keeps the decoded
/// frame and its texture at the image's own resolution, so a native 3000x3000
/// cover costs ~36 MB of pixels to fill a 140px box. At this size every cover
/// is 313 KB instead, whatever Plex stores.
const CARD_VARIANT: Variant = Variant::Transcoded {
    width: 280,
    height: 280,
};

/// What the viewport test could tell us this frame.
enum Visible {
    /// The cards near the viewport, in render order.
    Paths(Vec<String>),
    /// Nothing on screen wants artwork.
    Nothing,
    /// The strips on screen have not been laid out yet; ask again next frame.
    NotLaidOut,
}

/// `item.thumb ?? item.composite ?? item.art`.
fn artwork_path(item: &HubItem) -> Option<String> {
    item.thumb
        .as_deref()
        .or(item.composite.as_deref())
        .or(item.art.as_deref())
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
}

impl Root {
    // -----------------------------------------------------------------------
    // Entering the shell
    // -----------------------------------------------------------------------

    /// The config's server identity — the key both loads are generationed on.
    fn home_server_key(&self) -> Option<String> {
        let server = self.config.as_ref()?.server.as_ref()?;
        server
            .client_identifier
            .clone()
            .filter(|identifier| !identifier.is_empty())
            .or_else(|| Some(server.url.clone()).filter(|url| !url.is_empty()))
    }

    /// Open the authenticated shell for the server in the config.
    ///
    /// Mirrors the effects `home-screen.tsx` runs on mount: point the state at
    /// the selected server, then `loadSelectedServerData()` (music sections +
    /// home hubs) and the sidebar's `refreshServers`.
    pub fn enter_home(&mut self, server_name: String, cx: &mut Context<Self>) {
        self.home.username = self
            .account
            .as_ref()
            .map(|account| account.username.clone())
            .filter(|username| !username.is_empty())
            .unwrap_or_else(|| super::state::FALLBACK_ACCOUNT_NAME.to_owned())
            .into();
        self.home.server_name = if server_name.is_empty() {
            super::state::FALLBACK_SERVER_NAME.into()
        } else {
            server_name.into()
        };
        self.home.view = View::Home;
        self.home.invalidate_category();
        self.home.set_server(self.home_server_key());
        self.enter_artwork_surface();
        self.screen = Screen::Home;
        self.exiting = None;
        cx.notify();

        self.load_home_hubs(cx);
        self.load_music_sections(cx);
        self.refresh_servers(cx);
    }

    /// Forget everything the previous session's shell was showing.
    pub fn reset_home(&mut self) {
        self.home = super::state::HomeState::default();
        self.artwork.clear();
        self.home_task = None;
        self.sections_task = None;
        self.category_task = None;
        self.menu_task = None;
    }

    // -----------------------------------------------------------------------
    // Loads
    // -----------------------------------------------------------------------

    /// `homeState.loadHomeHubs()`
    pub fn load_home_hubs(&mut self, cx: &mut Context<Self>) {
        if self.preview {
            return;
        }
        let Begin::Start(request) = self.home.hubs.begin() else {
            cx.notify();
            return;
        };
        cx.notify();
        let Some(server) = self.server_config() else {
            self.home
                .hubs
                .finish(&request, Err(super::state::NO_SERVER_ERROR.to_owned()));
            cx.notify();
            return;
        };

        self.home_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    plex::get_home_hubs(&server).map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.home.hubs.finish(&request, result) {
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// `appState.loadMusicSections()`
    pub fn load_music_sections(&mut self, cx: &mut Context<Self>) {
        if self.preview {
            return;
        }
        let Begin::Start(request) = self.home.sections.begin() else {
            cx.notify();
            return;
        };
        cx.notify();
        let Some(server) = self.server_config() else {
            self.home
                .sections
                .finish(&request, Err(super::state::NO_SERVER_ERROR.to_owned()));
            cx.notify();
            return;
        };

        self.sections_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    plex::get_music_sections(&server).map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.home.sections.finish(&request, result) {
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// "Try again" under the error banner.
    pub fn retry_home(&mut self, cx: &mut Context<Self>) {
        self.load_home_hubs(cx);
    }

    fn server_config(&self) -> Option<ServerConfig> {
        self.config.as_ref()?.server.clone()
    }

    // -----------------------------------------------------------------------
    // Sidebar
    // -----------------------------------------------------------------------

    /// `changeView` — leaving Home drops any open category.
    pub fn change_view(&mut self, view: View, cx: &mut Context<Self>) {
        self.home.change_view(view);
        self.enter_artwork_surface();
        cx.notify();
    }

    /// The screen the shell is about to render, as an artwork cohort.
    ///
    /// Read from the state rather than from whatever navigation call is in
    /// progress, because the two can disagree: `changeView("home")` with a
    /// category open leaves the category on screen (the reference only clears
    /// it when the view is *not* Home), and releasing the covers of a screen
    /// that is still rendering would just re-decode them next frame.
    fn home_surface(&self) -> Surface {
        if self.home.view != View::Home {
            return Surface::view(self.home.view);
        }
        match self.home.category.as_ref() {
            Some(category) => Surface::category(&category.hub),
            None => Surface::Home,
        }
    }

    /// Tell the slot map which screen it is serving, releasing whatever is now
    /// two screens back.
    fn enter_artwork_surface(&mut self) {
        let surface = self.home_surface();
        let released = self.artwork.enter(surface);
        if released > 0 {
            log::debug!(
                "artwork: released {released} frames leaving a cold surface, {} queued",
                self.artwork.released_len()
            );
        }
    }

    /// The server selector: closing is free, opening runs `refreshServers`.
    pub fn toggle_server_menu(&mut self, cx: &mut Context<Self>) {
        if self.home.menu_open {
            self.home.menu_open = false;
            cx.notify();
            return;
        }
        self.home.menu_open = true;
        self.home.menu_loading = true;
        self.home.menu_error = None;
        cx.notify();
        self.refresh_servers(cx);
    }

    /// `refreshServers` — discover the account's servers and refresh the
    /// selected one's online badge.
    pub fn refresh_servers(&mut self, cx: &mut Context<Self>) {
        self.home.menu_run = self.home.menu_run.wrapping_add(1);
        let run = self.home.menu_run;

        if self.preview {
            self.home.menu_loading = false;
            cx.notify();
            return;
        }
        let Some(config) = self.config.clone() else {
            self.home.menu_loading = false;
            cx.notify();
            return;
        };

        self.menu_task = Some(cx.spawn(async move |this, cx| {
            let token = config.token.clone();
            let client_identifier = config.client_identifier.clone();
            let found = cx
                .background_spawn(async move { plex::discover_servers(&token, &client_identifier) })
                .await;
            this.update(cx, |this, cx| {
                if this.home.menu_run != run {
                    return;
                }
                match found {
                    Ok(servers) => {
                        this.home.server_status = this
                            .selected_server
                            .as_deref()
                            .and_then(|selected| {
                                servers
                                    .iter()
                                    .find(|server| server.client_identifier == selected)
                            })
                            .map(|server| server.online);
                        this.servers = servers;
                    }
                    Err(error) => {
                        this.home.menu_error =
                            Some(format!("Couldn't load servers: {error}").into());
                    }
                }
                this.home.menu_loading = false;
                cx.notify();
            })
            .ok();
        }));
    }

    /// Picking a server in the menu: persist it, drop the old server's artwork
    /// and reload the dashboard from scratch.
    pub fn select_home_server(&mut self, server: ServerInfo, cx: &mut Context<Self>) {
        // `selectServer` ignores unusable and already-selected servers, but the
        // click always closes the menu.
        self.home.menu_open = false;
        cx.notify();
        if server.url.is_empty()
            || self.selected_server.as_deref() == Some(server.client_identifier.as_str())
        {
            return;
        }

        // Sign-out semantics for one namespace: the previous server's objects
        // are no longer addressable from this account.
        let previous = self.artwork.namespace.clone();
        if let (Some(store), Some(namespace)) = (self.artwork.store.clone(), previous) {
            cx.background_spawn(async move { store.clear_namespace(&namespace) })
                .detach();
        }
        self.artwork.clear();

        let config = ServerConfig {
            client_identifier: Some(server.client_identifier.clone()),
            name: server.name.clone(),
            url: server.url.clone(),
            token: server.token.clone(),
        };
        if let Some(existing) = self.config.as_mut() {
            existing.server = Some(config);
        }
        self.selected_server = Some(server.client_identifier.clone());
        self.home.server_name = server.name.clone().into();
        self.home.server_status = Some(server.online);
        self.home.view = View::Home;
        self.home.set_server(self.home_server_key());
        self.enter_artwork_surface();
        cx.notify();

        if !self.preview
            && let Some(config) = self.config.clone()
        {
            self.config_task = Some(cx.spawn(async move |_, cx| {
                if let Err(error) = cx
                    .background_spawn(async move { plex::save_config(&config) })
                    .await
                {
                    log::error!("failed to save the selected Plex server: {error}");
                }
            }));
        }

        self.load_home_hubs(cx);
        self.load_music_sections(cx);
    }

    /// "Add a server…" — back to the auth flow's server-selection stage.
    pub fn add_server(&mut self, cx: &mut Context<Self>) {
        self.home.menu_open = false;
        // The shell is not an auth stage, so seed the stack with the stage the
        // user came from; the transition is then the same forward slide as
        // "Continue" on the connected screen.
        self.stage = Stage::Connected;
        self.exiting = None;
        self.continue_to_servers(cx);
    }

    // -----------------------------------------------------------------------
    // "See all"
    // -----------------------------------------------------------------------

    /// `openCategory` — the full contents of one hub.
    pub fn open_category(&mut self, hub: Hub, cx: &mut Context<Self>) {
        self.home.category_run = self.home.category_run.wrapping_add(1);
        let run = self.home.category_run;
        let server = self.home_server_key();
        self.home.category = Some(Category {
            hub: hub.clone(),
            items: Vec::new(),
            status: Status::Loading,
            error: None,
        });
        // The dashboard the category covers becomes the previous surface: its
        // covers stay warm for the trip back, and anything older is released.
        self.enter_artwork_surface();
        cx.notify();

        // A `music.recent.played.` row is already the mixed preview, and a hub
        // with no key has nowhere to expand to.
        let is_recently_played = hub.hub_identifier.starts_with(RECENTLY_PLAYED_PREFIX);
        if is_recently_played || hub.key.is_empty() || self.preview {
            self.apply_category(run, &server, hub.clone(), Ok(hub.items.clone()));
            cx.notify();
            return;
        }

        let Some(config) = self.server_config() else {
            self.apply_category(
                run,
                &server,
                hub,
                Err(super::state::NO_SERVER_ERROR.to_owned()),
            );
            cx.notify();
            return;
        };

        let key = hub.key.clone();
        self.category_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    plex::get_home_hub_items(&config, &key).map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                this.apply_category(run, &server, hub, result);
                cx.notify();
            })
            .ok();
        }));
    }

    /// The tail of `openCategory`: filter the items exactly like the rows do,
    /// unless a newer run or a server switch has superseded this response.
    fn apply_category(
        &mut self,
        run: usize,
        server: &Option<String>,
        hub: Hub,
        result: Result<Vec<HubItem>, String>,
    ) {
        if self.home.category_run != run || &self.home_server_key() != server {
            return;
        }
        match result {
            Ok(items) => {
                let source = Hub {
                    items,
                    ..hub.clone()
                };
                let filtered = filter_music_home_hubs(std::slice::from_ref(&source));
                let hub = filtered.into_iter().next().unwrap_or(Hub {
                    items: Vec::new(),
                    ..hub
                });
                self.home.category = Some(Category {
                    items: hub.items.clone(),
                    hub,
                    status: Status::Ready,
                    error: None,
                });
            }
            Err(error) => {
                self.home.category = Some(Category {
                    hub,
                    items: Vec::new(),
                    status: Status::Error,
                    error: Some(error),
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Artwork
    // -----------------------------------------------------------------------

    /// The decoded frame for one card, if it has already arrived.
    pub fn artwork_slot(&self, item: &HubItem) -> Option<Slot> {
        let key = self.artwork_key(item, CARD_VARIANT)?;
        self.artwork.slot(&key)
    }

    /// `item.thumb ?? item.composite ?? item.art`, addressed in the current
    /// account + server namespace.
    fn artwork_key(&self, item: &HubItem, variant: Variant) -> Option<ArtworkKey> {
        Some(ArtworkKey {
            namespace: self.artwork.namespace.clone()?,
            source: Source::Server(artwork_path(item)?),
            variant,
        })
    }

    /// Start a load for every card that is near the viewport and does not have
    /// one yet, then prune what is no longer needed.
    ///
    /// Called once per render pass, before the tree is built, so a card can be
    /// a pure read of the slot map. `ensure_scrollbars` has already allocated
    /// the row scroll handles this reads by then.
    pub fn ensure_artwork(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The only place a `&mut Window` and the release queue meet, and so the
        // only place artwork ever gives its GPU memory back. It runs before the
        // element tree is built, so nothing dropped here can still be painted
        // this frame, and before every early return below, so a queue filled by
        // a server switch drains even when nothing is on screen to load.
        self.release_artwork(window);
        if self.preview {
            return;
        }
        let paths = match self.visible_artwork_paths() {
            Visible::Paths(paths) => paths,
            // The strips have not been laid out yet (the view or its contents
            // changed this frame), so there is nothing trustworthy to test a
            // card against. Ask for one more frame and decide then.
            Visible::NotLaidOut => {
                window.request_animation_frame();
                return;
            }
            Visible::Nothing => return,
        };
        self.artwork.prune();
        log::debug!(
            "artwork: {} cards near the viewport, {} frames held, {} loads in flight",
            paths.len(),
            self.artwork.slot_len(),
            self.artwork.task_len()
        );
        if paths.is_empty() {
            return;
        }
        let Some(credentials) = self.artwork_credentials() else {
            return;
        };
        // Built on first use: `default_root()` must never run in preview mode.
        if self.artwork.store.is_none() {
            self.artwork.store = Some(ArtworkStore::new(ArtworkStore::default_root()));
        }
        if self.artwork.namespace.is_none() {
            self.artwork.namespace = self.build_namespace();
        }
        let (Some(store), Some(namespace)) =
            (self.artwork.store.clone(), self.artwork.namespace.clone())
        else {
            return;
        };

        for path in paths {
            let sized = ArtworkKey {
                namespace: namespace.clone(),
                source: Source::Server(path.clone()),
                variant: CARD_VARIANT,
            };
            if self.artwork.contains(&sized) {
                // Still on screen, so it must outlive anything scrolled away.
                self.artwork.touch(&sized);
                continue;
            }
            let fallback = ArtworkKey {
                variant: FALLBACK_VARIANT,
                ..sized.clone()
            };
            // `peek` is cheap and never touches disk, so a frame the LRU still
            // holds skips the task entirely.
            if let Some(image) = store.peek(&sized).or_else(|| store.peek(&fallback)) {
                self.artwork.insert(sized, Slot::Loaded(image));
                continue;
            }

            self.artwork.insert(sized.clone(), Slot::Loading);
            let task = {
                let store = store.clone();
                let credentials = credentials.clone();
                let sized = sized.clone();
                cx.spawn(async move |this, cx| {
                    load_artwork(this, cx, store, credentials, sized, fallback).await;
                })
            };
            self.artwork.insert_task(sized, task);
        }
    }

    /// Hand the sprite atlas back every released frame's tiles.
    ///
    /// `RenderImage` has no `Drop`: a frame's texture stays in the window's
    /// atlas until `drop_image` removes it, and the atlas frees a 1024x1024
    /// slab only once every tile in it is gone — which is why frames are
    /// released a screen at a time (see [`Surface`]). A frame someone else
    /// still holds stays queued for a later frame.
    fn release_artwork(&mut self, window: &mut Window) {
        let released = self.artwork.take_droppable();
        if released.is_empty() {
            return;
        }
        let count = released.len();
        for image in released {
            if let Err(error) = window.drop_image(image) {
                log::warn!("failed to release an artwork texture: {error}");
            }
        }
        log::debug!(
            "artwork: dropped {count} textures, {} still shared",
            self.artwork.released_len()
        );
    }

    /// How many `.home-hub-cards` strips the dashboard is about to render.
    pub(crate) fn card_strip_len(&self) -> usize {
        if self.home.view != View::Home || self.home.category.is_some() {
            return 0;
        }
        filter_music_home_hubs(&self.home.hubs.items).len()
    }

    /// The artwork paths of the cards inside the viewport, expanded by
    /// [`VIEWPORT_MARGIN`] — `ArtworkImage`'s `rootMargin: "400px 0px"`.
    ///
    /// A card clipped away by its own strip's horizontal scroll is outside the
    /// observer's intersection rectangle too, so it is skipped with no margin,
    /// exactly like the browser clips against every ancestor scroll container.
    fn visible_artwork_paths(&self) -> Visible {
        if self.home.view != View::Home {
            return Visible::Nothing;
        }
        let viewport = self.artwork.content_scroll.bounds();
        if viewport.size.height <= px(0.) {
            // `.home-content` has never been laid out; nothing is on screen.
            return Visible::Nothing;
        }
        let top = viewport.top() - px(VIEWPORT_MARGIN);
        let bottom = viewport.bottom() + px(VIEWPORT_MARGIN);

        let mut paths = Vec::new();
        let hubs;
        let strips: Vec<(&ScrollHandle, &[HubItem])> = match self.home.category.as_ref() {
            Some(category) if category.status == Status::Ready => {
                vec![(&self.artwork.category_scroll, category.items.as_slice())]
            }
            Some(_) => return Visible::Nothing,
            None if self.home.hubs.status == Status::Ready => {
                hubs = filter_music_home_hubs(&self.home.hubs.items);
                let mut strips = Vec::with_capacity(hubs.len());
                for (index, hub) in hubs.iter().enumerate() {
                    let Some(handle) = self.artwork.row_scroll(index) else {
                        return Visible::NotLaidOut;
                    };
                    let take = hub.items.len().min(HOME_HUB_PREVIEW_SIZE);
                    strips.push((handle, &hub.items[..take]));
                }
                strips
            }
            None => return Visible::Nothing,
        };

        for (handle, items) in strips {
            if items.is_empty() {
                continue;
            }
            // The handle still holds the previous frame's children whenever the
            // content changed, and a short list would silently gate the tail of
            // a long one; wait for the layout that matches what is rendering.
            if handle.bounds_for_item(items.len() - 1).is_none() {
                return Visible::NotLaidOut;
            }
            let strip = handle.bounds();
            let offset = handle.offset();
            for (index, item) in items.iter().enumerate() {
                let Some(card) = handle.bounds_for_item(index) else {
                    continue;
                };
                if card.bottom() + offset.y < top || card.top() + offset.y > bottom {
                    continue;
                }
                if card.right() + offset.x < strip.left() || card.left() + offset.x > strip.right()
                {
                    continue;
                }
                if let Some(path) = artwork_path(item) {
                    paths.push(path);
                }
            }
        }
        Visible::Paths(paths)
    }

    /// `artworkNamespace` for the account + server in the config.
    fn build_namespace(&self) -> Option<Namespace> {
        let config = self.config.as_ref()?;
        let server = config.server.as_ref()?;
        Namespace::server(
            self.account
                .as_ref()
                .map(|account| account.username.as_str())
                .filter(|username| !username.is_empty()),
            &config.client_identifier,
            server
                .client_identifier
                .as_deref()
                .filter(|identifier| !identifier.is_empty()),
            &server.url,
        )
    }

    fn artwork_credentials(&self) -> Option<Credentials> {
        let server = self.config.as_ref()?.server.as_ref()?;
        if server.url.is_empty() {
            return None;
        }
        Some(Credentials {
            base_url: server.url.clone(),
            token: server.token.clone(),
        })
    }
}

/// One card's artwork: the card-sized transcode, then the larger transcoded
/// fallback — the `attempt` ladder in `artwork-image.tsx`, with the primary
/// request sized for the card (see `CARD_VARIANT`).
async fn load_artwork(
    this: WeakEntity<Root>,
    cx: &mut AsyncApp,
    store: Arc<ArtworkStore>,
    credentials: Credentials,
    sized: ArtworkKey,
    fallback: ArtworkKey,
) {
    let key = sized.clone();
    let image = cx
        .background_spawn(async move {
            store
                .load(&sized, &credentials)
                .or_else(|| store.load(&fallback, &credentials))
        })
        .await;

    this.update(cx, |this, cx| {
        // A server switch clears the map; a result that lands afterwards
        // belongs to a namespace nothing is showing any more.
        if !this.artwork.contains(&key) {
            return;
        }
        let slot = match image {
            Some(image) => Slot::Loaded(image),
            None => Slot::Failed,
        };
        this.artwork.insert(key, slot);
        cx.notify();
    })
    .ok();
}
