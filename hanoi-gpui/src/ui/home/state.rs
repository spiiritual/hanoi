//! The home screen's view state and the load guards from
//! `../src/mainview/home/state.ts` (and the identical ones in
//! `app-state.ts` for the music sections).
//!
//! The guards are deliberately a plain, synchronous state machine: every
//! background task takes a [`Request`] token when it starts and hands it back
//! when it finishes, so a response that belongs to a superseded generation — or
//! to a server the user has already switched away from — can never mutate the
//! view. `home/mod.rs` owns the gpui side; this file is unit-testable on its own.

use std::collections::HashMap;
use std::sync::Arc;

use gpui::{Pixels, Point, RenderImage, ScrollHandle, SharedString, Task};

use crate::artwork::{ArtworkKey, ArtworkStore, Namespace, frame_bytes};
use crate::plex::{Album, Hub, HubItem, Section};
use crate::ui::album::state::AlbumsState;

/// `HomeStatus` / `MusicSectionsStatus`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Status {
    #[default]
    Idle,
    Loading,
    Ready,
    Error,
}

/// The error `loadHomeHubs` raises when nothing is selected yet.
pub const NO_SERVER_ERROR: &str = "No Plex server selected";

/// The identity of one in-flight request; handed back to [`Load::finish`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    generation: usize,
    server: Option<String>,
}

/// What [`Load::begin`] decided.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Begin {
    /// Already `ready`; the reference returns the cached rows.
    Cached,
    /// A request is already running; the reference awaits the shared promise.
    Pending,
    /// No server is selected — the state is now `error`.
    NoServer,
    /// Start a request with this token.
    Start(Request),
}

/// A once-per-server load with the reference's generation + in-flight guards.
#[derive(Debug)]
pub struct Load<T> {
    pub items: Vec<T>,
    pub status: Status,
    pub error: Option<String>,
    server: Option<String>,
    generation: usize,
    in_flight: bool,
}

impl<T> Default for Load<T> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            status: Status::Idle,
            error: None,
            server: None,
            generation: 0,
            in_flight: false,
        }
    }
}

impl<T> Load<T> {
    /// `setServer`: a different server bumps the generation and drops every
    /// cached row so the next `begin` refetches. Returns whether it changed.
    pub fn set_server(&mut self, server: Option<String>) -> bool {
        if self.server == server {
            return false;
        }
        self.server = server;
        self.generation = self.generation.wrapping_add(1);
        self.in_flight = false;
        self.items = Vec::new();
        self.status = Status::Idle;
        self.error = None;
        true
    }

    /// The head of `loadHomeHubs`: cached / shared / missing-server / start.
    pub fn begin(&mut self) -> Begin {
        if self.status == Status::Ready {
            return Begin::Cached;
        }
        if self.in_flight {
            return Begin::Pending;
        }
        let Some(server) = self.server.clone() else {
            self.status = Status::Error;
            self.error = Some(NO_SERVER_ERROR.to_owned());
            return Begin::NoServer;
        };
        self.status = Status::Loading;
        self.error = None;
        self.in_flight = true;
        Begin::Start(Request {
            generation: self.generation,
            server: Some(server),
        })
    }

    /// Apply a response. A stale token is dropped and returns `false`.
    pub fn finish(&mut self, request: &Request, result: Result<Vec<T>, String>) -> bool {
        if request.generation != self.generation || request.server != self.server {
            return false;
        }
        self.in_flight = false;
        match result {
            Ok(items) => {
                self.items = items;
                self.status = Status::Ready;
                self.error = None;
            }
            Err(message) => {
                self.status = Status::Error;
                self.error = Some(message);
            }
        }
        true
    }

    /// A preview's fixed state — the only way to build a `Load` with rows in
    /// it without a server or a request behind them.
    pub fn preview(status: Status, items: Vec<T>, error: Option<&str>) -> Self {
        Self {
            items,
            status,
            error: error.map(str::to_owned),
            ..Self::default()
        }
    }
}

/// The `HomeCategory` a "See all" opens.
pub struct Category {
    pub hub: Hub,
    pub items: Vec<HubItem>,
    pub status: Status,
    pub error: Option<String>,
}

/// The sidebar views this crate can reach. `search` exists in `ShellView` but
/// text entry is out of scope, so the topbar pill never activates it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum View {
    #[default]
    Home,
    Albums,
    Artists,
    Songs,
    Playlists,
}

impl View {
    /// `libraryItems` — the "Your Library" sub-navigation, in order.
    pub const LIBRARY: [Self; 4] = [Self::Albums, Self::Artists, Self::Songs, Self::Playlists];

    pub fn label(self) -> &'static str {
        match self {
            Self::Home => "Home",
            Self::Albums => "Albums",
            Self::Artists => "Artists",
            Self::Songs => "Songs",
            Self::Playlists => "Playlists",
        }
    }

    /// `shellViewCopy[view]`
    pub fn copy(self) -> ViewCopy {
        const NEXT_LIBRARY: &str = "Library browsing will be connected in the next app slice.";
        const LIBRARY_EYEBROW: &str = "YOUR LIBRARY";
        match self {
            Self::Home => ViewCopy {
                eyebrow: "HANOI",
                title: "Home is ready.",
                copy: "The music surface will land here next.",
            },
            Self::Albums => ViewCopy {
                eyebrow: LIBRARY_EYEBROW,
                title: "Albums are next.",
                copy: NEXT_LIBRARY,
            },
            Self::Artists => ViewCopy {
                eyebrow: LIBRARY_EYEBROW,
                title: "Artists are next.",
                copy: NEXT_LIBRARY,
            },
            Self::Songs => ViewCopy {
                eyebrow: LIBRARY_EYEBROW,
                title: "Songs are next.",
                copy: NEXT_LIBRARY,
            },
            Self::Playlists => ViewCopy {
                eyebrow: LIBRARY_EYEBROW,
                title: "Playlists are next.",
                copy: NEXT_LIBRARY,
            },
        }
    }
}

