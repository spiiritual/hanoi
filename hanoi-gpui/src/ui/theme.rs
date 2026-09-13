//! Design tokens transcribed from `../src/mainview/styles/global.css` plus the
//! bundled font faces. Every colour the auth flow uses lives here so the
//! screens never spell out a hex literal.

use gpui::{App, Rgba};
use std::borrow::Cow;

/// Build an opaque colour from a `0xRRGGBB` literal at compile time.
const fn hex(value: u32) -> Rgba {
    Rgba {
        r: ((value >> 16) & 0xff) as f32 / 255.0,
        g: ((value >> 8) & 0xff) as f32 / 255.0,
        b: (value & 0xff) as f32 / 255.0,
        a: 1.0,
    }
}

/// Build a translucent colour from a `0xRRGGBB` literal plus a CSS alpha — the
/// `rgba(...)` surfaces the home screen paints over `bg`.
const fn hexa(value: u32, alpha: f32) -> Rgba {
    let opaque = hex(value);
    Rgba { a: alpha, ..opaque }
}

pub const BG: Rgba = hex(0x14_14_19);
/// `--sidebar-bg`
pub const SIDEBAR_BG: Rgba = hex(0x0e_0e_13);
pub const SURFACE: Rgba = hex(0x1d_1d_24);
pub const SURFACE_2: Rgba = hex(0x27_27_30);
pub const ACCENT: Rgba = hex(0xe5_a0_0d);
pub const ACCENT_2: Rgba = hex(0xc8_6b_3f);
pub const TEXT_PRIMARY: Rgba = hex(0xf2_f2_f4);
pub const TEXT_SECONDARY: Rgba = hex(0x9d_9d_a8);
pub const TEXT_TERTIARY: Rgba = hex(0x6e_6e_79);
pub const SUCCESS_BG: Rgba = hex(0x1d_2b_1e);
pub const SUCCESS: Rgba = hex(0x4a_de_80);
pub const COPIED_BG: Rgba = hex(0x1c_2a_21);
pub const COPIED_BORDER: Rgba = hex(0x3a_6b_4a);
pub const COPIED_FG: Rgba = hex(0x5f_d4_8a);

/// Foreground used on top of `ACCENT` (the CSS spells it `#141419`).
pub const ON_ACCENT: Rgba = hex(0x14_14_19);
/// The tick glyph inside the success badge.
pub const BADGE_CHECK_FG: Rgba = hex(0x0b_0b_0e);
/// The unfilled part of the spinner ring.
pub const SPINNER_TRACK: Rgba = hex(0x33_33_3c);
/// Border a server row takes on hover.
pub const ROW_HOVER_BORDER: Rgba = hex(0x3a_3a_44);
/// Error copy on the server selection screen.
pub const ERROR: Rgba = hex(0xf0_a0_a0);

/// `filter: brightness(1.05)` over `ACCENT`.
pub const ACCENT_HOVER: Rgba = hex(0xf0_a8_0e);
/// `filter: brightness(1.1)` over `SURFACE_2`.
pub const SURFACE_2_HOVER: Rgba = hex(0x2b_2b_35);

// --- home screen -----------------------------------------------------------

/// `rgba(29, 29, 36, 0.42)` — `.home-state`, `.home-empty`,
/// `.home-category-status` and `.home-shell-placeholder`.
pub const PANEL_BG: Rgba = hexa(0x1d_1d_24, 0.42);
/// `rgba(214, 103, 103, 0.45)` — `.home-state.is-error`'s border.
pub const ERROR_BORDER: Rgba = hexa(0xd6_67_67, 0.45);
/// `.home-retry:hover`
pub const RETRY_HOVER: Rgba = hex(0x30_30_3a);
/// `.home-hub-see-all:hover` and `.home-hub-card-play:hover`.
pub const ACCENT_LIGHT: Rgba = hex(0xf3_c3_4d);
/// `rgba(255, 255, 255, 0.06)` — the sidebar's row hover wash.
pub const SIDEBAR_ROW_HOVER: Rgba = hexa(0xff_ff_ff, 0.06);
/// `rgba(255, 255, 255, 0.08)` — the inner hairline over card artwork.
pub const CARD_ART_HAIRLINE: Rgba = hexa(0xff_ff_ff, 0.08);
/// `linear-gradient(135deg, #363640 0%, #1f1f27 100%)` — the card art
/// placeholder the fallback glyph sits on.
pub const CARD_ART_FROM: Rgba = hex(0x36_36_40);
pub const CARD_ART_TO: Rgba = hex(0x1f_1f_27);
/// `box-shadow: 0 12px 30px rgba(0, 0, 0, 0.36)` on the server menu.
pub const MENU_SHADOW: Rgba = hexa(0x00_00_00, 0.36);

// --- overlay scrollbars ----------------------------------------------------
//
// `HomeContent.css` hides the scrollbars it would otherwise get
// (`scrollbar-width: none`), so these two have no counterpart in the design.
// They are the neutral white washes a macOS overlay scrollbar uses over a dark
// surface, in the same family as `CARD_ART_HAIRLINE`, so the bar reads as part
// of the window chrome rather than as another accent.

/// The resting thumb of `src/ui/scrollbar.rs`.
pub const SCROLLBAR_THUMB: Rgba = hexa(0xff_ff_ff, 0.13);
/// The thumb while it is hovered or dragged.
pub const SCROLLBAR_THUMB_ACTIVE: Rgba = hexa(0xff_ff_ff, 0.34);

pub const FONT_BODY: &str = "Inter";
pub const FONT_MONO: &str = "JetBrains Mono";

/// Browsers resolve `line-height: normal` for Inter to roughly 1.21em; gpui
/// defaults to the golden ratio, which is far looser than the CSS.
pub const LINE_HEIGHT_NORMAL: f32 = 1.21;

/// Register the bundled TTFs so `.font_family("Inter")` and
/// `.font_family("JetBrains Mono")` resolve without touching system fonts.
pub fn load_fonts(cx: &App) {
    let fonts: Vec<Cow<'static, [u8]>> = vec![
        Cow::Borrowed(include_bytes!("../../assets/fonts/Inter-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../../assets/fonts/Inter-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../../assets/fonts/Inter-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../../assets/fonts/Inter-Bold.ttf")),
        Cow::Borrowed(include_bytes!("../../assets/fonts/Inter-ExtraBold.ttf")),
        Cow::Borrowed(include_bytes!("../../assets/fonts/JetBrainsMono-Bold.ttf")),
    ];
    if let Err(error) = cx.text_system().add_fonts(fonts) {
        log::error!("failed to register the bundled fonts: {error}");
    }
}
