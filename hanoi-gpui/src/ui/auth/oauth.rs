//! `oauth-screen.tsx` + `OAuthScreen.css`: the PIN link card, the two steps,
//! the poll status and the cancel button.

use std::time::Duration;

use gpui::{AnyElement, Context, Div, FontWeight, SharedString, div, prelude::*, px, relative};

use crate::ui::components::{
    accent_pill_button, auth_inner, caption, pill_button, spacer, status_row, subtitle,
    surface_pill_button, title,
};
use crate::ui::root::Root;
use crate::ui::theme::{
    COPIED_BG, COPIED_BORDER, COPIED_FG, FONT_MONO, LINE_HEIGHT_NORMAL, SURFACE, SURFACE_2,
    TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY,
};

/// Shown until the real PIN arrives, exactly like the reference's initial state.
pub const PLACEHOLDER_CODE: &str = "A1B2C3";
pub const STATUS_WAITING: &str = "Waiting for authorization…";
pub const STATUS_STILL_WAITING: &str = "Still waiting for authorization…";
pub const STATUS_APPROVED: &str = "Authorization approved — loading…";
/// `waitForPin`'s message when the PIN is never approved.
pub const TIMEOUT_MESSAGE: &str = "Timed out waiting for Plex authorization";
/// How long `.btn-copy` holds its "Copied!" confirmation.
pub const COPIED_FEEDBACK: Duration = Duration::from_millis(2000);

const TITLE: &str = "Link your Plex account";
const SUBTITLE: &str = "Secure OAuth — your Plex password never touches this app.";
const LINK_PREFIX: &str = "plex.tv/link/";

pub fn render(root: &Root, cx: &mut Context<Root>) -> AnyElement {
    auth_inner()
        .child(title(TITLE))
        .child(spacer(8.))
        .child(subtitle(SUBTITLE))
        .child(spacer(36.))
        .child(link_card(root, cx))
        .child(spacer(28.))
        .child(steps())
        .child(spacer(28.))
        .child(status_row("oauth-spinner", root.oauth.status.clone()))
        .child(spacer(20.))
        .child(
            // `.btn-cancel`
            surface_pill_button(
                "oauth-cancel",
                cx.listener(|this, _, _, cx| this.cancel_oauth(cx)),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(TEXT_SECONDARY)
                    .child("✕"),
            )
            .child("Cancel"),
        )
        .into_any_element()
}

/// `.link-card`
fn link_card(root: &Root, cx: &mut Context<Root>) -> Div {
    div()
        .w(px(600.))
        .h(px(150.))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(14.))
        .bg(SURFACE)
        .border_1()
        .border_color(SURFACE_2)
        .rounded(px(14.))
        .child(caption("Your link"))
        .child(
            // `.link-row`
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(
                    // `.link-prefix`
                    div()
                        .text_size(px(22.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(TEXT_TERTIARY)
                        .line_height(relative(LINE_HEIGHT_NORMAL))
                        .child(LINK_PREFIX),
                )
                .child(code_value(&root.oauth.code)),
        )
        .child(
            // `.card-actions`
            div()
                .flex()
                .items_center()
                .gap(px(10.))
                .child(
                    accent_pill_button(
                        "oauth-open",
                        cx.listener(|this, _, _, cx| this.open_auth_link(cx)),
                    )
                    .child(div().text_size(px(12.)).child("↗"))
                    .child("Open in Browser"),
                )
                .child(copy_button(root, cx)),
        )
}

/// `.code-value` — gpui has no letter-spacing, so each glyph is its own element
/// in a 2px gap row. The trailing 2px padding reproduces the advance CSS adds
/// after the last character.
fn code_value(code: &SharedString) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(2.))
        .pr(px(2.))
        .font_family(FONT_MONO)
        .text_size(px(22.))
        .font_weight(FontWeight::BOLD)
        .text_color(crate::ui::theme::ACCENT)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .children(
            code.chars()
                .map(|character| div().child(character.to_string())),
        )
}

/// `.btn-copy`, with the `.is-copied` confirmation state.
fn copy_button(root: &Root, cx: &mut Context<Root>) -> gpui::Stateful<Div> {
    let on_click = cx.listener(|this, _, _, cx| this.copy_auth_link(cx));
    if root.oauth.copied {
        pill_button("oauth-copy")
            .bg(COPIED_BG)
            .text_color(COPIED_FG)
            .border_1()
            .border_color(COPIED_BORDER)
            .child(div().text_size(px(12.)).child("✓"))
            .child("Copied!")
            .on_click(on_click)
    } else {
        surface_pill_button("oauth-copy", on_click).child("Copy link")
    }
}

/// `.steps`
fn steps() -> Div {
    div()
        .w(px(600.))
        .flex()
        .flex_col()
        .gap(px(14.))
        .text_left()
        .child(step(
            "1",
            "Open the link",
            "Tap Open in Browser or copy the link — sign in with your Plex account",
        ))
        .child(step(
            "2",
            "Approve and you're connected",
            "No code to type — this app finishes the handshake automatically",
        ))
}

fn step(number: &'static str, heading: &'static str, description: &'static str) -> Div {
    div()
        .flex()
        .gap(px(14.))
        .items_start()
        .child(
            // `.step-num`
            div()
                .size(px(32.))
                .flex_none()
                .rounded(px(16.))
                .bg(SURFACE_2)
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(TEXT_PRIMARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(number),
        )
        .child(
            // `.step-info`
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(TEXT_PRIMARY)
                        .line_height(relative(LINE_HEIGHT_NORMAL))
                        .child(heading),
                )
                .child(caption(description).mt(px(2.))),
        )
}
