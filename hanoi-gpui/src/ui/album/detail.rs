//! `AlbumDetail` from `album-screen.tsx` + the `.album-detail*` and
//! `.album-track*` rules in `AlbumScreen.css`.
//!
//! The player is not ported, so the states that need one — "Playing", the
//! pause glyph, `.album-track-row.is-playing` and `.album-track-spectrum` — are
//! never rendered; Play, Shuffle and the rows only report the request.

use gpui::{
    AnyElement, Context, Div, FontWeight, ObjectFit, SharedString, Stateful, StyledImage as _, div,
    img, linear_color_stop, linear_gradient, prelude::*, px, relative, svg,
};

use crate::plex::{Album, AlbumDetail, Track};
use crate::ui::components::{delayed_loading_spinner, ellipsis, icons, loading_state};
use crate::ui::home::state::{Slot, Status};
use crate::ui::root::Root;
use crate::ui::theme::{
    ACCENT, ACCENT_LIGHT, BG, CARD_ART_FROM, CARD_ART_HAIRLINE, CARD_ART_TO, ERROR, ERROR_BORDER,
    LINE_HEIGHT_NORMAL, PANEL_BG, RETRY_HOVER, SURFACE_2, TEXT_PRIMARY, TEXT_SECONDARY,
    TEXT_TERTIARY,
};

use super::utils::{
    album_artist, album_meta, album_meta_loading, album_title, format_track_duration,
};

const ERROR_PREFIX: &str = "Couldn’t load this album";
const RETRY: &str = "Try again";
const EMPTY: &str = "This album has no tracks.";

/// `.album-detail-art` — `width` / `height` / `flex-basis`.
const ART_SIZE: f32 = 200.;
/// `@media (max-width: 1040px) .album-detail-art`
const ART_SIZE_COMPACT: f32 = 168.;
/// `.album-detail-art` — `border-radius`, inherited by its `::after`.
const ART_RADIUS: f32 = 12.;
/// `.album-detail-title` — `font-size`.
const TITLE_SIZE: f32 = 32.;
/// `@media (max-width: 1040px) .album-detail-title`
const TITLE_SIZE_COMPACT: f32 = 28.;
/// `:disabled` on `.album-detail-play` and `.album-detail-icon-action`.
const DISABLED_OPACITY: f32 = 0.55;

/// `grid-template-columns: 16px minmax(0, 1fr) 60px` — the fixed columns.
const NUMBER_COLUMN: f32 = 16.;
const DURATION_COLUMN: f32 = 60.;

/// `.album-track-row` — `min-height`. A row's two lines are shorter than this,
/// so every row is exactly this tall and the loading placeholder can reserve
/// the list's height from the track count alone.
const ROW_HEIGHT: f32 = 52.;
/// The space the loading placeholder reserves when the seed has no track
/// count to size it from.
const LOADING_ROWS_MIN_HEIGHT: f32 = 160.;
/// The tallest box the loading placeholder centres its spinner in, from the
/// top of the reserved space: a long album's spinner stays near the header
/// instead of in the middle of a very tall box.
const LOADING_SPINNER_BOX: f32 = 160.;

/// `.album-track-row` is a hover group: its hover swaps the index for the play
/// glyph.
const ROW_GROUP: &str = "album-track-row";