/// One entry of `shellViewCopy`.
pub struct ViewCopy {
    pub eyebrow: &'static str,
    pub title: &'static str,
    pub copy: &'static str,
}

/// `getLibraryStatusMessage` — the `aria-live` line under a placeholder.
pub fn library_status_message(status: Status, count: usize, error: Option<&str>) -> String {
    match status {
        Status::Loading => "Loading your Plex music library…".to_owned(),
        Status::Ready => {
            let noun = if count == 1 { "library" } else { "libraries" };
            format!("{count} music {noun} connected")
        }
        Status::Error => format!("Music library unavailable: {}", error.unwrap_or_default()),
        Status::Idle => String::new(),
    }
}

/// Everything the authenticated shell renders from.
pub struct HomeState {
    pub view: View,
    /// The account footer's name (`account.username`, or "Plex account").
    pub username: SharedString,
    /// The server selector's label (`selected?.name ?? "your server"`).
    pub server_name: SharedString,
    /// Tri-state reachability of the selected server: `None` = "Checking…".
    pub server_status: Option<bool>,

    /// "Your Library" remembers its open state for the session.
    pub library_open: bool,
    pub menu_open: bool,
    pub menu_loading: bool,
    pub menu_error: Option<SharedString>,
    /// Bumped per discovery so a stale `refreshServers` cannot overwrite a
    /// newer server list (the reference has no guard here; gpui needs one
    /// because the task outlives the click).
    pub menu_run: usize,

    pub hubs: Load<Hub>,
    pub sections: Load<Section>,

    pub category: Option<Category>,
    /// `categoryRun` — bumped whenever a category is opened or invalidated.
    pub category_run: usize,

    /// The Albums view, the album detail screen and album navigation.
    pub albums: AlbumsState,
}

impl Default for HomeState {
    fn default() -> Self {
        Self {
            view: View::Home,
            username: FALLBACK_ACCOUNT_NAME.into(),
            server_name: FALLBACK_SERVER_NAME.into(),
            server_status: None,
            library_open: true,
            menu_open: false,
            menu_loading: false,
            menu_error: None,
            menu_run: 0,
            hubs: Load::default(),
            sections: Load::default(),
            category: None,
            category_run: 0,
            albums: AlbumsState::default(),
        }
    }
}

/// `account?.username ?? "Plex account"`
pub const FALLBACK_ACCOUNT_NAME: &str = "Plex account";
/// `selected?.name ?? "your server"`
pub const FALLBACK_SERVER_NAME: &str = "your server";

impl HomeState {
    /// `changeView`: every album navigation is cleared, and leaving Home drops
    /// the category, exactly like the reference.
    pub fn change_view(&mut self, view: View) {
        self.albums.clear_navigation();
        if view != View::Home {
            self.invalidate_category();
        }
        self.view = view;
    }

    /// `openDetail("Album", item)`: remember the current view for Back, then
    /// show the album `seed` describes under the Albums view. Returns whether
    /// it opened.
    ///
    /// Deliberately not `change_view`: a category open on Home survives, so
    /// Back lands on it again, exactly like the reference.
    pub fn open_album(&mut self, seed: Album, offset: Point<Pixels>) -> bool {
        if !self.albums.open(seed, self.view, offset) {
            return false;
        }
        self.view = View::Albums;
        true
    }

    /// `closeDetail`: back to the view the album was opened from. Returns the
    /// `.home-content` offset to restore, or `None` when no album was open.
    pub fn close_album(&mut self) -> Option<Point<Pixels>> {
        let navigation = self.albums.close()?;
        self.view = navigation.return_view;
        Some(navigation.return_offset)
    }

    /// `reopenDetail`: the album Back left, under the Albums view again.
    /// `offset` is where `.home-content` is now, for the next Back.
    pub fn reopen_album(&mut self, offset: Point<Pixels>) -> bool {
        if !self.albums.reopen(offset) {
            return false;
        }
        self.view = View::Albums;
        true
    }

    /// Whether `AlbumLibrary` is what `.home-content` renders.
    pub fn album_library_showing(&self) -> bool {
        self.view == View::Albums && self.albums.selected.is_none()
    }

    /// The screen the shell is about to render, as an artwork cohort.
    ///
    /// Read from the state rather than from whatever navigation call is in
    /// progress, because the two can disagree: `changeView("home")` with a
    /// category open leaves the category on screen (the reference only clears
    /// it when the view is *not* Home), and releasing the covers of a screen
    /// that is still rendering would just re-decode them next frame. Likewise
    /// an album opened from a category leaves the category in place underneath.
    pub fn surface(&self) -> Surface {
        if self.view == View::Albums
            && let Some(selected) = self.albums.selected.as_ref()
        {
            return Surface::Album(SharedString::from(selected.rating_key.clone()));
        }
        if self.view != View::Home {
            return Surface::view(self.view);
        }
        match self.category.as_ref() {
            Some(category) => Surface::category(&category.hub),
            None => Surface::Home,
        }
    }

    /// `categoryRun.current += 1` plus `patch({ category: null })`.
    pub fn invalidate_category(&mut self) {
        self.category_run = self.category_run.wrapping_add(1);
        self.category = None;
    }

    /// Point every load at `server`; returns whether anything changed. A new
    /// server also drops the category and every album navigation.
    pub fn set_server(&mut self, server: Option<String>) -> bool {
        let hubs = self.hubs.set_server(server.clone());
        let sections = self.sections.set_server(server.clone());
        let albums = self.albums.set_server(server);
        let changed = hubs || sections || albums;
        if changed {
            self.invalidate_category();
        }
        changed
    }
}

/// One card's artwork, keyed by its [`ArtworkKey`] so a render pass never
/// re-spawns a load that is already running or already finished.
#[derive(Clone)]
pub enum Slot {
    Loading,
    Loaded(Arc<RenderImage>),
    Failed,
}

