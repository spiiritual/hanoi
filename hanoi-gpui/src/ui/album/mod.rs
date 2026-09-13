//! The album screens: `album-screen.tsx` + `AlbumScreen.css`.
//!
//! `AlbumLibrary` (the sidebar's Albums view) lives in `library.rs`,
//! `AlbumDetail` in `detail.rs`. See `ALBUM.md` for the spec.

pub mod actions;
pub mod detail;
pub mod library;
pub mod preview;
pub mod state;
pub mod utils;

use gpui::{AnyElement, Context};

use super::root::Root;

/// The Albums view's body inside `.home-content`: the album on show, or the
/// library grid.
pub fn render(root: &Root, cx: &mut Context<Root>) -> AnyElement {
    if root.home.albums.selected.is_some() {
        detail::render(root, cx)
    } else {
        library::render(root, cx)
    }
}
