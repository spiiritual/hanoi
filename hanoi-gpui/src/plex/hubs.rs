//! Plex Home hubs: the rows the home screen is built from.
//!
//! Mirrors the hub half of `../../src/bun/plex/client.ts` (`getHomeHubs`,
//! `getSectionHubs`, `getHomeHubItems`, `getMusicSections`,
//! `getRecentlyPlayed`, `composeHomeHubs`, `replaceRecentlyPlayedPreview`).
//! Every function is blocking (`ureq`); the UI calls them from
//! `cx.background_spawn`.

use std::collections::HashSet;
use std::thread;

use anyhow::{Result, anyhow};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use super::ServerConfig;
use super::http::{media_agent, request_error};

/// `RECENTLY_PLAYED_HUB_PREFIX` in `client.ts`: the artist-only hub Plex ships
/// that the mixed activity preview replaces.
const RECENTLY_PLAYED_HUB_PREFIX: &str = "music.recent.played.";

/// Plex media types used by the recently-played queries (8 = artist,
/// 9 = album, 10 = track), in the order `getRecentlyPlayedForSections`
/// concatenates them.
const RECENTLY_PLAYED_TYPES: [u8; 3] = [8, 9, 10];

/// A hub payload for a large library is far bigger than ureq's 10 MB default
/// body cap (a `/library/sections/{key}/all` response grows with the library),
/// and hitting the cap would look like a corrupt payload.
const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024;

/// Plex's `MediaContainer.Hub[]` entry: one Home row.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Hub {
    /// `hub.title`; empty when Plex omits it.
    pub title: String,
    /// `hub.hubIdentifier`; empty when Plex omits it.
    pub hub_identifier: String,
    /// `hub.key` — the full-data endpoint behind "See all"; empty when absent.
    pub key: String,
    pub context: String,
    /// `hub.type`.
    pub hub_type: String,
    pub size: Option<u64>,
    pub total_size: Option<u64>,
    /// `hub.Metadata`.
    pub items: Vec<HubItem>,
}

/// One card inside a Home row (`hubItemSchema`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HubItem {
    pub rating_key: String,
    pub key: String,
    pub title: String,
    /// `artist` | `album` | `track` | `playlist` | anything else Plex sends.
    pub item_type: String,
    pub thumb: Option<String>,
    pub composite: Option<String>,
    pub art: Option<String>,
    pub parent_title: Option<String>,
    pub grandparent_title: Option<String>,
    pub parent_rating_key: Option<String>,
    pub grandparent_rating_key: Option<String>,
    pub playlist_type: Option<String>,
    pub leaf_count: Option<u64>,
    pub child_count: Option<u64>,
    pub view_count: Option<u64>,
    pub last_viewed_at: Option<i64>,
    pub year: Option<u32>,
    pub duration: Option<u64>,
}

/// A library section (`sectionSchema`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Section {
    pub key: String,
    pub title: String,
    /// `section.type`; music libraries are `"artist"`.
    pub section_type: String,
}

/// `PlexClient.getHomeHubs()` with no identifiers: the music sections' hubs
/// composed with the global `/hubs` audio playlist rows, with the mixed
/// recently-played preview swapped in.
pub fn get_home_hubs(server: &ServerConfig) -> Result<Vec<Hub>> {
    // `Promise.all([this.parseContainerArray("/hubs"), this.getMusicSections()])`.
    let (global_hubs, sections) = thread::scope(|scope| {
        let global = scope.spawn(|| get_global_hubs(server));
        let sections = scope.spawn(|| get_music_sections(server));
        (joined(global), joined(sections))
    });
    let global_hubs = global_hubs?;
    let sections = sections?;
    // A server without a music library still has its global rows.
    if sections.is_empty() {
        return Ok(global_hubs);
    }

    let (section_hubs, recently_played) = thread::scope(|scope| {
        // One thread per section for `/hubs/sections/{key}` plus three per
        // section for the recently-played queries: `Promise.all` over both
        // groups at once, so a multi-section library does not serialise.
        let section_handles: Vec<_> = sections
            .iter()
            .map(|section| scope.spawn(move || get_section_hubs(server, &section.key)))
            .collect();
        let recent_handles: Vec<Vec<_>> = sections
            .iter()
            .map(|section| {
                RECENTLY_PLAYED_TYPES
                    .into_iter()
                    .map(|media_type| {
                        scope.spawn(move || {
                            get_recently_played_by_type(server, &section.key, media_type)
                        })
                    })
                    .collect()
            })
            .collect();

        let section_hubs = section_handles
            .into_iter()
            .map(joined)
            .collect::<Result<Vec<Vec<Hub>>>>();
        let recently_played = recent_handles
            .into_iter()
            .flatten()
            .map(joined)
            .collect::<Result<Vec<Vec<HubItem>>>>();
        (section_hubs, recently_played)
    });

    let section_hubs: Vec<Hub> = section_hubs?.into_iter().flatten().collect();
    let recently_played = dedupe_recently_played(recently_played?.into_iter().flatten());
    Ok(replace_recently_played_preview(
        compose_home_hubs(section_hubs, global_hubs),
        recently_played,
    ))
}

