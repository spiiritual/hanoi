//! Library browsing behind the album screens.
//!
//! Mirrors the album half of `../../src/bun/plex/client.ts` — `getAlbums`
//! (`buildBrowsePath` + `parseItems` with `albumSchema`) and `getAlbum`
//! (`parseMetadata` + the `/children` track list) — plus the fan-out
//! `AlbumLibrary` runs in `../../src/mainview/album/album-screen.tsx`
//! (`Promise.all` over the music sections, de-duplicated by `ratingKey`).
//! Every function is blocking (`ureq`); the UI calls them from
//! `cx.background_spawn`.
//!
//! CONTRACT: the `pub` items below are what `src/ui/album/` codes against.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::thread;

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use super::ServerConfig;
use super::hubs::{HubItem, Section, joined, lenient_u32, lenient_u64, parse_container, request};

/// The sort `AlbumLibrary` browses every section with: newest additions first.
pub const RECENTLY_ADDED_SORT: &str = "addedAt:desc";

/// The Plex media type `getAlbums` passes to `buildBrowsePath` (9 = album).
const ALBUM_MEDIA_TYPE: u8 = 9;

/// `albumSchema`: `key`, `ratingKey`, `title` and `type == "album"` are
/// required, everything else is optional.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Album {
    pub rating_key: String,
    pub key: String,
    pub title: String,
    /// The album artist.
    pub parent_title: Option<String>,
    pub parent_rating_key: Option<String>,
    pub thumb: Option<String>,
    pub year: Option<u32>,
    /// The album's track count.
    pub leaf_count: Option<u64>,
    pub view_count: Option<u64>,
}

impl Album {
    /// `AlbumLibrary` hands each `PlexAlbum` straight to `MediaCard` as a hub
    /// item: the same fields, `type: "album"`.
    pub fn to_hub_item(&self) -> HubItem {
        HubItem {
            rating_key: self.rating_key.clone(),
            key: self.key.clone(),
            title: self.title.clone(),
            item_type: "album".to_owned(),
            thumb: self.thumb.clone(),
            parent_title: self.parent_title.clone(),
            parent_rating_key: self.parent_rating_key.clone(),
            year: self.year,
            leaf_count: self.leaf_count,
            view_count: self.view_count,
            ..HubItem::default()
        }
    }

    /// The inverse of [`Album::to_hub_item`]: the album a clicked album card
    /// already describes. The detail screen renders its header from this while
    /// `getAlbum` is in flight. Hub-only fields (`composite`, `art`, the
    /// grandparent, `duration`, …) have no album counterpart and are dropped.
    pub fn from_hub_item(item: &HubItem) -> Self {
        Self {
            rating_key: item.rating_key.clone(),
            key: item.key.clone(),
            title: item.title.clone(),
            parent_title: item.parent_title.clone(),
            parent_rating_key: item.parent_rating_key.clone(),
            thumb: item.thumb.clone(),
            year: item.year,
            leaf_count: item.leaf_count,
            view_count: item.view_count,
        }
    }
}

/// `trackSchema`: `key`, `ratingKey`, `title` and `type == "track"` are
/// required, everything else is optional.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Track {
    pub rating_key: String,
    pub key: String,
    pub title: String,
    /// The track number on its disc.
    pub index: Option<u64>,
    /// Milliseconds.
    pub duration: Option<u64>,
    /// The album.
    pub parent_title: Option<String>,
    /// The track artist.
    pub grandparent_title: Option<String>,
    pub parent_rating_key: Option<String>,
    pub grandparent_rating_key: Option<String>,
    pub thumb: Option<String>,
    pub view_count: Option<u64>,
}

/// `PlexClient.getAlbum` — the album plus its tracks in Plex's order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AlbumDetail {
    pub album: Album,
    pub tracks: Vec<Track>,
}

/// `PlexClient.getAlbums(sectionKey, { sort })`:
/// `GET /library/sections/{key}/all?type=9[&sort=..]`, the query string encoded
/// exactly as `URLSearchParams` does (`addedAt:desc` -> `addedAt%3Adesc`).
pub fn get_albums(
    server: &ServerConfig,
    section_key: &str,
    sort: Option<&str>,
) -> Result<Vec<Album>> {
    let path = browse_path(section_key, ALBUM_MEDIA_TYPE, sort);
    let payload = request(server, &path)?;
    Ok(parse_container::<AlbumWire, _>(&payload, "Metadata", &path))
}

