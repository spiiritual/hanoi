//! An overlay scrollbar for the home screen's scroll containers.
//!
//! There is no design source for this: `HomeContent.css` hides the browser's
//! scrollbars outright (`scrollbar-width: none`), because the reference app is
//! driven with a trackpad. A mouse wheel has no horizontal axis, so without a
//! scrollbar a `.home-hub-cards` strip can only be moved with shift+wheel —
//! see `HOME.md` for the full note on the deviation.
//!
//! gpui core ships no scrollbar element (Zed's lives in its own `ui` crate),
//! so this is one: a pure-geometry [`metrics`] function plus a `div` that
//! overlays a [`ScrollHandle`]'s viewport without taking any space from it.
//!
//! Everything is painted from the *previous* frame's [`ScrollHandle::bounds`]
//! and [`ScrollHandle::max_offset`], which is what every gpui scrollbar does:
//! layout has not run yet when the tree is built, so the bar is one frame
//! behind on a resize and exact on every other frame.

use gpui::{
    Context, Div, MouseButton, MouseDownEvent, Pixels, Point, ScrollHandle, Window, div,
    prelude::*, px,
};

use super::root::Root;
use super::scroll::Axis;
use super::theme::{SCROLLBAR_THUMB, SCROLLBAR_THUMB_ACTIVE};

/// Hover group that reveals a row's scrollbar: the whole `.home-hub-row`, so
/// the bar appears as soon as the pointer is anywhere over the row, exactly
/// like a macOS overlay scrollbar appears on the first scroll gesture.
pub const ROW_GROUP: &str = "home-hub-row";
/// Hover group that reveals the `.home-content` scrollbar.
pub const CONTENT_GROUP: &str = "home-content";
/// Group on the track itself, so the thumb can brighten on its own hover.
const TRACK_GROUP: &str = "home-scrollbar";

/// Hit area across the axis; wider than the thumb so it is easy to grab.
const TRACK_THICKNESS: f32 = 10.;
/// The visible bar's thickness — a macOS overlay scrollbar is about this thin.
const THUMB_THICKNESS: f32 = 4.;
/// The thumb never shrinks below this, however long the content is.
const MIN_THUMB: f32 = 28.;

/// Above this share of its track, a thumb stops reading as a control and just
/// looks like a rule ruled under the row — so no bar is drawn at all.
///
/// A six-card row overflows by 56px of 966px: the thumb would fill 94% of the
/// track and sit between two rows looking like a divider, for a third of a
/// card's worth of travel. `HomeContent.css` hides these scrollbars outright
/// for the same reason; the bar exists here for people without a trackpad, and
/// it earns its place only once a row has something real to scroll. Raise the
/// `count` Plex returns per hub and it appears by itself.
const MAX_THUMB_FRACTION: f32 = 0.85;
/// Gap between the thumb and the track edge it hugs.
const EDGE_INSET: f32 = 2.;

/// How far below the strip's box a row's track sits.
///
/// The strip's 16px of bottom padding is the hover halo's room — a bar drawn
/// inside it hugs the meta text 8px above and reads as an underline for the
/// row rather than a control. `.home-hub-rows` leaves a 30px gap between rows
/// (38px of clear space once the strip's negative bottom margin is counted), so
/// the track hangs just past the box: 14px below the text and 20px above the
/// next heading, which keeps it plainly attached to its own row without
/// crowding either.
const ROW_TRACK_OFFSET: f32 = -4.;

/// Which scroll container a scrollbar drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// The `.home-hub-cards` strip of filtered hub row `index`.
    Row(usize),
    /// `.home-content`, the shell's vertical scroller.
    Content,
}

impl Target {
    const fn axis(self) -> Axis {
        match self {
            Self::Row(_) => Axis::Horizontal,
            Self::Content => Axis::Vertical,
        }
    }

    /// The hover group whose bounds reveal this scrollbar.
    const fn group(self) -> &'static str {
        match self {
            Self::Row(_) => ROW_GROUP,
            Self::Content => CONTENT_GROUP,
        }
    }
}

