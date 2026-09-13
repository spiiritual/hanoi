//! The slide + fade that plays when the flow moves between stages.
//!
//! Mirrors the four `@keyframes auth-stage-*` rules in `AuthLayout.css`,
//! including their `cubic-bezier(0.32, 0.72, 0, 1)` timing function.

use std::time::Duration;

/// `animation-duration: 420ms`.
pub const DURATION: Duration = Duration::from_millis(420);
/// The reference clears the exiting stage slightly after the animation ends.
pub const CLEANUP_DELAY: Duration = Duration::from_millis(450);

const ENTER_OFFSET: f32 = 40.0;
const EXIT_OFFSET: f32 = 24.0;

/// Which way through `["welcome", "oauth", "connected", "servers"]` the flow is
/// moving.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Direction {
    #[default]
    Forward,
    Backward,
}

/// Whether a stage layer is arriving or leaving.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Enter,
    Exit,
}

/// The animated values of one stage layer at `delta` (already eased).
///
/// Returns `(opacity, translate_x)`; gpui has no transforms on `div`, so the
/// horizontal offset is applied as a relative `left`.
pub fn frame(role: Role, direction: Direction, delta: f32) -> (f32, f32) {
    match (role, direction) {
        (Role::Enter, Direction::Forward) => (delta, ENTER_OFFSET * (1.0 - delta)),
        (Role::Enter, Direction::Backward) => (delta, -ENTER_OFFSET * (1.0 - delta)),
        (Role::Exit, Direction::Forward) => (1.0 - delta, -EXIT_OFFSET * delta),
        (Role::Exit, Direction::Backward) => (1.0 - delta, EXIT_OFFSET * delta),
    }
}

/// `cubic-bezier(0.32, 0.72, 0, 1)` — the flow's single easing curve.
pub fn ease(t: f32) -> f32 {
    cubic_bezier(0.32, 0.72, 0.0, 1.0, t)
}

/// Evaluate a CSS `cubic-bezier(x1, y1, x2, y2)` at `t`.
///
/// The curve is parametric, so `t` (the progress along the x axis) is first
/// solved for the curve parameter with Newton-Raphson, falling back to
/// bisection when the derivative is too flat to trust.
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    let parameter = solve_for_x(x1, x2, t);
    bezier(y1, y2, parameter)
}

/// One axis of a cubic Bezier whose end points are fixed at 0 and 1.
fn bezier(p1: f32, p2: f32, t: f32) -> f32 {
    let c = 3.0 * p1;
    let b = 3.0 * (p2 - p1) - c;
    let a = 1.0 - c - b;
    ((a * t + b) * t + c) * t
}

/// d/dt of [`bezier`].
fn bezier_slope(p1: f32, p2: f32, t: f32) -> f32 {
    let c = 3.0 * p1;
    let b = 3.0 * (p2 - p1) - c;
    let a = 1.0 - c - b;
    (3.0 * a * t + 2.0 * b) * t + c
}

fn solve_for_x(x1: f32, x2: f32, x: f32) -> f32 {
    const EPSILON: f32 = 1e-6;

    let mut t = x;
    for _ in 0..8 {
        let error = bezier(x1, x2, t) - x;
        if error.abs() < EPSILON {
            return t;
        }
        let slope = bezier_slope(x1, x2, t);
        if slope.abs() < EPSILON {
            break;
        }
        t -= error / slope;
    }

    let (mut low, mut high) = (0.0_f32, 1.0_f32);
    let mut t = x.clamp(0.0, 1.0);
    for _ in 0..32 {
        let value = bezier(x1, x2, t);
        if (value - x).abs() < EPSILON {
            break;
        }
        if value > x {
            high = t;
        } else {
            low = t;
        }
        t = (low + high) / 2.0;
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn easing_is_pinned_at_both_ends() {
        assert!((ease(0.0) - 0.0).abs() < 1e-4);
        assert!((ease(1.0) - 1.0).abs() < 1e-4);
    }

    #[test]
    fn easing_front_loads_like_the_css_curve() {
        // cubic-bezier(0.32, 0.72, 0, 1) is ~95% of the way at the halfway
        // point; a high-precision bisection of the same curve agrees.
        let midpoint = ease(0.5);
        assert!(
            (midpoint - 0.954_809).abs() < 1e-3,
            "unexpected midpoint {midpoint}"
        );
        let quarter = ease(0.25);
        assert!(
            (quarter - 0.779_131).abs() < 1e-3,
            "unexpected quarter point {quarter}"
        );
    }

    #[test]
    fn easing_is_monotonic() {
        let mut previous = 0.0;
        for step in 0..=100 {
            let value = ease(step as f32 / 100.0);
            assert!(value >= previous - 1e-6, "eased value went backwards");
            previous = value;
        }
    }
}
