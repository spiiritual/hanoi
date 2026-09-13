//! `.home-topbar` from `home-screen.tsx` + `HomeScreen.css`.
//!
//! Every control is inert: there is no navigation stack yet (so back and
//! forward are `disabled`, exactly as the reference renders them with no detail
//! open), search text entry is out of scope, and the queue and notification
//! buttons are `disabled` in the reference too.

use gpui::{Div, FontWeight, div, prelude::*, px, relative, svg};

use crate::ui::components::icons;
use crate::ui::theme::{LINE_HEIGHT_NORMAL, SURFACE_2, TEXT_SECONDARY, TEXT_TERTIARY};

const PLACEHOLDER: &str = "Search songs, albums, artists";

/// `.home-topbar`
pub fn render() -> Div {
    div()
        .flex_none()
        .h(px(64.))
        .w_full()
        .flex()
        .items_center()
        .gap(px(16.))
        .px(px(28.))
        .child(icon_button(icons::CHEVRON_LEFT))
        .child(icon_button(icons::CHEVRON_RIGHT))
        .child(search())
        // `.topbar-spacer`
        .child(div().flex_1().min_w_0())
        .child(icon_button(icons::QUEUE))
        .child(icon_button(icons::BELL))
}

/// `.topbar-icon:disabled` — the muted 20px glyph.
fn icon_button(icon: &'static str) -> Div {
    div()
        .size(px(20.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .cursor_default()
        .child(svg().size(px(20.)).path(icon).text_color(TEXT_TERTIARY))
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
