//! `AuthStartupScreen` in `auth-flow.tsx`: what the window shows while the
//! saved session is checked.

use gpui::{AnyElement, prelude::*};

use crate::ui::components::{app_name, auth_inner, logo_mark, spacer, status_row};

pub const STATUS: &str = "Checking your Plex account…";

pub fn render() -> AnyElement {
    auth_inner()
        .child(logo_mark())
        .child(spacer(12.))
        .child(app_name())
        .child(spacer(36.))
        .child(status_row("startup-spinner", STATUS))
        .into_any_element()
}
