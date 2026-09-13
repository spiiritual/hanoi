//! Wheel and trackpad scrolling for the shell's two scrolling surfaces.
//!
//! gpui's built-in overflow scrolling is not used here. It has no notion of a
//! gesture: every event is applied to whichever axis the element can scroll, so
//! a two-finger swipe — which is never perfectly axis-aligned — moves the page
//! *and* nudges whichever `.home-hub-cards` strip happens to be under the
//! pointer, a few pixels back and forth. `Style::restrict_scroll_to_axis` does
//! not help: it only stops a delta being repurposed onto the *other* axis, and
//! the strip's sideways jitter comes from the gesture's real horizontal
//! component.
//!
//! Browsers solve this with directional lock: the first event that clearly
//! favours one axis pins the whole gesture to it. That is what [`Gesture`]
//! implements, and the two surfaces consult one shared lock so they can never
//! disagree about which way a gesture is going.
//!
//! The elements keep their tracked `ScrollHandle`s and simply clip their
//! overflow; gpui still clamps the offset, records `max_offset`, `bounds` and
//! every child's bounds from the handle alone, which is what the scrollbars and
//! the artwork viewport gate read.

use std::time::{Duration, Instant};

use gpui::{Context, Pixels, ScrollHandle, ScrollWheelEvent, TouchPhase, Window, px};

use super::root::Root;

/// Which way a gesture is going.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

/// The directional lock for the gesture in progress.
#[derive(Default)]
pub struct Gesture {
    axis: Option<Axis>,
    last: Option<Instant>,
}

impl Gesture {
    /// A mouse wheel reports no touch phases, so the lock would otherwise
    /// outlive the scroll it was taken for. A pause this long ends a gesture.
    const IDLE: Duration = Duration::from_millis(150);

    /// The axis this event belongs to, or `None` while the gesture is still
    /// ambiguous (a perfectly diagonal first event, or no movement at all).
    pub fn axis(&mut self, event: &ScrollWheelEvent, line_height: Pixels) -> Option<Axis> {
        self.tick(event.touch_phase, Instant::now());

        let delta = event.delta.pixel_delta(line_height);
        if self.axis.is_none() {
            let horizontal = delta.x.abs();
            let vertical = delta.y.abs();
            if horizontal > vertical {
                self.axis = Some(Axis::Horizontal);
            } else if vertical > horizontal {
                self.axis = Some(Axis::Vertical);
            }
        }

        let axis = self.axis;
        if matches!(event.touch_phase, TouchPhase::Ended) {
            self.axis = None;
        }
        axis
    }

    /// Release the lock when a new gesture starts, or when the last one has
    /// been quiet long enough to be over.
    fn tick(&mut self, phase: TouchPhase, now: Instant) {
        let idle = self
            .last
            .is_none_or(|last| now.saturating_duration_since(last) >= Self::IDLE);
        if matches!(phase, TouchPhase::Started) || idle {
            self.axis = None;
        }
        self.last = Some(now);
    }
}

/// Move one axis of a scroll handle, clamped to its content.
///
/// Offsets are zero or negative, `max_offset` is the positive distance the
/// content can travel, exactly as gpui's own scroll handling defines them.
pub fn scroll_by(handle: &ScrollHandle, axis: Axis, delta: Pixels) {
    let max = handle.max_offset();
    let mut offset = handle.offset();
    match axis {
        Axis::Horizontal => offset.x = (offset.x + delta).clamp(-max.width, px(0.)),
        Axis::Vertical => offset.y = (offset.y + delta).clamp(-max.height, px(0.)),
    }
    handle.set_offset(offset);
}

impl Root {
    /// A wheel event over one `.home-hub-cards` strip: horizontal gestures only.
    pub fn scroll_row(
        &mut self,
        index: usize,
        event: &ScrollWheelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Axis::Horizontal) = self.scroll.axis(event, window.line_height()) else {
            return;
        };
        let Some(handle) = self.artwork.row_scroll(index) else {
            return;
        };
        scroll_by(
            handle,
            Axis::Horizontal,
            event.delta.pixel_delta(window.line_height()).x,
        );
        cx.notify();
    }

    /// A wheel event anywhere over `.home-content`: vertical gestures only.
    ///
    /// The strips sit inside this element, so both handlers see the same event;
    /// the shared lock is what keeps a sideways flick from also creeping the
    /// page downwards.
    pub fn scroll_content(
        &mut self,
        event: &ScrollWheelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(Axis::Vertical) = self.scroll.axis(event, window.line_height()) else {
            return;
        };
        scroll_by(
            &self.artwork.content_scroll,
            Axis::Vertical,
            event.delta.pixel_delta(window.line_height()).y,
        );
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use gpui::{Modifiers, ScrollDelta, ScrollWheelEvent, TouchPhase, point, px};

    use super::{Axis, Gesture};

    fn event(x: f32, y: f32, touch_phase: TouchPhase) -> ScrollWheelEvent {
        ScrollWheelEvent {
            position: point(px(0.), px(0.)),
            delta: ScrollDelta::Pixels(point(px(x), px(y))),
            modifiers: Modifiers::default(),
            touch_phase,
            ..Default::default()
        }
    }

    const LINE: gpui::Pixels = px(16.);

    #[test]
    fn a_gesture_locks_to_the_axis_it_favours() {
        let mut gesture = Gesture::default();
        assert_eq!(
            gesture.axis(&event(2., -30., TouchPhase::Started), LINE),
            Some(Axis::Vertical),
            "a swipe down with a slight sideways component is vertical"
        );
        assert_eq!(
            gesture.axis(&event(9., -4., TouchPhase::Moved), LINE),
            Some(Axis::Vertical),
            "and stays vertical even when a later event leans sideways"
        );
    }

    #[test]
    fn a_sideways_flick_locks_horizontally() {
        let mut gesture = Gesture::default();
        assert_eq!(
            gesture.axis(&event(-24., 3., TouchPhase::Started), LINE),
            Some(Axis::Horizontal)
        );
        assert_eq!(
            gesture.axis(&event(-2., 6., TouchPhase::Moved), LINE),
            Some(Axis::Horizontal),
            "the page must not creep while a row is being flicked"
        );
    }

    #[test]
    fn the_next_gesture_starts_unlocked() {
        let mut gesture = Gesture::default();
        gesture.axis(&event(0., -20., TouchPhase::Started), LINE);
        gesture.axis(&event(0., -20., TouchPhase::Ended), LINE);
        assert_eq!(
            gesture.axis(&event(-20., 0., TouchPhase::Started), LINE),
            Some(Axis::Horizontal)
        );
    }

    #[test]
    fn an_idle_pause_ends_a_gesture_that_reports_no_phases() {
        // A mouse wheel only ever reports `Moved`, so without the idle timeout
        // the first scroll of a session would pin the lock forever.
        let mut gesture = Gesture::default();
        assert_eq!(
            gesture.axis(&event(0., -20., TouchPhase::Moved), LINE),
            Some(Axis::Vertical)
        );
        gesture.tick(
            TouchPhase::Moved,
            Instant::now() + Duration::from_millis(200),
        );
        assert_eq!(
            gesture.axis(&event(-20., 0., TouchPhase::Moved), LINE),
            Some(Axis::Horizontal)
        );
    }

    #[test]
    fn a_gesture_with_no_movement_is_ambiguous() {
        let mut gesture = Gesture::default();
        assert_eq!(
            gesture.axis(&event(0., 0., TouchPhase::Started), LINE),
            None
        );
    }
}
