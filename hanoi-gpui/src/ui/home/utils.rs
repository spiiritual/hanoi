//! `../src/mainview/home/utils.ts`, transcribed.
//!
//! The TypeScript uses `??` (null-ish) and `filter(Boolean)` (empty strings are
//! falsy), which are *not* the same test. Both are reproduced exactly: `??`
//! becomes `Option::unwrap_or_else` (an empty string stays an empty string) and
//! `filter(Boolean)` becomes a non-empty filter.

use crate::plex::{Hub, HubItem};

/// Plex Home rows are previews when they fill all six card slots.
pub const HOME_HUB_PREVIEW_SIZE: usize = 6;

/// `musicItemTypes`
const MUSIC_ITEM_TYPES: [&str; 4] = ["artist", "album", "track", "playlist"];

const SEPARATOR: &str = " · ";

/// `isMusicHomeItem`
fn is_music_home_item(item: &HubItem) -> bool {
    if !MUSIC_ITEM_TYPES.contains(&item.item_type.as_str()) {
        return false;
    }
    item.item_type != "playlist" || item.playlist_type.as_deref() != Some("video")
}

/// Keep Plex's row order while omitting non-music rows and cards.
pub fn filter_music_home_hubs(hubs: &[Hub]) -> Vec<Hub> {
    hubs.iter()
        .filter_map(|hub| {
            let items: Vec<HubItem> = hub
                .items
                .iter()
                .filter(|item| is_music_home_item(item))
                .cloned()
                .collect();
            (!items.is_empty()).then(|| Hub {
                items,
                ..hub.clone()
            })
        })
        .collect()
}

/// `HomeHubItemInteraction` — the affordance a Home card shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interaction {
    /// `.home-hub-card-track`: reveals the accent play button on hover.
    Track,
    /// `.home-hub-card-other`
    Other,
}

/// Interaction affordance shown for a Plex Home card.
pub fn home_hub_item_interaction(item: &HubItem) -> Interaction {
    if item.item_type == "track" {
        Interaction::Track
    } else {
        Interaction::Other
    }
}

/// Plex Home hubs are previews when they fill all six card slots.
pub fn should_show_home_hub_see_all(hub: &Hub) -> bool {
    hub.items.len() >= HOME_HUB_PREVIEW_SIZE
}

/// `[a, b].filter(Boolean).join(sep)` for optional, possibly empty strings.
fn join_truthy(values: [Option<&str>; 3]) -> String {
    values
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(SEPARATOR)
}

/// Text shown beneath cards in a Plex Home row.
pub fn home_hub_item_meta(item: &HubItem) -> String {
    match item.item_type.as_str() {
        "track" => {
            let byline = join_truthy([
                item.grandparent_title.as_deref(),
                item.parent_title.as_deref(),
                None,
            ]);
            if byline.is_empty() {
                "Song".to_owned()
            } else {
                byline
            }
        }
        // `item.parentTitle ?? "Unknown artist"`: a present-but-empty title
        // stays empty, exactly like the reference.
        "album" => item
            .parent_title
            .clone()
            .unwrap_or_else(|| "Unknown artist".to_owned()),
        "artist" => "Artist".to_owned(),
        "playlist" => {
            let playlist_type = match item.playlist_type.as_deref() {
                Some("audio") => Some("Playlist"),
                other => other,
            };
            let song_count = song_count(item);
            let details = join_truthy([playlist_type, song_count.as_deref(), None]);
            if details.is_empty() {
                "Playlist".to_owned()
            } else {
                details
            }
        }
        other => other.to_owned(),
    }
}

/// Text shown beneath cards on a full Plex category screen.
pub fn home_category_item_meta(item: &HubItem) -> String {
    match item.item_type.as_str() {
        "track" => join_truthy([Some("Song"), item.grandparent_title.as_deref(), None]),
        "album" => join_truthy([Some("Album"), item.parent_title.as_deref(), None]),
        "artist" => "Artist".to_owned(),
        "playlist" => {
            let playlist_type = match item.playlist_type.as_deref() {
                Some("audio") => None,
                other => other,
            };
            let song_count = song_count(item);
            join_truthy([Some("Playlist"), playlist_type, song_count.as_deref()])
        }
        other => other.to_owned(),
    }
}

/// `item.leafCount > 0 ? `${leafCount} songs` : null`
fn song_count(item: &HubItem) -> Option<String> {
    item.leaf_count
        .filter(|count| *count > 0)
        .map(|count| format!("{count} songs"))
}

#[cfg(test)]
mod tests {
    use super::{
        HOME_HUB_PREVIEW_SIZE, Interaction, filter_music_home_hubs, home_category_item_meta,
        home_hub_item_interaction, home_hub_item_meta, should_show_home_hub_see_all,
    };
    use crate::plex::{Hub, HubItem};

    fn item(rating_key: &str, title: &str, item_type: &str) -> HubItem {
        HubItem {
            rating_key: rating_key.to_owned(),
            key: format!("/library/metadata/{rating_key}"),
            title: title.to_owned(),
            item_type: item_type.to_owned(),
            ..HubItem::default()
        }
    }

    fn hub(hub_identifier: &str, items: Vec<HubItem>) -> Hub {
        Hub {
            hub_identifier: hub_identifier.to_owned(),
            items,
            ..Hub::default()
        }
    }

