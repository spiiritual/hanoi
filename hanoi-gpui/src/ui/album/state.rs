//! The album screens' view state: the Albums library load, the album detail
//! load, and the album half of `home-screen.tsx`'s navigation
//! (`selectedAlbum` / `forwardAlbum`).
//!
//! Like `home/state.rs`, this is plain synchronous state that `actions.rs`
//! drives from gpui; everything here is unit-testable on its own.

use gpui::{Pixels, Point};

use crate::plex::{Album, AlbumDetail, HubItem, Section};
use crate::ui::home::state::{Begin, Load, Status, View};

/// `HANOI_START=<view>` — where a live run lands once the shell opens.
pub const START_ENV: &str = "HANOI_START";

/// `AlbumNavigation` in `home-screen.tsx`: the album on show and the view Back
/// returns to.
#[derive(Clone, Debug, PartialEq)]
pub struct AlbumNavigation {
    pub rating_key: String,
    /// `returnView` — the sidebar view that was active when the album opened.
    pub return_view: View,
    /// `.home-content`'s scroll offset when the album opened, restored by Back.
    /// An adaptation: the browser keeps one `scrollTop` across every view.
    pub return_offset: Point<Pixels>,
    /// What is already known about the album before `getAlbum` returns: the
    /// clicked card's item, or the loaded album once Back has left it. The
    /// detail screen renders its header from this while the load is in
    /// flight, and the cover starts loading from its `thumb`. An adaptation:
    /// the reference shows "Loading album…" on an empty screen instead.
    pub seed: Option<Album>,
}

/// `AlbumDetail`'s `detailState`.
#[derive(Clone, Debug, PartialEq)]
pub struct DetailState {
    /// The album this state belongs to; a response for any other is stale.
    pub rating_key: String,
    pub status: Status,
    /// `Some` once `status` is `Ready`.
    pub detail: Option<AlbumDetail>,
    pub error: Option<String>,
}

/// The identity of one detail load; handed back to
/// [`AlbumsState::finish_detail`].
///
/// The reference guards with `active` (unmounted?) and `attempt !== reload`
/// (retried?); here the run counter covers both, and the server and rating key
/// are checked too because the task outlives any navigation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DetailRequest {
    run: usize,
    server: Option<String>,
    pub rating_key: String,
}

/// `HANOI_START` for a live run: the app cannot be clicked by automation, so
/// this is how the live album screens are reached for a screenshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    /// Enter the Albums view once the shell opens.
    Albums,
    /// Enter the Albums view, then open the library's first album once it has
    /// loaded.
    Album,
}

impl Start {
    pub const ALL: &'static [&'static str] = &["albums", "album"];

    /// Parse a `HANOI_START` value; anything else is `None`.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "albums" => Some(Self::Albums),
            "album" => Some(Self::Album),
            _ => None,
        }
    }
}

/// Which load "Try again" under `.album-library-status` re-runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retry {
    /// The music sections failed; reloading them loads the albums after.
    Sections,
    /// The album load itself failed.
    Albums,
}

/// What `.album-library-status` shows, if anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LibraryBanner {
    /// Still loading. It carries no copy: the Albums view draws the shell's
    /// loading spinner where the reference says "Loading albums…".
    Loading,
    /// `.is-error`: the message plus a "Try again" for `retry`.
    Error { message: String, retry: Retry },
    /// "No albums found in this library."
    Empty,
}

/// The copy of [`LibraryBanner::Empty`].
pub const LIBRARY_EMPTY: &str = "No albums found in this library.";
const LIBRARY_ERROR_PREFIX: &str = "Couldn’t load your albums";

/// `Couldn’t load your albums: {error}`, or `…albums.` without one.
fn library_error(error: Option<&str>) -> String {
    match error.filter(|error| !error.is_empty()) {
        Some(error) => format!("{LIBRARY_ERROR_PREFIX}: {error}"),
        None => format!("{LIBRARY_ERROR_PREFIX}."),
    }
}

/// `AlbumLibrary`'s `message`, as its branches intend it.
///
/// The reference derives this from `displayedStatus`, which flashes the empty
/// copy while the first request is in flight (it never sets `loading` before
/// it) and styles a sections failure as an error that says "No albums found".
/// This is the table in `ALBUM.md` instead: loading until both loads settle,
/// the sections' own error when they failed, and the empty copy only once
/// there is really nothing.
pub fn library_banner(sections: &Load<Section>, library: &Load<HubItem>) -> Option<LibraryBanner> {
    match sections.status {
        Status::Idle | Status::Loading => return Some(LibraryBanner::Loading),
        Status::Error => {
            return Some(LibraryBanner::Error {
                message: library_error(sections.error.as_deref()),
                retry: Retry::Sections,
            });
        }
        Status::Ready if sections.items.is_empty() => return Some(LibraryBanner::Empty),
        Status::Ready => {}
    }
    match library.status {
        Status::Idle | Status::Loading => Some(LibraryBanner::Loading),
        Status::Error => Some(LibraryBanner::Error {
            message: library_error(library.error.as_deref()),
            retry: Retry::Albums,
        }),
        Status::Ready if library.items.is_empty() => Some(LibraryBanner::Empty),
        Status::Ready => None,
    }
}

