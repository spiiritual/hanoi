//! `sidebar.tsx` + `sidebar/utils.ts` + `Sidebar.css`.

use gpui::{
    AnyElement, App, BoxShadow, ClickEvent, Context, Div, ElementId, FontWeight, ObjectFit, Rgba,
    SharedString, Stateful, StyledImage as _, Window, div, img, linear_color_stop, linear_gradient,
    point, prelude::*, px, relative, svg,
};

use crate::plex::ServerInfo;
use crate::ui::components::{ellipsis, icons, tracked_text};
use crate::ui::root::Root;
use crate::ui::theme::{
    ACCENT, ACCENT_2, LINE_HEIGHT_NORMAL, MENU_SHADOW, ON_ACCENT, SIDEBAR_BG, SIDEBAR_ROW_HOVER,
    SUCCESS, SURFACE, SURFACE_2, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY,
};

use super::state::View;

const MENU_TITLE: &str = "Your servers";
const ADD_SERVER: &str = "Add a server…";
const MENU_LOADING: &str = "Loading servers…";
const MENU_EMPTY: &str = "No servers found";

/// `serverStatusLabel`
fn status_label(online: Option<bool>) -> &'static str {
    match online {
        Some(true) => "● Online",
        Some(false) => "○ Offline",
        None => "Checking…",
    }
}

/// `serverStatusClass`, resolved through `Sidebar.css` to a colour.
fn status_color(online: Option<bool>) -> Rgba {
    if online == Some(true) {
        SUCCESS
    } else {
        TEXT_TERTIARY
    }
}

/// `.app-sidebar`
pub fn render(root: &Root, cx: &mut Context<Root>) -> Div {
    div()
        .flex_none()
        .w(px(240.))
        .h_full()
        .flex()
        .flex_col()
        .gap(px(2.))
        .px(px(16.))
        .py(px(14.))
        .bg(SIDEBAR_BG)
        .child(nav(root, cx))
        // `.sidebar-spacer`
        .child(div().flex_1().min_h(px(16.)))
        .child(server_wrap(root, cx))
        .child(user(root))
}

/// `.sidebar-nav`
fn nav(root: &Root, cx: &mut Context<Root>) -> Div {
    let active = root.home.view == View::Home;
    div()
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            nav_item("sidebar-home", icons::HOME, "Home", active, false)
                .on_click(cx.listener(|this, _, _, cx| this.change_view(View::Home, cx))),
        )
        .child(library(root, cx))
}

/// `.sidebar-library` — the collapsible "Your Library" group.
fn library(root: &Root, cx: &mut Context<Root>) -> Div {
    let group = div()
        .p(px(4.))
        .rounded(px(8.))
        .flex()
        .flex_col()
        .gap(px(2.))
        .child(
            // `.sidebar-library-toggle` overrides the nav item's padding,
            // colour and weight, and always tints its icon accent.
            nav_item(
                "sidebar-library-toggle",
                icons::LIBRARY,
                "Your Library",
                false,
                true,
            )
            .px(px(8.))
            .text_color(TEXT_PRIMARY)
            .font_weight(FontWeight::SEMIBOLD)
            .on_click(cx.listener(|this, _, _, cx| {
                this.home.library_open = !this.home.library_open;
                cx.notify();
            })),
        );

    if !root.home.library_open {
        return group;
    }
    // `.sidebar-library-items`
    group.child(
        div().flex().flex_col().gap(px(2.)).children(
            View::LIBRARY
                .into_iter()
                .enumerate()
                .map(|(index, view)| subnav_item(index, view, root.home.view == view, cx)),
        ),
    )
}

/// `.sidebar-nav-item`
fn nav_item(
    id: impl Into<ElementId>,
    icon: &'static str,
    label: &'static str,
    active: bool,
    accent_icon: bool,
) -> Stateful<Div> {
    // `.sidebar-icon` is `stroke: currentColor`, so it takes the row's colour
    // unless the row is active or the icon carries `.is-accent`.
    let icon_color = if accent_icon || active {
        ACCENT
    } else {
        TEXT_SECONDARY
    };

    let item = div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(12.))
        .w_full()
        .h(px(38.))
        .px(px(12.))
        .rounded(px(8.))
        .text_size(px(14.))
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .child(
            // `.sidebar-icon`
            svg()
                .size(px(18.))
                .flex_none()
                .path(icon)
                .text_color(icon_color),
        )
        .child(label);

    if active {
        // `.sidebar-nav-item.is-active:hover` keeps `surface-2`.
        item.bg(SURFACE_2)
            .text_color(TEXT_PRIMARY)
            .font_weight(FontWeight::SEMIBOLD)
    } else {
        item.text_color(TEXT_SECONDARY)
            .font_weight(FontWeight::NORMAL)
            .hover(|style| style.bg(SIDEBAR_ROW_HOVER))
    }
}