/// The screen a decoded frame was last needed on — its *cohort*.
///
/// Artwork is released a whole screen at a time rather than a frame at a time.
/// The sprite atlas hands out 1024x1024 slabs and frees one only when every
/// tile in it has been released; a 280x280 cover tiles 3x3, so ~9 covers share
/// a slab, and the covers that share one are the ones that were loaded
/// together — the same screen. Evicting one frame here and one there leaves
/// every slab half full and unreclaimable; dropping a screen's worth at once
/// empties slabs.
///
/// The surfaces are the dashboard, one "See all" category, the library views
/// (the Albums grid, and the placeholders that show no artwork at all) and one
/// album detail screen. An album carries its rating key, which keeps two of
/// them apart exactly as [`Surface::Category`] carries its hub identifier; an
/// artist or playlist screen will add a variant each the same way, and nothing
/// else in the cohort machinery changes (see `ALBUM.md`, "Artwork").
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Surface {
    /// The Home dashboard's hub rows.
    #[default]
    Home,
    /// The `HomeCategory` one "See all" opened, identified by the hub it
    /// expands so that switching between two categories is a real transition.
    Category(SharedString),
    /// One of the sidebar's library views. The Albums grid carries frames;
    /// the other views still render placeholders, and their variant is what
    /// makes leaving Home for one of them a transition rather than a no-op.
    Library(View),
    /// One album's detail screen, identified by its rating key, so opening a
    /// second album is a real transition.
    Album(SharedString),
}

impl Surface {
    /// The surface a "See all" on `hub` opens.
    ///
    /// `hubIdentifier` is the hub's identity everywhere else in this port; its
    /// `key` and then its title stand in when Plex omits one, which is the
    /// same ladder `category_view` uses for the heading.
    pub fn category(hub: &Hub) -> Self {
        let identity = [
            hub.hub_identifier.as_str(),
            hub.key.as_str(),
            hub.title.as_str(),
        ]
        .into_iter()
        .find(|candidate| !candidate.is_empty())
        .unwrap_or_default();
        Self::Category(SharedString::from(identity.to_owned()))
    }

    /// The surface a sidebar view renders.
    pub fn view(view: View) -> Self {
        match view {
            View::Home => Self::Home,
            other => Self::Library(other),
        }
    }
}

/// How many decoded frames the shell keeps alive, matching
/// `RendererArtworkStore`'s cap in `../src/mainview/artwork/index.ts`.
///
/// Dropping a slot costs a re-decode from the disk cache — about a millisecond
/// for a 23 KB JPEG — because this map is the only owner of a decoded frame
/// (the store's memory LRU holds weak references).
pub const MAX_SLOTS: usize = 128;

/// The budget that actually bounds memory. A frame's cost depends on the
/// artwork's own resolution, not on the 140px box it is drawn in, so counting
/// slots bounds nothing on its own: 128 covers is ~40 MB at the 280x280 the
/// cards request, but would be several GB of native 3000x3000 art.
///
/// Deliberately **global**, not per-surface. Keeping the previous screen warm
/// is a policy about *which* frames occupy this budget, never a licence to
/// exceed it: a warm previous screen costs nothing above the cap and simply
/// yields its headroom to the current screen when the current screen needs it.
pub const MAX_SLOT_BYTES: u64 = 64 * 1024 * 1024;

/// One slot plus the frame it was last needed on, for the LRU.
struct Entry {
    slot: Slot,
    used: u64,
    /// What the decoded frame costs, priced once on insert.
    bytes: u64,
    /// The cohort this frame belongs to: the surface that last needed it.
    surface: Surface,
}

/// The artwork cache plus the per-key bookkeeping the render pass reads.
///
/// This map is the **only owner** of a decoded frame: `ArtworkStore`'s memory
/// LRU holds weak references, so `MAX_SLOTS` + [`MAX_SLOT_BYTES`] is what
/// decides the resident set, and dropping the last reference here is what makes
/// a frame's texture reclaimable.
///
/// Reclaiming it needs one more step. `RenderImage` has no `Drop`, and gpui
/// frees its sprite-atlas tiles only from [`gpui::Window::drop_image`], which
/// needs a `&mut Window` that an eviction path (a background task finishing, a
/// server switch) does not have. So every release path queues its frame here
/// instead and the render pass drains the queue — see [`Self::take_droppable`].
///
/// The scroll handles are the gpui equivalent of `ArtworkImage`'s
/// `IntersectionObserver`: `content_scroll` is the observer root (the
/// `.home-content` viewport) and the per-strip handles give every card's laid
/// out bounds, so a load only starts for a card that is near the viewport.
#[derive(Default)]
pub struct ArtworkState {
    /// Built lazily the first time a card needs artwork: `default_root()` must
    /// never run in preview mode.
    pub store: Option<Arc<ArtworkStore>>,
    /// The current account + server partition; rebuilt on a server switch.
    pub namespace: Option<Namespace>,
    slots: HashMap<ArtworkKey, Entry>,
    /// Running total of the `slots` frames' bytes.
    slot_bytes: u64,
    /// Held so a load is not cancelled the moment it is spawned.
    tasks: HashMap<ArtworkKey, Task<()>>,
    /// Monotonic frame counter behind the LRU.
    tick: u64,
    /// The screen on show: every `insert` and `touch` stamps it, so a slot's
    /// cohort is always whatever last needed the frame.
    current: Surface,
    /// The screen just navigated away from, kept warm because back and forward
    /// make a rapid return likely. Everything older is released.
    previous: Option<Surface>,
    /// Frames no slot references any more, waiting for the render pass's
    /// `&mut Window` to hand their atlas tiles back.
    released: Vec<Arc<RenderImage>>,
    /// `.home-content` — the observer root.
    pub content_scroll: ScrollHandle,
    /// One per `.home-hub-cards` strip, indexed like the filtered hubs.
    row_scrolls: Vec<ScrollHandle>,
    /// `.home-category-cards`; kept apart from the rows so a view switch can
    /// never read one surface's child bounds for the other's cards.
    pub category_scroll: ScrollHandle,
    /// `.album-grid`, for the same reason: the Albums grid never scrolls
    /// itself, but its handle is what gives the gate each card's bounds.
    pub album_grid_scroll: ScrollHandle,
}

