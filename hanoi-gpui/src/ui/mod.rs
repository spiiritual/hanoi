//! gpui user interface: the window, the bundled assets and the auth flow.
//!
//! See `DESIGN.md` for the measurements every screen is built from.

mod auth;
mod components;
mod home;
mod preview;
mod root;
mod screenshot;
mod scroll;
mod scrollbar;
mod theme;
mod transition;

use std::borrow::Cow;

use anyhow::Result;
use gpui::{
    App, Application, AssetSource, Bounds, KeyBinding, Menu, MenuItem, SharedString,
    SystemMenuType, TitlebarOptions, WindowBounds, WindowOptions, actions, prelude::*, px, size,
};

use preview::Preview;
use root::Root;

/// `HANOI_PREVIEW=<stage>` renders one stage from sample data.
const PREVIEW_ENV: &str = "HANOI_PREVIEW";
/// `HANOI_SCREENSHOT=<path>` captures the window and quits.
const SCREENSHOT_ENV: &str = "HANOI_SCREENSHOT";
const WINDOW_WIDTH: f32 = 1200.;
const WINDOW_HEIGHT: f32 = 800.;

actions!(hanoi, [Quit]);

/// Icons are compiled into the binary; gpui resolves `svg().path("icons/..")`
/// through this source.
struct Assets;

impl Assets {
    const SPINNER_TRACK: &'static [u8] = include_bytes!("../../assets/icons/spinner-track.svg");
    const SPINNER_ARC: &'static [u8] = include_bytes!("../../assets/icons/spinner-arc.svg");
    const SERVER: &'static [u8] = include_bytes!("../../assets/icons/server.svg");
    const CHECK_CIRCLE: &'static [u8] = include_bytes!("../../assets/icons/check-circle.svg");
    const HOME: &'static [u8] = include_bytes!("../../assets/icons/home.svg");
    const LIBRARY: &'static [u8] = include_bytes!("../../assets/icons/library.svg");
    const ALBUMS: &'static [u8] = include_bytes!("../../assets/icons/albums.svg");
    const ARTISTS: &'static [u8] = include_bytes!("../../assets/icons/artists.svg");
    const SONGS: &'static [u8] = include_bytes!("../../assets/icons/songs.svg");
    const PLAYLISTS: &'static [u8] = include_bytes!("../../assets/icons/playlists.svg");
    const CHEVRON_DOWN: &'static [u8] = include_bytes!("../../assets/icons/chevron-down.svg");
    const CHEVRON_UP: &'static [u8] = include_bytes!("../../assets/icons/chevron-up.svg");
    const CHEVRON_LEFT: &'static [u8] = include_bytes!("../../assets/icons/chevron-left.svg");
    const CHEVRON_RIGHT: &'static [u8] = include_bytes!("../../assets/icons/chevron-right.svg");
    const SETTINGS: &'static [u8] = include_bytes!("../../assets/icons/settings.svg");
    const SEARCH: &'static [u8] = include_bytes!("../../assets/icons/search.svg");
    const QUEUE: &'static [u8] = include_bytes!("../../assets/icons/queue.svg");
    const BELL: &'static [u8] = include_bytes!("../../assets/icons/bell.svg");
    const PLAY: &'static [u8] = include_bytes!("../../assets/icons/play.svg");
}

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        use components::icons;

        let bytes = match path {
            icons::SPINNER_TRACK => Self::SPINNER_TRACK,
            icons::SPINNER_ARC => Self::SPINNER_ARC,
            icons::SERVER => Self::SERVER,
            icons::CHECK_CIRCLE => Self::CHECK_CIRCLE,
            icons::HOME => Self::HOME,
            icons::LIBRARY => Self::LIBRARY,
            icons::ALBUMS => Self::ALBUMS,
            icons::ARTISTS => Self::ARTISTS,
            icons::SONGS => Self::SONGS,
            icons::PLAYLISTS => Self::PLAYLISTS,
            icons::CHEVRON_DOWN => Self::CHEVRON_DOWN,
            icons::CHEVRON_UP => Self::CHEVRON_UP,
            icons::CHEVRON_LEFT => Self::CHEVRON_LEFT,
            icons::CHEVRON_RIGHT => Self::CHEVRON_RIGHT,
            icons::SETTINGS => Self::SETTINGS,
            icons::SEARCH => Self::SEARCH,
            icons::QUEUE => Self::QUEUE,
            icons::BELL => Self::BELL,
            icons::PLAY => Self::PLAY,
            _ => return Ok(None),
        };
        Ok(Some(Cow::Borrowed(bytes)))
    }

    fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
        Ok(components::icons::ALL
            .iter()
            .map(|path| SharedString::from(*path))
            .collect())
    }
}

/// Start the gpui application and open the main window.
pub fn run() {
    let preview = std::env::var(PREVIEW_ENV).ok().map(|value| {
        Preview::parse(&value).unwrap_or_else(|| {
            panic!(
                "unknown {PREVIEW_ENV}={value:?}; expected one of {}",
                Preview::ALL.join(", ")
            )
        })
    });
    let screenshot = std::env::var(SCREENSHOT_ENV).ok().filter(|p| !p.is_empty());

    Application::new()
        .with_assets(Assets)
        .run(move |cx: &mut App| {
            theme::load_fonts(cx);
            install_menu(cx);

            cx.on_window_closed(|cx| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();

            let options = WindowOptions {
                titlebar: Some(TitlebarOptions {
                    title: Some("Hanoi".into()),
                    ..Default::default()
                }),
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(WINDOW_WIDTH), px(WINDOW_HEIGHT)),
                    cx,
                ))),
                ..Default::default()
            };

            let window = cx
                .open_window(options, |_, cx| {
                    cx.new(|cx| match preview {
                        Some(preview) => Root::preview(preview),
                        None => Root::new(cx),
                    })
                })
                .expect("failed to open the Hanoi window");
            cx.activate(true);

            if let Some(path) = screenshot.clone() {
                screenshot::capture(window, path, cx);
            }
        });
}

fn install_menu(cx: &mut App) {
    cx.on_action(|_: &Quit, cx: &mut App| cx.quit());
    cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
    cx.set_menus(vec![Menu {
        name: "Hanoi".into(),
        items: vec![
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("Quit Hanoi", Quit),
        ],
    }]);
}
