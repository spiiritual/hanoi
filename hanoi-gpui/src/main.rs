//! Hanoi (gpui rewrite) - a desktop music player for Plex.
//!
//! This crate is the native rewrite of the Electrobun app in `../src`.
//! Only the authentication flow exists so far (see `DESIGN.md`).

mod artwork;
mod plex;
mod ui;

fn main() {
    env_logger::init();
    ui::run();
}
