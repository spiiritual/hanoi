//! `HomeDashboard` and `HomeCategory` from `home-content.tsx` + `HomeContent.css`.

use gpui::{
    AnyElement, Context, Div, FontWeight, SharedString, Stateful, div, prelude::*, px, relative,
};

use crate::plex::Hub;
use crate::ui::root::Root;
use crate::ui::scrollbar;
use crate::ui::theme::{
    ACCENT, ACCENT_LIGHT, ERROR, ERROR_BORDER, LINE_HEIGHT_NORMAL, PANEL_BG, RETRY_HOVER,
    SURFACE_2, TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY,
};

use super::card;
use super::state::{Category, Status};
use super::utils::{HOME_HUB_PREVIEW_SIZE, filter_music_home_hubs, should_show_home_hub_see_all};

const LOADING: &str = "Loading your Plex home…";
const ERROR_PREFIX: &str = "Couldn't load your Plex home";
const CATEGORY_LOADING: &str = "Loading…";
const CATEGORY_ERROR_PREFIX: &str = "Couldn't load this category";
const CATEGORY_EMPTY: &str = "No items in this category.";
const EMPTY_TITLE: &str = "No music rows yet";
const EMPTY_COPY: &str = "Plex has not returned any music recommendations for this server.";
const FALLBACK_ROW_TITLE: &str = "Plex Home";
const FALLBACK_CATEGORY_TITLE: &str = "Plex category";

/// The Home view: the category screen when "See all" is open, the dashboard
/// otherwise.
pub fn render(root: &Root, cx: &mut Context<Root>) -> AnyElement {
    match root.home.category.as_ref() {
        Some(category) => category_view(root, category).into_any_element(),
        None => dashboard(root, cx).into_any_element(),
    }
}

/// `.home-dashboard`
fn dashboard(root: &Root, cx: &mut Context<Root>) -> Div {
    let state = &root.home.hubs;
    let hubs = filter_music_home_hubs(&state.items);

    let mut column = div().min_w_0().flex().flex_col().gap(px(24.)).pb(px(28.));

    match state.status {
        Status::Loading => column = column.child(banner(LOADING, false)),
        Status::Error => {
            let message = match state.error.as_deref().filter(|error| !error.is_empty()) {
                Some(error) => format!("{ERROR_PREFIX}: {error}"),
                None => format!("{ERROR_PREFIX}."),
            };
            // `align-self: flex-start`: gpui has no align-self, so a full-width
            // flex row keeps the pill at its content width.
            column = column
                .child(banner(message, true))
                .child(div().flex().child(retry(cx)));
        }
        Status::Idle => {}
        Status::Ready => {
            if hubs.is_empty() {
                column = column.child(empty());
            }
        }
    }

    if state.status != Status::Ready {
        return column;
    }

    // `.home-hub-rows`
    column.child(
        div().min_w_0().flex().flex_col().gap(px(30.)).children(
            hubs.iter()
                .enumerate()
                .map(|(index, hub)| row(root, index, hub, cx)),
        ),
    )
}

/// `.home-state` and `.home-state.is-error`.
fn banner(text: impl Into<SharedString>, error: bool) -> Div {
    div()
        .px(px(16.))
        .py(px(14.))
        .border_1()
        .border_color(if error { ERROR_BORDER } else { SURFACE_2 })
        .rounded(px(10.))
        .bg(PANEL_BG)
        .text_size(px(13.))
        .text_color(if error { ERROR } else { TEXT_SECONDARY })
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(text.into())
}