impl ArtworkState {
    /// Drop everything the previous server's cards were showing.
    ///
    /// Every loaded frame goes on the release queue: a server switch is the
    /// one moment the whole resident set becomes unreachable at once, so it is
    /// also the largest block of atlas slabs there is to hand back.
    pub fn clear(&mut self) {
        self.namespace = None;
        for entry in std::mem::take(&mut self.slots).into_values() {
            self.queue_release(entry.slot);
        }
        self.slot_bytes = 0;
        self.tasks.clear();
        self.current = Surface::default();
        self.previous = None;
    }

    /// The screen whose cohort new frames join.
    #[cfg(test)]
    pub fn surface(&self) -> &Surface {
        &self.current
    }

    /// Move to `surface`: it and the one it replaces stay warm, every older
    /// cohort's frames are released. Returns how many slots were released.
    ///
    /// Re-entering the surface already on show is not a transition — a
    /// `change_view` that lands where it started must not age out the screen it
    /// is still rendering.
    pub fn enter(&mut self, surface: Surface) -> usize {
        if self.current == surface {
            return 0;
        }
        let left = std::mem::replace(&mut self.current, surface);
        self.previous = Some(left);
        self.release_cold()
    }

    /// Release every slot outside the current and previous cohorts.
    fn release_cold(&mut self) -> usize {
        let Self {
            slots,
            slot_bytes,
            released,
            current,
            previous,
            ..
        } = self;
        let before = slots.len();
        slots.retain(|_, entry| {
            let warm = &entry.surface == current || previous.as_ref() == Some(&entry.surface);
            if !warm {
                *slot_bytes = slot_bytes.saturating_sub(entry.bytes);
                if let Slot::Loaded(image) = &entry.slot {
                    released.push(Arc::clone(image));
                }
            }
            warm
        });
        // A released cohort's in-flight loads have nowhere to land any more;
        // `prune` drops their tasks on the next pass, which cancels them.
        before - slots.len()
    }

    /// Queue a slot's frame for [`gpui::Window::drop_image`], if it had one.
    fn queue_release(&mut self, slot: Slot) {
        if let Slot::Loaded(image) = slot {
            self.released.push(image);
        }
    }

    /// The queued frames this map holds the last reference to, ready to be
    /// handed to [`gpui::Window::drop_image`]. Called once per render pass.
    ///
    /// A frame that is still shared — an element tree built this frame, a
    /// background load that has not applied its result yet — stays queued and
    /// is offered again next frame, rather than being dropped blind. With the
    /// store holding only weak references, a count of 1 really does mean
    /// "nobody can paint this any more".
    pub fn take_droppable(&mut self) -> Vec<Arc<RenderImage>> {
        let (droppable, shared): (Vec<_>, Vec<_>) = std::mem::take(&mut self.released)
            .into_iter()
            .partition(|image| Arc::strong_count(image) == 1);
        self.released = shared;
        droppable
    }

    /// How many frames are waiting for a `&mut Window`.
    pub fn released_len(&self) -> usize {
        self.released.len()
    }

    /// The decoded frame for one key, if it has already arrived.
    pub fn slot(&self, key: &ArtworkKey) -> Option<Slot> {
        self.slots.get(key).map(|entry| entry.slot.clone())
    }

    pub fn contains(&self, key: &ArtworkKey) -> bool {
        self.slots.contains_key(key)
    }

    /// Record a slot, mark it as used this frame and stamp it with the surface
    /// that needed it.
    pub fn insert(&mut self, key: ArtworkKey, slot: Slot) {
        self.tick = self.tick.wrapping_add(1);
        let used = self.tick;
        let bytes = match &slot {
            Slot::Loaded(image) => frame_bytes(image),
            Slot::Loading | Slot::Failed => 0,
        };
        let surface = self.current.clone();
        if let Some(replaced) = self.slots.insert(
            key,
            Entry {
                slot,
                used,
                bytes,
                surface,
            },
        ) {
            self.slot_bytes = self.slot_bytes.saturating_sub(replaced.bytes);
            // Usually a `Loading` placeholder, but a re-decode replacing a live
            // frame would otherwise strand its texture in the atlas.
            self.queue_release(replaced.slot);
        }
        self.slot_bytes = self.slot_bytes.saturating_add(bytes);
    }

    /// Mark a key as still needed, so eviction reaches for something else, and
    /// move it into the cohort of the surface that is asking.
    pub fn touch(&mut self, key: &ArtworkKey) {
        self.tick = self.tick.wrapping_add(1);
        let used = self.tick;
        let surface = self.current.clone();
        if let Some(entry) = self.slots.get_mut(key) {
            entry.used = used;
            entry.surface = surface;
        }
    }

    pub fn insert_task(&mut self, key: ArtworkKey, task: Task<()>) {
        self.tasks.insert(key, task);
    }

