//! `welcome-screen.tsx`.

use gpui::{AnyElement, Context, FontWeight, div, prelude::*, px, relative};

use crate::ui::components::{app_name, auth_inner, link_muted, logo_mark, spacer};
use crate::ui::root::Root;
use crate::ui::theme::{ACCENT, ACCENT_HOVER, LINE_HEIGHT_NORMAL, ON_ACCENT, TEXT_SECONDARY};

const SIGN_UP_URL: &str = "https://www.plex.tv/sign-up/";
const TAGLINE: &str = "A desktop music player for Plex.";
/// `Don&apos;t have an account?&nbsp; Create one`
const CREATE_ACCOUNT: &str = "Don't have an account?\u{a0} Create one";

pub fn render(cx: &mut Context<Root>) -> AnyElement {
    auth_inner()
        .child(logo_mark())
        .child(spacer(12.))
        .child(app_name())
        .child(spacer(21.))
        .child(
            div()
                .text_size(px(17.))
                .font_weight(FontWeight::NORMAL)
                .text_color(TEXT_SECONDARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(TAGLINE),
        )
        .child(spacer(40.))
        .child(
            // `.btn-signin`
            div()
                .id("welcome-sign-in")
                .w(px(320.))
                .h(px(52.))
                .px(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .gap(px(10.))
                .bg(ACCENT)
                .text_color(ON_ACCENT)
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .rounded(px(26.))
                .cursor_pointer()
                .hover(|style| style.bg(ACCENT_HOVER))
                .child(
                    // `.plex-icon`
                    div()
                        .size(px(20.))
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .text_size(px(14.))
                        .child("▶"),
                )
                .child("Sign in with Plex")
                .on_click(cx.listener(|this, _, _, cx| this.sign_in(cx))),
        )
        .child(spacer(16.))
        .child(link_muted(
            "welcome-create-account",
            CREATE_ACCOUNT,
            true,
            move |_, _, cx| cx.open_url(SIGN_UP_URL),
        ))
        .child(spacer(64.))
        .into_any_element()
}
