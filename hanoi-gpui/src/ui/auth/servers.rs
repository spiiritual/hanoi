//! `server-selection-screen.tsx` + `ServerSelection.css`.

use gpui::{AnyElement, AnyView, Context, Div, FontWeight, div, prelude::*, px, relative, svg};

use crate::plex::ServerInfo;
use crate::ui::components::{
    Tooltip, auth_inner, icons, link_muted, primary_button, spacer, spinner, subtitle, title,
};
use crate::ui::root::Root;
use crate::ui::theme::{
    ACCENT, ERROR, LINE_HEIGHT_NORMAL, ON_ACCENT, ROW_HOVER_BORDER, SURFACE, SURFACE_2,
    TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY,
};

const TITLE: &str = "Choose your server";
const SUBTITLE: &str = "Select the Plex server that hosts your music library.";
const LOADING: &str = "Loading your Plex servers…";
const NO_CONNECTION: &str = "No connection available";
const UNAVAILABLE_TOOLTIP: &str = "No server connection is available";
/// `Can&apos;t find your server?&nbsp;{" "}`
const HINT: &str = "Can't find your server?\u{a0} ";

pub fn render(root: &Root, cx: &mut Context<Root>) -> AnyElement {
    let starting = root.server_starting;
    let selectable = root.selected_server.is_some() && !starting;

    auth_inner()
        .child(title(TITLE))
        .child(spacer(8.))
        .child(subtitle(SUBTITLE))
        .child(spacer(36.))
        .child(server_list(root, cx))
        .child(spacer(28.))
        .when_some(root.server_error.clone(), |column, error| {
            column.child(
                // `.server-error`
                div()
                    .max_w(px(520.))
                    .text_size(px(13.))
                    .line_height(px(18.2))
                    .text_color(ERROR)
                    .child(error),
            )
        })
        .child(
            // `.hint`
            div()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(13.))
                .text_color(TEXT_SECONDARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(HINT)
                .child(link_muted(
                    "servers-sign-in-again",
                    "Sign in again",
                    !starting,
                    cx.listener(|this, _, _, cx| this.sign_in_again(cx)),
                )),
        )
        .child(spacer(28.))
        .child(primary_button(
            "servers-start",
            "Start listening",
            selectable,
            cx.listener(|this, _, _, cx| this.start_listening(cx)),
        ))
        .into_any_element()
}

/// `.server-list`
fn server_list(root: &Root, cx: &mut Context<Root>) -> Div {
    let list = div().w(px(520.)).flex().flex_col().gap(px(12.));
    if root.server_loading {
        return list.child(loading_row());
    }
    let username = root
        .account
        .as_ref()
        .map(|account| account.username.clone())
        .filter(|username| !username.is_empty());
    list.children(
        root.servers
            .iter()
            .enumerate()
            .map(|(index, server)| server_row(root, index, server, username.as_deref(), cx)),
    )
}

/// `.server-loading`
fn loading_row() -> Div {
    div()
        .w_full()
        .h(px(76.))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(10.))
        .bg(SURFACE)
        .border_1()
        .border_color(SURFACE_2)
        .rounded(px(12.))
        .text_size(px(13.))
        .text_color(TEXT_SECONDARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(spinner("servers-spinner"))
        .child(LOADING)
}

/// One `.server` row, with its `.sel` and `.is-unavailable` variants.
fn server_row(
    root: &Root,
    index: usize,
    server: &ServerInfo,
    username: Option<&str>,
    cx: &mut Context<Root>,
) -> AnyElement {
    let usable = !server.url.is_empty();
    let selected =
        usable && root.selected_server.as_deref() == Some(server.client_identifier.as_str());
    let host = match (usable, username) {
        (true, Some(username)) => format!("{} · {username}", server.url),
        (true, None) => server.url.clone(),
        (false, Some(username)) => format!("{NO_CONNECTION} · {username}"),
        (false, None) => NO_CONNECTION.to_owned(),
    };

    let row = div()
        .id(("server", index))
        .flex()
        .items_center()
        .gap(px(14.))
        .px(px(18.))
        .h(px(76.))
        .bg(if selected { SURFACE_2 } else { SURFACE })
        .border(if selected { px(1.5) } else { px(1.) })
        .border_color(if selected { ACCENT } else { SURFACE_2 })
        .rounded(px(12.))
        .child(
            // `.server-icon`
            div()
                .size(px(44.))
                .flex_none()
                .rounded(px(10.))
                .bg(ACCENT)
                .flex()
                .items_center()
                .justify_center()
                .child(
                    svg()
                        .size(px(22.))
                        .path(icons::SERVER)
                        .text_color(ON_ACCENT),
                ),
        )
        .child(
            // `.server-info`
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .text_left()
                .child(
                    div()
                        .text_size(px(15.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(TEXT_PRIMARY)
                        .line_height(relative(LINE_HEIGHT_NORMAL))
                        .child(server.name.clone()),
                )
                .child(
                    // `.server-host`
                    div()
                        .mt(px(1.))
                        .text_size(px(12.))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(TEXT_TERTIARY)
                        .line_height(relative(LINE_HEIGHT_NORMAL))
                        // Not `truncate()`: gpui caches the first measurement
                        // of `nowrap` text and never re-truncates once the flex
                        // pass shrinks this column, so the ellipsis would never
                        // appear. Wrapping text with a one-line clamp re-measures
                        // at the final width and truncates with "…" like CSS.
                        .w_full()
                        .overflow_hidden()
                        .whitespace_normal()
                        .text_ellipsis()
                        .line_clamp(1)
                        .child(host),
                ),
        )
        .child(
            // `.server-check`
            div()
                .ml_auto()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .child(
                    svg()
                        .size(px(20.))
                        .path(icons::CHECK_CIRCLE)
                        .text_color(if selected { ACCENT } else { TEXT_TERTIARY }),
                ),
        );

    if !usable {
        return row
            .opacity(0.55)
            .cursor_not_allowed()
            .tooltip(|_, cx: &mut gpui::App| -> AnyView { Tooltip::view(UNAVAILABLE_TOOLTIP, cx) })
            .into_any_element();
    }

    let client_identifier = server.client_identifier.clone();
    let row =
        row.cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx: &mut Context<Root>| {
                this.select_server(client_identifier.clone(), cx);
            }));
    // `.server.sel` wins over `.server:hover` in the cascade, so a selected row
    // keeps its accent border while hovered.
    if selected {
        row.into_any_element()
    } else {
        row.hover(|style| style.border_color(ROW_HOVER_BORDER))
            .into_any_element()
    }
}