    /// Drop finished tasks and evict the least recently needed frames, queueing
    /// each evicted frame for release.
    ///
    /// Safe to call only from the render pass: a task whose slot is no longer
    /// `Loading` has already applied its result and returned, so dropping it
    /// cannot cancel work in flight.
    pub fn prune(&mut self) {
        let Self { slots, tasks, .. } = self;
        tasks.retain(|key, _| {
            matches!(slots.get(key).map(|entry| &entry.slot), Some(Slot::Loading))
        });

        while self.slots.len() > MAX_SLOTS || self.slot_bytes > MAX_SLOT_BYTES {
            let victim = self
                .slots
                .iter()
                .filter(|(_, entry)| !matches!(entry.slot, Slot::Loading))
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone());
            match victim {
                Some(key) => {
                    if let Some(evicted) = self.slots.remove(&key) {
                        self.slot_bytes = self.slot_bytes.saturating_sub(evicted.bytes);
                        self.queue_release(evicted.slot);
                    }
                }
                // Everything left is still loading; it will age out next frame.
                None => break,
            }
        }
    }

    /// Make sure there is a scroll handle per hub row about to be rendered.
    pub fn ensure_rows(&mut self, count: usize) {
        if self.row_scrolls.len() < count {
            self.row_scrolls.resize_with(count, ScrollHandle::new);
        }
    }

    /// The handle `.home-hub-cards` tracks for row `index`.
    pub fn row_scroll(&self, index: usize) -> Option<&ScrollHandle> {
        self.row_scrolls.get(index)
    }

    /// How many decoded frames are currently held.
    pub fn slot_len(&self) -> usize {
        self.slots.len()
    }

    /// How many loads are still running (finished ones are dropped by `prune`).
    pub fn task_len(&self) -> usize {
        self.tasks.len()
    }

    #[cfg(test)]
    pub fn slot_count(&self) -> usize {
        self.slots.len()
    }
}

#[cfg(test)]
mod tests {
    use gpui::{Point, RenderImage, Task, point, px};

    use std::sync::Arc;

    use super::{
        ArtworkState, Begin, Category, HomeState, Load, MAX_SLOT_BYTES, MAX_SLOTS, NO_SERVER_ERROR,
        Slot, Status, Surface, View, library_status_message,
    };
    use crate::artwork::{ArtworkKey, Namespace, Source, Variant};
    use crate::plex::{Album, Hub};

    /// The album a clicked card seeds `open_album` with.
    fn album(rating_key: &str) -> Album {
        Album {
            rating_key: rating_key.to_owned(),
            ..Album::default()
        }
    }

    fn key(index: usize) -> ArtworkKey {
        ArtworkKey {
            namespace: Namespace {
                account_id: "alexr".to_owned(),
                server_id: "home-server".to_owned(),
            },
            source: Source::Server(format!("/library/metadata/{index}/thumb/1")),
            variant: Variant::Native,
        }
    }

    fn hub(hub_identifier: &str) -> Hub {
        Hub {
            hub_identifier: hub_identifier.to_owned(),
            ..Hub::default()
        }
    }

    /// A 4x4 frame: big enough to be a real `RenderImage`, small enough that a
    /// test never bumps into [`MAX_SLOT_BYTES`].
    fn frame() -> Arc<RenderImage> {
        Arc::new(RenderImage::new(vec![image::Frame::new(
            image::RgbaImage::new(4, 4),
        )]))
    }

    fn start(load: &mut Load<Hub>) -> super::Request {
        match load.begin() {
            Begin::Start(request) => request,
            other => panic!("expected a fresh request, got {other:?}"),
        }
    }

    #[test]
    fn home_hub_loading_is_shared_between_concurrent_callers() {
        let mut load = Load::<Hub>::default();
        load.set_server(Some("server-1".to_owned()));

        let request = start(&mut load);
        assert_eq!(load.status, Status::Loading);
        // The second caller joins the in-flight request instead of starting one.
        assert_eq!(load.begin(), Begin::Pending);

        assert!(load.finish(&request, Ok(vec![hub("home.music.recent")])));
        assert_eq!(load.status, Status::Ready);
        assert_eq!(load.error, None);
        // A `ready` load is never refetched.
        assert_eq!(load.begin(), Begin::Cached);
    }

    #[test]
    fn a_load_without_a_server_reports_the_reference_error() {
        let mut load = Load::<Hub>::default();
        assert_eq!(load.begin(), Begin::NoServer);
        assert_eq!(load.status, Status::Error);
        assert_eq!(load.error.as_deref(), Some(NO_SERVER_ERROR));
    }

    #[test]
    fn failed_home_hub_loads_expose_an_error_and_can_be_retried() {
        let mut load = Load::<Hub>::default();
        load.set_server(Some("server-1".to_owned()));

        let request = start(&mut load);
        assert!(load.finish(&request, Err("Plex home unavailable".to_owned())));
        assert_eq!(load.status, Status::Error);
        assert_eq!(load.error.as_deref(), Some("Plex home unavailable"));
        assert!(load.items.is_empty());

        let retry = start(&mut load);
        assert!(load.finish(&retry, Ok(vec![hub("home.music.recent")])));
        assert_eq!(load.status, Status::Ready);
        assert_eq!(load.error, None);
        assert_eq!(load.items.len(), 1);
    }

    #[test]
    fn changing_servers_invalidates_the_cached_home_rows() {
        let mut load = Load::<Hub>::default();
        load.set_server(Some("server-1".to_owned()));
        let first = start(&mut load);
        assert!(load.finish(&first, Ok(vec![hub("home.music.recent")])));

        assert!(load.set_server(Some("server-2".to_owned())));
        assert_eq!(load.status, Status::Idle);
        assert!(load.items.is_empty());

        let second = start(&mut load);
        assert!(load.finish(&second, Ok(vec![hub("home.music.recent")])));
        assert_eq!(load.status, Status::Ready);

        // Re-selecting the same server is a no-op.
        assert!(!load.set_server(Some("server-2".to_owned())));
    }

    #[test]
    fn a_response_from_a_superseded_server_never_mutates_state() {
        let mut load = Load::<Hub>::default();
        load.set_server(Some("server-1".to_owned()));
        let stale = start(&mut load);

        load.set_server(Some("server-2".to_owned()));
        let fresh = start(&mut load);

        assert!(!load.finish(&stale, Ok(vec![hub("stale")])));
        assert!(load.items.is_empty());
        assert_eq!(load.status, Status::Loading);

        assert!(load.finish(&fresh, Ok(vec![hub("fresh")])));
        assert_eq!(load.items[0].hub_identifier, "fresh");
    }