/// Everything the Albums view and the album detail screen render from.
#[derive(Default)]
pub struct AlbumsState {
    /// `AlbumLibrary`'s albums, merged across every music section and already
    /// in `MediaCard`'s hub-item shape. Loaded once per server, like the Home
    /// hubs.
    pub library: Load<HubItem>,
    /// `selectedAlbum` — `Some` while the detail screen is on show.
    pub selected: Option<AlbumNavigation>,
    /// `forwardAlbum` — what the topbar's Forward button reopens.
    pub forward: Option<AlbumNavigation>,
    /// The detail screen's load, for `selected`.
    pub detail: Option<DetailState>,
    /// Bumped whenever a detail load starts or is superseded.
    pub detail_run: usize,
    /// `HANOI_START`, until it has been acted on. Live runs only.
    pub start: Option<Start>,
}

impl AlbumsState {
    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    /// The navigation half of `openDetail("Album", item)`: ignore an empty key,
    /// then make `seed`'s album the one on show with nothing to go forward to.
    /// Returns whether an album was opened.
    pub fn open(&mut self, seed: Album, return_view: View, return_offset: Point<Pixels>) -> bool {
        if seed.rating_key.is_empty() {
            return false;
        }
        self.clear_navigation();
        self.selected = Some(AlbumNavigation {
            rating_key: seed.rating_key.clone(),
            return_view,
            return_offset,
            seed: Some(seed),
        });
        // Any real navigation supersedes a `HANOI_START` still waiting for the
        // library.
        self.start = None;
        true
    }

    /// `closeDetail`: the album on show becomes the one Forward reopens.
    /// Returns where Back lands, or `None` when no album was open.
    ///
    /// The detail screen unmounts in the reference, so its load is dropped
    /// here too; Forward starts a fresh one. A detail that had loaded becomes
    /// the navigation's seed, so Forward's header is the freshest one seen.
    pub fn close(&mut self) -> Option<AlbumNavigation> {
        let loaded = self.ready_detail().map(seed_from_detail);
        let mut navigation = self.selected.take()?;
        if let Some(seed) = loaded {
            navigation.seed = Some(seed);
        }
        self.forward = Some(navigation.clone());
        self.invalidate_detail();
        Some(navigation)
    }

    /// `reopenDetail`: the album Back left becomes the album on show again.
    /// Returns whether there was one.
    ///
    /// `returnView` is kept, exactly like the reference. The return offset is
    /// refreshed to `current_offset`: Back should land where the user was when
    /// they pressed Forward, which after a round trip is no longer where they
    /// were when the album first opened.
    pub fn reopen(&mut self, current_offset: Point<Pixels>) -> bool {
        let Some(mut navigation) = self.forward.take() else {
            return false;
        };
        navigation.return_offset = current_offset;
        self.selected = Some(navigation);
        true
    }

    /// `clearNavigation` for the album half: nothing on show, nothing forward,
    /// and any detail load in flight is superseded.
    pub fn clear_navigation(&mut self) {
        self.selected = None;
        self.forward = None;
        self.invalidate_detail();
    }

    fn invalidate_detail(&mut self) {
        self.detail = None;
        self.detail_run = self.detail_run.wrapping_add(1);
    }

    /// Point the library load at `server`. A different server clears every
    /// album navigation and the detail with it, like the reference's
    /// `selectedServer` effect. Returns whether anything changed.
    pub fn set_server(&mut self, server: Option<String>) -> bool {
        let changed = self.library.set_server(server);
        if changed {
            self.clear_navigation();
        }
        changed
    }

    // -----------------------------------------------------------------------
    // Loads
    // -----------------------------------------------------------------------

    /// The head of `AlbumLibrary`'s effect, with the Home hubs' guards.
    ///
    /// `None` while the music sections are not `ready` — the effect's early
    /// return. With no sections the library is `ready` and empty at once, and
    /// the caller is told [`Begin::Cached`]: there is nothing to request.
    pub fn begin_library(&mut self, sections: &Load<Section>) -> Option<Begin> {
        if sections.status != Status::Ready {
            return None;
        }
        let begin = self.library.begin();
        if let Begin::Start(request) = &begin
            && sections.items.is_empty()
        {
            self.library.finish(request, Ok(Vec::new()));
            return Some(Begin::Cached);
        }
        Some(begin)
    }