/// `.album-detail`
///
/// The CSS's `min-width: 0` on `.album-detail`, `.album-detail-header`,
/// `.album-track-list` and `.album-track-rows` is deliberately left out. On a
/// flex column's stretched children it changes nothing, but in gpui it breaks
/// the track ellipses: while taffy sizes `.home-content` under a min-content
/// constraint it hands such a child a definite 0px width, every title is
/// truncated to "…" in that pass, and gpui's text layout keeps the 3-byte text
/// run that truncation left behind, so the final paint draws only the first
/// three bytes of each title. `min-width: 0` stays where it matters, on the
/// flexible cells of the rows.
pub fn render(root: &Root, cx: &mut Context<Root>) -> AnyElement {
    // No state yet, or one left over from another album, is a load that has
    // not reported back: `detailState` starts out `loading`.
    let selected = root.home.albums.selected.as_ref();
    let state =
        root.home.albums.detail.as_ref().filter(|state| {
            selected.is_none_or(|selected| selected.rating_key == state.rating_key)
        });
    let Some(state) = state else {
        return pending(root, cx).into_any_element();
    };

    match (state.status, state.detail.as_ref()) {
        (Status::Idle | Status::Loading, _) => pending(root, cx),
        (Status::Error, _) => {
            let message = match state.error.as_deref().filter(|error| !error.is_empty()) {
                Some(error) => format!("{ERROR_PREFIX}: {error}"),
                None => format!("{ERROR_PREFIX}."),
            };
            column().child(error_banner(message, cx))
        }
        (Status::Ready, Some(detail)) => column()
            .child(header(root, &detail.album, Some(&detail.tracks), cx))
            .child(track_list(detail, cx)),
        // `status === "ready" && album`: `getAlbum` always yields an album (a
        // placeholder when Plex returns none), so this renders nothing.
        (Status::Ready, None) => column(),
    }
    .into_any_element()
}

/// `.album-detail` — column, gap 20, `padding-bottom` 28.
fn column() -> Div {
    div().flex().flex_col().gap(px(20.)).pb(px(28.))
}

/// The detail has not reported back yet.
///
/// An adaptation: the reference shows "Loading album…" on an otherwise empty
/// screen, which flashes on every open. When the navigation carries a seed —
/// the clicked card's album, or the loaded one Back left — the screen is laid
/// out as if it were ready: the real header drawn from the seed (the cover
/// already loading, the card's own frame standing in for it) over
/// [`track_list_loading`]. When the tracks arrive only the meta line's
/// duration and the rows appear; nothing above them moves.
fn pending(root: &Root, cx: &mut Context<Root>) -> Div {
    match root.home.albums.loading_seed() {
        Some(seed) => column()
            .child(header(root, seed, None, cx))
            .child(track_list_loading(seed)),
        None => loading(),
    }
}

/// The loading state without a seed (`Plex Music Album - Loading` in
/// `plex.pen`): no banner, no header, only the delayed spinner centred in
/// `.home-content`'s visible area. Every album card seeds its album, so this
/// is a defensive path the `album-loading-bare` preview keeps visible.
///
/// Unlike the other states, the column grows (`flex_1`) so the spinner has the
/// content area's full height to centre in, and it drops the 28px
/// `padding-bottom`, which would pull the spinner up by half of it.
fn loading() -> Div {
    div()
        .flex_1()
        .flex()
        .flex_col()
        .child(loading_state("album-detail-loading"))
}

/// `.album-detail-error` — the message and `.album-detail-retry`, in the box
/// it shares with `.album-library-status`.
fn error_banner(message: String, cx: &mut Context<Root>) -> Div {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(14.))
        .px(px(16.))
        .py(px(14.))
        .border_1()
        .border_color(ERROR_BORDER)
        .rounded(px(10.))
        .bg(PANEL_BG)
        .text_size(px(13.))
        .text_color(ERROR)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(div().min_w_0().child(message))
        .child(retry(cx))
}

/// `.album-detail-retry`
fn retry(cx: &mut Context<Root>) -> Stateful<Div> {
    div()
        .id("album-detail-retry")
        .flex_none()
        .flex()
        .items_center()
        .min_h(px(30.))
        .px(px(12.))
        .rounded(px(15.))
        .bg(SURFACE_2)
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(TEXT_PRIMARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .hover(|style| style.bg(RETRY_HOVER))
        .child(RETRY)
        .on_click(cx.listener(|this, _, _, cx| this.retry_album(cx)))
}

/// What Play and Shuffle do in the header's current state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Playback {
    /// The tracks are still loading. Drawn exactly like [`Playback::Enabled`]
    /// — a disabled look that lifts when they arrive would be a flash of its
    /// own — but a click does nothing yet.
    Pending,
    /// Loaded, with tracks.
    Enabled,
    /// `disabled` — loaded, with no tracks.
    Disabled,
}