/// A thumb drag in progress. gpui resolves it through a window-level mouse
/// listener (see [`Root::scrollbar_drag_listener`]), so the pointer may leave
/// the row — or the window — without dropping the drag.
#[derive(Clone, Copy, Debug)]
pub struct Drag {
    target: Target,
    /// Pointer position along the axis when the thumb was grabbed.
    grab: f32,
    /// The container's scroll offset (<= 0) when the thumb was grabbed.
    offset: f32,
}

/// The one drag the shell can have in flight.
#[derive(Default)]
pub struct ScrollbarState {
    drag: Option<Drag>,
    /// `HANOI_PREVIEW=home-scrollbar` pins every bar visible so the overlay
    /// can be screenshotted; a screenshot cannot hover.
    pub force_visible: bool,
}

impl ScrollbarState {
    pub const fn is_dragging(&self) -> bool {
        self.drag.is_some()
    }

    fn drags(&self, target: Target) -> bool {
        matches!(self.drag, Some(drag) if drag.target == target)
    }
}

/// Where the thumb sits inside its track, in pixels along the axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    /// The track's length — the viewport's length along the axis.
    pub track: f32,
    /// The thumb's length: the visible fraction of the content, floored at
    /// [`MIN_THUMB`] so a very long row still leaves something to grab.
    pub thumb: f32,
    /// Distance from the start of the track to the start of the thumb.
    pub start: f32,
}

/// The thumb geometry for a viewport of `viewport` px holding content that can
/// scroll `max_offset` px further, currently at `offset` (<= 0, as gpui
/// reports it). `None` when the content fits and no bar should be drawn.
pub fn metrics(viewport: f32, max_offset: f32, offset: f32) -> Option<Metrics> {
    if viewport <= 0. || max_offset <= 0. {
        return None;
    }
    let content = viewport + max_offset;
    let thumb = (viewport * viewport / content).max(MIN_THUMB).min(viewport);
    if thumb > viewport * MAX_THUMB_FRACTION {
        return None;
    }
    let progress = (-offset / max_offset).clamp(0., 1.);
    Some(Metrics {
        track: viewport,
        thumb,
        // `.max(0.)` also normalises the negative zero a resting offset of
        // `-0.0` would otherwise carry into the thumb's position.
        start: (progress * (viewport - thumb)).max(0.),
    })
}

/// The overlay for one scroll container, or `None` while its content fits.
///
/// The caller positions it by making the container's parent `relative()`: the
/// bar is absolutely positioned and never contributes to layout, so no card
/// moves when it appears.
pub fn render(root: &Root, target: Target, cx: &mut Context<Root>) -> Option<Div> {
    let handle = root.scroll_handle(target)?;
    let axis = target.axis();
    let metrics = metrics(
        f32::from(viewport(handle, axis)),
        f32::from(max_offset(handle, axis)),
        f32::from(offset(handle, axis)),
    )?;

    let dragging = root.scrollbar.drags(target);
    let visible = dragging || root.scrollbar.force_visible;

    let thumb = div()
        .absolute()
        .rounded(px(THUMB_THICKNESS / 2.))
        .bg(if dragging {
            SCROLLBAR_THUMB_ACTIVE
        } else {
            SCROLLBAR_THUMB
        })
        .group_hover(TRACK_GROUP, |style| style.bg(SCROLLBAR_THUMB_ACTIVE));
    let thumb = match axis {
        Axis::Horizontal => thumb
            .bottom(px(EDGE_INSET))
            .h(px(THUMB_THICKNESS))
            .left(px(metrics.start))
            .w(px(metrics.thumb)),
        Axis::Vertical => thumb
            .right(px(EDGE_INSET))
            .w(px(THUMB_THICKNESS))
            .top(px(metrics.start))
            .h(px(metrics.thumb)),
    };

    let track = div()
        .group(TRACK_GROUP)
        .absolute()
        // Every control in this app is `cursor: pointer` on hover; a bar you
        // grab and a track you click are no exception.
        .cursor_pointer()
        .opacity(if visible { 1. } else { 0. })
        .group_hover(target.group(), |style| style.opacity(1.))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(move |this, event: &MouseDownEvent, _, cx| {
                this.press_scrollbar(target, event.position, cx);
            }),
        )
        .child(thumb);

    // The track is flush with the container's edge and reaches end to end, so
    // its own bounds are the container's bounds: `press_scrollbar` can turn a
    // window-space pointer position into a track offset from the scroll
    // handle alone, with nothing else to measure.
    Some(match axis {
        Axis::Horizontal => track
            .left_0()
            .right_0()
            .bottom(px(ROW_TRACK_OFFSET))
            .h(px(TRACK_THICKNESS)),
        Axis::Vertical => track.top_0().bottom_0().right_0().w(px(TRACK_THICKNESS)),
    })
}