    /// Start (or restart) the detail load for the album on show: bump the run
    /// and reset the detail to loading. `None` when no album is selected.
    pub fn begin_detail(&mut self, server: Option<String>) -> Option<DetailRequest> {
        let rating_key = self.selected.as_ref()?.rating_key.clone();
        self.detail_run = self.detail_run.wrapping_add(1);
        self.detail = Some(DetailState {
            rating_key: rating_key.clone(),
            status: Status::Loading,
            detail: None,
            error: None,
        });
        Some(DetailRequest {
            run: self.detail_run,
            server,
            rating_key,
        })
    }

    /// Apply a detail response if the run, the server and the album on show
    /// all still match. A stale response is dropped and returns `false`.
    pub fn finish_detail(
        &mut self,
        request: &DetailRequest,
        server: &Option<String>,
        result: Result<AlbumDetail, String>,
    ) -> bool {
        let current = self
            .selected
            .as_ref()
            .is_some_and(|selected| selected.rating_key == request.rating_key);
        if request.run != self.detail_run || &request.server != server || !current {
            return false;
        }
        self.detail = Some(match result {
            Ok(detail) => DetailState {
                rating_key: request.rating_key.clone(),
                status: Status::Ready,
                detail: Some(detail),
                error: None,
            },
            Err(error) => DetailState {
                rating_key: request.rating_key.clone(),
                status: Status::Error,
                detail: None,
                error: Some(error),
            },
        });
        true
    }

    /// The album on show's detail state, if it belongs to that album.
    fn selected_detail(&self) -> Option<(&AlbumNavigation, Option<&DetailState>)> {
        let selected = self.selected.as_ref()?;
        let detail = self
            .detail
            .as_ref()
            .filter(|detail| detail.rating_key == selected.rating_key);
        Some((selected, detail))
    }

    /// Whether an album is on show and its detail has not reported back. No
    /// state yet, or one left over from another album, counts: `detailState`
    /// starts out `loading`.
    pub fn detail_pending(&self) -> bool {
        self.selected_detail().is_some_and(|(_, detail)| {
            detail.is_none_or(|detail| matches!(detail.status, Status::Idle | Status::Loading))
        })
    }

    /// The seed the header renders from while the detail is pending. `None`
    /// once the load has reported back, or for an album opened without one.
    pub fn loading_seed(&self) -> Option<&Album> {
        if !self.detail_pending() {
            return None;
        }
        self.selected.as_ref()?.seed.as_ref()
    }

    /// The album on show's detail, once it is `ready`.
    pub fn ready_detail(&self) -> Option<&AlbumDetail> {
        let (_, detail) = self.selected_detail()?;
        let detail = detail.filter(|detail| detail.status == Status::Ready)?;
        detail.detail.as_ref()
    }

    /// The path `.album-detail-art` loads when it has a non-empty `thumb`: the
    /// seed's while the detail is pending, so the cover starts loading in the
    /// frame the album opens (alongside `getAlbum`, not after it), then the
    /// loaded album's. The two are the same path for an album opened from a
    /// card, so the load is not restarted when the detail arrives.
    pub fn cover_path(&self) -> Option<&str> {
        let album = match self.ready_detail() {
            Some(detail) => &detail.album,
            None => self.loading_seed()?,
        };
        album.thumb.as_deref().filter(|thumb| !thumb.is_empty())
    }

    /// `HANOI_START=album`, once the library has settled: the album to open,
    /// if the Albums grid is still on show. Consumes the request either way,
    /// so an empty or failed library does not open something later.
    pub fn take_start_album(&mut self) -> Option<Album> {
        if self.start != Some(Start::Album) || self.selected.is_some() {
            return None;
        }
        if !matches!(self.library.status, Status::Ready | Status::Error) {
            return None;
        }
        self.start = None;
        self.library.items.first().map(Album::from_hub_item)
    }
}

/// The seed a loaded detail leaves behind for Forward: its album, with the
/// track count `album_meta` showed (`leafCount ?? tracks.length`) filled in,
/// so Forward's loading header and track placeholder match the screen Back
/// left.
fn seed_from_detail(detail: &AlbumDetail) -> Album {
    Album {
        leaf_count: detail
            .album
            .leaf_count
            .or_else(|| u64::try_from(detail.tracks.len()).ok()),
        ..detail.album.clone()
    }
}

#[cfg(test)]
mod tests {
    use gpui::{Point, point, px};

