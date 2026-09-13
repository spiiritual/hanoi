//! `.home-topbar` from `home-screen.tsx` (`HomeTopbar`) + `HomeScreen.css`.
//!
//! Back and Forward walk the album navigation (`closeDetail` /
//! `reopenDetail`) and are `disabled` whenever there is nothing to walk to,
//! exactly as the reference renders them. Search text entry is out of scope,
//! and the queue and notification buttons are `disabled` in the reference too.

use gpui::{Context, Div, FontWeight, Stateful, div, prelude::*, px, relative, svg};

use crate::ui::components::icons;
use crate::ui::root::Root;
use crate::ui::theme::{LINE_HEIGHT_NORMAL, SURFACE_2, TEXT_SECONDARY, TEXT_TERTIARY};

const PLACEHOLDER: &str = "Search songs, albums, artists";

/// `.home-topbar`
pub fn render(root: &Root, cx: &mut Context<Root>) -> Div {
    let albums = &root.home.albums;
    // `disabled={!selectedAlbum && ...}` / `disabled={!forwardAlbum && ...}`.
    let back = if albums.selected.is_some() {
        nav_button("topbar-back", icons::CHEVRON_LEFT)
            .on_click(cx.listener(|this, _, _, cx| this.close_album(cx)))
            .into_any_element()
    } else {
        icon_button(icons::CHEVRON_LEFT).into_any_element()
    };
    let forward = if albums.forward.is_some() {
        nav_button("topbar-forward", icons::CHEVRON_RIGHT)
            .on_click(cx.listener(|this, _, _, cx| this.reopen_album(cx)))
            .into_any_element()
    } else {
        icon_button(icons::CHEVRON_RIGHT).into_any_element()
    };

    div()
        .flex_none()
        .h(px(64.))
        .w_full()
        .flex()
        .items_center()
        .gap(px(16.))
        .px(px(28.))
        .child(back)
        .child(forward)
        .child(search())
        // `.topbar-spacer`
        .child(div().flex_1().min_w_0())
        .child(icon_button(icons::QUEUE))
        .child(icon_button(icons::BELL))
}

/// The 20px box every `.topbar-icon` shares.
fn icon_box() -> Div {
    div()
        .size(px(20.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
}

/// `.topbar-icon:disabled` — the muted 20px glyph.
fn icon_button(icon: &'static str) -> Div {
    icon_box()
        .cursor_default()
        .child(svg().size(px(20.)).path(icon).text_color(TEXT_TERTIARY))
}

/// An enabled `.topbar-icon`: `text-secondary` and `cursor: pointer`. The CSS
/// has no hover rule for it.
fn nav_button(id: &'static str, icon: &'static str) -> Stateful<Div> {
    icon_box()
        .id(id)
        .cursor_pointer()
        .child(svg().size(px(20.)).path(icon).text_color(TEXT_SECONDARY))
}

/// `.topbar-search` — the 280px pill, rendered without its `<input>`.
fn search() -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .w(px(280.))
        .h(px(36.))
        .px(px(12.))
        .rounded(px(18.))
        .bg(SURFACE_2)
        .text_size(px(13.))
        .font_weight(FontWeight::NORMAL)
        .text_color(TEXT_TERTIARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_text()
        .child(
            svg()
                .size(px(16.))
                .flex_none()
                .path(icons::SEARCH)
                .text_color(TEXT_SECONDARY),
        )
        .child(PLACEHOLDER)
}