fn viewport(handle: &ScrollHandle, axis: Axis) -> Pixels {
    let size = handle.bounds().size;
    match axis {
        Axis::Horizontal => size.width,
        Axis::Vertical => size.height,
    }
}

fn max_offset(handle: &ScrollHandle, axis: Axis) -> Pixels {
    let max = handle.max_offset();
    match axis {
        Axis::Horizontal => max.width,
        Axis::Vertical => max.height,
    }
}

fn offset(handle: &ScrollHandle, axis: Axis) -> Pixels {
    let offset = handle.offset();
    match axis {
        Axis::Horizontal => offset.x,
        Axis::Vertical => offset.y,
    }
}

/// The track's own origin along the axis: the overlay spans its container's
/// border box exactly, so the container's bounds are the track's bounds.
fn track_origin(handle: &ScrollHandle, axis: Axis) -> Pixels {
    let bounds = handle.bounds();
    match axis {
        Axis::Horizontal => bounds.left(),
        Axis::Vertical => bounds.top(),
    }
}

fn along(position: Point<Pixels>, axis: Axis) -> Pixels {
    match axis {
        Axis::Horizontal => position.x,
        Axis::Vertical => position.y,
    }
}

impl Root {
    /// Allocate the scroll handle each `.home-hub-cards` strip tracks, and ask
    /// for one more frame while any of them is still unmeasured.
    ///
    /// A bar is drawn from the *previous* frame's bounds, so the first frame
    /// after the rows appear has nothing to measure and draws nothing. Nothing
    /// else would redraw the shell — it only repaints when something notifies
    /// it — so without this the bars would only turn up on the next unrelated
    /// redraw. One extra frame settles it, and the test then stops asking.
    pub fn ensure_scrollbars(&mut self, window: &mut Window) {
        let rows = self.card_strip_len();
        self.artwork.ensure_rows(rows);

        let unmeasured = viewport(&self.artwork.content_scroll, Axis::Vertical) <= px(0.)
            || (0..rows).any(|index| {
                self.scroll_handle(Target::Row(index))
                    .is_none_or(|handle| viewport(handle, Axis::Horizontal) <= px(0.))
            });
        if unmeasured {
            window.request_animation_frame();
            return;
        }
        // The bars only appear on hover, so this is how a headless run (or a
        // screenshot, which cannot hover) can tell what they would be showing.
        log::debug!("scrollbars: {}", self.scrollbar_geometry(rows));
    }

    /// One line describing every scroll container's viewport, content length
    /// and thumb, for the `hanoi=debug` log.
    fn scrollbar_geometry(&self, rows: usize) -> String {
        let describe = |target: Target| {
            let axis = target.axis();
            let Some(handle) = self.scroll_handle(target) else {
                return "unmeasured".to_owned();
            };
            let view = f32::from(viewport(handle, axis));
            let max = f32::from(max_offset(handle, axis));
            match metrics(view, max, f32::from(offset(handle, axis))) {
                Some(metrics) => format!(
                    "{view:.0}px of {:.0}px, thumb {:.0}px at {:.0}px",
                    view + max,
                    metrics.thumb,
                    metrics.start
                ),
                None if max > 0. => {
                    format!(
                        "{view:.0}px of {:.0}px, {max:.0}px over but no bar",
                        view + max
                    )
                }
                None => format!("{view:.0}px fits"),
            }
        };
        let rows = (0..rows)
            .map(|index| format!("row {index}: {}", describe(Target::Row(index))))
            .collect::<Vec<_>>()
            .join("; ");
        format!("content: {}; {rows}", describe(Target::Content))
    }

