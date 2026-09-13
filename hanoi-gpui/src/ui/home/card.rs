//! `MediaCard` from `home-content.tsx` + the `.home-hub-card*` rules.
//!
//! The 150px column is the same in a row, in the category grid and in the
//! Albums grid; only the meta line differs (`homeHubItemMeta` vs
//! `homeCategoryItemMeta`).

use gpui::{
    AnyElement, Context, Div, ElementId, FontWeight, ObjectFit, StyledImage as _, div, img,
    linear_color_stop, linear_gradient, prelude::*, px, relative, svg,
};

use crate::plex::{Album, HubItem};
use crate::ui::components::{ellipsis, icons};
use crate::ui::root::Root;
use crate::ui::theme::{
    ACCENT, ACCENT_LIGHT, BG, CARD_ART_FROM, CARD_ART_HAIRLINE, CARD_ART_TO, LINE_HEIGHT_NORMAL,
    SURFACE_2, TEXT_PRIMARY, TEXT_TERTIARY,
};

use super::state::Slot;
use super::utils::{
    Interaction, home_category_item_meta, home_hub_item_interaction, home_hub_item_meta,
};

/// The `::before` halo and the play button both react to the card's hover, so
/// the card is a gpui hover group.
const GROUP: &str = "home-hub-card";

/// One `.home-hub-card`.
/// `.home-hub-card` is 150px wide in the CSS and its art 140px: the card box is
/// deliberately 10px wider than what it holds, because `.home-hub-card::before`
/// insets only 3px horizontally, so the hover halo clears the artwork by 8px on
/// every side. Keep that relationship — collapse it and the glow hugs the art.
///
/// Six cards at the CSS size overflow the 1200px window's strip by 56px, so the
/// space comes out of the art instead: 6x140 + 5x12 gaps + 6px padding = 906px
/// against a 910px viewport, with the halo's 8px intact.
const CARD_WIDTH: f32 = 140.;
/// `.home-hub-card-art` — the square tile, `CARD_WIDTH` less the halo's room.
const ART_SIZE: f32 = 130.;

/// One card. `id` names the card among its siblings; only an album card uses it, as the
/// `.home-hub-card-album` button that opens the album (`MediaCard`'s
/// `onAlbum`). Callers keep it unique per surface — a row index plus the
/// card's position — since the same album can appear in two rows.
pub fn render(
    root: &Root,
    item: &HubItem,
    category: bool,
    id: ElementId,
    cx: &mut Context<Root>,
) -> AnyElement {
    let interaction = home_hub_item_interaction(item);
    let meta = if category {
        home_category_item_meta(item)
    } else {
        home_hub_item_meta(item)
    };

    let card = div()
        .group(GROUP)
        .relative()
        .w(px(CARD_WIDTH))
        .flex_none()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(10.))
        .text_color(TEXT_PRIMARY)
        .text_left()
        // Every card kind is `cursor: pointer` in the CSS. Only an album card
        // opens anything: artist and playlist screens are not ported, and a
        // track card's play button waits for the player.
        .cursor_pointer()
        // `.home-hub-card::before` — the `surface-2` halo, faded in on hover.
        .child(
            div()
                .absolute()
                .top(px(-8.))
                .bottom(px(-8.))
                .left(px(-3.))
                .right(px(-3.))
                .rounded(px(8.))
                .bg(SURFACE_2)
                .opacity(0.)
                .group_hover(GROUP, |style| style.opacity(1.)),
        )
        .child(art(root, item, interaction))
        .child(
            // `.home-hub-card-text`
            div()
                .relative()
                .w(px(ART_SIZE))
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    // `.home-hub-card-title`
                    ellipsis(item.title.clone())
                        .w_full()
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .line_height(relative(1.25)),
                )
                .child(
                    // `.home-hub-card-meta`
                    ellipsis(meta)
                        .w_full()
                        .text_size(px(12.))
                        .font_weight(FontWeight::NORMAL)
                        .text_color(TEXT_TERTIARY)
                        .line_height(relative(1.3)),
                ),
        );

    // `canOpenAlbum`: `item.type === "album"` with an `onAlbum` handler, which
    // every surface that renders cards passes.
    if item.item_type != "album" {
        return card.into_any_element();
    }
    // The card already knows the album's header and cover: it seeds the detail
    // screen, which renders them while `getAlbum` is in flight.
    let seed = Album::from_hub_item(item);
    card.id(id)
        .on_click(cx.listener(move |this, _, _, cx| {
            this.open_album(seed.clone(), cx);
        }))
        .into_any_element()
}

/// `.home-hub-card-art` — the square tile, its hairline and its play button.
fn art(root: &Root, item: &HubItem, interaction: Interaction) -> Div {
    let tile = div()
        .relative()
        .size(px(ART_SIZE))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(10.))
        .bg(linear_gradient(
            135.,
            linear_color_stop(CARD_ART_FROM, 0.),
            linear_color_stop(CARD_ART_TO, 1.),
        ));

    let tile = match root.artwork_slot(item) {
        Some(Slot::Loaded(image)) => tile.child(
            img(image)
                .size(px(ART_SIZE))
                .object_fit(ObjectFit::Cover)
                .rounded(px(10.)),
        ),
        // Loading, failed, or no usable path: the reference keeps its fallback
        // span visible until an image actually arrives.
        _ => tile.child(fallback(item)),
    };

    // `.home-hub-card-art::after` — the inner hairline over the artwork.
    let tile = tile.child(
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .border_1()
            .border_color(CARD_ART_HAIRLINE)
            .rounded(px(10.)),
    );

    if interaction == Interaction::Track {
        tile.child(play_button())
    } else {
        tile
    }
}

/// `.home-hub-card-art-fallback` — the title's first letter, or `♪`.
fn fallback(item: &HubItem) -> Div {
    let glyph = item
        .title
        .chars()
        .next()
        .map(|character| character.to_uppercase().to_string())
        .unwrap_or_else(|| "♪".to_owned());

    div()
        .text_size(px(28.))
        .font_weight(FontWeight::BOLD)
        .text_color(TEXT_TERTIARY)
        .line_height(relative(LINE_HEIGHT_NORMAL))
        .child(glyph)
}

/// `.home-hub-card-play` — revealed by the card's hover.
///
/// The CSS also slides it up 4px, but gpui resolves geometry during layout,
/// before any hover style exists, so only paint-time properties can react to a
/// hover. The resting state is fully transparent, so the settled position is
/// the only one that is ever visible.
fn play_button() -> Div {
    div()
        .absolute()
        .right(px(8.))
        .bottom(px(8.))
        .size(px(34.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(17.))
        .bg(ACCENT)
        .text_color(BG)
        .opacity(0.)
        .cursor_pointer()
        .group_hover(GROUP, |style| style.opacity(1.))
        .hover(|style| style.bg(ACCENT_LIGHT))
        .child(svg().size(px(14.)).path(icons::PLAY).text_color(BG))
}
