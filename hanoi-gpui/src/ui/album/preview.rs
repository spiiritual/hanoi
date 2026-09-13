//! Sample album details for the `album*` `HANOI_PREVIEW` stages. No artwork
//! paths, so the cover exercises its fallback glyph.

use crate::plex::{Album, AlbumDetail, HubItem, Track};

/// The rating key every detail preview opens.
pub const SAMPLE_RATING_KEY: &str = "album-1";

/// The album artist's rating key, shared by the album and its tracks.
const SAMPLE_ARTIST_RATING_KEY: &str = "artist-1";
const SAMPLE_ARTIST: &str = "Radiohead";
const SAMPLE_TITLE: &str = "In Rainbows";

/// A ready album with enough tracks to scroll, one title long enough to
/// ellipsize and one track without a duration (`--:--`).
pub fn sample_detail() -> AlbumDetail {
    let tracks = [
        ("15 Step", Some(237_293)),
        ("Bodysnatchers", Some(242_040)),
        ("Nude", Some(255_374)),
        ("Weird Fishes / Arpeggi", Some(318_186)),
        ("All I Need", Some(228_760)),
        // Plex omits `duration` for a track it has not analysed yet.
        ("Faust Arp", None),
        ("Reckoner", Some(290_213)),
        ("House of Cards", Some(328_293)),
        // Wider than the title column at 1200px, so the row ellipsizes.
        (
            "Jigsaw Falling into Place (Live from the Basement, Maida Vale Studios, London, \
             recorded for the In Rainbows webcast, December 2007)",
            Some(249_120),
        ),
        ("Videotape", Some(279_613)),
    ]
    .into_iter()
    .zip(1_u64..)
    .map(|((title, duration), index)| track(index, title, duration))
    .collect();

    AlbumDetail {
        album: sample_album(Some(10)),
        tracks,
    }
}

/// The album card that opens [`sample_detail`]'s album, as the Albums grid
/// would render it: what the detail previews seed their navigation with.
pub fn sample_card() -> HubItem {
    sample_album(Some(10)).to_hub_item()
}

/// The same album with no tracks: the empty list and a disabled Play button.
pub fn sample_empty_detail() -> AlbumDetail {
    AlbumDetail {
        album: sample_album(None),
        tracks: Vec::new(),
    }
}

fn sample_album(leaf_count: Option<u64>) -> Album {
    Album {
        rating_key: SAMPLE_RATING_KEY.to_owned(),
        key: format!("/library/metadata/{SAMPLE_RATING_KEY}/children"),
        title: SAMPLE_TITLE.to_owned(),
        parent_title: Some(SAMPLE_ARTIST.to_owned()),
        parent_rating_key: Some(SAMPLE_ARTIST_RATING_KEY.to_owned()),
        thumb: None,
        year: Some(2007),
        leaf_count,
        view_count: Some(12),
    }
}

fn track(index: u64, title: &str, duration: Option<u64>) -> Track {
    let rating_key = format!("track-{index}");
    Track {
        key: format!("/library/metadata/{rating_key}"),
        rating_key,
        title: title.to_owned(),
        index: Some(index),
        duration,
        parent_title: Some(SAMPLE_TITLE.to_owned()),
        grandparent_title: Some(SAMPLE_ARTIST.to_owned()),
        parent_rating_key: Some(SAMPLE_RATING_KEY.to_owned()),
        grandparent_rating_key: Some(SAMPLE_ARTIST_RATING_KEY.to_owned()),
        thumb: None,
        view_count: None,
    }
}