    #[test]
    fn a_response_from_a_superseded_generation_never_mutates_state() {
        let mut load = Load::<Hub>::default();
        load.set_server(Some("server-1".to_owned()));
        let stale = start(&mut load);

        // A round trip through another server and back bumps the generation
        // twice, so the old token no longer matches even though the server does.
        load.set_server(Some("server-2".to_owned()));
        load.set_server(Some("server-1".to_owned()));

        assert!(!load.finish(&stale, Err("too late".to_owned())));
        assert_eq!(load.status, Status::Idle);
        assert_eq!(load.error, None);
    }

    #[test]
    fn leaving_home_clears_the_category() {
        let mut state = HomeState::default();
        state.category_run = 3;
        state.change_view(View::Albums);
        assert_eq!(state.view, View::Albums);
        assert!(state.category.is_none());
        assert_eq!(state.category_run, 4);

        // Returning to Home must not bump the run again.
        state.change_view(View::Home);
        assert_eq!(state.category_run, 4);
    }

    #[test]
    fn changing_view_clears_every_album_navigation() {
        let mut state = HomeState::default();
        assert!(state.open_album(album("album-1"), Point::default()));
        state.albums.forward = state.albums.selected.clone();

        state.change_view(View::Albums);
        assert_eq!(state.view, View::Albums);
        assert_eq!(state.albums.selected, None);
        assert_eq!(state.albums.forward, None);
        assert!(state.album_library_showing());
    }

    #[test]
    fn opening_an_album_from_a_category_keeps_the_category_for_back() {
        let mut state = HomeState {
            category: Some(Category {
                hub: hub("home.music.recent"),
                items: Vec::new(),
                status: Status::Ready,
                error: None,
            }),
            ..HomeState::default()
        };
        let run = state.category_run;
        let scrolled = point(px(0.), px(-360.));

        assert!(state.open_album(album("album-1"), scrolled));
        assert_eq!(state.view, View::Albums, "the album shows under Albums");
        assert!(!state.album_library_showing(), "the detail, not the grid");
        assert!(
            state.category.is_some(),
            "not `change_view`: the category survives"
        );
        assert_eq!(state.category_run, run);

        assert_eq!(
            state.close_album(),
            Some(scrolled),
            "Back restores the offset"
        );
        assert_eq!(state.view, View::Home);
        assert!(state.category.is_some(), "and lands on the category again");
        assert_eq!(
            state.surface(),
            Surface::category(&hub("home.music.recent"))
        );
    }

    #[test]
    fn forward_reopens_the_album_under_the_albums_view() {
        let mut state = HomeState::default();
        state.change_view(View::Albums);
        assert!(!state.open_album(Album::default(), Point::default()));
        assert!(state.open_album(album("album-1"), Point::default()));
        assert_eq!(state.close_album(), Some(Point::default()));
        assert_eq!(
            state.view,
            View::Albums,
            "opened from the grid, so back to it"
        );
        assert!(state.album_library_showing());

        let now = point(px(0.), px(-200.));
        assert!(state.reopen_album(now));
        assert_eq!(state.view, View::Albums);
        assert_eq!(state.close_album(), Some(now));
        assert_eq!(state.close_album(), None, "nothing is open any more");
    }

    #[test]
    fn a_server_switch_clears_the_album_navigation() {
        let mut state = HomeState::default();
        state.set_server(Some("server-1".to_owned()));
        assert!(state.open_album(album("album-1"), Point::default()));

        assert!(state.set_server(Some("server-2".to_owned())));
        assert_eq!(state.albums.selected, None);
        assert_eq!(state.albums.forward, None);
        assert_eq!(state.albums.library.status, Status::Idle);
    }

    #[test]
    fn the_surface_follows_the_screen_on_show() {
        let mut state = HomeState::default();
        assert_eq!(state.surface(), Surface::Home);
        state.change_view(View::Albums);
        assert_eq!(state.surface(), Surface::Library(View::Albums));
        assert!(state.open_album(album("album-1"), Point::default()));
        assert_eq!(state.surface(), Surface::Album("album-1".into()));
        assert!(state.open_album(album("album-2"), Point::default()));
        assert_ne!(
            state.surface(),
            Surface::Album("album-1".into()),
            "two albums are two surfaces"
        );
        state.change_view(View::Artists);
        assert_eq!(state.surface(), Surface::Library(View::Artists));
    }

    #[test]
    fn grid_to_album_and_back_keeps_both_screens_warm() {
        let mut state = HomeState::default();
        let mut artwork = ArtworkState::default();
        artwork.insert(key(0), Slot::Loaded(frame()));

        state.change_view(View::Albums);
        artwork.enter(state.surface());
        artwork.insert(key(1), Slot::Loaded(frame()));

        assert!(state.open_album(album("album-1"), Point::default()));
        assert_eq!(
            artwork.enter(state.surface()),
            1,
            "the dashboard is two screens back once the album opens"
        );
        artwork.insert(key(2), Slot::Loaded(frame()));

        state.close_album();
        assert_eq!(
            artwork.enter(state.surface()),
            0,
            "Back to the grid releases nothing"
        );
        assert!(
            artwork.slot(&key(1)).is_some(),
            "the grid's covers are still warm"
        );
        assert!(
            artwork.slot(&key(2)).is_some(),
            "and so is the album's, for Forward"
        );

        assert!(state.reopen_album(Point::default()));
        assert_eq!(
            artwork.enter(state.surface()),
            0,
            "Forward releases nothing either"
        );
        assert!(artwork.slot(&key(1)).is_some());
        assert!(artwork.slot(&key(2)).is_some());
    }

