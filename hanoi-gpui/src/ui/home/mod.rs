//! The authenticated shell: `home-screen.tsx` + `HomeScreen.css`.
//!
//! `.app-shell` is a full-window row — the 240px sidebar next to `.home-main`,
//! a column of the 64px topbar over the scrolling `.home-content`. The player
//! bar is out of scope (see `HOME.md`), so `.home-main` takes the full height
//! instead of the CSS's `calc(100% - 88px)`.

mod actions;
pub mod card;
pub mod dashboard;
pub mod sidebar;
pub mod state;
pub mod topbar;
pub mod utils;

use gpui::{AnyElement, Context, Div, FontWeight, div, prelude::*, px, relative};

use super::album;
use super::components::tracked_text;
use super::root::Root;
use super::scrollbar;
use super::theme::{
    ACCENT, BG, LINE_HEIGHT_NORMAL, PANEL_BG, SURFACE_2, TEXT_SECONDARY, TEXT_TERTIARY,
};
use state::{View, library_status_message};

pub fn render(root: &Root, cx: &mut Context<Root>) -> AnyElement {
    // `.app-shell`
    div()
        .size_full()
        .min_w(px(920.))
        .bg(BG)
        .flex()
        .child(sidebar::render(root, cx))
        .child(
            // `.home-main`
            div()
                .flex_1()
                .min_w_0()
                .min_h_0()
                .flex()
                .flex_col()
                .bg(BG)
                .child(topbar::render(root, cx))
                .child(content(root, cx)),
        )
        .into_any_element()
}

/// `.home-content` — the only vertically scrolling region of the shell, inside
/// the positioning parent its overlay scrollbar is measured against.
fn content(root: &Root, cx: &mut Context<Root>) -> Div {
    let body = match root.home.view {
        View::Home => dashboard::render(root, cx),
        // The album detail screen is shown under the Albums view too, exactly
        // as `openDetail` switches `activeView` to `albums`.
        View::Albums => album::render(root, cx),
        view => placeholder(root, view).into_any_element(),
    };

    div()
        .group(scrollbar::CONTENT_GROUP)
        .relative()
        .flex_1()
        .min_h_0()
        .flex()
        .flex_col()
        .child(
            // Scrolled by `Root::scroll_content`: vertical gestures only, so a
            // sideways flick over a row cannot creep the page (see `ui::scroll`).
            div()
                .id("home-content")
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .gap(px(20.))
                .px(px(28.))
                .pb(px(28.))
                .overflow_hidden()
                // The viewport every card's artwork gating is measured against.
                .track_scroll(&root.artwork.content_scroll)
                .on_scroll_wheel(cx.listener(|this, event, window, cx| {
                    this.scroll_content(event, window, cx);
                }))
                .child(body),
        )
        // In the 28px side padding, so the rows keep their full width.
        .children(scrollbar::render(root, scrollbar::Target::Content, cx))
}

/// `.home-shell-placeholder` — what every view outside Home still shows.
fn placeholder(root: &Root, view: View) -> Div {
    let copy = view.copy();
    let status = library_status_message(
        root.home.sections.status,
        root.home.sections.items.len(),
        root.home.sections.error.as_deref(),
    );

    div()
        .w_full()
        .min_h(px(220.))
        .flex()
        .flex_col()
        .items_start()
        .justify_center()
        .p(px(28.))
        .border_1()
        .border_color(SURFACE_2)
        .rounded(px(14.))
        .bg(PANEL_BG)
        .child(
            // `.home-shell-eyebrow` — 11px/700 accent with 0.16em tracking.
            div()
                .text_size(px(11.))
                .font_weight(FontWeight::BOLD)
                .text_color(ACCENT)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(tracked_text(copy.eyebrow, 1.76)),
        )
        .child(
            // `.home-shell-placeholder h2`
            div()
                .mt(px(10.))
                .text_size(px(28.))
                .font_weight(FontWeight::BOLD)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(copy.title),
        )
        .child(
            // `.home-shell-placeholder p`
            div()
                .mt(px(8.))
                .text_size(px(14.))
                .text_color(TEXT_SECONDARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(copy.copy),
        )
        .child(
            // `.home-shell-status`
            div()
                .mt(px(8.))
                .text_size(px(12.))
                .text_color(TEXT_TERTIARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(status),
        )
}