    use super::{
        AlbumNavigation, AlbumsState, DetailRequest, DetailState, LIBRARY_EMPTY, LibraryBanner,
        Retry, Start, library_banner,
    };
    use crate::plex::{Album, AlbumDetail, HubItem, Section, Track};
    use crate::ui::home::state::{Begin, Load, Status, View};

    fn album(rating_key: &str) -> HubItem {
        HubItem {
            rating_key: rating_key.to_owned(),
            item_type: "album".to_owned(),
            ..HubItem::default()
        }
    }

    fn section(key: &str) -> Section {
        Section {
            key: key.to_owned(),
            title: "Music".to_owned(),
            section_type: "artist".to_owned(),
        }
    }

    fn detail(title: &str, thumb: Option<&str>) -> AlbumDetail {
        AlbumDetail {
            album: Album {
                rating_key: "album-1".to_owned(),
                title: title.to_owned(),
                thumb: thumb.map(str::to_owned),
                ..Album::default()
            },
            tracks: Vec::new(),
        }
    }

    /// What a clicked album card seeds the detail screen with.
    fn seed(rating_key: &str) -> Album {
        Album {
            rating_key: rating_key.to_owned(),
            key: format!("/library/metadata/{rating_key}/children"),
            title: "In Rainbows".to_owned(),
            parent_title: Some("Radiohead".to_owned()),
            thumb: Some(format!("/library/metadata/{rating_key}/thumb/1")),
            year: Some(2007),
            leaf_count: Some(10),
            ..Album::default()
        }
    }

    fn server(key: &str) -> Option<String> {
        Some(key.to_owned())
    }

    fn opened(rating_key: &str) -> AlbumsState {
        let mut state = AlbumsState::default();
        assert!(state.open(seed(rating_key), View::Home, point(px(0.), px(-480.))));
        state
    }

    fn start_detail(state: &mut AlbumsState, key: &str) -> DetailRequest {
        state
            .begin_detail(server(key))
            .expect("an album is selected")
    }

    fn ready_sections(items: Vec<Section>) -> Load<Section> {
        let mut sections = Load::default();
        sections.set_server(server("server-1"));
        let Begin::Start(request) = sections.begin() else {
            panic!("expected a fresh request");
        };
        assert!(sections.finish(&request, Ok(items)));
        sections
    }

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    #[test]
    fn opening_an_album_records_where_back_returns_and_clears_forward() {
        let mut state = opened("album-1");
        state.forward = state.selected.clone();

        let offset = point(px(0.), px(-120.));
        assert!(state.open(seed("album-2"), View::Albums, offset));
        assert_eq!(
            state.selected,
            Some(AlbumNavigation {
                rating_key: "album-2".to_owned(),
                return_view: View::Albums,
                return_offset: offset,
                seed: Some(seed("album-2")),
            })
        );
        assert_eq!(state.forward, None, "opening clears the forward album");
    }

    #[test]
    fn an_album_without_a_rating_key_is_never_opened() {
        let mut state = opened("album-1");
        assert!(!state.open(Album::default(), View::Albums, Point::default()));
        assert_eq!(
            state
                .selected
                .as_ref()
                .map(|selected| selected.rating_key.as_str()),
            Some("album-1"),
            "the album on show is left alone"
        );
    }

    #[test]
    fn back_moves_the_album_to_forward_and_forward_brings_it_back() {
        let mut state = opened("album-1");
        let request = start_detail(&mut state, "server-1");

        let back = state.close().expect("an album was open");
        assert_eq!(back.return_view, View::Home);
        assert_eq!(back.return_offset, point(px(0.), px(-480.)));
        assert_eq!(state.selected, None);
        assert_eq!(
            state
                .forward
                .as_ref()
                .map(|forward| forward.rating_key.as_str()),
            Some("album-1")
        );
        assert_eq!(state.detail, None, "the detail screen unmounts");
        assert!(
            !state.finish_detail(&request, &server("server-1"), Ok(detail("Kid A", None))),
            "a load that was in flight when Back was pressed has nowhere to land"
        );

        let now = point(px(0.), px(-64.));
        assert!(state.reopen(now));
        assert_eq!(state.forward, None);
        let selected = state.selected.as_ref().expect("forward reopened it");
        assert_eq!(selected.rating_key, "album-1");
        assert_eq!(selected.return_view, View::Home, "returnView is kept");
        assert_eq!(
            selected.return_offset, now,
            "Back lands where Forward was pressed"
        );

        assert!(!state.reopen(now), "nothing left to go forward to");
        assert_eq!(AlbumsState::default().close(), None);
    }