/// `.sidebar-subnav-item`
fn subnav_item(index: usize, view: View, active: bool, cx: &mut Context<Root>) -> Stateful<Div> {
    let icon = match view {
        View::Albums => icons::ALBUMS,
        View::Artists => icons::ARTISTS,
        View::Songs => icons::SONGS,
        View::Playlists | View::Home => icons::PLAYLISTS,
    };

    let item = div()
        .id(("sidebar-subnav", index))
        .flex()
        .items_center()
        .gap(px(10.))
        .w_full()
        .h(px(28.))
        .px(px(42.))
        .rounded(px(6.))
        .text_size(px(13.))
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .child(
            // `.sidebar-subnav-icon` — tertiary, accent when the row is active.
            svg()
                .size(px(14.))
                .flex_none()
                .path(icon)
                .text_color(if active { ACCENT } else { TEXT_TERTIARY }),
        )
        .child(view.label())
        .on_click(cx.listener(move |this, _, _, cx| this.change_view(view, cx)));

    if active {
        item.bg(SURFACE_2)
            .text_color(TEXT_PRIMARY)
            .font_weight(FontWeight::SEMIBOLD)
    } else {
        item.text_color(TEXT_SECONDARY)
            .font_weight(FontWeight::NORMAL)
            .hover(|style| style.bg(SIDEBAR_ROW_HOVER))
    }
}

/// `.sidebar-server-wrap`
fn server_wrap(root: &Root, cx: &mut Context<Root>) -> Div {
    let open = root.home.menu_open;
    let wrap = div().relative().w_full().child(selector(root, cx));
    if open {
        wrap.child(menu(root, cx))
    } else {
        wrap
    }
}

/// `.sidebar-server-selector`
fn selector(root: &Root, cx: &mut Context<Root>) -> Stateful<Div> {
    let open = root.home.menu_open;
    let chevron = if open {
        icons::CHEVRON_DOWN
    } else {
        icons::CHEVRON_UP
    };

    let button = div()
        .id("sidebar-server-selector")
        .flex()
        .items_center()
        .gap(px(10.))
        .w_full()
        .h(px(48.))
        .px(px(10.))
        .rounded(px(10.))
        .text_color(TEXT_PRIMARY)
        .cursor_pointer()
        .child(
            // `.sidebar-server-icon`
            div()
                .size(px(28.))
                .flex_none()
                .rounded(px(7.))
                .bg(ACCENT)
                .flex()
                .items_center()
                .justify_center()
                .child(
                    svg()
                        .size(px(14.))
                        .path(icons::SERVER)
                        .text_color(ON_ACCENT),
                ),
        )
        .child(
            // `.sidebar-server-copy`
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(1.))
                .child(
                    ellipsis(root.home.server_name.clone())
                        .w_full()
                        .text_size(px(13.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .line_height(relative(LINE_HEIGHT_NORMAL)),
                )
                .child(
                    ellipsis(status_label(root.home.server_status))
                        .w_full()
                        .text_size(px(11.))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(status_color(root.home.server_status))
                        .line_height(relative(LINE_HEIGHT_NORMAL)),
                ),
        )
        .child(
            // `.sidebar-chevron`
            svg()
                .size(px(16.))
                .flex_none()
                .path(chevron)
                .text_color(TEXT_TERTIARY),
        )
        .on_click(cx.listener(|this, _, _, cx| this.toggle_server_menu(cx)));

    if open {
        // `.sidebar-server-selector.is-open` is declared after the shared hover
        // rule, so an open selector keeps `surface-2` while hovered.
        button.bg(SURFACE_2).border_1().border_color(ACCENT)
    } else {
        button
            .bg(SURFACE)
            .hover(|style| style.bg(SIDEBAR_ROW_HOVER))
    }
}

/// `.sidebar-server-menu`
fn menu(root: &Root, cx: &mut Context<Root>) -> Div {
    div()
        .absolute()
        .left_0()
        .right_0()
        .bottom(px(54.))
        .flex()
        .flex_col()
        .gap(px(4.))
        .p(px(8.))
        .border_1()
        .border_color(SURFACE_2)
        .rounded(px(10.))
        .bg(SURFACE)
        .shadow(vec![BoxShadow {
            color: MENU_SHADOW.into(),
            offset: point(px(0.), px(12.)),
            blur_radius: px(30.),
            spread_radius: px(0.),
        }])
        .child(
            // `.sidebar-server-menu-title`
            div()
                .pt(px(4.))
                .px(px(8.))
                .pb(px(6.))
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(TEXT_TERTIARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(tracked_text(&MENU_TITLE.to_uppercase(), 0.44)),
        )
        .child(menu_body(root, cx))
        .child(
            // `.sidebar-add-server`
            div()
                .id("sidebar-add-server")
                .flex()
                .items_center()
                .justify_start()
                .w_full()
                .min_h(px(34.))
                .px(px(8.))
                .py(px(6.))
                .mt(px(2.))
                .border_t_1()
                .border_color(SURFACE_2)
                .rounded_b(px(7.))
                .text_size(px(12.))
                .text_color(TEXT_SECONDARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .cursor_pointer()
                .hover(|style| style.bg(SURFACE_2))
                .child(ADD_SERVER)
                .on_click(cx.listener(|this, _, _, cx| this.add_server(cx))),
        )
}

/// `.sidebar-server-options` — loading / error / empty / the server rows.
fn menu_body(root: &Root, cx: &mut Context<Root>) -> Div {
    if root.home.menu_loading {
        return div().child(menu_note(MENU_LOADING));
    }
    if let Some(error) = root.home.menu_error.clone() {
        return div().child(menu_note(error));
    }
    if root.servers.is_empty() {
        return div().child(menu_note(MENU_EMPTY));
    }
    div().children(
        root.servers
            .iter()
            .enumerate()
            .map(|(index, server)| menu_option(root, index, server, cx)),
    )
}

/// A bare `.sidebar-server-option-status` used as the menu's status line.
fn menu_note(text: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(10.))
        .text_color(TEXT_TERTIARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(text.into())
}

/// `.sidebar-server-option`
fn menu_option(
    root: &Root,
    index: usize,
    server: &ServerInfo,
    cx: &mut Context<Root>,
) -> AnyElement {
    let selected = root.selected_server.as_deref() == Some(server.client_identifier.as_str());
    let online = Some(server.online);
    let target = server.clone();

    let option = div()
        .id(("sidebar-server-option", index))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.))
        .w_full()
        .min_h(px(34.))
        .px(px(8.))
        .py(px(6.))
        .rounded(px(7.))
        .text_size(px(12.))
        .text_color(TEXT_PRIMARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .hover(|style| style.bg(SURFACE_2))
        .child(
            // `.sidebar-server-option-copy`
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    ellipsis(server.name.clone())
                        .w_full()
                        .font_weight(FontWeight::SEMIBOLD),
                )
                .child(
                    div()
                        .text_size(px(10.))
                        .text_color(status_color(online))
                        .child(status_label(online)),
                ),
        )
        .on_click(cx.listener(move |this, _, _, cx| this.select_home_server(target.clone(), cx)));

    if selected {
        // `.sidebar-server-option-check`
        option
            .child(
                div()
                    .flex_none()
                    .text_size(px(14.))
                    .text_color(ACCENT)
                    .child("✓"),
            )
            .into_any_element()
    } else {
        option.into_any_element()
    }
}

/// `.sidebar-user`
fn user(root: &Root) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(10.))
        .w_full()
        .h(px(48.))
        .px(px(4.))
        .text_color(TEXT_PRIMARY)
        .child(avatar(root))
        .child(
            // `.sidebar-user-name`
            ellipsis(root.home.username.clone())
                .min_w_0()
                .text_size(px(13.))
                .font_weight(FontWeight::SEMIBOLD)
                .line_height(relative(LINE_HEIGHT_NORMAL)),
        )
        // `.sidebar-user-spacer`
        .child(div().flex_1().min_w_0())
        .child(settings_button())
}

