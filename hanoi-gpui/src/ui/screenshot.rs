//! `HANOI_SCREENSHOT=<path>`: capture the window shortly after it appears and
//! quit. Used for the visual QA pass described in `DESIGN.md`.

use std::time::Duration;

use gpui::{App, WindowHandle, prelude::*};

use super::root::Root;

/// How long the window is given to settle (fonts, first paint) before capture.
const DELAY: Duration = Duration::from_millis(1500);
/// `HANOI_SCREENSHOT_DELAY_MS=<ms>` overrides it, so a live capture can wait
/// for the home screen's network round-trips instead of the first paint.
const DELAY_ENV: &str = "HANOI_SCREENSHOT_DELAY_MS";

/// `DELAY`, or the override when it parses.
fn delay() -> Duration {
    std::env::var(DELAY_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(DELAY, Duration::from_millis)
}

/// Screenshot the window with `screencapture`, then quit the app.
pub fn capture(window: WindowHandle<Root>, path: String, cx: &mut App) {
    cx.spawn(async move |cx| {
        cx.background_executor().timer(delay()).await;

        // `-l <window id>` is the only mode that reliably contains the window
        // on every macOS screen-capture configuration; the window rect is the
        // fallback when the window server will not name it.
        let region = window
            .update(cx, |_, window, _| {
                let frame = window.bounds();
                let viewport = window.viewport_size();
                let chrome = frame.size.height - viewport.height;
                format!(
                    "-R{},{},{},{}",
                    f32::from(frame.origin.x).round() as i32,
                    f32::from(frame.origin.y + chrome).round() as i32,
                    f32::from(viewport.width).round() as i32,
                    f32::from(viewport.height).round() as i32,
                )
            })
            .unwrap_or_else(|error| {
                log::error!("failed to read the window bounds: {error}");
                String::new()
            });

        let outcome = cx
            .background_spawn(async move {
                let mut command = std::process::Command::new("screencapture");
                command.arg("-x").arg("-o");
                match window_id() {
                    Some(id) => command.arg("-l").arg(id.to_string()),
                    None => command.arg(region),
                };
                command.arg(&path).status()
            })
            .await;
        match outcome {
            Ok(status) if status.success() => {}
            Ok(status) => log::error!("screencapture exited with {status}"),
            Err(error) => log::error!("failed to run screencapture: {error}"),
        }

        cx.update(|cx| cx.quit());
    })
    .detach();
}

/// The window-server id of this process' first on-screen normal window.
#[cfg(target_os = "macos")]
fn window_id() -> Option<u32> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
    };

    let pid = i64::from(std::process::id());
    let windows = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )?;
    let owner_key = CFString::from_static_string("kCGWindowOwnerPID");
    let layer_key = CFString::from_static_string("kCGWindowLayer");
    let number_key = CFString::from_static_string("kCGWindowNumber");

    windows.iter().find_map(|item| {
        let window = unsafe {
            CFDictionary::<CFString, CFType>::wrap_under_get_rule(*item as CFDictionaryRef)
        };
        let integer =
            |key: &CFString| -> Option<i64> { window.find(key)?.downcast::<CFNumber>()?.to_i64() };
        // Layer 0 is a normal application window; anything else belongs to the
        // menu bar, a panel or a shadow surface.
        (integer(&owner_key)? == pid && integer(&layer_key)? == 0)
            .then(|| u32::try_from(integer(&number_key)?).ok())
            .flatten()
    })
}

#[cfg(not(target_os = "macos"))]
fn window_id() -> Option<u32> {
    None
}