    #[test]
    fn back_and_forward_keep_the_seed_and_a_loaded_detail_refreshes_it() {
        // Back while the detail is still loading: the card's seed goes forward.
        let mut state = opened("album-1");
        start_detail(&mut state, "server-1");
        state.close();
        assert!(state.reopen(Point::default()));
        assert_eq!(
            state
                .selected
                .as_ref()
                .and_then(|selected| selected.seed.clone()),
            Some(seed("album-1")),
            "Forward renders the card's header again"
        );

        // Back once it has loaded: the loaded album replaces the seed, with
        // the count the meta line showed filled in when Plex omitted it.
        let request = start_detail(&mut state, "server-1");
        let loaded = AlbumDetail {
            album: Album {
                title: "In Rainbows (Remastered)".to_owned(),
                leaf_count: None,
                ..seed("album-1")
            },
            tracks: vec![Track::default(), Track::default()],
        };
        assert!(state.finish_detail(&request, &server("server-1"), Ok(loaded.clone())));
        let back = state.close().expect("an album was open");
        let expected = Album {
            leaf_count: Some(2),
            ..loaded.album.clone()
        };
        assert_eq!(back.seed.as_ref(), Some(&expected));
        assert_eq!(
            state
                .forward
                .as_ref()
                .and_then(|forward| forward.seed.as_ref()),
            Some(&expected)
        );

        // A failed load leaves the seed it had.
        assert!(state.reopen(Point::default()));
        let request = start_detail(&mut state, "server-1");
        assert!(state.finish_detail(
            &request,
            &server("server-1"),
            Err("fetch failed".to_owned())
        ));
        assert_eq!(
            state.close().and_then(|back| back.seed),
            Some(expected),
            "only a ready detail refreshes the seed"
        );
    }

    #[test]
    fn the_seed_renders_only_while_the_detail_is_pending() {
        assert!(!AlbumsState::default().detail_pending());
        assert_eq!(AlbumsState::default().loading_seed(), None);

        let mut state = opened("album-1");
        assert!(state.detail_pending(), "no state yet is a pending load");
        assert_eq!(state.loading_seed(), Some(&seed("album-1")));
        assert_eq!(state.ready_detail(), None);

        let request = start_detail(&mut state, "server-1");
        assert!(state.detail_pending());
        assert_eq!(state.loading_seed(), Some(&seed("album-1")));

        assert!(state.finish_detail(&request, &server("server-1"), Ok(detail("Kid A", None))));
        assert!(!state.detail_pending());
        assert_eq!(state.loading_seed(), None, "the loaded header takes over");
        assert_eq!(
            state
                .ready_detail()
                .map(|detail| detail.album.title.as_str()),
            Some("Kid A")
        );

        let request = start_detail(&mut state, "server-1");
        assert!(state.finish_detail(
            &request,
            &server("server-1"),
            Err("fetch failed".to_owned())
        ));
        assert!(!state.detail_pending());
        assert_eq!(state.loading_seed(), None, "an error shows no header");
        assert_eq!(state.ready_detail(), None);

        // A state left over from another album is a load that has not
        // reported back.
        state.detail = Some(DetailState {
            rating_key: "album-9".to_owned(),
            status: Status::Ready,
            detail: Some(detail("Other", None)),
            error: None,
        });
        assert!(state.detail_pending());
        assert_eq!(state.ready_detail(), None);

        // Opened without a seed (only a preview does this): pending, but
        // there is nothing to render a header from.
        state.selected = state.selected.take().map(|selected| AlbumNavigation {
            seed: None,
            ..selected
        });
        assert!(state.detail_pending());
        assert_eq!(state.loading_seed(), None);
    }

    #[test]
    fn clearing_navigation_drops_both_albums_and_supersedes_the_detail_load() {
        let mut state = opened("album-1");
        let request = start_detail(&mut state, "server-1");
        state.forward = state.selected.clone();

        state.clear_navigation();
        assert_eq!(state.selected, None);
        assert_eq!(state.forward, None);
        assert_eq!(state.detail, None);
        assert!(!state.finish_detail(&request, &server("server-1"), Ok(detail("Kid A", None))));
    }

    #[test]
    fn a_server_switch_clears_navigation_and_resets_the_library() {
        let mut state = opened("album-1");
        state.set_server(server("server-1"));
        let sections = ready_sections(vec![section("1")]);
        let Some(Begin::Start(request)) = state.begin_library(&sections) else {
            panic!("expected a library request");
        };
        assert!(state.library.finish(&request, Ok(vec![album("album-1")])));
        assert!(state.open(seed("album-1"), View::Albums, Point::default()));
        state.forward = state.selected.clone();

        assert!(state.set_server(server("server-2")));
        assert_eq!(state.selected, None);
        assert_eq!(state.forward, None);
        assert_eq!(state.detail, None);
        assert_eq!(state.library.status, Status::Idle);
        assert!(state.library.items.is_empty());

        // Re-selecting the same server is a no-op, navigation included.
        assert!(state.open(seed("album-9"), View::Albums, Point::default()));
        assert!(!state.set_server(server("server-2")));
        assert!(state.selected.is_some());
    }