    /// The handle behind one scrollbar. Rows are indexed like the filtered
    /// hubs, so a row that is no longer rendered has no handle.
    pub fn scroll_handle(&self, target: Target) -> Option<&ScrollHandle> {
        match target {
            Target::Row(index) => self.artwork.row_scroll(index),
            Target::Content => Some(&self.artwork.content_scroll),
        }
    }

    /// Mouse down on a scrollbar: grab the thumb, or page toward a click that
    /// landed on the bare track.
    fn press_scrollbar(&mut self, target: Target, position: Point<Pixels>, cx: &mut Context<Self>) {
        let axis = target.axis();
        let Some(handle) = self.scroll_handle(target).cloned() else {
            return;
        };
        let max = f32::from(max_offset(&handle, axis));
        let current = f32::from(offset(&handle, axis));
        let Some(metrics) = metrics(f32::from(viewport(&handle, axis)), max, current) else {
            return;
        };

        let local = f32::from(along(position, axis) - track_origin(&handle, axis));
        if local >= metrics.start && local <= metrics.start + metrics.thumb {
            self.scrollbar.drag = Some(Drag {
                target,
                grab: f32::from(along(position, axis)),
                offset: current,
            });
        } else {
            // A page in the direction of the click, the way a browser's track
            // click behaves. Offsets are negative, so scrolling forward
            // subtracts.
            let page = metrics.track;
            let delta = if local < metrics.start { page } else { -page };
            scroll_to(&handle, axis, (current + delta).clamp(-max, 0.));
        }
        cx.notify();
    }

    /// A move while the thumb is held: map the pointer's travel along the
    /// track onto the whole scrollable range.
    pub fn drag_scrollbar(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(drag) = self.scrollbar.drag else {
            return;
        };
        let axis = drag.target.axis();
        let Some(handle) = self.scroll_handle(drag.target).cloned() else {
            return;
        };
        let max = f32::from(max_offset(&handle, axis));
        let Some(metrics) = metrics(
            f32::from(viewport(&handle, axis)),
            max,
            f32::from(offset(&handle, axis)),
        ) else {
            return;
        };
        let travel = metrics.track - metrics.thumb;
        if travel <= 0. {
            return;
        }

        let moved = f32::from(along(position, axis)) - drag.grab;
        let next = (drag.offset - moved * max / travel).clamp(-max, 0.);
        scroll_to(&handle, axis, next);
        cx.notify();
    }

    /// Mouse up, or any move that arrives without the button still down.
    pub fn end_scrollbar_drag(&mut self, cx: &mut Context<Self>) {
        if self.scrollbar.drag.take().is_some() {
            cx.notify();
        }
    }

    /// An invisible element whose only job is to register the window-level
    /// mouse listeners a drag needs.
    ///
    /// A `div`'s `on_mouse_move` only fires while its own hitbox is hovered,
    /// which a thumb drag leaves immediately. gpui's drag-and-drop machinery
    /// (`on_drag` / `DragMoveEvent`) is built around a dragged *value* with a
    /// preview element, which a scrollbar has no use for, so it is resolved with
    /// the window listeners `Window::on_mouse_event` registers instead — they
    /// are dispatched whatever the pointer is over, including outside the
    /// window.
    pub fn scrollbar_drag_listener(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let moved = cx.entity().downgrade();
        let released = moved.clone();
        gpui::canvas(
            |_, _, _| (),
            move |_, (), window, _| {
                window.on_mouse_event(move |event: &gpui::MouseMoveEvent, phase, _, cx| {
                    if phase != gpui::DispatchPhase::Bubble {
                        return;
                    }
                    moved
                        .update(cx, |this, cx| {
                            // A button that came up off-window never produced a
                            // mouse-up here, so the first buttonless move ends it.
                            if event.pressed_button == Some(MouseButton::Left) {
                                this.drag_scrollbar(event.position, cx);
                            } else {
                                this.end_scrollbar_drag(cx);
                            }
                        })
                        .ok();
                });
                window.on_mouse_event(move |_: &gpui::MouseUpEvent, phase, _, cx| {
                    if phase != gpui::DispatchPhase::Bubble {
                        return;
                    }
                    released.update(cx, Self::end_scrollbar_drag).ok();
                });
            },
        )
        .absolute()
        .size_full()
    }
}

