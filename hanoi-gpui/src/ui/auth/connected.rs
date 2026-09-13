//! `connected-screen.tsx` + `account-card.tsx` + `ConnectedScreen.css`.

use gpui::{
    AnyElement, Context, Div, FontWeight, ObjectFit, StyledImage as _, div, img, linear_color_stop,
    linear_gradient, prelude::*, px, relative,
};

use crate::ui::components::{auth_inner, caption, primary_button, spacer, title};
use crate::ui::root::Root;
use crate::ui::theme::{
    ACCENT, ACCENT_2, BADGE_CHECK_FG, LINE_HEIGHT_NORMAL, ON_ACCENT, SUCCESS, SUCCESS_BG, SURFACE,
    SURFACE_2, TEXT_PRIMARY,
};

const TITLE: &str = "You're signed in!";
const FALLBACK_NAME: &str = "Plex account";
const FALLBACK_EMAIL: &str = "Account details unavailable";

pub fn render(root: &Root, cx: &mut Context<Root>) -> AnyElement {
    auth_inner()
        .child(badge())
        .child(spacer(28.))
        .child(title(TITLE))
        .child(spacer(40.))
        .child(account_card(root))
        .child(spacer(40.))
        .child(primary_button(
            "connected-continue",
            "Continue",
            true,
            cx.listener(|this, _, _, cx| this.continue_to_servers(cx)),
        ))
        .into_any_element()
}

/// `.badge` + `.badge-check`
fn badge() -> Div {
    div()
        .size(px(88.))
        .rounded(px(44.))
        .bg(SUCCESS_BG)
        .flex()
        .items_center()
        .justify_center()
        .child(
            div()
                .size(px(40.))
                .rounded(px(20.))
                .bg(SUCCESS)
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(24.))
                .font_weight(FontWeight::EXTRA_BOLD)
                .text_color(BADGE_CHECK_FG)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child("✓"),
        )
}

/// `.account-card`
fn account_card(root: &Root) -> Div {
    let name = root
        .account
        .as_ref()
        .map(|account| account.username.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| FALLBACK_NAME.to_owned());
    let email = root
        .account
        .as_ref()
        .map(|account| account.email.clone())
        .filter(|email| !email.is_empty())
        .unwrap_or_else(|| FALLBACK_EMAIL.to_owned());

    div()
        .flex()
        .items_center()
        .gap(px(16.))
        .px(px(20.))
        .py(px(15.))
        .min_h(px(82.))
        .bg(SURFACE)
        .border_1()
        .border_color(SURFACE_2)
        .rounded(px(14.))
        .child(avatar(root, &name))
        .child(
            // `.card-info`
            div()
                .flex()
                .flex_col()
                .gap(px(3.))
                .min_w_0()
                .text_left()
                .child(
                    div()
                        .text_size(px(15.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(TEXT_PRIMARY)
                        .line_height(relative(LINE_HEIGHT_NORMAL))
                        .child(name),
                )
                .child(caption(email)),
        )
}

/// `.avatar` — the gradient circle, with the account thumb over it once it has
/// been fetched and decoded.
fn avatar(root: &Root, name: &str) -> Div {
    let circle = div()
        .size(px(52.))
        .flex_none()
        .rounded(px(26.))
        .overflow_hidden()
        .bg(linear_gradient(
            135.,
            linear_color_stop(ACCENT, 0.),
            linear_color_stop(ACCENT_2, 1.),
        ))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(18.))
        .font_weight(FontWeight::BOLD)
        .text_color(ON_ACCENT)
        .line_height(relative(LINE_HEIGHT_NORMAL));

    match root.avatar.clone() {
        Some(image) => circle.child(
            img(image)
                .size(px(52.))
                .object_fit(ObjectFit::Cover)
                .rounded(px(26.)),
        ),
        None => circle.child(initials(name)),
    }
}

/// `initials` from `../src/mainview/utils.ts`.
fn initials(name: &str) -> String {
    name.split_whitespace()
        .take(2)
        .filter_map(|word| word.chars().next())
        .collect::<String>()
        .to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::initials;

    #[test]
    fn initials_take_the_first_letter_of_up_to_two_words() {
        assert_eq!(initials("Alex Rivera"), "AR");
        assert_eq!(initials("alexr"), "A");
        assert_eq!(initials("ada b lovelace"), "AB");
        assert_eq!(initials("   "), "");
    }
}
