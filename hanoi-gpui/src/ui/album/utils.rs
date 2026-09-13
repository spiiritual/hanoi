//! The pure copy helpers `album-screen.tsx` renders from, with unit tests.
//!
//! As in `home/utils.rs`, the reference's `??` (null-ish) is reproduced as an
//! `Option` test — a present-but-empty string stays an empty string — while its
//! truthiness tests (`||`, `find(t => t.grandparentTitle)`) also reject `""`.

use crate::plex::{Album, Track};

const SEPARATOR: &str = " · ";

/// `formatTrackDuration`: `m:ss`, or `--:--` for a missing or non-positive
/// duration (milliseconds).
pub fn format_track_duration(duration: Option<u64>) -> String {
    let Some(duration) = duration.filter(|duration| *duration > 0) else {
        return "--:--".to_owned();
    };
    let total_seconds = duration / 1000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes}:{seconds:02}")
}

/// `formatAlbumDuration`: `1 hr 2 min 3 sec`, dropping zero parts but never
/// returning an empty string (milliseconds).
pub fn format_album_duration(duration: u64) -> String {
    let total_seconds = duration / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    let mut parts = Vec::with_capacity(3);
    if hours > 0 {
        parts.push(format!("{hours} hr"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes} min"));
    }
    if seconds > 0 || parts.is_empty() {
        parts.push(format!("{seconds} sec"));
    }
    parts.join(" ")
}

/// `album.title || "Untitled album"`.
pub fn album_title(album: &Album) -> String {
    if album.title.is_empty() {
        "Untitled album".to_owned()
    } else {
        album.title.clone()
    }
}

/// `album?.parentTitle ?? tracks.find(t => t.grandparentTitle)?.grandparentTitle
/// ?? "Unknown artist"`.
pub fn album_artist(album: &Album, tracks: &[Track]) -> String {
    album
        .parent_title
        .clone()
        .or_else(|| {
            tracks
                .iter()
                .filter_map(|track| track.grandparent_title.as_deref())
                .find(|artist| !artist.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "Unknown artist".to_owned())
}

/// `.album-detail-meta`: `Album · 2007 · 10 songs, 42 min 34 sec`.
pub fn album_meta(album: &Album, tracks: &[Track]) -> String {
    let track_count = album
        .leaf_count
        .unwrap_or_else(|| u64::try_from(tracks.len()).unwrap_or(u64::MAX));
    let total_duration = tracks
        .iter()
        .map(|track| track.duration.unwrap_or(0))
        .fold(0_u64, u64::saturating_add);

    let mut parts = meta_prefix(album);
    parts.push(format!(
        "{}, {}",
        song_count(track_count),
        format_album_duration(total_duration)
    ));
    parts.join(SEPARATOR)
}

/// `.album-detail-meta` while the tracks are still loading (an adaptation; the
/// reference has no header yet): `Album · 2007 · 10 songs`. The duration needs
/// the tracks, so it is left out rather than shown as `0 sec`, and so is a
/// count the album does not carry.
pub fn album_meta_loading(album: &Album) -> String {
    let mut parts = meta_prefix(album);
    if let Some(track_count) = album.leaf_count {
        parts.push(song_count(track_count));
    }
    parts.join(SEPARATOR)
}

/// `Album` and the year, when there is one.
fn meta_prefix(album: &Album) -> Vec<String> {
    let mut parts = vec!["Album".to_owned()];
    if let Some(year) = album.year {
        parts.push(year.to_string());
    }
    parts
}

/// `{n} song{s}`, singular for exactly one.
fn song_count(track_count: u64) -> String {
    let plural = if track_count == 1 { "" } else { "s" };
    format!("{track_count} song{plural}")
}

#[cfg(test)]
mod tests {
    use super::{
        album_artist, album_meta, album_meta_loading, album_title, format_album_duration,
        format_track_duration,
    };
    use crate::plex::{Album, Track};

    fn album(title: &str) -> Album {
        Album {
            rating_key: "album-1".to_owned(),
            key: "/library/metadata/album-1/children".to_owned(),
            title: title.to_owned(),
            ..Album::default()
        }
    }

    fn track(rating_key: &str, duration: Option<u64>, artist: Option<&str>) -> Track {
        Track {
            rating_key: rating_key.to_owned(),
            key: format!("/library/metadata/{rating_key}"),
            title: rating_key.to_owned(),
            duration,
            grandparent_title: artist.map(str::to_owned),
            ..Track::default()
        }
    }

    #[test]
    fn track_durations_without_a_positive_length_show_a_placeholder() {
        assert_eq!(format_track_duration(None), "--:--");
        assert_eq!(format_track_duration(Some(0)), "--:--");
    }

    #[test]
    fn track_durations_floor_to_whole_seconds_and_pad_them() {
        assert_eq!(format_track_duration(Some(999)), "0:00");
        assert_eq!(format_track_duration(Some(5_999)), "0:05");
        assert_eq!(format_track_duration(Some(237_293)), "3:57");
        assert_eq!(format_track_duration(Some(600_000)), "10:00");
    }

    #[test]
    fn track_durations_never_roll_minutes_into_hours() {
        assert_eq!(format_track_duration(Some(3_725_000)), "62:05");
    }

    #[test]
    fn album_durations_are_never_empty() {
        assert_eq!(format_album_duration(0), "0 sec");
        assert_eq!(format_album_duration(999), "0 sec");
    }

    #[test]
    fn album_durations_drop_the_zero_parts() {
        assert_eq!(format_album_duration(3_600_000), "1 hr");
        assert_eq!(format_album_duration(120_000), "2 min");
        assert_eq!(format_album_duration(45_000), "45 sec");
        assert_eq!(format_album_duration(3_605_000), "1 hr 5 sec");
        assert_eq!(format_album_duration(3_720_000), "1 hr 2 min");
        assert_eq!(format_album_duration(2_554_999), "42 min 34 sec");
    }

    #[test]
    fn album_durations_name_every_nonzero_part() {
        assert_eq!(format_album_duration(3_723_000), "1 hr 2 min 3 sec");
        assert_eq!(format_album_duration(90_061_000), "25 hr 1 min 1 sec");
    }

    #[test]
    fn untitled_albums_get_a_placeholder_title() {
        assert_eq!(album_title(&album("In Rainbows")), "In Rainbows");
        assert_eq!(album_title(&album("")), "Untitled album");
    }

    #[test]
    fn the_album_artist_comes_from_the_album_first() {
        let tracks = [track("track-1", None, Some("Thom Yorke"))];
        let credited = Album {
            parent_title: Some("Radiohead".to_owned()),
            ..album("In Rainbows")
        };
        assert_eq!(album_artist(&credited, &tracks), "Radiohead");

        // `??` keeps a present-but-empty artist rather than falling through.
        let blank = Album {
            parent_title: Some(String::new()),
            ..album("In Rainbows")
        };
        assert_eq!(album_artist(&blank, &tracks), "");
    }

    #[test]
    fn the_album_artist_falls_back_to_the_first_credited_track() {
        let tracks = [
            track("track-1", None, None),
            track("track-2", None, Some("")),
            track("track-3", None, Some("Radiohead")),
            track("track-4", None, Some("Thom Yorke")),
        ];
        assert_eq!(album_artist(&album("In Rainbows"), &tracks), "Radiohead");
    }

    #[test]
    fn the_album_artist_is_unknown_without_any_credit() {
        let tracks = [
            track("track-1", None, None),
            track("track-2", None, Some("")),
        ];
        assert_eq!(
            album_artist(&album("In Rainbows"), &tracks),
            "Unknown artist"
        );
        assert_eq!(album_artist(&album("In Rainbows"), &[]), "Unknown artist");
    }

    #[test]
    fn album_meta_names_the_year_count_and_total_duration() {
        let tracks = [
            track("track-1", Some(237_000), None),
            track("track-2", Some(242_000), None),
        ];
        let dated = Album {
            year: Some(2007),
            leaf_count: Some(2),
            ..album("In Rainbows")
        };
        assert_eq!(
            album_meta(&dated, &tracks),
            "Album · 2007 · 2 songs, 7 min 59 sec"
        );
    }

    #[test]
    fn album_meta_omits_a_missing_year() {
        let tracks = [track("track-1", Some(61_000), None)];
        let undated = Album {
            leaf_count: Some(3),
            ..album("In Rainbows")
        };
        assert_eq!(
            album_meta(&undated, &tracks),
            "Album · 3 songs, 1 min 1 sec"
        );
    }

    #[test]
    fn album_meta_prefers_the_leaf_count_over_the_loaded_tracks() {
        let tracks = [track("track-1", Some(60_000), None)];
        let counted = Album {
            leaf_count: Some(0),
            ..album("In Rainbows")
        };
        assert_eq!(album_meta(&counted, &tracks), "Album · 0 songs, 1 min");

        let uncounted = album("In Rainbows");
        let three = [
            track("track-1", Some(60_000), None),
            track("track-2", Some(60_000), None),
            track("track-3", Some(60_000), None),
        ];
        assert_eq!(album_meta(&uncounted, &three), "Album · 3 songs, 3 min");
    }

    #[test]
    fn album_meta_uses_the_singular_for_one_song() {
        let tracks = [track("track-1", Some(180_000), None)];
        assert_eq!(
            album_meta(&album("Single"), &tracks),
            "Album · 1 song, 3 min"
        );
    }

    #[test]
    fn album_meta_counts_missing_durations_as_zero() {
        let tracks = [
            track("track-1", Some(90_000), None),
            track("track-2", None, None),
        ];
        assert_eq!(
            album_meta(&album("In Rainbows"), &tracks),
            "Album · 2 songs, 1 min 30 sec"
        );
        assert_eq!(album_meta(&album("Empty"), &[]), "Album · 0 songs, 0 sec");
    }

    #[test]
    fn the_loading_meta_names_the_year_and_count_without_a_duration() {
        let seeded = Album {
            year: Some(2007),
            leaf_count: Some(10),
            ..album("In Rainbows")
        };
        assert_eq!(album_meta_loading(&seeded), "Album · 2007 · 10 songs");
        assert_eq!(
            album_meta(&seeded, &[]),
            "Album · 2007 · 10 songs, 0 sec",
            "`album_meta` would claim a duration before the tracks exist"
        );

        let single = Album {
            leaf_count: Some(1),
            ..album("Single")
        };
        assert_eq!(album_meta_loading(&single), "Album · 1 song");
        let empty = Album {
            leaf_count: Some(0),
            ..album("Empty")
        };
        assert_eq!(album_meta_loading(&empty), "Album · 0 songs");
    }

    #[test]
    fn the_loading_meta_leaves_out_what_the_album_does_not_carry() {
        assert_eq!(album_meta_loading(&album("In Rainbows")), "Album");
        let dated = Album {
            year: Some(2007),
            ..album("In Rainbows")
        };
        assert_eq!(album_meta_loading(&dated), "Album · 2007");
    }
}