    #[test]
    fn a_third_screen_after_an_album_releases_the_oldest() {
        let mut state = HomeState::default();
        let mut artwork = ArtworkState::default();
        state.change_view(View::Albums);
        artwork.enter(state.surface());
        artwork.insert(key(0), Slot::Loaded(frame()));

        assert!(state.open_album(album("album-1"), Point::default()));
        artwork.enter(state.surface());
        artwork.insert(key(1), Slot::Loaded(frame()));
        state.close_album();
        artwork.enter(state.surface());

        // Grid -> album -> grid -> Artists: the album is now two screens back.
        state.change_view(View::Artists);
        assert_eq!(artwork.enter(state.surface()), 1);
        assert!(
            artwork.slot(&key(0)).is_some(),
            "the grid is the previous screen"
        );
        assert!(
            artwork.slot(&key(1)).is_none(),
            "the album's cover is released"
        );
        assert_eq!(artwork.take_droppable().len(), 1);

        // Opening a second album from the grid ages out the first one too.
        let mut state = HomeState::default();
        let mut artwork = ArtworkState::default();
        state.change_view(View::Albums);
        artwork.enter(state.surface());
        assert!(state.open_album(album("album-1"), Point::default()));
        artwork.enter(state.surface());
        artwork.insert(key(1), Slot::Loaded(frame()));
        state.close_album();
        artwork.enter(state.surface());
        assert!(state.open_album(album("album-2"), Point::default()));
        assert_eq!(
            artwork.enter(state.surface()),
            1,
            "album-1 is two screens back"
        );
        assert!(artwork.slot(&key(1)).is_none());
    }

    #[test]
    fn the_library_status_line_matches_the_reference_copy() {
        assert_eq!(
            library_status_message(Status::Loading, 0, None),
            "Loading your Plex music library…"
        );
        assert_eq!(
            library_status_message(Status::Ready, 1, None),
            "1 music library connected"
        );
        assert_eq!(
            library_status_message(Status::Ready, 2, None),
            "2 music libraries connected"
        );
        assert_eq!(
            library_status_message(Status::Error, 0, Some("fetch failed")),
            "Music library unavailable: fetch failed"
        );
        assert_eq!(library_status_message(Status::Idle, 0, None), "");
    }

    #[test]
    fn the_slot_map_evicts_the_least_recently_needed_frames() {
        let mut artwork = ArtworkState::default();
        for index in 0..(MAX_SLOTS + 8) {
            artwork.insert(key(index), Slot::Failed);
        }
        artwork.prune();

        assert_eq!(artwork.slot_count(), MAX_SLOTS);
        for index in 0..8 {
            assert!(
                artwork.slot(&key(index)).is_none(),
                "{index} should have aged out"
            );
        }
        for index in 8..(MAX_SLOTS + 8) {
            assert!(
                artwork.slot(&key(index)).is_some(),
                "{index} should still be held"
            );
        }
    }

    #[test]
    fn the_slot_map_evicts_on_its_byte_budget_before_its_entry_count() {
        // Native-sized covers: eight of these blow the budget long before the
        // 128-entry cap, which is the whole reason the budget exists.
        const SIDE: u32 = 3000;
        let frame = |side| {
            Arc::new(RenderImage::new(vec![image::Frame::new(
                image::RgbaImage::new(side, side),
            )]))
        };
        let per_frame = u64::from(SIDE) * u64::from(SIDE) * 4;

        let mut artwork = ArtworkState::default();
        let fits = usize::try_from(MAX_SLOT_BYTES / per_frame).expect("budget fits a usize");
        for index in 0..(fits + 4) {
            artwork.insert(key(index), Slot::Loaded(frame(SIDE)));
        }
        artwork.prune();

        assert!(
            artwork.slot_count() <= fits,
            "{} frames of {per_frame} bytes exceed the {MAX_SLOT_BYTES} byte budget",
            artwork.slot_count()
        );
        assert!(
            artwork.slot_count() < MAX_SLOTS,
            "the entry cap alone would have kept every frame"
        );
        assert!(
            artwork.slot(&key(fits + 3)).is_some(),
            "the most recently needed frame must survive"
        );

        // Card-sized frames are ~313 KB, so the entry cap is what binds there.
        let mut artwork = ArtworkState::default();
        for index in 0..(MAX_SLOTS + 4) {
            artwork.insert(key(index), Slot::Loaded(frame(280)));
        }
        artwork.prune();
        assert_eq!(artwork.slot_count(), MAX_SLOTS);
    }

    #[test]
    fn touching_a_visible_card_keeps_it_out_of_the_eviction_queue() {
        let mut artwork = ArtworkState::default();
        for index in 0..MAX_SLOTS {
            artwork.insert(key(index), Slot::Failed);
        }
        // The oldest entry is still on screen this frame.
        artwork.touch(&key(0));
        artwork.insert(key(MAX_SLOTS), Slot::Failed);
        artwork.prune();

        assert!(artwork.slot(&key(0)).is_some());
        assert!(artwork.slot(&key(1)).is_none());
    }

    #[test]
    fn pruning_drops_finished_tasks_and_never_evicts_a_loading_slot() {
        let mut artwork = ArtworkState::default();
        artwork.insert(key(0), Slot::Loading);
        artwork.insert_task(key(0), Task::ready(()));
        artwork.insert(key(1), Slot::Failed);
        artwork.insert_task(key(1), Task::ready(()));

        artwork.prune();
        // The load that already applied its result no longer holds a task.
        assert_eq!(artwork.task_len(), 1);

        for index in 2..(MAX_SLOTS + 4) {
            artwork.insert(key(index), Slot::Failed);
        }
        artwork.prune();
        assert!(matches!(artwork.slot(&key(0)), Some(Slot::Loading)));
        assert_eq!(artwork.slot_count(), MAX_SLOTS);
    }

    #[test]
    fn a_transition_keeps_the_current_and_previous_cohorts_and_releases_the_rest() {
        let mut artwork = ArtworkState::default();
        assert_eq!(artwork.surface(), &Surface::Home);
        artwork.insert(key(0), Slot::Loaded(frame()));

        let recent = Surface::category(&hub("home.music.recent"));
        assert_eq!(
            artwork.enter(recent.clone()),
            0,
            "the dashboard is only one screen back, so it stays warm"
        );
        artwork.insert(key(1), Slot::Loaded(frame()));

        let added = Surface::category(&hub("home.music.added"));
        assert_ne!(recent, added, "two hubs' categories are two surfaces");
        assert_eq!(
            artwork.enter(added),
            1,
            "the dashboard is now two screens back"
        );

        assert!(
            artwork.slot(&key(0)).is_none(),
            "the dashboard's covers are released"
        );
        assert!(
            artwork.slot(&key(1)).is_some(),
            "the category we came from is kept warm for the trip back"
        );
        assert_eq!(artwork.released_len(), 1, "released, not dropped blind");
        assert_eq!(artwork.take_droppable().len(), 1);
    }