/// `.album-detail-header`, from the loaded album and its `tracks` — or, while
/// they are loading (`None`), from the navigation's seed, with the meta line's
/// duration left out and Play and Shuffle [`Playback::Pending`].
fn header(root: &Root, album: &Album, tracks: Option<&[Track]>, cx: &mut Context<Root>) -> Div {
    let title_size = if root.compact {
        TITLE_SIZE_COMPACT
    } else {
        TITLE_SIZE
    };
    let (artist, meta, playback) = match tracks {
        Some(tracks) => (
            album_artist(album, tracks),
            album_meta(album, tracks),
            if tracks.is_empty() {
                Playback::Disabled
            } else {
                Playback::Enabled
            },
        ),
        None => (
            album_artist(album, &[]),
            album_meta_loading(album),
            Playback::Pending,
        ),
    };

    div()
        .w_full()
        .flex()
        .items_center()
        .gap(px(24.))
        .child(art(root, album))
        .child(
            // `.album-detail-info`
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(
                    // `.album-detail-title` — wraps. `letter-spacing: -0.5px`
                    // has no gpui equivalent and is dropped.
                    div()
                        .text_size(px(title_size))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(TEXT_PRIMARY)
                        .line_height(relative(1.15))
                        .child(album_title(album)),
                )
                .child(
                    // `.album-detail-artist` — wraps.
                    div()
                        .text_size(px(16.))
                        .text_color(TEXT_SECONDARY)
                        .line_height(relative(LINE_HEIGHT_NORMAL))
                        .child(artist),
                )
                .child(
                    // `.album-detail-meta`
                    div()
                        .text_size(px(13.))
                        .text_color(TEXT_TERTIARY)
                        .line_height(relative(LINE_HEIGHT_NORMAL))
                        .child(meta),
                )
                .child(actions(playback, cx)),
        )
}

/// `.album-detail-art` — the square cover, its fallback glyph and its hairline.
///
/// The cover is requested the moment the album opens. Until its 400px frame
/// arrives, the clicked card's 280px frame of the same artwork is drawn
/// scaled up in its place, if the slot map still holds it; only with neither
/// does the fallback glyph show.
fn art(root: &Root, album: &Album) -> Div {
    let size = if root.compact {
        ART_SIZE_COMPACT
    } else {
        ART_SIZE
    };

    let tile = div()
        .relative()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(ART_RADIUS))
        .bg(linear_gradient(
            135.,
            linear_color_stop(CARD_ART_FROM, 0.),
            linear_color_stop(CARD_ART_TO, 1.),
        ));

    let loaded = |slot: Option<Slot>| match slot {
        Some(Slot::Loaded(image)) => Some(image),
        _ => None,
    };
    let image =
        loaded(root.album_cover_slot()).or_else(|| loaded(root.album_cover_placeholder_slot()));
    let tile = match image {
        Some(image) => tile.child(
            img(image)
                .size(px(size))
                .object_fit(ObjectFit::Cover)
                .rounded(px(ART_RADIUS)),
        ),
        // Loading, failed, or no cover at all, and no card frame to stand in:
        // the fallback span stays until an image actually arrives.
        None => tile.child(fallback(album)),
    };

    // `.album-detail-art::after` — the inner hairline over the cover.
    tile.child(
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .border_1()
            .border_color(CARD_ART_HAIRLINE)
            .rounded(px(ART_RADIUS)),
    )
}

