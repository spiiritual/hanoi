//! The pieces `AuthLayout.css`, `OAuthScreen.css` and `ConnectedScreen.css`
//! share between screens: the logo, headings, the spinner, buttons and links.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyView, App, ClickEvent, Context, Div, ElementId, FontWeight,
    IntoElement, Render, SharedString, Stateful, Transformation, Window, div, percentage,
    prelude::*, px, relative, svg,
};

use super::theme::{
    ACCENT, ACCENT_HOVER, FONT_BODY, LINE_HEIGHT_NORMAL, ON_ACCENT, SPINNER_TRACK, SURFACE,
    SURFACE_2, SURFACE_2_HOVER, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY,
};

pub mod icons {
    pub const SPINNER_TRACK: &str = "icons/spinner-track.svg";
    pub const SPINNER_ARC: &str = "icons/spinner-arc.svg";
    pub const SERVER: &str = "icons/server.svg";
    pub const CHECK_CIRCLE: &str = "icons/check-circle.svg";

    // The home shell's icons, transcribed from the `<Icon>` children in
    // `sidebar.tsx` and `home-screen.tsx`.
    pub const HOME: &str = "icons/home.svg";
    pub const LIBRARY: &str = "icons/library.svg";
    pub const ALBUMS: &str = "icons/albums.svg";
    pub const ARTISTS: &str = "icons/artists.svg";
    pub const SONGS: &str = "icons/songs.svg";
    pub const PLAYLISTS: &str = "icons/playlists.svg";
    pub const CHEVRON_DOWN: &str = "icons/chevron-down.svg";
    pub const CHEVRON_UP: &str = "icons/chevron-up.svg";
    pub const CHEVRON_LEFT: &str = "icons/chevron-left.svg";
    pub const CHEVRON_RIGHT: &str = "icons/chevron-right.svg";
    pub const SETTINGS: &str = "icons/settings.svg";
    pub const SEARCH: &str = "icons/search.svg";
    pub const QUEUE: &str = "icons/queue.svg";
    pub const BELL: &str = "icons/bell.svg";
    pub const PLAY: &str = "icons/play.svg";

    /// Every bundled asset, in the order `Assets::list` reports them.
    pub const ALL: &[&str] = &[
        SPINNER_TRACK,
        SPINNER_ARC,
        SERVER,
        CHECK_CIRCLE,
        HOME,
        LIBRARY,
        ALBUMS,
        ARTISTS,
        SONGS,
        PLAYLISTS,
        CHEVRON_DOWN,
        CHEVRON_UP,
        CHEVRON_LEFT,
        CHEVRON_RIGHT,
        SETTINGS,
        SEARCH,
        QUEUE,
        BELL,
        PLAY,
    ];
}

/// `.spacer` — a fixed vertical gap that never collapses.
pub fn spacer(height: f32) -> Div {
    div().w(px(1.)).flex_none().h(px(height))
}

/// `.auth-inner` / `.welcome-inner` — the centred 640px column every screen
/// puts its content in.
pub fn auth_inner() -> Div {
    div()
        .flex()
        .flex_col()
        .items_center()
        .text_center()
        .w_full()
        .max_w(px(640.))
}

/// `.logo-mark`
pub fn logo_mark() -> Div {
    div()
        .size(px(72.))
        .bg(ACCENT)
        .rounded(px(20.))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(44.))
        .font_weight(FontWeight::EXTRA_BOLD)
        .text_color(ON_ACCENT)
        .line_height(px(44.))
        .child("H")
}

/// `.app-name`
pub fn app_name() -> Div {
    div()
        .text_size(px(40.))
        .font_weight(FontWeight::BOLD)
        .line_height(px(44.))
        .child("Hanoi")
}

/// `.title`
pub fn title(text: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(32.))
        .font_weight(FontWeight::BOLD)
        .line_height(px(35.2))
        .text_color(TEXT_PRIMARY)
        .child(text.into())
}

/// `.subtitle`
pub fn subtitle(text: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(15.))
        .font_weight(FontWeight::NORMAL)
        .text_color(TEXT_SECONDARY)
        .max_w(px(460.))
        .line_height(px(21.))
        .child(text.into())
}

/// `.spinner` — a 16px ring whose accent quarter turns once a second.
///
/// gpui paints an SVG as a single-colour mask, so the track and the accent arc
/// are two stacked assets and only the arc rotates. Visually identical to the
/// CSS, which spins a circle whose top border alone is tinted.
pub fn spinner(id: impl Into<ElementId>) -> Div {
    div()
        .size(px(16.))
        .flex_none()
        .relative()
        .child(
            svg()
                .absolute()
                .top_0()
                .left_0()
                .size(px(16.))
                .path(icons::SPINNER_TRACK)
                .text_color(SPINNER_TRACK),
        )
        .child(
            svg()
                .absolute()
                .top_0()
                .left_0()
                .size(px(16.))
                .path(icons::SPINNER_ARC)
                .text_color(ACCENT)
                .with_animation(
                    id,
                    Animation::new(Duration::from_secs(1)).repeat(),
                    |arc, delta| arc.with_transformation(Transformation::rotate(percentage(delta))),
                ),
        )
}

