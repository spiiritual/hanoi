//! The pieces `AuthLayout.css`, `OAuthScreen.css` and `ConnectedScreen.css`
//! share between screens: the logo, headings, the spinner, buttons and links.

use std::sync::Arc;
use std::time::Duration;

use gpui::{
    Animation, AnimationElement, AnimationExt as _, AnyView, App, ClickEvent, Context, Div,
    ElementId, FontWeight, IntoElement, Render, SharedString, Stateful, Transformation, Window,
    div, percentage, prelude::*, px, relative, svg,
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

    // The album screens' icons, transcribed from the `<Icon>` children in
    // `album-screen.tsx`. `PLAY_SOLID` is the play triangle with
    // `stroke: none`, as `.album-detail-play svg` and `.album-track-play svg`
    // draw it; `PLAY` keeps the card button's stroked outline.
    pub const PLAY_SOLID: &str = "icons/play-solid.svg";
    pub const SHUFFLE: &str = "icons/shuffle.svg";
    pub const HEART: &str = "icons/heart.svg";
    pub const MORE: &str = "icons/more.svg";
    pub const SORT: &str = "icons/sort.svg";

    // The content-area loading spinner (`Loading Spinner` in `plex.pen`): the
    // same ring as `SPINNER_*`, drawn at 28px with a 3px stroke.
    pub const LOADER_TRACK: &str = "icons/loader-track.svg";
    pub const LOADER_ARC: &str = "icons/loader-arc.svg";

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
        PLAY_SOLID,
        SHUFFLE,
        HEART,
        MORE,
        SORT,
        LOADER_TRACK,
        LOADER_ARC,
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

/// `Loading Spinner` in `plex.pen` — a 28px ring whose accent quarter turns
/// once a second, like [`spinner`]. The shell's content areas show this instead
/// of a line of loading copy.
pub fn loading_spinner(id: impl Into<ElementId>) -> Div {
    const SIZE: f32 = 28.;

    div()
        .size(px(SIZE))
        .flex_none()
        .relative()
        .child(
            svg()
                .absolute()
                .top_0()
                .left_0()
                .size(px(SIZE))
                .path(icons::LOADER_TRACK)
                .text_color(SPINNER_TRACK),
        )
        .child(
            svg()
                .absolute()
                .top_0()
                .left_0()
                .size(px(SIZE))
                .path(icons::LOADER_ARC)
                .text_color(ACCENT)
                .with_animation(
                    id,
                    Animation::new(Duration::from_secs(1)).repeat(),
                    |arc, delta| arc.with_transformation(Transformation::rotate(percentage(delta))),
                ),
        )
}

/// How long a content area stays loading before [`delayed_loading_spinner`]
/// shows anything. Most loads settle sooner, and a spinner that blinks on and
/// off for a few frames is itself the flash it is meant to cover.
const SPINNER_DELAY: Duration = Duration::from_millis(300);
/// How long the delayed spinner then takes to fade in.
const SPINNER_FADE: Duration = Duration::from_millis(150);

/// The opacity [`delayed_loading_spinner`] draws at, `progress` being how far
/// through `SPINNER_DELAY + SPINNER_FADE` it is (`0..=1`): nothing for the
/// delay, then a linear ramp to fully opaque.
fn delayed_spinner_opacity(progress: f32) -> f32 {
    let delay = SPINNER_DELAY.as_secs_f32() / (SPINNER_DELAY + SPINNER_FADE).as_secs_f32();
    ((progress - delay) / (1. - delay)).clamp(0., 1.)
}

/// [`loading_spinner`], invisible for [`SPINNER_DELAY`] after it first appears
/// and then faded in over [`SPINNER_FADE`] — what CSS would write as
/// `animation: fade-in 150ms 300ms both`; the reference shows its loading copy
/// at once. It takes its 28px from the first frame, so nothing moves when it
/// shows.
///
/// A one-shot `with_animation` on the wrapper's opacity. Its start is element
/// state keyed by the global element id: it holds the final value once done
/// for as long as the spinner keeps rendering, and a spinner that was not
/// rendered last frame (a new load, another screen) starts the delay over.
/// The fade's id is derived from `id` but distinct from the rotation's.
pub fn delayed_loading_spinner(id: impl Into<ElementId>) -> AnimationElement<Div> {
    let id = id.into();
    let fade = ElementId::NamedChild(Arc::new(id.clone()), "delay".into());
    div().flex_none().child(loading_spinner(id)).with_animation(
        fade,
        Animation::new(SPINNER_DELAY + SPINNER_FADE).with_easing(delayed_spinner_opacity),
        |spinner, opacity| spinner.opacity(opacity),
    )
}

/// A content area that is still loading: it takes all the height its column
/// has left and centres [`delayed_loading_spinner`] in it (`Loading state` in
/// `plex.pen`). Every ancestor between it and `.home-content` must be a flex
/// column that grows (`flex_1`) while it is shown, or there is no height to
/// centre in.
pub fn loading_state(id: impl Into<ElementId>) -> Div {
    div()
        .flex_1()
        .min_h(px(120.))
        .w_full()
        .flex()
        .items_center()
        .justify_center()
        .child(delayed_loading_spinner(id))
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

#[cfg(test)]
mod tests {
    use super::{SPINNER_DELAY, SPINNER_FADE, delayed_spinner_opacity};

    /// The opacity `elapsed` into the animation.
    fn opacity_at(elapsed_ms: u64) -> f32 {
        let total = (SPINNER_DELAY + SPINNER_FADE).as_millis() as f32;
        delayed_spinner_opacity((elapsed_ms as f32 / total).min(1.))
    }

    #[test]
    fn the_delayed_spinner_stays_invisible_for_the_delay() {
        assert_eq!(SPINNER_DELAY.as_millis(), 300);
        assert_eq!(opacity_at(0), 0.);
        assert_eq!(opacity_at(120), 0.);
        assert_eq!(opacity_at(299), 0.);
    }

    #[test]
    fn the_delayed_spinner_then_fades_in_and_holds() {
        assert_eq!(SPINNER_FADE.as_millis(), 150);
        assert!((opacity_at(375) - 0.5).abs() < 1e-3, "{}", opacity_at(375));
        assert!((opacity_at(450) - 1.).abs() < 1e-6);
        // A finished one-shot animation keeps reporting its last value.
        assert_eq!(delayed_spinner_opacity(1.), 1.);
        assert_eq!(opacity_at(10_000), 1.);
        // Out-of-range easing input never leaves `0..=1`.
        assert_eq!(delayed_spinner_opacity(-0.5), 0.);
        assert_eq!(delayed_spinner_opacity(1.5), 1.);
    }
}