    // -----------------------------------------------------------------------
    // Library load
    // -----------------------------------------------------------------------

    #[test]
    fn the_library_waits_for_the_music_sections() {
        let mut state = AlbumsState::default();
        state.set_server(server("server-1"));

        let mut sections = Load::<Section>::default();
        assert_eq!(state.begin_library(&sections), None, "idle sections");
        sections.set_server(server("server-1"));
        let Begin::Start(_) = sections.begin() else {
            panic!("expected a sections request");
        };
        assert_eq!(state.begin_library(&sections), None, "loading sections");
        assert_eq!(state.library.status, Status::Idle, "nothing started");
    }

    #[test]
    fn a_library_with_no_music_sections_is_ready_and_empty_without_a_request() {
        let mut state = AlbumsState::default();
        state.set_server(server("server-1"));
        let sections = ready_sections(Vec::new());

        assert_eq!(state.begin_library(&sections), Some(Begin::Cached));
        assert_eq!(state.library.status, Status::Ready);
        assert!(state.library.items.is_empty());
    }

    #[test]
    fn the_library_is_loaded_once_per_server_and_shared_while_in_flight() {
        let mut state = AlbumsState::default();
        state.set_server(server("server-1"));
        let sections = ready_sections(vec![section("1"), section("4")]);

        let Some(Begin::Start(request)) = state.begin_library(&sections) else {
            panic!("expected a library request");
        };
        assert_eq!(state.library.status, Status::Loading);
        assert_eq!(state.begin_library(&sections), Some(Begin::Pending));

        assert!(
            state
                .library
                .finish(&request, Ok(vec![album("album-1"), album("album-2")]))
        );
        assert_eq!(
            state.begin_library(&sections),
            Some(Begin::Cached),
            "never refetched"
        );
        assert_eq!(state.library.items.len(), 2);
    }

    #[test]
    fn a_library_response_from_a_superseded_server_is_dropped() {
        let mut state = AlbumsState::default();
        state.set_server(server("server-1"));
        let sections = ready_sections(vec![section("1")]);
        let Some(Begin::Start(stale)) = state.begin_library(&sections) else {
            panic!("expected a library request");
        };

        state.set_server(server("server-2"));
        assert!(!state.library.finish(&stale, Ok(vec![album("stale")])));
        assert_eq!(state.library.status, Status::Idle);
        assert!(state.library.items.is_empty());
    }

    #[test]
    fn a_failed_library_load_can_be_retried() {
        let mut state = AlbumsState::default();
        state.set_server(server("server-1"));
        let sections = ready_sections(vec![section("1")]);
        let Some(Begin::Start(request)) = state.begin_library(&sections) else {
            panic!("expected a library request");
        };
        assert!(
            state
                .library
                .finish(&request, Err("fetch failed".to_owned()))
        );
        assert_eq!(state.library.status, Status::Error);

        let Some(Begin::Start(retry)) = state.begin_library(&sections) else {
            panic!("an error is retried, not cached");
        };
        assert!(state.library.finish(&retry, Ok(vec![album("album-1")])));
        assert_eq!(state.library.status, Status::Ready);
        assert_eq!(state.library.error, None);
    }

    // -----------------------------------------------------------------------
    // Detail load
    // -----------------------------------------------------------------------

    #[test]
    fn the_detail_load_resets_to_loading_and_applies_its_result() {
        let mut state = opened("album-1");
        assert_eq!(
            AlbumsState::default().begin_detail(server("server-1")),
            None
        );

        let request = start_detail(&mut state, "server-1");
        let loading = state.detail.as_ref().expect("the detail is loading");
        assert_eq!(loading.status, Status::Loading);
        assert_eq!(loading.rating_key, "album-1");

        assert!(state.finish_detail(
            &request,
            &server("server-1"),
            Err("fetch failed".to_owned())
        ));
        let failed = state.detail.as_ref().expect("the detail failed");
        assert_eq!(failed.status, Status::Error);
        assert_eq!(failed.error.as_deref(), Some("fetch failed"));

        // "Try again" resets to loading and refetches.
        let retry = start_detail(&mut state, "server-1");
        assert_eq!(
            state.detail.as_ref().map(|detail| detail.status),
            Some(Status::Loading)
        );
        assert_eq!(
            state
                .detail
                .as_ref()
                .and_then(|detail| detail.error.clone()),
            None
        );
        assert!(
            !state.finish_detail(&request, &server("server-1"), Ok(detail("stale", None))),
            "the first run is superseded"
        );
        assert!(state.finish_detail(&retry, &server("server-1"), Ok(detail("Kid A", None))));
        let ready = state.detail.as_ref().expect("the detail is ready");
        assert_eq!(ready.status, Status::Ready);
        assert_eq!(
            ready
                .detail
                .as_ref()
                .map(|detail| detail.album.title.as_str()),
            Some("Kid A")
        );
    }

