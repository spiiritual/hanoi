//! The behaviour behind the album screens: the library and detail loads,
//! album navigation (open / Back / Forward) and the cover artwork.
//!
//! Same rules as `home/actions.rs`: everything blocking runs on
//! `cx.background_spawn`, and every result is applied through
//! `this.update(cx, ..)` + `cx.notify()` only if its guard still recognises it.
//! The decisions themselves — which load to start, whether a response is
//! stale, where Back lands — are the pure methods in `state.rs`.

use gpui::{Context, Point, prelude::*};

use crate::plex::{self, Album};
use crate::ui::home::state::{Begin, NO_SERVER_ERROR, Slot, View};
use crate::ui::root::Root;

use super::state::{LibraryBanner, Retry, START_ENV, Start, library_banner};

impl Root {
    // -----------------------------------------------------------------------
    // Loads
    // -----------------------------------------------------------------------

    /// `AlbumLibrary`'s effect: load the merged album list for the selected
    /// server once the music sections are ready.
    ///
    /// Kicked from `change_view(View::Albums)`, from Back landing on the grid,
    /// and from the sections load finishing while the grid is on show. It is
    /// a no-op until the sections are `ready`, returns the cached albums once
    /// they are, and joins a load that is already running.
    pub fn load_albums(&mut self, cx: &mut Context<Self>) {
        if self.preview {
            return;
        }
        let begin = self.home.albums.begin_library(&self.home.sections);
        let request = match begin {
            Some(Begin::Start(request)) => request,
            // Ready already (or ready and empty without a request): a
            // `HANOI_START=album` still waiting can open its album now.
            Some(Begin::Cached) => {
                self.open_start_album(cx);
                cx.notify();
                return;
            }
            Some(Begin::Pending | Begin::NoServer) | None => {
                cx.notify();
                return;
            }
        };
        cx.notify();
        let Some(server) = self
            .config
            .as_ref()
            .and_then(|config| config.server.clone())
        else {
            self.home
                .albums
                .library
                .finish(&request, Err(NO_SERVER_ERROR.to_owned()));
            cx.notify();
            return;
        };
        let sections = self.home.sections.items.clone();

        self.albums_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    plex::get_library_albums(&server, &sections)
                        .map(|albums| albums.iter().map(Album::to_hub_item).collect())
                        .map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.home.albums.library.finish(&request, result) {
                    log::debug!(
                        "albums: library {:?} with {} albums",
                        this.home.albums.library.status,
                        this.home.albums.library.items.len()
                    );
                    this.open_start_album(cx);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// "Try again" under `.album-library-status`: re-run whichever load the
    /// banner is reporting. A sections failure reloads the sections, whose
    /// completion loads the albums in turn.
    pub fn retry_albums(&mut self, cx: &mut Context<Self>) {
        let retry = match library_banner(&self.home.sections, &self.home.albums.library) {
            Some(LibraryBanner::Error { retry, .. }) => retry,
            _ => return,
        };
        match retry {
            Retry::Sections => self.load_music_sections(cx),
            Retry::Albums => self.load_albums(cx),
        }
    }

    /// `AlbumDetail`'s effect for the album on show: bump the run, reset the
    /// detail to loading and fetch it, applying the result only if the run,
    /// the server and the album on show still match.
    fn load_album(&mut self, cx: &mut Context<Self>) {
        let server = self.home_server_key();
        let Some(request) = self.home.albums.begin_detail(server.clone()) else {
            return;
        };
        cx.notify();

        // Preview mode never touches the network: a card clicked in a preview
        // opens the sample album.
        if self.preview {
            let detail = super::preview::sample_detail();
            self.home
                .albums
                .finish_detail(&request, &server, Ok(detail));
            return;
        }
        let Some(config) = self
            .config
            .as_ref()
            .and_then(|config| config.server.clone())
        else {
            self.home
                .albums
                .finish_detail(&request, &server, Err(NO_SERVER_ERROR.to_owned()));
            return;
        };

        let rating_key = request.rating_key.clone();
        self.album_task = Some(cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    plex::get_album(&config, &rating_key).map_err(|error| error.to_string())
                })
                .await;
            this.update(cx, |this, cx| {
                let server = this.home_server_key();
                if this.home.albums.finish_detail(&request, &server, result) {
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    /// `openAlbum` — show one album's detail screen.
    ///
    /// `openDetail("Album", item)`: remember the view and the `.home-content`
    /// offset for Back, switch to Albums without `change_view` (a category
    /// open on Home survives), start at the top and load the album. `seed` is
    /// the clicked card's album: the header renders from it, and the next
    /// render pass starts the cover load from its thumb, while `getAlbum` runs.
    pub fn open_album(&mut self, seed: Album, cx: &mut Context<Self>) {
        let offset = self.artwork.content_scroll.offset();
        if !self.home.open_album(seed, offset) {
            return;
        }
        self.artwork.content_scroll.set_offset(Point::default());
        self.enter_artwork_surface();
        self.load_album(cx);
        cx.notify();
    }

    /// The topbar's Back button: `closeDetail`.
    ///
    /// Lands on the view the album was opened from, where `.home-content` was
    /// scrolled to. Landing on the Albums grid (re)starts its load, which is
    /// free once it is cached.
    pub fn close_album(&mut self, cx: &mut Context<Self>) {
        let Some(offset) = self.home.close_album() else {
            return;
        };
        self.album_task = None;
        // gpui clamps this against the restored screen on the next layout.
        self.artwork.content_scroll.set_offset(offset);
        self.enter_artwork_surface();
        if self.home.album_library_showing() {
            self.load_albums(cx);
        }
        cx.notify();
    }

    /// The topbar's Forward button: `reopenDetail`.
    ///
    /// The reference remounts `AlbumDetail`, which refetches; so does this.
    pub fn reopen_album(&mut self, cx: &mut Context<Self>) {
        let offset = self.artwork.content_scroll.offset();
        if !self.home.reopen_album(offset) {
            return;
        }
        self.artwork.content_scroll.set_offset(Point::default());
        self.enter_artwork_surface();
        self.load_album(cx);
        cx.notify();
    }

    /// "Try again" under `.album-detail-error`.
    pub fn retry_album(&mut self, cx: &mut Context<Self>) {
        self.load_album(cx);
    }

    // -----------------------------------------------------------------------
    // Artwork
    // -----------------------------------------------------------------------

    /// The decoded cover of the album on show, if it has arrived.
    pub fn album_cover_slot(&self) -> Option<Slot> {
        let key = self.album_cover_key()?;
        self.artwork.slot(&key)
    }

    /// The clicked card's frame for the same artwork, if the slot map still
    /// holds it: `.album-detail-art` draws it scaled up until the cover
    /// arrives. Never loaded for its own sake (see `ensure_artwork`).
    pub fn album_cover_placeholder_slot(&self) -> Option<Slot> {
        let key = self.album_cover_placeholder_key()?;
        self.artwork.slot(&key)
    }

    // -----------------------------------------------------------------------
    // Player (not ported)
    // -----------------------------------------------------------------------

    /// Play (`shuffle == false`) or Shuffle on the detail header. The player is
    /// not ported, so this only records the intent.
    pub fn play_album(&mut self, shuffle: bool) {
        log::debug!("album: play requested (shuffle: {shuffle}); the player is not ported");
    }

    /// A click on track row `index`. The player is not ported, so this only
    /// records the intent.
    pub fn play_album_track(&mut self, index: usize) {
        log::debug!("album: track {index} requested; the player is not ported");
    }

    // -----------------------------------------------------------------------
    // HANOI_START
    // -----------------------------------------------------------------------

    /// Read `HANOI_START` once, for a live run. An unknown value is ignored
    /// with a warning rather than failing the launch.
    pub fn read_start() -> Option<Start> {
        let value = std::env::var(START_ENV).ok()?;
        let start = Start::parse(&value);
        match start {
            Some(start) => log::debug!("{START_ENV}={value:?}: starting on {start:?}"),
            None => log::warn!(
                "unknown {START_ENV}={value:?}; expected one of {}",
                Start::ALL.join(", ")
            ),
        }
        start
    }

    /// The shell has opened: act on `HANOI_START`. `albums` is done once the
    /// view is entered; `album` waits for the library to load.
    pub(crate) fn apply_start(&mut self, cx: &mut Context<Self>) {
        let Some(start) = self.home.albums.start else {
            return;
        };
        log::debug!("{START_ENV}: entering the Albums view");
        self.change_view(View::Albums, cx);
        if start == Start::Albums {
            self.home.albums.start = None;
        }
    }

    /// `HANOI_START=album`, once the library has settled.
    fn open_start_album(&mut self, cx: &mut Context<Self>) {
        if let Some(seed) = self.home.albums.take_start_album() {
            log::debug!("{START_ENV}: opening the first album of the library");
            self.open_album(seed, cx);
        }
    }
}