/// `.album-detail-art-fallback` — `album.title.charAt(0).toUpperCase() || "♪"`.
/// The raw title, not "Untitled album", so an untitled album shows `♪`.
fn fallback(album: &Album) -> Div {
    let glyph = album
        .title
        .chars()
        .next()
        .map(|character| character.to_uppercase().to_string())
        .unwrap_or_else(|| "♪".to_owned());

    div()
        .text_size(px(48.))
        .font_weight(FontWeight::BOLD)
        .text_color(TEXT_TERTIARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(glyph)
}

/// `.album-detail-actions` — Play, then Shuffle, Like and More. Play and
/// Shuffle are `disabled` while the album has no tracks, and inert (but not
/// disabled-looking) while the tracks load.
fn actions(playback: Playback, cx: &mut Context<Root>) -> Div {
    let shuffle = icon_action(
        "album-detail-shuffle",
        icons::SHUFFLE,
        playback != Playback::Disabled,
    );
    let shuffle = if playback == Playback::Enabled {
        shuffle.on_click(cx.listener(|this, _, _, _| this.play_album(true)))
    } else {
        shuffle
    };

    div()
        .flex()
        .items_center()
        .gap(px(14.))
        .pt(px(16.))
        .child(play(playback, cx))
        .child(shuffle)
        // Like and "More album actions" are inert in the reference too; they
        // keep the hover colour of every enabled icon action.
        .child(icon_action("album-detail-like", icons::HEART, true))
        .child(icon_action("album-detail-more", icons::MORE, true))
}

/// `.album-detail-play`
fn play(playback: Playback, cx: &mut Context<Root>) -> Stateful<Div> {
    let button = div()
        .id("album-detail-play")
        .flex_none()
        .h(px(40.))
        .px(px(20.))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .rounded(px(20.))
        .bg(ACCENT)
        .text_color(BG)
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(
            svg()
                .flex_none()
                .size(px(16.))
                .path(icons::PLAY_SOLID)
                .text_color(BG),
        )
        .child("Play");

    match playback {
        Playback::Enabled => button
            .cursor_pointer()
            .hover(|style| style.bg(ACCENT_LIGHT))
            .on_click(cx.listener(|this, _, _, _| this.play_album(false))),
        Playback::Pending => button
            .cursor_pointer()
            .hover(|style| style.bg(ACCENT_LIGHT)),
        Playback::Disabled => disabled(button),
    }
}

/// `.album-detail-icon-action` — a 20x20 box around a 20px stroked icon.
///
/// gpui paints an SVG with its own text colour rather than an inherited one, so
/// the button is a hover group and the icon itself takes the hover tint.
fn icon_action(id: &'static str, icon: &'static str, enabled: bool) -> Stateful<Div> {
    let glyph = svg()
        .flex_none()
        .size(px(20.))
        .path(icon)
        .text_color(TEXT_SECONDARY);

    let button = div()
        .id(id)
        .flex_none()
        .size(px(20.))
        .flex()
        .items_center()
        .justify_center();

    if enabled {
        button
            .group(id)
            .cursor_pointer()
            .child(glyph.group_hover(id, |style| style.text_color(TEXT_PRIMARY)))
    } else {
        disabled(button.child(glyph))
    }
}

/// `:disabled` — `cursor: not-allowed; opacity: 0.55`, no hover, no click.
fn disabled(button: Stateful<Div>) -> Stateful<Div> {
    button.opacity(DISABLED_OPACITY).cursor_not_allowed()
}

/// `.album-track-list` — the column header and the divider, before the rows.
fn list_frame() -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .child(list_header())
        // `.album-track-divider`
        .child(div().w_full().h(px(1.)).flex_none().bg(SURFACE_2))
}

/// `.album-track-list` while the tracks load: the same column header and
/// divider as [`track_list`], over the space the rows will take — the seed's
/// `leafCount` rows of [`ROW_HEIGHT`], or [`LOADING_ROWS_MIN_HEIGHT`] without a
/// count — so the page does not jump when they arrive. The delayed spinner is
/// centred near the top of that space.
fn track_list_loading(album: &Album) -> Div {
    let reserved = album
        .leaf_count
        .filter(|count| *count > 0)
        .map_or(LOADING_ROWS_MIN_HEIGHT, |count| count as f32 * ROW_HEIGHT);

    list_frame().child(
        div().w_full().h(px(reserved)).flex_none().child(
            div()
                .w_full()
                .h(px(reserved.min(LOADING_SPINNER_BOX)))
                .flex()
                .items_center()
                .justify_center()
                .child(delayed_loading_spinner("album-detail-tracks-loading")),
        ),
    )
}

