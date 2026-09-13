//! Token-free Plex artwork with a memory + disk cache.
//!
//! CONTRACT: everything `pub` here is the API the UI codes against. The
//! semantics mirror `../../src/bun/plex/artwork/{cache,fetcher,types}.ts` and
//! the renderer-side store in `../../src/mainview/artwork/index.ts`:
//!
//! * keys are namespaced per account + server and never contain token material,
//! * objects live on disk with their validators (ETag / Last-Modified) and are
//!   revalidated conditionally once they go stale,
//! * decoded frames are kept in a bounded in-memory LRU,
//! * concurrent loads of the same key collapse onto one fetch.
//!
//! `ArtworkStore::load` is **blocking**; the UI calls it from
//! `cx.background_spawn`.
//!
//! The implementation is split into `key.rs` (addressing and the token
//! guards), `fetcher.rs` (URL building, HTTP, response validation) and
//! `cache.rs` (the memory + disk cache itself); everything is re-exported
//! here so `crate::artwork::<item>` keeps working.

mod cache;
mod fetcher;
mod key;

use gpui::RenderImage;

pub use cache::ArtworkStore;
#[allow(unused_imports, reason = "backend contract the UI does not call yet")]
pub use key::{ArtworkKey, Credentials, FALLBACK_VARIANT, Namespace, Source, Variant};

/// What one decoded frame actually costs in memory: 4 bytes per pixel, at the
/// image's own resolution rather than the size it is drawn at.
///
/// Every cache that holds `Arc<RenderImage>` budgets with this instead of
/// counting entries, because a decoded cover ranges from ~360 KB (300x300) to
/// ~36 MB (3000x3000) — a hundredfold spread that makes an entry count
/// meaningless as a memory bound.
pub fn frame_bytes(image: &RenderImage) -> u64 {
    (0..image.frame_count())
        .map(|index| {
            let size = image.size(index);
            let width = u64::try_from(size.width.0).unwrap_or(0);
            let height = u64::try_from(size.height.0).unwrap_or(0);
            width * height * 4
        })
        .sum()
}