/// `PlexClient.getHomeHubItems(key)` — every item behind a row's "See all".
pub fn get_home_hub_items(server: &ServerConfig, key: &str) -> Result<Vec<HubItem>> {
    let payload = request(server, key)?;
    Ok(parse_container::<HubItemWire, _>(&payload, "Metadata", key))
}

/// `PlexClient.getMusicSections()` — sections whose type is `artist`.
pub fn get_music_sections(server: &ServerConfig) -> Result<Vec<Section>> {
    const PATH: &str = "/library/sections";

    let payload = request(server, PATH)?;
    let sections = parse_container::<SectionWire, Section>(&payload, "Directory", PATH);
    Ok(sections
        .into_iter()
        .filter(|section| section.section_type == "artist")
        .collect())
}

/// The global `/hubs` response (no `identifier` query).
fn get_global_hubs(server: &ServerConfig) -> Result<Vec<Hub>> {
    const PATH: &str = "/hubs";

    let payload = request(server, PATH)?;
    Ok(parse_container::<HubWire, _>(&payload, "Hub", PATH))
}

/// `PlexClient.getSectionHubs(key)`.
fn get_section_hubs(server: &ServerConfig, section_key: &str) -> Result<Vec<Hub>> {
    let path = format!("/hubs/sections/{section_key}");
    let payload = request(server, &path)?;
    Ok(parse_container::<HubWire, _>(&payload, "Hub", &path))
}

/// `getRecentlyPlayedByType`: the query behind the `music.recent.played` hub,
/// for one media type in one section. `%3E` is the escaped `>` the reference
/// hard-codes, so the URL is used verbatim.
fn get_recently_played_by_type(
    server: &ServerConfig,
    section_key: &str,
    media_type: u8,
) -> Result<Vec<HubItem>> {
    let path = format!(
        "/library/sections/{section_key}/all?viewCount%3E=1&type={media_type}&sort=lastViewedAt:desc"
    );
    let payload = request(server, &path)?;
    Ok(parse_container::<HubItemWire, _>(
        &payload, "Metadata", &path,
    ))
}

/// The tail of `getRecentlyPlayedForSections`: drop repeats by `ratingKey`
/// (first occurrence wins, i.e. artists before albums before tracks) and sort
/// by `lastViewedAt` descending. `toSorted` is stable, and so is `sort_by_key`.
fn dedupe_recently_played(items: impl IntoIterator<Item = HubItem>) -> Vec<HubItem> {
    let mut seen = HashSet::new();
    let mut unique: Vec<HubItem> = items
        .into_iter()
        .filter(|item| seen.insert(item.rating_key.clone()))
        .collect();
    unique.sort_by_key(|item| std::cmp::Reverse(item.last_viewed_at.unwrap_or(0)));
    unique
}

/// `composeHomeHubs`: the music-library order is the home surface, plus the
/// global audio playlist rows that are not already part of it.
fn compose_home_hubs(section_hubs: Vec<Hub>, global_hubs: Vec<Hub>) -> Vec<Hub> {
    let music_rows: Vec<Hub> = section_hubs
        .into_iter()
        .filter(has_audio_home_items)
        .collect();
    if music_rows.is_empty() {
        return global_hubs
            .into_iter()
            .filter(has_audio_home_items)
            .collect();
    }

    let section_identifiers: HashSet<&str> = music_rows
        .iter()
        .map(|hub| hub.hub_identifier.as_str())
        .filter(|identifier| !identifier.is_empty())
        .collect();
    let global_playlist_rows: Vec<Hub> = global_hubs
        .into_iter()
        .filter(|hub| {
            has_audio_playlist(hub)
                && (hub.hub_identifier.is_empty()
                    || !section_identifiers.contains(hub.hub_identifier.as_str()))
        })
        .collect();
    let mut composed = music_rows;
    composed.extend(global_playlist_rows);
    composed
}