/// `.album-track-list`
fn track_list(detail: &AlbumDetail, cx: &mut Context<Root>) -> Div {
    let artist = album_artist(&detail.album, &detail.tracks);
    let list = list_frame();

    if detail.tracks.is_empty() {
        return list.child(
            // `.album-track-empty`
            div()
                .px(px(8.))
                .py(px(20.))
                .text_size(px(13.))
                .text_color(TEXT_TERTIARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(EMPTY),
        );
    }

    list.child(
        // `.album-track-rows`
        div().flex().flex_col().children(
            detail
                .tracks
                .iter()
                .enumerate()
                .map(|(position, track)| track_row(position, track, &artist, cx)),
        ),
    )
}

/// `.album-track-list-header` and `.album-track-row`:
/// `grid-template-columns: 16px minmax(0, 1fr) 60px; column-gap: 12px;
/// padding: 0 8px; align-items: center`.
fn row_grid() -> Div {
    div().flex().items_center().gap(px(12.)).px(px(8.))
}

/// `.album-track-list-header` — "#" and "Title" start-aligned, "Duration"
/// right-aligned.
fn list_header() -> Div {
    row_grid()
        .min_h(px(28.))
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(TEXT_TERTIARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(div().w(px(NUMBER_COLUMN)).flex_none().child("#"))
        .child(div().flex_1().min_w_0().child("Title"))
        .child(
            div()
                .w(px(DURATION_COLUMN))
                .flex_none()
                .text_right()
                .child("Duration"),
        )
}

/// `.album-track-row` — the whole row plays the track.
fn track_row(
    position: usize,
    track: &Track,
    album_artist: &str,
    cx: &mut Context<Root>,
) -> Stateful<Div> {
    let number: SharedString = track
        .index
        .map_or_else(
            || position + 1,
            |index| usize::try_from(index).unwrap_or(usize::MAX),
        )
        .to_string()
        .into();
    // `track.grandparentTitle ?? artist`
    let artist = track
        .grandparent_title
        .clone()
        .unwrap_or_else(|| album_artist.to_owned());

    row_grid()
        .id((ROW_GROUP, position))
        .group(ROW_GROUP)
        .min_h(px(ROW_HEIGHT))
        .rounded(px(8.))
        .text_color(TEXT_PRIMARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .hover(|style| style.bg(SURFACE_2))
        .on_click(cx.listener(move |this, _, _, _| this.play_album_track(position)))
        .child(
            // `.album-track-number` — the index and the play glyph share the
            // box; the row's hover swaps their opacity, since gpui cannot
            // toggle `display` on hover.
            div()
                .relative()
                .w(px(NUMBER_COLUMN))
                .h(px(20.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(13.))
                .text_color(TEXT_TERTIARY)
                .child(
                    // `.album-track-index`
                    div()
                        .flex_none()
                        .group_hover(ROW_GROUP, |style| style.opacity(0.))
                        .child(number),
                )
                .child(
                    // `.album-track-play`
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .opacity(0.)
                        .group_hover(ROW_GROUP, |style| style.opacity(1.))
                        .child(
                            svg()
                                .flex_none()
                                .size(px(14.))
                                .path(icons::PLAY_SOLID)
                                .text_color(TEXT_PRIMARY),
                        ),
                ),
        )
        .child(
            // `.album-track-copy`
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    // `.album-track-title`
                    ellipsis(track.title.clone())
                        .w_full()
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD),
                )
                .child(
                    // `.album-track-artist`
                    ellipsis(artist)
                        .w_full()
                        .text_size(px(12.))
                        .text_color(TEXT_SECONDARY),
                ),
        )
        .child(
            // `.album-track-duration`
            div()
                .w(px(DURATION_COLUMN))
                .flex_none()
                .text_right()
                .text_size(px(13.))
                .text_color(TEXT_TERTIARY)
                .child(format_track_duration(track.duration)),
        )
}