/// `.status-row` — spinner plus `.status-text`.
pub fn status_row(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(8.))
        .child(spinner(id))
        .child(
            div()
                .text_size(px(13.))
                .text_color(TEXT_TERTIARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(text.into()),
        )
}

/// `.btn-primary` — the 320x52 accent pill.
pub fn primary_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    enabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let button = div()
        .id(id)
        .w(px(320.))
        .h(px(52.))
        .flex()
        .items_center()
        .justify_center()
        .bg(ACCENT)
        .text_color(ON_ACCENT)
        .text_size(px(15.))
        .font_weight(FontWeight::SEMIBOLD)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .rounded(px(26.))
        .child(label.into());
    if enabled {
        button
            .cursor_pointer()
            .hover(|style| style.bg(ACCENT_HOVER))
            .on_click(on_click)
    } else {
        button.opacity(0.45).cursor_default()
    }
}

/// The shared box of `.btn-open` / `.btn-copy` / `.btn-cancel`.
pub fn pill_button(id: impl Into<ElementId>) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(40.))
        .px(px(18.))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .rounded(px(20.))
        .text_size(px(14.))
        .font_weight(FontWeight::SEMIBOLD)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
}

/// `.btn-open` — accent pill inside the link card.
pub fn accent_pill_button(
    id: impl Into<ElementId>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    pill_button(id)
        .bg(ACCENT)
        .text_color(ON_ACCENT)
        .hover(|style| style.bg(ACCENT_HOVER))
        .on_click(on_click)
}

/// `.btn-copy` / `.btn-cancel` — the neutral surface pill.
pub fn surface_pill_button(
    id: impl Into<ElementId>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    pill_button(id)
        .bg(SURFACE_2)
        .text_color(TEXT_PRIMARY)
        .hover(|style| style.bg(SURFACE_2_HOVER))
        .on_click(on_click)
}

/// `.link-muted`
pub fn link_muted(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    enabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let link = div()
        .id(id)
        .text_size(px(13.))
        .font_weight(FontWeight::NORMAL)
        .text_color(TEXT_SECONDARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .text_decoration_1()
        .text_decoration_solid()
        .text_decoration_color(TEXT_SECONDARY)
        .child(label.into());
    if enabled {
        link.cursor_pointer().on_click(on_click)
    } else {
        link.cursor_default()
    }
}

/// CSS `letter-spacing`, which gpui does not have: each glyph becomes its own
/// element inside a row whose gap is the tracking, plus the trailing advance
/// the browser adds after the last character.
pub fn tracked_text(text: &str, tracking: f32) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(tracking))
        .pr(px(tracking))
        .children(
            text.chars()
                .map(|character| div().child(character.to_string())),
        )
}

/// A single-line label that ends in an ellipsis once its column runs out.
///
/// `.truncate()` is deliberately not used: gpui caches the measured size of
/// `nowrap` text, so the truncation width never lands once the flex pass
/// shrinks the column (this already bit `.server-host`).
pub fn ellipsis(text: impl Into<SharedString>) -> Div {
    div()
        .overflow_hidden()
        .whitespace_normal()
        .text_ellipsis()
        .line_clamp(1)
        .child(text.into())
}

/// `.card-label`, `.step-desc`, `.server-host` and friends: 12px tertiary text.
pub fn caption(text: impl Into<SharedString>) -> Div {
    div()
        .text_size(px(12.))
        .font_weight(FontWeight::NORMAL)
        .text_color(TEXT_TERTIARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(text.into())
}

/// The `title` attribute of an unavailable server row.
pub struct Tooltip {
    text: SharedString,
}

impl Tooltip {
    pub fn view(text: impl Into<SharedString>, cx: &mut App) -> AnyView {
        let text = text.into();
        cx.new(|_| Self { text }).into()
    }
}

impl Render for Tooltip {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .bg(SURFACE)
            .border_1()
            .border_color(SURFACE_2)
            .rounded(px(6.))
            .px(px(8.))
            .py(px(4.))
            .font_family(FONT_BODY)
            .text_size(px(12.))
            .text_color(TEXT_SECONDARY)
            .line_height(relative(LINE_HEIGHT_NORMAL))
            .child(self.text.clone())
    }
}