/// `replaceRecentlyPlayedPreview`: swap the mixed preview into the first
/// `music.recent.played.*` row and leave every other row untouched.
fn replace_recently_played_preview(hubs: Vec<Hub>, recently_played: Vec<HubItem>) -> Vec<Hub> {
    if recently_played.is_empty() {
        return hubs;
    }
    let mut replaced = false;
    hubs.into_iter()
        .map(|hub| {
            if replaced || !hub.hub_identifier.starts_with(RECENTLY_PLAYED_HUB_PREFIX) {
                return hub;
            }
            replaced = true;
            Hub {
                items: recently_played.clone(),
                ..hub
            }
        })
        .collect()
}

/// `isAudioHomeItem`: artists, albums, tracks and non-video playlists.
fn is_audio_home_item(item: &HubItem) -> bool {
    match item.item_type.as_str() {
        "artist" | "album" | "track" => true,
        "playlist" => item.playlist_type.as_deref() != Some("video"),
        _ => false,
    }
}

fn has_audio_home_items(hub: &Hub) -> bool {
    hub.items.iter().any(is_audio_home_item)
}

fn has_audio_playlist(hub: &Hub) -> bool {
    hub.items
        .iter()
        .any(|item| item.item_type == "playlist" && item.playlist_type.as_deref() != Some("video"))
}

/// `PlexClient.request`: `Accept: application/json` + `X-Plex-Token`, a non-2xx
/// status and a non-JSON content type both raising the reference's messages.
pub(super) fn request(server: &ServerConfig, path: &str) -> Result<Value> {
    let base = server.url.trim_end_matches('/');
    let mut response = media_agent()
        .get(format!("{base}{path}"))
        .header("Accept", "application/json")
        .header("X-Plex-Token", &server.token)
        .call()
        .map_err(|error| request_failed(path, &error))?;

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    if !content_type.to_ascii_lowercase().contains("json") {
        let described = if content_type.is_empty() {
            "non-JSON"
        } else {
            &content_type
        };
        return Err(anyhow!(
            "Plex returned {described} for {path}; expected application/json"
        ));
    }

    response
        .body_mut()
        .with_config()
        .limit(MAX_JSON_BYTES)
        .read_json::<Value>()
        .map_err(|error| {
            log::warn!("Plex returned an unreadable payload for {path}: {error}");
            anyhow!("Plex returned an invalid JSON payload for {path}")
        })
}

/// `Plex request failed: 401 Unauthorized for /hubs` — the message `request()`
/// throws. ureq reports 4xx/5xx as `StatusCode`, so the reason phrase is
/// recovered from the code exactly as `http::request_error` does.
fn request_failed(path: &str, error: &ureq::Error) -> anyhow::Error {
    anyhow!("{} for {path}", request_error("Plex request failed", error))
}

/// `parseContainerArray`: unwrap `MediaContainer[key]` and validate each item.
/// A malformed item is dropped with a log line instead of failing the request
/// (`filterItems`); note that — as in the reference, where `hubSchema` embeds
/// `hubItemSchema` — an invalid *item inside a hub* invalidates that whole hub.
pub(super) fn parse_container<W, T>(payload: &Value, key: &str, path: &str) -> Vec<T>
where
    W: serde::de::DeserializeOwned + Into<T>,
{
    let Some(container) = payload
        .get("MediaContainer")
        .filter(|value| value.is_object())
    else {
        log::error!("Plex response failed validation ({path}): no MediaContainer object");
        return Vec::new();
    };
    let Some(items) = container.get(key).and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match serde_json::from_value::<W>(item.clone()) {
            Ok(parsed) => Some(parsed.into()),
            Err(error) => {
                log::error!("Plex item failed validation ({path}); dropped: {error}");
                None
            }
        })
        .collect()
}