/// `.sidebar-avatar` — the gradient circle, or the loaded account thumb.
fn avatar(root: &Root) -> Div {
    let circle = div()
        .size(px(32.))
        .flex_none()
        .rounded(px(16.))
        .overflow_hidden()
        .bg(linear_gradient(
            135.,
            linear_color_stop(ACCENT, 0.),
            linear_color_stop(ACCENT_2, 1.),
        ))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(12.))
        .font_weight(FontWeight::BOLD)
        .text_color(ON_ACCENT)
        .line_height(relative(LINE_HEIGHT_NORMAL));

    match root.avatar.clone() {
        Some(image) => circle.child(
            img(image)
                .size(px(32.))
                .object_fit(ObjectFit::Cover)
                .rounded(px(16.)),
        ),
        None => circle.child(initials(&root.home.username)),
    }
}

/// `.sidebar-settings` — styled exactly like the reference, but inert: the
/// settings surface is out of scope (`HOME.md`).
fn settings_button() -> Stateful<Div> {
    div()
        .id("sidebar-settings")
        .size(px(24.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .text_color(TEXT_TERTIARY)
        .cursor_pointer()
        .hover(|style| style.bg(SIDEBAR_ROW_HOVER))
        .child(
            svg()
                .size(px(16.))
                .path(icons::SETTINGS)
                .text_color(TEXT_TERTIARY),
        )
        .on_click(|_: &ClickEvent, _: &mut Window, _: &mut App| {})
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
    use super::{SUCCESS, TEXT_TERTIARY, status_color, status_label};

    #[test]
    fn the_server_status_line_matches_the_reference_labels() {
        assert_eq!(status_label(Some(true)), "● Online");
        assert_eq!(status_label(Some(false)), "○ Offline");
        assert_eq!(status_label(None), "Checking…");
        assert_eq!(status_color(Some(true)), SUCCESS);
        assert_eq!(status_color(Some(false)), TEXT_TERTIARY);
        assert_eq!(status_color(None), TEXT_TERTIARY);
    }
}
