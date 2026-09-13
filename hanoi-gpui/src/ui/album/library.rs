//! `AlbumLibrary` from `album-screen.tsx` + the `.album-library*`,
//! `.album-filter*`, `.album-sort*` and `.album-grid` rules in
//! `AlbumScreen.css`.

use gpui::{
    AnyElement, Context, Div, FontWeight, SharedString, Stateful, div, prelude::*, px, relative,
    svg,
};

use crate::ui::components::{icons, loading_state};
use crate::ui::home::card;
use crate::ui::home::state::{Status, View};
use crate::ui::root::Root;
use crate::ui::theme::{
    BG, ERROR, ERROR_BORDER, LINE_HEIGHT_NORMAL, PANEL_BG, RETRY_HOVER, SURFACE_2, TEXT_PRIMARY,
    TEXT_SECONDARY,
};

use super::state::{LIBRARY_EMPTY, LibraryBanner, library_banner};

/// `.album-library-title` and `.album-sort-label` — the only sort there is.
const RECENTLY_ADDED: &str = "Recently added";

/// `libraryTabs`: every library view, Albums active.
const TABS: [View; 4] = View::LIBRARY;

/// `.album-library`
///
/// While the library is loading, it and its section grow to fill
/// `.home-content` so the spinner can centre in the space the grid will take;
/// every other state keeps its natural height and scrolls.
pub fn render(root: &Root, cx: &mut Context<Root>) -> AnyElement {
    let banner = library_banner(&root.home.sections, &root.home.albums.library);
    let loading = banner == Some(LibraryBanner::Loading);
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(20.))
        .pb(px(28.))
        .when(loading, |column| column.flex_1())
        .child(filter_tabs(cx))
        .child(section(root, banner, cx))
        .into_any_element()
}

/// `.album-filter-tabs` — the four views, a spacer, then the inert sort label.
fn filter_tabs(cx: &mut Context<Root>) -> Div {
    div()
        .w_full()
        .min_h(px(32.))
        .flex()
        .items_center()
        .gap(px(8.))
        .children(
            TABS.into_iter()
                .enumerate()
                .map(|(index, view)| filter_tab(index, view, cx)),
        )
        // `.album-filter-spacer`
        .child(div().flex_1().min_w_0())
        .child(
            // `.album-sort-icon`
            svg()
                .size(px(18.))
                .flex_none()
                .path(icons::SORT)
                .text_color(TEXT_SECONDARY),
        )
        .child(
            // `.album-sort-label`
            div()
                .flex_none()
                .text_size(px(13.))
                .text_color(TEXT_SECONDARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(RECENTLY_ADDED),
        )
}

/// `.album-filter-tab` / `.album-filter-tab.is-active`.
fn filter_tab(index: usize, view: View, cx: &mut Context<Root>) -> Stateful<Div> {
    let tab = div()
        .id(("album-filter-tab", index))
        .flex_none()
        .h(px(32.))
        .px(px(14.))
        .flex()
        .items_center()
        .rounded(px(16.))
        .text_size(px(13.))
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .child(view.label())
        .on_click(cx.listener(move |this, _, _, cx| this.change_view(view, cx)));

    if view == View::Albums {
        tab.bg(TEXT_PRIMARY)
            .text_color(BG)
            .font_weight(FontWeight::SEMIBOLD)
    } else {
        tab.bg(SURFACE_2)
            .text_color(TEXT_SECONDARY)
            .font_weight(FontWeight::NORMAL)
            .hover(|style| style.bg(RETRY_HOVER).text_color(TEXT_PRIMARY))
    }
}

/// `.album-library-section` — the title, then the spinner, the status banner
/// or the grid.
fn section(root: &Root, banner: Option<LibraryBanner>, cx: &mut Context<Root>) -> Div {
    let library = &root.home.albums.library;
    // `displayedStatus === "ready"`: the cards only render once both loads
    // are ready, and `library_banner` is `None` or `Empty` exactly then.
    let show_cards = root.home.sections.status == Status::Ready
        && !root.home.sections.items.is_empty()
        && library.status == Status::Ready;

    let column = div().min_w_0().flex().flex_col().gap(px(12.)).child(
        // `.album-library-title`
        div()
            .text_size(px(20.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(TEXT_PRIMARY)
            .line_height(relative(LINE_HEIGHT_NORMAL))
            .child(RECENTLY_ADDED),
    );

    let column = match banner {
        None => column,
        // No "Loading albums…" copy: the shell's content areas show the
        // centred `Loading Spinner` from `plex.pen` instead, in the space the
        // grid will take. The empty grid is left out so nothing sits under it.
        Some(LibraryBanner::Loading) => {
            return column
                .flex_1()
                .child(loading_state("album-library-loading"));
        }
        Some(LibraryBanner::Empty) => column.child(status(LIBRARY_EMPTY, false)),
        Some(LibraryBanner::Error { message, .. }) => {
            column.child(status(message, true).child(retry(cx)))
        }
    };

    // `.album-grid` — `repeat(auto-fill, 150px)` with `gap: 24px 12px`, cards
    // at `HOME.md`'s 140px. Always present, like the `<ul>`, so the section's
    // gap below the banner matches. Tracked, though it never scrolls itself,
    // purely so `ensure_artwork` can read each card's bounds: a library can
    // run to thousands of albums and only the ones near the viewport may load.
    column.child(
        div()
            .id("album-grid")
            .track_scroll(&root.artwork.album_grid_scroll)
            .min_w_0()
            .flex()
            .flex_wrap()
            .items_start()
            .gap_x(px(12.))
            .gap_y(px(24.))
            .when(show_cards, |grid| {
                grid.children(library.items.iter().enumerate().map(|(position, item)| {
                    card::render(root, item, true, ("album-grid-card", position).into(), cx)
                }))
            }),
    )
}

/// `.album-library-status` and `.album-library-status.is-error`.
fn status(message: impl Into<SharedString>, error: bool) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(14.))
        .px(px(16.))
        .py(px(14.))
        .border_1()
        .border_color(if error { ERROR_BORDER } else { SURFACE_2 })
        .rounded(px(10.))
        .bg(PANEL_BG)
        .text_size(px(13.))
        .text_color(if error { ERROR } else { TEXT_SECONDARY })
        .line_height(relative(LINE_HEIGHT_NORMAL))
        // The `<span>`. `flex_1` is not in the CSS, but gpui measures text at
        // its narrowest when a flex item may shrink, so without it the span
        // collapses to one glyph per line; growing into the free space draws
        // the same left-aligned text with the retry button still at the end.
        .child(div().flex_1().min_w_0().child(message.into()))
}

/// `.album-library-retry`
fn retry(cx: &mut Context<Root>) -> Stateful<Div> {
    div()
        .id("album-library-retry")
        .flex_none()
        .min_h(px(30.))
        .px(px(12.))
        .flex()
        .items_center()
        .rounded(px(15.))
        .bg(SURFACE_2)
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(TEXT_PRIMARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .hover(|style| style.bg(RETRY_HOVER))
        .child("Try again")
        .on_click(cx.listener(|this, _, _, cx| this.retry_albums(cx)))
}