/// `.home-retry`
fn retry(cx: &mut Context<Root>) -> Stateful<Div> {
    div()
        .id("home-retry")
        .flex_none()
        .flex()
        .items_center()
        .min_h(px(34.))
        .px(px(14.))
        .rounded(px(17.))
        .bg(SURFACE_2)
        .text_size(px(12.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(TEXT_PRIMARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .hover(|style| style.bg(RETRY_HOVER))
        .child("Try again")
        .on_click(cx.listener(|this, _, _, cx| this.retry_home(cx)))
}

/// `.home-empty`
fn empty() -> Div {
    div()
        .min_h(px(150.))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.))
        .p(px(28.))
        .border_1()
        .border_color(SURFACE_2)
        .rounded(px(14.))
        .bg(PANEL_BG)
        .text_center()
        .child(
            div()
                .text_size(px(16.))
                .font_weight(FontWeight::SEMIBOLD)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(EMPTY_TITLE),
        )
        .child(
            div()
                .text_size(px(13.))
                .text_color(TEXT_TERTIARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(EMPTY_COPY),
        )
}

/// `.home-hub-row`
fn row(root: &Root, index: usize, hub: &Hub, cx: &mut Context<Root>) -> Div {
    let title = if hub.title.is_empty() {
        if hub.hub_identifier.is_empty() {
            FALLBACK_ROW_TITLE.to_owned()
        } else {
            hub.hub_identifier.clone()
        }
    } else {
        hub.title.clone()
    };

    // `shouldShowHomeHubSeeAll(hub) && (hubIdentifier || key)`
    let show_see_all = should_show_home_hub_see_all(hub)
        && (!hub.hub_identifier.is_empty() || !hub.key.is_empty());

    let mut heading = div()
        .flex()
        .items_center()
        .justify_between()
        .h(px(28.))
        .gap(px(16.))
        .child(
            // `.home-hub-title`
            div()
                .text_size(px(20.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(TEXT_PRIMARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(title),
        );
    if show_see_all {
        heading = heading.child(see_all(index, hub.clone(), cx));
    }

    div()
        // The overlay scrollbar is revealed by a hover anywhere on the row,
        // heading included, the way a macOS overlay bar appears for the
        // surface you are pointing at rather than the exact strip.
        .group(scrollbar::ROW_GROUP)
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(10.))
        .child(heading)
        .child(
            // The strip's negative margins live on this wrapper instead of on
            // the strip, so the wrapper's box is exactly the strip's border
            // box and the absolutely positioned scrollbar lines up with the
            // viewport the scroll handle reports.
            div()
                .relative()
                .min_w_0()
                .flex()
                .flex_col()
                .mt(px(-8.))
                .mx(px(-3.))
                .mb(px(-8.))
                .child(
                    // `.home-hub-cards` — the horizontally scrolling strip. Its
                    // padding makes room for the hover halo; the wrapper's
                    // negative margins pull the strip back so the cards stay
                    // flush with the heading.
                    // Scrolled by `Root::scroll_row` rather than by gpui's own
                    // overflow handling, so a swipe only moves the strip when
                    // the gesture is actually sideways (see `ui::scroll`). The
                    // handle is still tracked: gpui clamps the offset and
                    // records every card's bounds from it.
                    div()
                        .id(("home-hub-cards", index))
                        .flex()
                        .items_start()
                        .gap(px(12.))
                        .min_w_0()
                        .pt(px(8.))
                        .px(px(3.))
                        .pb(px(16.))
                        .overflow_hidden()
                        .when_some(root.artwork.row_scroll(index), |strip, handle| {
                            strip.track_scroll(handle)
                        })
                        .on_scroll_wheel(cx.listener(move |this, event, window, cx| {
                            this.scroll_row(index, event, window, cx);
                        }))
                        .children(
                            hub.items
                                .iter()
                                .take(HOME_HUB_PREVIEW_SIZE)
                                .map(|item| card::render(root, item, false)),
                        ),
                )
                // Drawn inside the 16px the strip already reserves for the
                // halo, so revealing it never moves a card.
                .children(scrollbar::render(root, scrollbar::Target::Row(index), cx)),
        )
}

/// `.home-hub-see-all`
fn see_all(index: usize, hub: Hub, cx: &mut Context<Root>) -> Stateful<Div> {
    div()
        .id(("home-hub-see-all", index))
        .flex_none()
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ACCENT)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .cursor_pointer()
        .hover(|style| style.text_color(ACCENT_LIGHT))
        .child("See all")
        .on_click(cx.listener(move |this, _, _, cx| this.open_category(hub.clone(), cx)))
}

/// `.home-category`
fn category_view(root: &Root, category: &Category) -> Div {
    let hub = &category.hub;
    let title = if hub.title.is_empty() {
        if hub.hub_identifier.is_empty() {
            FALLBACK_CATEGORY_TITLE.to_owned()
        } else {
            hub.hub_identifier.clone()
        }
    } else {
        hub.title.clone()
    };

    let status_message = match category.status {
        Status::Loading => CATEGORY_LOADING.to_owned(),
        Status::Error => match category.error.as_deref().filter(|error| !error.is_empty()) {
            Some(error) => format!("{CATEGORY_ERROR_PREFIX}: {error}"),
            None => format!("{CATEGORY_ERROR_PREFIX}."),
        },
        _ => CATEGORY_EMPTY.to_owned(),
    };
    let hide_status = category.status == Status::Ready && !category.items.is_empty();

    let mut column = div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(12.))
        .pb(px(28.))
        .child(
            // `.home-category-header`
            div().flex().items_center().h(px(28.)).child(
                // `.home-category-title`
                div()
                    .text_size(px(20.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(TEXT_PRIMARY)
                    .line_height(relative(LINE_HEIGHT_NORMAL))
                    .child(title),
            ),
        );

    if !hide_status {
        // `.home-category-status`
        column = column.child(
            div()
                .px(px(16.))
                .py(px(14.))
                .border_1()
                .border_color(SURFACE_2)
                .rounded(px(10.))
                .bg(PANEL_BG)
                .text_size(px(13.))
                .text_color(TEXT_SECONDARY)
                .line_height(relative(LINE_HEIGHT_NORMAL))
                .child(status_message),
        );
    }

    // `.home-category-cards` — `repeat(auto-fill, 150px)` with a 12px gutter.
    // Tracked, though it never scrolls itself, purely so `ensure_artwork` can
    // read each card's bounds: a category can run to hundreds of items and only
    // the ones near the viewport may load.
    column.child(
        div()
            .id("home-category-cards")
            .track_scroll(&root.artwork.category_scroll)
            .flex()
            .flex_wrap()
            .items_start()
            .gap(px(12.))
            .min_w_0()
            .when(category.status == Status::Ready, |grid| {
                grid.children(
                    category
                        .items
                        .iter()
                        .map(|item| card::render(root, item, true)),
                )
            }),
    )
}