/// `PlexClient.getAlbum(ratingKey)`.
pub fn get_album(server: &ServerConfig, rating_key: &str) -> Result<AlbumDetail> {
    let metadata_path = format!("/library/metadata/{rating_key}");
    let children_path = format!("{metadata_path}/children");
    // The reference awaits the two requests one after the other; neither
    // depends on the other, so they run side by side and either failure still
    // fails the call.
    let (album, tracks) = thread::scope(|scope| {
        let album = scope.spawn(|| {
            request(server, &metadata_path).map(|payload| metadata_album(&payload, &metadata_path))
        });
        let tracks = scope.spawn(|| {
            request(server, &children_path).map(|payload| {
                parse_container::<TrackWire, Track>(&payload, "Metadata", &children_path)
            })
        });
        (joined(album), joined(tracks))
    });
    Ok(album_detail(rating_key, album?, tracks?))
}

/// `AlbumLibrary`'s load: every section's albums sorted by
/// [`RECENTLY_ADDED_SORT`], fetched in parallel, merged the way its
/// `Map<ratingKey, PlexAlbum>` merges them. Any failed section fails the whole
/// load, like `Promise.all`.
pub fn get_library_albums(server: &ServerConfig, sections: &[Section]) -> Result<Vec<Album>> {
    // `AlbumLibrary` never starts a load without sections.
    if sections.is_empty() {
        return Ok(Vec::new());
    }
    let results = thread::scope(|scope| {
        let handles: Vec<_> = sections
            .iter()
            .map(|section| {
                scope.spawn(move || get_albums(server, &section.key, Some(RECENTLY_ADDED_SORT)))
            })
            .collect();
        handles
            .into_iter()
            .map(joined)
            .collect::<Result<Vec<Vec<Album>>>>()
    });
    Ok(merge_albums(results?))
}

/// `PlexClient.buildBrowsePath(sectionKey, type, { sort })`. The section key is
/// interpolated as-is, the query goes through `URLSearchParams` (`type` first,
/// then `sort` unless it is absent or empty).
fn browse_path(section_key: &str, media_type: u8, sort: Option<&str>) -> String {
    let mut query = format!("type={media_type}");
    if let Some(sort) = sort.filter(|sort| !sort.is_empty()) {
        query.push_str("&sort=");
        query.push_str(&form_urlencoded(sort));
    }
    format!("/library/sections/{section_key}/all?{query}")
}

/// `URLSearchParams.toString()` for one value (the
/// `application/x-www-form-urlencoded` serializer): unreserved characters pass
/// through, a space becomes `+`, everything else is percent-encoded from its
/// UTF-8 bytes.
fn form_urlencoded(value: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                encoded.push(char::from(byte));
            }
            b' ' => encoded.push('+'),
            other => {
                // Writing into a String cannot fail.
                let _ = write!(encoded, "%{other:02X}");
            }
        }
    }
    encoded
}

/// `parseMetadata` followed by `getAlbum`'s `items.find(type === "album")`:
/// the first item's `type` picks the schema, so the items are validated as
/// albums only when that sample is an album, and the album is the first item
/// that validates. Any other sample means there is no album.
fn metadata_album(payload: &Value, path: &str) -> Option<Album> {
    let Some(container) = payload
        .get("MediaContainer")
        .filter(|value| value.is_object())
    else {
        log::error!("Plex response failed validation ({path}): no MediaContainer object");
        return None;
    };
    let sample_type = container
        .get("Metadata")
        .and_then(|items| items.get(0))
        .and_then(|sample| sample.get("type"));
    if sample_type.and_then(Value::as_str) != Some("album") {
        let described = sample_type.map_or_else(|| "no item type".to_owned(), Value::to_string);
        log::warn!("Plex metadata for {path} is not an album ({described})");
        return None;
    }
    parse_container::<AlbumWire, Album>(payload, "Metadata", path)
        .into_iter()
        .next()
}

/// `getAlbum`'s return value: the album, or the reference's placeholder
/// `{ key: "", ratingKey, title: "", type: "album" }` when the metadata did not
/// yield one. `tracks.filter(type === "track")` is already guaranteed by
/// [`TrackWire`].
fn album_detail(rating_key: &str, album: Option<Album>, tracks: Vec<Track>) -> AlbumDetail {
    AlbumDetail {
        album: album.unwrap_or_else(|| Album {
            rating_key: rating_key.to_owned(),
            ..Album::default()
        }),
        tracks,
    }
}