    #[test]
    fn a_detail_response_for_another_server_or_album_is_dropped() {
        let mut state = opened("album-1");
        let request = start_detail(&mut state, "server-1");
        assert!(
            !state.finish_detail(&request, &server("server-2"), Ok(detail("Kid A", None))),
            "the server switched under the request"
        );

        // Another album opened: the run moves on, and the key no longer matches
        // either.
        let request = start_detail(&mut state, "server-1");
        assert!(state.open(seed("album-2"), View::Albums, Point::default()));
        assert!(!state.finish_detail(&request, &server("server-1"), Ok(detail("Kid A", None))));
        assert_eq!(state.detail, None);
    }

    #[test]
    fn the_cover_starts_from_the_seed_and_follows_the_loaded_album() {
        const SEED_THUMB: &str = "/library/metadata/album-1/thumb/1";

        let mut state = opened("album-1");
        assert_eq!(
            state.cover_path(),
            Some(SEED_THUMB),
            "the load starts in the frame the album opens"
        );
        let request = start_detail(&mut state, "server-1");
        assert_eq!(state.cover_path(), Some(SEED_THUMB), "still loading");

        // The normal case: the detail names the same thumb, so the key (and
        // the load already running for it) does not change.
        assert!(state.finish_detail(
            &request,
            &server("server-1"),
            Ok(detail("In Rainbows", Some(SEED_THUMB)))
        ));
        assert_eq!(state.cover_path(), Some(SEED_THUMB));

        // A detail whose thumb moved on is followed.
        let request = start_detail(&mut state, "server-1");
        assert_eq!(state.cover_path(), Some(SEED_THUMB), "loading again");
        assert!(state.finish_detail(
            &request,
            &server("server-1"),
            Ok(detail("Kid A", Some("/library/metadata/1/thumb/9")))
        ));
        assert_eq!(state.cover_path(), Some("/library/metadata/1/thumb/9"));

        let request = start_detail(&mut state, "server-1");
        assert!(state.finish_detail(&request, &server("server-1"), Ok(detail("Kid A", Some("")))));
        assert_eq!(
            state.cover_path(),
            None,
            "an empty thumb has nothing to load"
        );

        let request = start_detail(&mut state, "server-1");
        assert!(state.finish_detail(
            &request,
            &server("server-1"),
            Err("fetch failed".to_owned())
        ));
        assert_eq!(state.cover_path(), None, "the error state has no cover");

        state.close();
        assert_eq!(state.cover_path(), None, "Back unmounts the cover");

        // No seed, or a seed without a usable thumb: nothing until the detail
        // is ready.
        let mut state = opened("album-1");
        state.selected = state.selected.take().map(|selected| AlbumNavigation {
            seed: Some(Album {
                thumb: Some(String::new()),
                ..seed("album-1")
            }),
            ..selected
        });
        assert_eq!(state.cover_path(), None, "an empty seed thumb");
        state.selected = state.selected.take().map(|selected| AlbumNavigation {
            seed: None,
            ..selected
        });
        let request = start_detail(&mut state, "server-1");
        assert_eq!(state.cover_path(), None, "no seed");
        assert!(state.finish_detail(
            &request,
            &server("server-1"),
            Ok(detail("Kid A", Some("/library/metadata/1/thumb/9")))
        ));
        assert_eq!(state.cover_path(), Some("/library/metadata/1/thumb/9"));
    }

    // -----------------------------------------------------------------------
    // Status banner
    // -----------------------------------------------------------------------