/// A panicking request thread would be a bug; surface it as a failed load
/// rather than unwinding the caller's scope.
pub(super) fn joined<T>(handle: thread::ScopedJoinHandle<'_, Result<T>>) -> Result<T> {
    handle
        .join()
        .unwrap_or_else(|_| Err(anyhow!("Plex request thread panicked")))
}

/// `sectionSchema`.
#[derive(Debug, Deserialize)]
struct SectionWire {
    key: String,
    title: String,
    #[serde(rename = "type")]
    section_type: String,
}

impl From<SectionWire> for Section {
    fn from(wire: SectionWire) -> Self {
        Self {
            key: wire.key,
            title: wire.title,
            section_type: wire.section_type,
        }
    }
}

/// `hubItemSchema`: `key`, `ratingKey`, `title` and `type` are required, every
/// other field is optional (unknown fields are tolerated, like `z.looseObject`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubItemWire {
    rating_key: String,
    key: String,
    title: String,
    #[serde(rename = "type")]
    item_type: String,
    #[serde(default)]
    thumb: Option<String>,
    #[serde(default)]
    composite: Option<String>,
    #[serde(default)]
    art: Option<String>,
    #[serde(default)]
    parent_title: Option<String>,
    #[serde(default)]
    grandparent_title: Option<String>,
    #[serde(default)]
    parent_rating_key: Option<String>,
    #[serde(default)]
    grandparent_rating_key: Option<String>,
    #[serde(default)]
    playlist_type: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    leaf_count: Option<u64>,
    #[serde(default, deserialize_with = "lenient_u64")]
    child_count: Option<u64>,
    #[serde(default, deserialize_with = "lenient_u64")]
    view_count: Option<u64>,
    #[serde(default, deserialize_with = "lenient_i64")]
    last_viewed_at: Option<i64>,
    #[serde(default, deserialize_with = "lenient_u32")]
    year: Option<u32>,
    #[serde(default, deserialize_with = "lenient_u64")]
    duration: Option<u64>,
}

impl From<HubItemWire> for HubItem {
    fn from(wire: HubItemWire) -> Self {
        Self {
            rating_key: wire.rating_key,
            key: wire.key,
            title: wire.title,
            item_type: wire.item_type,
            thumb: wire.thumb,
            composite: wire.composite,
            art: wire.art,
            parent_title: wire.parent_title,
            grandparent_title: wire.grandparent_title,
            parent_rating_key: wire.parent_rating_key,
            grandparent_rating_key: wire.grandparent_rating_key,
            playlist_type: wire.playlist_type,
            leaf_count: wire.leaf_count,
            child_count: wire.child_count,
            view_count: wire.view_count,
            last_viewed_at: wire.last_viewed_at,
            year: wire.year,
            duration: wire.duration,
        }
    }
}

/// `hubSchema`: every field is optional; the public `Hub` flattens the absent
/// strings to `""` the way the UI consumes them.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubWire {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    hub_identifier: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(rename = "type", default)]
    hub_type: Option<String>,
    #[serde(default, deserialize_with = "lenient_u64")]
    size: Option<u64>,
    #[serde(default, deserialize_with = "lenient_u64")]
    total_size: Option<u64>,
    #[serde(rename = "Metadata", default)]
    metadata: Option<Vec<HubItemWire>>,
}

impl From<HubWire> for Hub {
    fn from(wire: HubWire) -> Self {
        Self {
            title: wire.title.unwrap_or_default(),
            hub_identifier: wire.hub_identifier.unwrap_or_default(),
            key: wire.key.unwrap_or_default(),
            context: wire.context.unwrap_or_default(),
            hub_type: wire.hub_type.unwrap_or_default(),
            size: wire.size,
            total_size: wire.total_size,
            items: wire
                .metadata
                .unwrap_or_default()
                .into_iter()
                .map(HubItem::from)
                .collect(),
        }
    }
}

/// zod's `z.number()` accepts any JSON number, while serde's integer types
/// reject `1.0` — and a rejected field drops the whole item (or, inside a hub,
/// the whole row). Numbers are therefore read as JSON numbers and truncated.
fn lenient_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<f64>, D::Error> {
    Ok(Option::<serde_json::Number>::deserialize(deserializer)?.and_then(|number| number.as_f64()))
}