    #[test]
    fn going_back_to_the_previous_surface_releases_nothing() {
        let mut artwork = ArtworkState::default();
        artwork.insert(key(0), Slot::Loaded(frame()));

        let category = Surface::category(&hub("home.music.recent"));
        artwork.enter(category.clone());
        artwork.insert(key(1), Slot::Loaded(frame()));

        assert_eq!(
            artwork.enter(category),
            0,
            "re-entering the surface on show is not a transition"
        );
        assert_eq!(artwork.enter(Surface::Home), 0, "back to the dashboard");

        assert!(artwork.slot(&key(0)).is_some());
        assert!(artwork.slot(&key(1)).is_some());
        assert_eq!(
            artwork.released_len(),
            0,
            "back and forward between two screens never releases either"
        );
    }

    #[test]
    fn two_steps_away_from_home_releases_the_dashboard_and_cancels_its_loads() {
        let mut artwork = ArtworkState::default();
        artwork.insert(key(0), Slot::Loaded(frame()));
        artwork.insert(key(1), Slot::Loading);
        artwork.insert_task(key(1), Task::ready(()));

        assert_eq!(Surface::view(View::Home), Surface::Home);
        artwork.enter(Surface::view(View::Albums));
        assert!(
            artwork.slot(&key(0)).is_some(),
            "one step away keeps the dashboard warm"
        );

        assert_eq!(artwork.enter(Surface::view(View::Artists)), 2);
        assert!(artwork.slot(&key(0)).is_none());
        assert_eq!(artwork.released_len(), 1, "the loading slot had no frame");

        artwork.prune();
        assert_eq!(
            artwork.task_len(),
            0,
            "a released cohort's load has nowhere to land, so it is cancelled"
        );
    }

    #[test]
    fn a_frame_the_new_surface_still_needs_joins_its_cohort() {
        // The same cover can appear on two screens — a "See all" of the row it
        // was first seen in, most obviously. Whichever screen last asked for it
        // owns it, so it is released with that one and not with the older one.
        let mut artwork = ArtworkState::default();
        artwork.insert(key(0), Slot::Loaded(frame()));

        artwork.enter(Surface::category(&hub("home.music.recent")));
        artwork.touch(&key(0));
        artwork.enter(Surface::view(View::Albums));

        assert!(
            artwork.slot(&key(0)).is_some(),
            "it belongs to the category now, which is still the previous surface"
        );
        assert_eq!(artwork.released_len(), 0);
    }

    #[test]
    fn evicting_a_frame_queues_its_texture_for_release() {
        let mut artwork = ArtworkState::default();
        for index in 0..(MAX_SLOTS + 4) {
            artwork.insert(key(index), Slot::Loaded(frame()));
        }
        artwork.prune();

        assert_eq!(artwork.slot_count(), MAX_SLOTS);
        assert_eq!(
            artwork.released_len(),
            4,
            "the byte/entry budget releases through the same queue"
        );
        assert_eq!(artwork.take_droppable().len(), 4);
    }

    #[test]
    fn clearing_the_slot_map_queues_every_loaded_frame() {
        let mut artwork = ArtworkState::default();
        artwork.insert(key(0), Slot::Loaded(frame()));
        artwork.insert(key(1), Slot::Loaded(frame()));
        artwork.insert(key(2), Slot::Failed);
        artwork.insert(key(3), Slot::Loading);
        artwork.insert_task(key(3), Task::ready(()));
        artwork.enter(Surface::category(&hub("home.music.recent")));

        artwork.clear();
        assert_eq!(artwork.slot_count(), 0);
        assert_eq!(artwork.task_len(), 0);
        assert_eq!(artwork.surface(), &Surface::Home, "a switch starts over");
        assert_eq!(
            artwork.released_len(),
            2,
            "a server switch hands back every texture it was holding"
        );
        assert_eq!(artwork.take_droppable().len(), 2);
        assert_eq!(artwork.released_len(), 0);
    }

    #[test]
    fn a_frame_that_is_still_shared_stays_queued_instead_of_being_dropped() {
        let shared = frame();
        let mut artwork = ArtworkState::default();
        artwork.insert(key(0), Slot::Loaded(Arc::clone(&shared)));
        artwork.insert(key(1), Slot::Loaded(frame()));
        artwork.clear();

        assert_eq!(
            artwork.take_droppable().len(),
            1,
            "only the frame nothing else references is handed to drop_image"
        );
        assert_eq!(artwork.released_len(), 1);

        drop(shared);
        assert_eq!(
            artwork.take_droppable().len(),
            1,
            "and it is offered again on a later frame, once the last reference goes"
        );
        assert_eq!(artwork.released_len(), 0);
    }

    #[test]
    fn a_category_surface_is_identified_by_its_hub() {
        assert_eq!(
            Surface::category(&hub("home.music.recent")),
            Surface::Category("home.music.recent".into())
        );
        // Plex omits `hubIdentifier` on some hubs; the key, then the title,
        // stand in for it — the same ladder the category heading uses.
        let keyed = Hub {
            key: "/hubs/home/recentlyAdded".to_owned(),
            title: "Recently Added".to_owned(),
            ..Hub::default()
        };
        assert_eq!(
            Surface::category(&keyed),
            Surface::Category("/hubs/home/recentlyAdded".into())
        );
        let titled = Hub {
            title: "Recently Added".to_owned(),
            ..Hub::default()
        };
        assert_eq!(
            Surface::category(&titled),
            Surface::Category("Recently Added".into())
        );
    }
}