    #[test]
    fn the_library_banner_follows_the_album_table() {
        let sections = |status, items: Vec<Section>, error| Load::preview(status, items, error);
        let library = |status, items: Vec<HubItem>, error| Load::preview(status, items, error);
        let music = || vec![section("1")];

        // Sections idle or loading: loading, whatever the albums say.
        for status in [Status::Idle, Status::Loading] {
            assert_eq!(
                library_banner(
                    &sections(status, Vec::new(), None),
                    &library(Status::Error, Vec::new(), Some("x"))
                ),
                Some(LibraryBanner::Loading)
            );
        }
        // Sections failed: their error, retried by reloading the sections.
        assert_eq!(
            library_banner(
                &sections(Status::Error, Vec::new(), Some("Plex request failed")),
                &library(Status::Ready, vec![album("album-1")], None)
            ),
            Some(LibraryBanner::Error {
                message: "Couldn’t load your albums: Plex request failed".to_owned(),
                retry: Retry::Sections,
            })
        );
        assert_eq!(
            library_banner(
                &sections(Status::Error, Vec::new(), Some("")),
                &library(Status::Idle, Vec::new(), None)
            ),
            Some(LibraryBanner::Error {
                message: "Couldn’t load your albums.".to_owned(),
                retry: Retry::Sections,
            })
        );
        // Ready with no music sections: empty.
        assert_eq!(
            library_banner(
                &sections(Status::Ready, Vec::new(), None),
                &library(Status::Idle, Vec::new(), None)
            ),
            Some(LibraryBanner::Empty)
        );
        // Ready sections, albums idle or loading: loading.
        for status in [Status::Idle, Status::Loading] {
            assert_eq!(
                library_banner(
                    &sections(Status::Ready, music(), None),
                    &library(status, Vec::new(), None)
                ),
                Some(LibraryBanner::Loading)
            );
        }
        // Ready sections, albums failed: their error, retried by the album load.
        assert_eq!(
            library_banner(
                &sections(Status::Ready, music(), None),
                &library(Status::Error, Vec::new(), Some("fetch failed"))
            ),
            Some(LibraryBanner::Error {
                message: "Couldn’t load your albums: fetch failed".to_owned(),
                retry: Retry::Albums,
            })
        );
        assert_eq!(
            library_banner(
                &sections(Status::Ready, music(), None),
                &library(Status::Error, Vec::new(), None)
            ),
            Some(LibraryBanner::Error {
                message: "Couldn’t load your albums.".to_owned(),
                retry: Retry::Albums,
            })
        );
        // Ready and empty, then ready with albums: the grid alone.
        assert_eq!(
            library_banner(
                &sections(Status::Ready, music(), None),
                &library(Status::Ready, Vec::new(), None)
            ),
            Some(LibraryBanner::Empty)
        );
        assert_eq!(
            library_banner(
                &sections(Status::Ready, music(), None),
                &library(Status::Ready, vec![album("album-1")], None)
            ),
            None
        );
    }

    #[test]
    fn the_banner_copy_uses_the_reference_typography() {
        assert_eq!(LIBRARY_EMPTY, "No albums found in this library.");
        let Some(LibraryBanner::Error { message, .. }) = library_banner(
            &Load::preview(Status::Ready, vec![section("1")], None),
            &Load::preview(Status::Error, Vec::new(), Some("fetch failed")),
        ) else {
            panic!("expected the error banner");
        };
        assert!(
            message.contains('’'),
            "the typographic apostrophe: {message}"
        );
    }

    // -----------------------------------------------------------------------
    // HANOI_START
    // -----------------------------------------------------------------------

    #[test]
    fn hanoi_start_names_the_two_album_screens() {
        assert_eq!(Start::parse("albums"), Some(Start::Albums));
        assert_eq!(Start::parse(" album\n"), Some(Start::Album));
        assert_eq!(Start::parse("home"), None);
        assert_eq!(Start::parse(""), None);
        assert!(Start::ALL.iter().all(|value| Start::parse(value).is_some()));
    }

    #[test]
    fn hanoi_start_album_opens_the_first_album_once_the_library_settles() {
        let mut state = AlbumsState {
            start: Some(Start::Album),
            ..AlbumsState::default()
        };
        state.set_server(server("server-1"));
        let sections = ready_sections(vec![section("1")]);
        let Some(Begin::Start(request)) = state.begin_library(&sections) else {
            panic!("expected a library request");
        };
        assert_eq!(state.take_start_album(), None, "still loading");
        assert_eq!(state.start, Some(Start::Album), "and still waiting");

        assert!(
            state
                .library
                .finish(&request, Ok(vec![album("album-7"), album("album-8")]))
        );
        assert_eq!(
            state.take_start_album(),
            Some(Album::from_hub_item(&album("album-7"))),
            "the first card's item seeds the album it opens"
        );
        assert_eq!(state.start, None);
        assert_eq!(state.take_start_album(), None, "only once");
    }

    #[test]
    fn hanoi_start_album_gives_up_on_an_empty_library_or_a_real_navigation() {
        let mut state = AlbumsState {
            start: Some(Start::Album),
            library: Load::preview(Status::Ready, Vec::new(), None),
            ..AlbumsState::default()
        };
        assert_eq!(state.take_start_album(), None);
        assert_eq!(state.start, None, "an empty library consumes the request");

        let mut state = AlbumsState {
            start: Some(Start::Album),
            ..AlbumsState::default()
        };
        assert!(state.open(seed("album-3"), View::Home, Point::default()));
        assert_eq!(state.start, None, "the user opened an album first");
    }
}