pub(super) fn lenient_u64<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    // Rust saturates out-of-range float casts, so a nonsensical value clamps
    // instead of wrapping.
    Ok(lenient_number(deserializer)?.map(|value| value as u64))
}

pub(super) fn lenient_u32<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u32>, D::Error> {
    Ok(lenient_number(deserializer)?.map(|value| value as u32))
}

pub(super) fn lenient_i64<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    Ok(lenient_number(deserializer)?.map(|value| value as i64))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        Hub, HubItem, HubItemWire, HubWire, Section, SectionWire, compose_home_hubs,
        dedupe_recently_played, parse_container, replace_recently_played_preview, request_failed,
    };

    fn hubs(payload: &serde_json::Value) -> Vec<Hub> {
        parse_container::<HubWire, Hub>(payload, "Hub", "/hubs")
    }

    fn items(payload: &serde_json::Value) -> Vec<HubItem> {
        parse_container::<HubItemWire, HubItem>(payload, "Metadata", "/hubs/items")
    }

    fn item(rating_key: &str, item_type: &str) -> HubItem {
        HubItem {
            rating_key: rating_key.to_owned(),
            key: format!("/library/metadata/{rating_key}"),
            title: rating_key.to_owned(),
            item_type: item_type.to_owned(),
            ..HubItem::default()
        }
    }

    fn playlist(rating_key: &str, playlist_type: &str) -> HubItem {
        HubItem {
            playlist_type: Some(playlist_type.to_owned()),
            ..item(rating_key, "playlist")
        }
    }

    fn hub(identifier: &str, items: Vec<HubItem>) -> Hub {
        Hub {
            title: identifier.to_owned(),
            hub_identifier: identifier.to_owned(),
            items,
            ..Hub::default()
        }
    }

    #[test]
    fn hubs_parse_with_their_items() {
        let parsed = hubs(&json!({
            "MediaContainer": {
                "size": 1,
                "Hub": [{
                    "hubKey": "/hubs/ignored",
                    "key": "/hubs/sections/1/recentlyAdded?type=9",
                    "title": "Recently Added",
                    "type": "album",
                    "hubIdentifier": "album.recentlyAdded.1",
                    "context": "hub.music.recentlyAdded",
                    "size": 12,
                    "totalSize": 40,
                    "more": true,
                    "Metadata": [{
                        "ratingKey": "101",
                        "key": "/library/metadata/101/children",
                        "title": "Blue Weather",
                        "type": "album",
                        "parentTitle": "Nova",
                        "parentRatingKey": "55",
                        "thumb": "/library/metadata/101/thumb/1",
                        "year": 2019,
                        "viewCount": 6,
                        "leafCount": 7,
                        "lastViewedAt": 1_735_689_600
                    }]
                }]
            }
        }));
        assert_eq!(parsed.len(), 1);
        let row = &parsed[0];
        assert_eq!(row.title, "Recently Added");
        assert_eq!(row.hub_identifier, "album.recentlyAdded.1");
        assert_eq!(row.key, "/hubs/sections/1/recentlyAdded?type=9");
        assert_eq!(row.context, "hub.music.recentlyAdded");
        assert_eq!(row.hub_type, "album");
        assert_eq!(row.size, Some(12));
        assert_eq!(row.total_size, Some(40));
        assert_eq!(row.items.len(), 1);
        let card = &row.items[0];
        assert_eq!(card.rating_key, "101");
        assert_eq!(card.parent_title.as_deref(), Some("Nova"));
        assert_eq!(card.thumb.as_deref(), Some("/library/metadata/101/thumb/1"));
        assert_eq!(card.year, Some(2019));
        assert_eq!(card.view_count, Some(6));
        assert_eq!(card.leaf_count, Some(7));
        assert_eq!(card.last_viewed_at, Some(1_735_689_600));
    }

    #[test]
    fn a_hub_without_any_optional_field_still_parses() {
        let parsed = hubs(&json!({ "MediaContainer": { "Hub": [{}] } }));
        assert_eq!(parsed, vec![Hub::default()]);
    }

    #[test]
    fn items_that_fail_validation_are_dropped_not_fatal() {
        let parsed = items(&json!({
            "MediaContainer": {
                "Metadata": [
                    { "ratingKey": "1", "key": "/k/1", "title": "Keep", "type": "track" },
                    { "ratingKey": "2", "key": "/k/2", "type": "track" },
                    { "key": "/k/3", "title": "No rating key", "type": "album" },
                    { "ratingKey": "4", "key": "/k/4", "title": "Also kept", "type": "artist" }
                ]
            }
        }));
        let kept: Vec<&str> = parsed.iter().map(|item| item.rating_key.as_str()).collect();
        assert_eq!(kept, vec!["1", "4"], "only the valid items survive");
    }

    #[test]
    fn a_hub_containing_an_invalid_item_is_dropped_whole() {
        // `hubSchema` embeds `hubItemSchema`, so in the reference an invalid
        // item invalidates its hub rather than being filtered out of it.
        let parsed = hubs(&json!({
            "MediaContainer": {
                "Hub": [
                    { "hubIdentifier": "broken", "Metadata": [{ "ratingKey": "1" }] },
                    { "hubIdentifier": "fine", "Metadata": [
                        { "ratingKey": "2", "key": "/k/2", "title": "T", "type": "track" }
                    ] }
                ]
            }
        }));
        let kept: Vec<&str> = parsed
            .iter()
            .map(|hub| hub.hub_identifier.as_str())
            .collect();
        assert_eq!(kept, vec!["fine"]);
    }

    #[test]
    fn a_missing_container_or_key_yields_nothing() {
        assert!(hubs(&json!({ "MediaContainer": { "size": 0 } })).is_empty());
        assert!(hubs(&json!({ "Hub": [] })).is_empty());
        assert!(hubs(&json!([])).is_empty());
        assert!(hubs(&json!({ "MediaContainer": { "Hub": {} } })).is_empty());
    }

    #[test]
    fn float_and_absent_numbers_do_not_drop_an_item() {
        // Plex occasionally sends a float where the schema expects a number;
        // `z.number()` accepts it, so the item must survive here too.
        let parsed = items(&json!({
            "MediaContainer": {
                "Metadata": [{
                    "ratingKey": "1", "key": "/k/1", "title": "T", "type": "track",
                    "duration": 214_000.0, "year": 2020.0, "viewCount": 3.0
                }]
            }
        }));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].duration, Some(214_000));
        assert_eq!(parsed[0].year, Some(2020));
        assert_eq!(parsed[0].view_count, Some(3));
    }

    #[test]
    fn sections_parse_and_music_sections_are_the_artist_ones() {
        let parsed = parse_container::<SectionWire, Section>(
            &json!({
                "MediaContainer": {
                    "Directory": [
                        { "key": "1", "title": "Music", "type": "artist", "agent": "tv.plex.agents.music" },
                        { "key": "2", "title": "Movies", "type": "movie" },
                        { "key": "3", "title": "Broken" }
                    ]
                }
            }),
            "Directory",
            "/library/sections",
        );
        assert_eq!(
            parsed,
            vec![
                Section {
                    key: "1".to_owned(),
                    title: "Music".to_owned(),
                    section_type: "artist".to_owned()
                },
                Section {
                    key: "2".to_owned(),
                    title: "Movies".to_owned(),
                    section_type: "movie".to_owned()
                },
            ],
            "the section without a type is dropped"
        );
        let music: Vec<&Section> = parsed
            .iter()
            .filter(|section| section.section_type == "artist")
            .collect();
        assert_eq!(music, vec![&parsed[0]]);
    }

    #[test]
    fn compose_prefers_section_rows_and_appends_global_playlist_rows() {
        let section = vec![
            hub("album.recentlyAdded.1", vec![item("1", "album")]),
            hub("movie.row", vec![item("2", "movie")]),
        ];
        let global = vec![
            hub("home.playlists", vec![playlist("3", "audio")]),
            hub("home.videos", vec![playlist("4", "video")]),
            hub("album.recentlyAdded.1", vec![playlist("5", "audio")]),
        ];
        let composed = compose_home_hubs(section, global);
        let identifiers: Vec<&str> = composed
            .iter()
            .map(|hub| hub.hub_identifier.as_str())
            .collect();
        assert_eq!(
            identifiers,
            vec!["album.recentlyAdded.1", "home.playlists"],
            "non-audio rows and duplicate identifiers are excluded"
        );
    }

    #[test]
    fn an_unidentified_global_playlist_row_is_always_kept() {
        let composed = compose_home_hubs(
            vec![hub("album.recentlyAdded.1", vec![item("1", "album")])],
            vec![hub("", vec![playlist("2", "audio")])],
        );
        assert_eq!(composed.len(), 2);
        assert_eq!(composed[1].items[0].rating_key, "2");
    }

    #[test]
    fn without_section_music_rows_the_global_audio_rows_are_used() {
        let composed = compose_home_hubs(
            vec![hub("movie.row", vec![item("1", "movie")])],
            vec![
                hub("home.playlists", vec![playlist("2", "audio")]),
                hub("home.movies", vec![item("3", "movie")]),
                hub("home.tracks", vec![item("4", "track")]),
            ],
        );
        let identifiers: Vec<&str> = composed
            .iter()
            .map(|hub| hub.hub_identifier.as_str())
            .collect();
        assert_eq!(identifiers, vec!["home.playlists", "home.tracks"]);
    }

    #[test]
    fn only_the_first_recently_played_row_is_replaced() {
        let hubs = vec![
            hub("album.recentlyAdded.1", vec![item("1", "album")]),
            hub("music.recent.played.1", vec![item("2", "artist")]),
            hub("music.recent.played.2", vec![item("3", "artist")]),
        ];
        let preview = vec![item("9", "track"), item("8", "album")];
        let replaced = replace_recently_played_preview(hubs.clone(), preview.clone());
        assert_eq!(replaced[0], hubs[0], "other rows are untouched");
        assert_eq!(replaced[1].items, preview);
        assert_eq!(
            replaced[1].title, "music.recent.played.1",
            "only Metadata changes"
        );
        assert_eq!(
            replaced[2], hubs[2],
            "the second recent row keeps its items"
        );
    }

    #[test]
    fn an_empty_preview_leaves_every_row_alone() {
        let hubs = vec![hub("music.recent.played.1", vec![item("2", "artist")])];
        assert_eq!(
            replace_recently_played_preview(hubs.clone(), Vec::new()),
            hubs
        );
    }

    #[test]
    fn recently_played_is_deduped_by_rating_key_and_sorted_by_last_played() {
        let played = |rating_key: &str, item_type: &str, at: Option<i64>| HubItem {
            last_viewed_at: at,
            ..item(rating_key, item_type)
        };
        let deduped = dedupe_recently_played(vec![
            played("1", "artist", Some(300)),
            played("2", "album", Some(500)),
            played("1", "track", Some(900)),
            played("3", "track", None),
            played("4", "track", Some(500)),
        ]);
        let order: Vec<(&str, &str)> = deduped
            .iter()
            .map(|item| (item.rating_key.as_str(), item.item_type.as_str()))
            .collect();
        assert_eq!(
            order,
            vec![
                ("2", "album"),
                ("4", "track"),
                ("1", "artist"),
                ("3", "track")
            ],
            "the first occurrence of a rating key wins and ties keep their order"
        );
    }

    /// A live smoke test against the signed-in server:
    /// `cargo test -- --ignored live_home_hubs`.
    #[test]
    #[ignore = "requires a signed-in config and a reachable Plex server"]
    fn live_home_hubs_load_from_the_configured_server() {
        let config = crate::plex::load_config().expect("sign in first: no plex-config.json");
        let server = config.server.expect("no server selected in the config");
        let hubs = super::get_home_hubs(&server).expect("home hubs");
        for hub in &hubs {
            println!(
                "{} [{}] -> {} items (key {})",
                hub.title,
                hub.hub_identifier,
                hub.items.len(),
                hub.key
            );
        }
        assert!(!hubs.is_empty(), "the server returned no home rows");
    }

    #[test]
    fn request_failures_read_like_the_reference() {
        assert_eq!(
            request_failed("/hubs", &ureq::Error::StatusCode(401)).to_string(),
            "Plex request failed: 401 Unauthorized for /hubs"
        );
        assert_eq!(
            request_failed("/library/sections", &ureq::Error::StatusCode(599)).to_string(),
            "Plex request failed: 599 for /library/sections"
        );
        assert!(
            request_failed("/hubs", &ureq::Error::HostNotFound)
                .to_string()
                .ends_with(" for /hubs")
        );
    }
}