/// Write one axis of a scroll offset, leaving the other alone.
fn scroll_to(handle: &ScrollHandle, axis: Axis, value: f32) {
    let mut offset = handle.offset();
    match axis {
        Axis::Horizontal => offset.x = px(value),
        Axis::Vertical => offset.y = px(value),
    }
    handle.set_offset(offset);
}

#[cfg(test)]
mod tests {
    use super::{MIN_THUMB, metrics};

    #[test]
    fn a_barely_overflowing_row_draws_no_bar() {
        // The live dashboard: 966px of cards in a 910px strip. A proportional
        // thumb would be 857px of a 910px track — a divider, not a control.
        assert_eq!(metrics(910., 56., 0.), None);
        // Twice as many cards, and it is a scrollbar again.
        assert!(metrics(910., 1022., 0.).is_some());
    }

    #[test]
    fn content_that_fits_has_no_scrollbar() {
        assert_eq!(metrics(600., 0., 0.), None);
        assert_eq!(metrics(0., 400., 0.), None);
    }

    #[test]
    fn the_thumb_is_the_visible_fraction_of_the_content() {
        // 600px of viewport over 1800px of content: a third of the track.
        let metrics = metrics(600., 1200., 0.).expect("a scrollable strip has a bar");
        assert_eq!(metrics.track, 600.);
        assert!((metrics.thumb - 200.).abs() < 0.01, "{}", metrics.thumb);
        assert_eq!(metrics.start, 0.);
    }

    #[test]
    fn the_minimum_thumb_never_outgrows_its_track() {
        // A very long row: the proportional thumb would be 3.9px, so the
        // minimum applies — and still leaves most of the track to travel.
        let long = metrics(200., 10_000., 0.).expect("a bar");
        assert_eq!(long.thumb, MIN_THUMB);
        assert!(long.thumb < long.track);

        // A track too short for the minimum draws nothing rather than a thumb
        // that fills it end to end.
        assert_eq!(metrics(20., 100., 0.), None);
    }

    #[test]
    fn a_very_long_row_keeps_a_grabbable_thumb() {
        let metrics = metrics(600., 40_000., 0.).expect("a scrollable strip has a bar");
        assert_eq!(metrics.thumb, MIN_THUMB);
    }

    #[test]
    fn the_thumb_tracks_the_scroll_offset_end_to_end() {
        let track = 600.;
        let max = 1200.;
        let thumb = metrics(track, max, 0.).expect("a bar").thumb;

        let start = metrics(track, max, 0.).expect("a bar");
        assert_eq!(start.start, 0.);

        let middle = metrics(track, max, -max / 2.).expect("a bar");
        assert!((middle.start - (track - thumb) / 2.).abs() < 0.01);

        let end = metrics(track, max, -max).expect("a bar");
        assert!((end.start - (track - thumb)).abs() < 0.01);
        // The thumb never overruns the track.
        assert!(end.start + end.thumb <= track + 0.01);
    }

    #[test]
    fn an_out_of_range_offset_is_clamped_to_the_track() {
        let under = metrics(600., 1200., 400.).expect("a bar");
        assert_eq!(under.start, 0.);
        let over = metrics(600., 1200., -5000.).expect("a bar");
        let full = metrics(600., 1200., -1200.).expect("a bar");
        assert_eq!(over.start, full.start);
    }
}