    #[test]
    fn see_all_shows_when_plex_returned_a_capped_six_card_preview() {
        let items: Vec<HubItem> = (0..HOME_HUB_PREVIEW_SIZE)
            .map(|index| {
                item(
                    &format!("album-{index}"),
                    &format!("Album {index}"),
                    "album",
                )
            })
            .collect();
        let full = hub("", items.clone());
        assert!(should_show_home_hub_see_all(&full));

        let short = hub("", items[..5].to_vec());
        assert!(!should_show_home_hub_see_all(&short));
    }

    #[test]
    fn album_home_cards_use_the_artist_as_their_byline() {
        let album = HubItem {
            parent_title: Some("Playboi Carti".to_owned()),
            year: Some(2023),
            ..item("album-1", "BABY BOI", "album")
        };
        assert_eq!(home_hub_item_meta(&album), "Playboi Carti");
    }

    #[test]
    fn album_home_cards_fall_back_when_plex_omits_the_artist() {
        let album = item("album-1", "Unknown album", "album");
        assert_eq!(home_hub_item_meta(&album), "Unknown artist");
    }

    #[test]
    fn track_home_cards_join_the_artist_and_album() {
        let track = HubItem {
            grandparent_title: Some("Radiohead".to_owned()),
            parent_title: Some("In Rainbows".to_owned()),
            ..item("track-1", "Nude", "track")
        };
        assert_eq!(home_hub_item_meta(&track), "Radiohead · In Rainbows");
        let bare = item("track-2", "Untitled", "track");
        assert_eq!(home_hub_item_meta(&bare), "Song");
    }

    #[test]
    fn playlist_home_cards_name_the_type_and_song_count() {
        let playlist = HubItem {
            playlist_type: Some("audio".to_owned()),
            leaf_count: Some(12),
            ..item("playlist-1", "Focus", "playlist")
        };
        assert_eq!(home_hub_item_meta(&playlist), "Playlist · 12 songs");
        let empty = HubItem {
            playlist_type: Some("audio".to_owned()),
            leaf_count: Some(0),
            ..item("playlist-2", "Empty", "playlist")
        };
        assert_eq!(home_hub_item_meta(&empty), "Playlist");
        let untyped = item("playlist-3", "Mystery", "playlist");
        assert_eq!(home_hub_item_meta(&untyped), "Playlist");
    }

    #[test]
    fn expanded_category_cards_identify_the_plex_media_type() {
        let album = HubItem {
            parent_title: Some("Artist one".to_owned()),
            ..item("album-1", "Album one", "album")
        };
        assert_eq!(home_category_item_meta(&album), "Album · Artist one");

        let track = HubItem {
            grandparent_title: Some("Artist one".to_owned()),
            parent_title: Some("Album one".to_owned()),
            ..item("track-1", "Track one", "track")
        };
        assert_eq!(home_category_item_meta(&track), "Song · Artist one");

        let artist = item("artist-1", "Artist one", "artist");
        assert_eq!(home_category_item_meta(&artist), "Artist");
    }

    #[test]
    fn expanded_category_playlists_drop_the_redundant_audio_type() {
        let audio = HubItem {
            playlist_type: Some("audio".to_owned()),
            leaf_count: Some(4),
            ..item("playlist-1", "Focus", "playlist")
        };
        assert_eq!(home_category_item_meta(&audio), "Playlist · 4 songs");
        let video = HubItem {
            playlist_type: Some("video".to_owned()),
            ..item("playlist-2", "Watch later", "playlist")
        };
        assert_eq!(home_category_item_meta(&video), "Playlist · video");
    }

    #[test]
    fn unknown_media_types_fall_through_to_the_plex_type() {
        let movie = item("movie-1", "A Movie", "movie");
        assert_eq!(home_hub_item_meta(&movie), "movie");
        assert_eq!(home_category_item_meta(&movie), "movie");
    }

    #[test]
    fn home_cards_expose_the_track_hover_state_only_for_tracks() {
        assert_eq!(
            home_hub_item_interaction(&item("track-1", "Track one", "track")),
            Interaction::Track
        );
        for item_type in ["album", "artist", "playlist"] {
            assert_eq!(
                home_hub_item_interaction(&item("id", "Title", item_type)),
                Interaction::Other,
                "{item_type} must use the shared non-track hover state"
            );
        }
    }

    #[test]
    fn home_rows_keep_plex_order_and_exclude_hubs_without_music_metadata() {
        let movie_hub = hub(
            "movie.recentlyadded",
            vec![item("movie-1", "A Movie", "movie")],
        );
        let recently_added = hub(
            "home.music.recent.added",
            vec![item("album-2", "Kid A", "album")],
        );
        let mixed = hub(
            "home.mixed",
            vec![
                item("album-1", "In Rainbows", "album"),
                item("movie-1", "A Movie", "movie"),
                HubItem {
                    playlist_type: Some("video".to_owned()),
                    ..item("playlist-1", "Watch Later", "playlist")
                },
            ],
        );

        let filtered = filter_music_home_hubs(&[movie_hub, recently_added, mixed]);
        let identifiers: Vec<&str> = filtered
            .iter()
            .map(|hub| hub.hub_identifier.as_str())
            .collect();
        assert_eq!(identifiers, ["home.music.recent.added", "home.mixed"]);
        let types: Vec<&str> = filtered[1]
            .items
            .iter()
            .map(|item| item.item_type.as_str())
            .collect();
        assert_eq!(types, ["album"]);
    }

    #[test]
    fn audio_playlists_survive_the_music_filter() {
        let playlists = hub(
            "home.playlists",
            vec![HubItem {
                playlist_type: Some("audio".to_owned()),
                ..item("playlist-1", "Focus", "playlist")
            }],
        );
        assert_eq!(filter_music_home_hubs(&[playlists]).len(), 1);
    }
}