/// `AlbumLibrary`'s `Map<ratingKey, PlexAlbum>`: `Map.set` on an existing key
/// replaces the value in place, so the order is that of each rating key's
/// first occurrence and the album is its last occurrence.
fn merge_albums(results: impl IntoIterator<Item = Vec<Album>>) -> Vec<Album> {
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<Album> = Vec::new();
    for album in results.into_iter().flatten() {
        match positions.entry(album.rating_key.clone()) {
            Entry::Occupied(position) => merged[*position.get()] = album,
            Entry::Vacant(position) => {
                position.insert(merged.len());
                merged.push(album);
            }
        }
    }
    merged
}

/// `z.literal("album")`: any other `type` (or none) fails the item, which
/// `parse_container` then drops with a log line.
#[derive(Debug, Deserialize)]
enum AlbumType {
    #[serde(rename = "album")]
    Album,
}

/// `z.literal("track")`.
#[derive(Debug, Deserialize)]
enum TrackType {
    #[serde(rename = "track")]
    Track,
}

/// `albumSchema`: `key`, `ratingKey`, `title` and the `type` literal are
/// required, every other field is optional (unknown fields are tolerated, like
/// `z.looseObject`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlbumWire {
    rating_key: String,
    key: String,
    title: String,
    /// Validated, never read.
    #[serde(rename = "type")]
    _type: AlbumType,
    #[serde(default)]
    parent_title: Option<String>,
    #[serde(default)]
    parent_rating_key: Option<String>,
    #[serde(default)]
    thumb: Option<String>,
    #[serde(default, deserialize_with = "lenient_u32")]
    year: Option<u32>,
    #[serde(default, deserialize_with = "lenient_u64")]
    leaf_count: Option<u64>,
    #[serde(default, deserialize_with = "lenient_u64")]
    view_count: Option<u64>,
}

impl From<AlbumWire> for Album {
    fn from(wire: AlbumWire) -> Self {
        Self {
            rating_key: wire.rating_key,
            key: wire.key,
            title: wire.title,
            parent_title: wire.parent_title,
            parent_rating_key: wire.parent_rating_key,
            thumb: wire.thumb,
            year: wire.year,
            leaf_count: wire.leaf_count,
            view_count: wire.view_count,
        }
    }
}

/// `trackSchema`: `key`, `ratingKey`, `title` and the `type` literal are
/// required, every other field is optional.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackWire {
    rating_key: String,
    key: String,
    title: String,
    /// Validated, never read.
    #[serde(rename = "type")]
    _type: TrackType,
    #[serde(default, deserialize_with = "lenient_u64")]
    index: Option<u64>,
    #[serde(default, deserialize_with = "lenient_u64")]
    duration: Option<u64>,
    #[serde(default)]
    parent_title: Option<String>,
    #[serde(default)]
    grandparent_title: Option<String>,
    #[serde(default)]
    parent_rating_key: Option<String>,
    #[serde(default)]
    grandparent_rating_key: Option<String>,
    #[serde(default)]
    thumb: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    view_count: Option<u64>,
    /// `Media: z.array(mediaSchema).optional()` — not part of [`Track`] yet,
    /// but a malformed `Media` still fails the item as it does in the reference.
    #[serde(rename = "Media", default)]
    _media: Option<Vec<MediaWire>>,
}

impl From<TrackWire> for Track {
    fn from(wire: TrackWire) -> Self {
        Self {
            rating_key: wire.rating_key,
            key: wire.key,
            title: wire.title,
            index: wire.index,
            duration: wire.duration,
            parent_title: wire.parent_title,
            grandparent_title: wire.grandparent_title,
            parent_rating_key: wire.parent_rating_key,
            grandparent_rating_key: wire.grandparent_rating_key,
            thumb: wire.thumb,
            view_count: wire.view_count,
        }
    }
}

/// `mediaSchema`: `Part` is a required array.
#[derive(Debug, Deserialize)]
struct MediaWire {
    #[serde(rename = "Part")]
    _part: Vec<PartWire>,
}

/// `partSchema`: `key` is an optional string.
#[derive(Debug, Deserialize)]
struct PartWire {
    #[serde(rename = "key", default)]
    _key: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        Album, AlbumDetail, AlbumWire, RECENTLY_ADDED_SORT, Track, TrackWire, album_detail,
        browse_path, form_urlencoded, merge_albums, metadata_album, parse_container,
    };
    use crate::plex::{HubItem, Section, ServerConfig};

    fn albums(payload: &serde_json::Value) -> Vec<Album> {
        parse_container::<AlbumWire, Album>(payload, "Metadata", "/library/sections/1/all")
    }

    fn tracks(payload: &serde_json::Value) -> Vec<Track> {
        parse_container::<TrackWire, Track>(payload, "Metadata", "/library/metadata/1/children")
    }

    fn album(rating_key: &str, title: &str) -> Album {
        Album {
            rating_key: rating_key.to_owned(),
            key: format!("/library/metadata/{rating_key}/children"),
            title: title.to_owned(),
            ..Album::default()
        }
    }

    fn rating_keys(albums: &[Album]) -> Vec<&str> {
        albums
            .iter()
            .map(|album| album.rating_key.as_str())
            .collect()
    }

    /// A server whose URL cannot even be parsed, so any request fails at once
    /// without touching the network.
    fn unreachable_server() -> ServerConfig {
        ServerConfig {
            client_identifier: None,
            name: "Nowhere".to_owned(),
            url: "not a url".to_owned(),
            token: "unused".to_owned(),
        }
    }

    #[test]
    fn albums_parse_with_every_album_field() {
        let parsed = albums(&json!({
            "MediaContainer": {
                "size": 1,
                "Metadata": [{
                    "ratingKey": "101",
                    "key": "/library/metadata/101/children",
                    "title": "Blue Weather",
                    "type": "album",
                    "parentTitle": "Nova",
                    "parentRatingKey": "55",
                    "thumb": "/library/metadata/101/thumb/1",
                    "year": 2019,
                    "leafCount": 7,
                    "viewCount": 6,
                    "addedAt": 1_735_689_600,
                    "Genre": [{ "tag": "Ambient" }]
                }]
            }
        }));
        assert_eq!(
            parsed,
            vec![Album {
                rating_key: "101".to_owned(),
                key: "/library/metadata/101/children".to_owned(),
                title: "Blue Weather".to_owned(),
                parent_title: Some("Nova".to_owned()),
                parent_rating_key: Some("55".to_owned()),
                thumb: Some("/library/metadata/101/thumb/1".to_owned()),
                year: Some(2019),
                leaf_count: Some(7),
                view_count: Some(6),
            }]
        );
    }

    #[test]
    fn albums_missing_a_required_field_or_the_album_type_are_dropped() {
        let parsed = albums(&json!({
            "MediaContainer": {
                "Metadata": [
                    { "ratingKey": "1", "key": "/k/1", "title": "Keep", "type": "album" },
                    { "key": "/k/2", "title": "No rating key", "type": "album" },
                    { "ratingKey": "3", "title": "No key", "type": "album" },
                    { "ratingKey": "4", "key": "/k/4", "type": "album" },
                    { "ratingKey": "5", "key": "/k/5", "title": "No type" },
                    { "ratingKey": "6", "key": "/k/6", "title": "A track", "type": "track" },
                    { "ratingKey": "7", "key": "/k/7", "title": "Numeric key", "type": "album", "year": "2019" },
                    { "ratingKey": "8", "key": "/k/8", "title": "Also kept", "type": "album" }
                ]
            }
        }));
        assert_eq!(
            rating_keys(&parsed),
            vec!["1", "8"],
            "only the valid albums survive"
        );
        assert_eq!(
            parsed[0],
            Album {
                key: "/k/1".to_owned(),
                ..album("1", "Keep")
            },
            "absent optional fields stay `None`"
        );
    }

    #[test]
    fn float_numbers_do_not_drop_an_album_or_a_track() {
        // `z.number()` accepts `2019.0`; serde's integers would not.
        let parsed = albums(&json!({
            "MediaContainer": {
                "Metadata": [{
                    "ratingKey": "1", "key": "/k/1", "title": "T", "type": "album",
                    "year": 2019.0, "leafCount": 12.0, "viewCount": 3.0
                }]
            }
        }));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].year, Some(2019));
        assert_eq!(parsed[0].leaf_count, Some(12));
        assert_eq!(parsed[0].view_count, Some(3));

        let parsed = tracks(&json!({
            "MediaContainer": {
                "Metadata": [{
                    "ratingKey": "2", "key": "/k/2", "title": "T", "type": "track",
                    "index": 4.0, "duration": 214_000.0, "viewCount": 1.0
                }]
            }
        }));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].index, Some(4));
        assert_eq!(parsed[0].duration, Some(214_000));
        assert_eq!(parsed[0].view_count, Some(1));
    }

    #[test]
    fn tracks_parse_in_plex_order_and_non_tracks_are_dropped() {
        let parsed = tracks(&json!({
            "MediaContainer": {
                "Metadata": [
                    {
                        "ratingKey": "201",
                        "key": "/library/metadata/201",
                        "title": "Low Tide",
                        "type": "track",
                        "index": 1,
                        "duration": 214_000,
                        "parentTitle": "Blue Weather",
                        "grandparentTitle": "Nova",
                        "parentRatingKey": "101",
                        "grandparentRatingKey": "55",
                        "thumb": "/library/metadata/101/thumb/1",
                        "viewCount": 9,
                        "Media": [{ "id": 1, "Part": [{ "key": "/library/parts/1/file.flac" }] }]
                    },
                    { "ratingKey": "101", "key": "/k/101", "title": "An album", "type": "album" },
                    { "ratingKey": "203", "key": "/k/203", "title": "No type" },
                    { "ratingKey": "202", "key": "/k/202", "title": "Undertow", "type": "track" }
                ]
            }
        }));
        assert_eq!(
            parsed,
            vec![
                Track {
                    rating_key: "201".to_owned(),
                    key: "/library/metadata/201".to_owned(),
                    title: "Low Tide".to_owned(),
                    index: Some(1),
                    duration: Some(214_000),
                    parent_title: Some("Blue Weather".to_owned()),
                    grandparent_title: Some("Nova".to_owned()),
                    parent_rating_key: Some("101".to_owned()),
                    grandparent_rating_key: Some("55".to_owned()),
                    thumb: Some("/library/metadata/101/thumb/1".to_owned()),
                    view_count: Some(9),
                },
                Track {
                    rating_key: "202".to_owned(),
                    key: "/k/202".to_owned(),
                    title: "Undertow".to_owned(),
                    ..Track::default()
                },
            ]
        );
    }

    #[test]
    fn a_track_with_malformed_media_is_dropped_like_track_schema_does() {
        let parsed = tracks(&json!({
            "MediaContainer": {
                "Metadata": [
                    { "ratingKey": "1", "key": "/k/1", "title": "No Part", "type": "track", "Media": [{}] },
                    { "ratingKey": "2", "key": "/k/2", "title": "Bad part key", "type": "track",
                      "Media": [{ "Part": [{ "key": 7 }] }] },
                    { "ratingKey": "3", "key": "/k/3", "title": "Empty media", "type": "track", "Media": [] },
                    { "ratingKey": "4", "key": "/k/4", "title": "Keyless part", "type": "track",
                      "Media": [{ "Part": [{}] }] }
                ]
            }
        }));
        let kept: Vec<&str> = parsed
            .iter()
            .map(|track| track.rating_key.as_str())
            .collect();
        assert_eq!(kept, vec!["3", "4"]);
    }

    #[test]
    fn the_browse_path_encodes_its_query_like_url_search_params() {
        assert_eq!(
            browse_path("1", 9, Some(RECENTLY_ADDED_SORT)),
            "/library/sections/1/all?type=9&sort=addedAt%3Adesc"
        );
        assert_eq!(
            browse_path("12", 9, None),
            "/library/sections/12/all?type=9"
        );
        assert_eq!(
            browse_path("12", 9, Some("")),
            "/library/sections/12/all?type=9",
            "an empty sort is omitted"
        );
        assert_eq!(
            browse_path("3", 9, Some("titleSort:asc,year")),
            "/library/sections/3/all?type=9&sort=titleSort%3Aasc%2Cyear"
        );
    }

    #[test]
    fn form_urlencoding_matches_the_url_search_params_serializer() {
        assert_eq!(form_urlencoded("AZaz09*-._"), "AZaz09*-._");
        assert_eq!(form_urlencoded("a b"), "a+b");
        assert_eq!(
            form_urlencoded("~!'()/?&=+%"),
            "%7E%21%27%28%29%2F%3F%26%3D%2B%25"
        );
        assert_eq!(form_urlencoded("é"), "%C3%A9");
    }

    #[test]
    fn metadata_is_an_album_only_when_its_first_item_is_one() {
        let path = "/library/metadata/101";
        let payload = |items: serde_json::Value| json!({ "MediaContainer": { "Metadata": items } });

        let found = metadata_album(
            &payload(json!([
                { "ratingKey": "101", "key": "/k/101", "title": "First", "type": "album" },
                { "ratingKey": "102", "key": "/k/102", "title": "Second", "type": "album" }
            ])),
            path,
        );
        assert_eq!(found.map(|album| album.title), Some("First".to_owned()));

        let found = metadata_album(
            &payload(json!([
                { "ratingKey": "101", "type": "album" },
                { "ratingKey": "102", "key": "/k/102", "title": "First valid", "type": "album" }
            ])),
            path,
        );
        assert_eq!(
            found.map(|album| album.title),
            Some("First valid".to_owned()),
            "an invalid album sample still selects the album schema"
        );

        for items in [
            json!([
                { "ratingKey": "55", "key": "/k/55", "title": "Nova", "type": "artist" },
                { "ratingKey": "101", "key": "/k/101", "title": "Later", "type": "album" }
            ]),
            json!([
                { "ratingKey": "1", "key": "/k/1", "title": "Untyped" },
                { "ratingKey": "101", "key": "/k/101", "title": "Later", "type": "album" }
            ]),
            json!([{ "ratingKey": "101", "key": "/k/101", "title": "Numeric", "type": 9 }]),
            json!([]),
        ] {
            assert_eq!(
                metadata_album(&payload(items.clone()), path),
                None,
                "{items}"
            );
        }
        assert_eq!(metadata_album(&json!({ "MediaContainer": {} }), path), None);
        assert_eq!(metadata_album(&json!({}), path), None);
    }

    #[test]
    fn a_missing_album_becomes_the_reference_placeholder() {
        let tracks = vec![Track {
            rating_key: "201".to_owned(),
            key: "/k/201".to_owned(),
            title: "Low Tide".to_owned(),
            ..Track::default()
        }];
        assert_eq!(
            album_detail("101", None, tracks.clone()),
            AlbumDetail {
                album: Album {
                    rating_key: "101".to_owned(),
                    key: String::new(),
                    title: String::new(),
                    ..Album::default()
                },
                tracks: tracks.clone(),
            }
        );
        let found = album("101", "Blue Weather");
        assert_eq!(
            album_detail("999", Some(found.clone()), tracks.clone()),
            AlbumDetail {
                album: found,
                tracks
            },
            "a found album is kept as-is, whatever key was asked for"
        );
    }

    #[test]
    fn merged_albums_keep_first_occurrence_order_with_last_occurrence_values() {
        let merged = merge_albums(vec![
            vec![album("1", "one (a)"), album("2", "two (a)")],
            vec![],
            vec![album("3", "three"), album("1", "one (b)")],
            vec![
                album("2", "two (b)"),
                album("4", "four"),
                album("1", "one (c)"),
            ],
        ]);
        let order: Vec<(&str, &str)> = merged
            .iter()
            .map(|album| (album.rating_key.as_str(), album.title.as_str()))
            .collect();
        assert_eq!(
            order,
            vec![
                ("1", "one (c)"),
                ("2", "two (b)"),
                ("3", "three"),
                ("4", "four")
            ]
        );
        assert!(merge_albums(Vec::<Vec<Album>>::new()).is_empty());
    }

    #[test]
    fn no_sections_load_no_albums_without_a_request() {
        // Any request against this server would fail, so `Ok` proves none ran.
        assert_eq!(
            super::get_library_albums(&unreachable_server(), &[]).expect("no request"),
            Vec::<Album>::new()
        );
    }

    #[test]
    fn a_failing_section_fails_the_whole_library_load() {
        let sections = [Section {
            key: "1".to_owned(),
            title: "Music".to_owned(),
            section_type: "artist".to_owned(),
        }];
        let error = super::get_library_albums(&unreachable_server(), &sections)
            .expect_err("the section request cannot succeed");
        assert!(
            error
                .to_string()
                .ends_with(" for /library/sections/1/all?type=9&sort=addedAt%3Adesc"),
            "{error}"
        );
    }

    #[test]
    fn an_album_becomes_the_hub_item_its_card_renders() {
        let source = Album {
            rating_key: "101".to_owned(),
            key: "/library/metadata/101/children".to_owned(),
            title: "Blue Weather".to_owned(),
            parent_title: Some("Nova".to_owned()),
            parent_rating_key: Some("55".to_owned()),
            thumb: Some("/library/metadata/101/thumb/1".to_owned()),
            year: Some(2019),
            leaf_count: Some(7),
            view_count: Some(6),
        };
        assert_eq!(
            source.to_hub_item(),
            HubItem {
                rating_key: "101".to_owned(),
                key: "/library/metadata/101/children".to_owned(),
                title: "Blue Weather".to_owned(),
                item_type: "album".to_owned(),
                thumb: Some("/library/metadata/101/thumb/1".to_owned()),
                parent_title: Some("Nova".to_owned()),
                parent_rating_key: Some("55".to_owned()),
                year: Some(2019),
                leaf_count: Some(7),
                view_count: Some(6),
                ..HubItem::default()
            }
        );
    }

    #[test]
    fn an_album_card_hub_item_becomes_the_album_it_describes() {
        let item = HubItem {
            rating_key: "101".to_owned(),
            key: "/library/metadata/101/children".to_owned(),
            title: "Blue Weather".to_owned(),
            item_type: "album".to_owned(),
            thumb: Some("/library/metadata/101/thumb/1".to_owned()),
            composite: Some("/composite/101".to_owned()),
            art: Some("/library/metadata/101/art/1".to_owned()),
            parent_title: Some("Nova".to_owned()),
            grandparent_title: Some("Ignored".to_owned()),
            parent_rating_key: Some("55".to_owned()),
            year: Some(2019),
            leaf_count: Some(7),
            view_count: Some(6),
            duration: Some(2_554_999),
            ..HubItem::default()
        };
        let album = Album::from_hub_item(&item);
        assert_eq!(
            album,
            Album {
                rating_key: "101".to_owned(),
                key: "/library/metadata/101/children".to_owned(),
                title: "Blue Weather".to_owned(),
                parent_title: Some("Nova".to_owned()),
                parent_rating_key: Some("55".to_owned()),
                thumb: Some("/library/metadata/101/thumb/1".to_owned()),
                year: Some(2019),
                leaf_count: Some(7),
                view_count: Some(6),
            }
        );

        // Round trip: every field `to_hub_item` writes comes back unchanged.
        assert_eq!(Album::from_hub_item(&album.to_hub_item()), album);
        assert_eq!(
            Album::from_hub_item(&HubItem::default()),
            Album::default(),
            "absent optional fields stay `None`"
        );
    }

    /// A live smoke test against the signed-in server:
    /// `cargo test live_library -- --ignored --nocapture`.
    #[test]
    #[ignore = "requires a signed-in config and a reachable Plex server"]
    fn live_library_albums_and_an_album_load_from_the_configured_server() {
        let config = crate::plex::load_config().expect("sign in first: no plex-config.json");
        let server = config.server.expect("no server selected in the config");
        let sections = crate::plex::get_music_sections(&server).expect("music sections");
        println!("{} music section(s)", sections.len());
        let library = super::get_library_albums(&server, &sections).expect("library albums");
        println!("{} album(s) in the library", library.len());
        for album in library.iter().take(5) {
            println!(
                "  {} — {} (year {:?}, leafCount {:?}, thumb {})",
                album.title,
                album.parent_title.as_deref().unwrap_or("?"),
                album.year,
                album.leaf_count,
                album.thumb.is_some()
            );
        }
        let first = library.first().expect("the library has no albums");
        let detail = super::get_album(&server, &first.rating_key).expect("album detail");
        println!(
            "first album: {} by {} (year {:?}, leafCount {:?}) -> {} track(s)",
            detail.album.title,
            detail.album.parent_title.as_deref().unwrap_or("?"),
            detail.album.year,
            detail.album.leaf_count,
            detail.tracks.len()
        );
        for track in detail.tracks.iter().take(5) {
            println!(
                "  {:?}. {} ({:?} ms)",
                track.index, track.title, track.duration
            );
        }
        assert_eq!(detail.album.rating_key, first.rating_key);
        assert!(
            !detail.album.key.is_empty(),
            "the album resolved to the placeholder"
        );
    }
}
