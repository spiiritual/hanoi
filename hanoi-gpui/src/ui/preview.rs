//! `HANOI_PREVIEW=<stage>` — one stage rendered from fixed sample data so the
//! screens can be screenshotted without a Plex account. Nothing here touches
//! the network, the config file or the artwork cache.

use crate::plex::{Account, Hub, HubItem, Section, ServerInfo};

use super::auth::{Stage, oauth};
use super::home::state::{Category, Load, Status, View};
use super::root::{Root, Screen};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preview {
    Startup,
    Welcome,
    Oauth,
    OauthCopied,
    Connected,
    ServersLoading,
    Servers,
    ServersError,
    Home,
    HomeLoading,
    HomeError,
    HomeEmpty,
    HomeCategory,
    HomeLibrary,
    HomeScrollbar,
}

impl Preview {
    /// Parse the `HANOI_PREVIEW` value; unknown names are rejected so a typo
    /// does not silently launch the real flow.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "startup" => Some(Self::Startup),
            "welcome" => Some(Self::Welcome),
            "oauth" => Some(Self::Oauth),
            "oauth-copied" => Some(Self::OauthCopied),
            "connected" => Some(Self::Connected),
            "servers-loading" => Some(Self::ServersLoading),
            "servers" => Some(Self::Servers),
            "servers-error" => Some(Self::ServersError),
            "home" => Some(Self::Home),
            "home-loading" => Some(Self::HomeLoading),
            "home-error" => Some(Self::HomeError),
            "home-empty" => Some(Self::HomeEmpty),
            "home-category" => Some(Self::HomeCategory),
            "home-library" => Some(Self::HomeLibrary),
            "home-scrollbar" => Some(Self::HomeScrollbar),
            _ => None,
        }
    }

    pub const ALL: &'static [&'static str] = &[
        "startup",
        "welcome",
        "oauth",
        "oauth-copied",
        "connected",
        "servers-loading",
        "servers",
        "servers-error",
        "home",
        "home-loading",
        "home-error",
        "home-empty",
        "home-category",
        "home-library",
        "home-scrollbar",
    ];

    /// Put `root` into the state this preview names.
    pub fn apply(self, root: &mut Root) {
        match self {
            Self::Startup => root.screen = Screen::Startup,
            Self::Welcome => root.show(Stage::Welcome),
            Self::Oauth => {
                root.show(Stage::Oauth);
                root.oauth.code = oauth::PLACEHOLDER_CODE.into();
                root.oauth.status = oauth::STATUS_WAITING.into();
            }
            Self::OauthCopied => {
                Self::Oauth.apply(root);
                root.oauth.copied = true;
            }
            Self::Connected => {
                root.show(Stage::Connected);
                root.account = Some(sample_account("Alex Rivera", "alex@example.com"));
            }
            Self::ServersLoading => {
                root.show(Stage::Servers);
                root.server_loading = true;
            }
            Self::Servers => {
                root.show(Stage::Servers);
                root.account = Some(sample_account("alexr", "alex@example.com"));
                root.servers = sample_servers();
                root.selected_server = Some("home-server".to_owned());
            }
            Self::ServersError => {
                Self::Servers.apply(root);
                root.server_error = Some("Couldn't load your Plex servers: fetch failed".into());
            }
            Self::Home => {
                shell(root);
                root.home.hubs = Load::preview(Status::Ready, sample_hubs(), None);
            }
            Self::HomeLoading => {
                shell(root);
                root.home.hubs = Load::preview(Status::Loading, Vec::new(), None);
            }
            Self::HomeError => {
                shell(root);
                root.home.hubs = Load::preview(Status::Error, Vec::new(), Some("fetch failed"));
            }
            Self::HomeEmpty => {
                shell(root);
                root.home.hubs = Load::preview(Status::Ready, Vec::new(), None);
            }
            Self::HomeCategory => {
                Self::Home.apply(root);
                let hub = recently_added();
                root.home.category = Some(Category {
                    items: category_albums(),
                    hub,
                    status: Status::Ready,
                    error: None,
                });
            }
            Self::HomeLibrary => {
                Self::Home.apply(root);
                root.home.view = View::Albums;
                root.home.sections = Load::preview(Status::Ready, sample_sections(), None);
            }
            // The overlay scrollbars are revealed by a hover, which a
            // screenshot cannot perform; this pins them on instead.
            Self::HomeScrollbar => {
                Self::Home.apply(root);
                root.scrollbar.force_visible = true;
            }
        }
    }
}

/// The shell chrome every `home-*` preview shares.
fn shell(root: &mut Root) {
    root.screen = Screen::Home;
    root.account = Some(sample_account("Alex Rivera", "alex@example.com"));
    root.servers = sample_servers();
    root.selected_server = Some("home-server".to_owned());
    root.home.username = "Alex Rivera".into();
    root.home.server_name = "Home Server".into();
    root.home.server_status = Some(true);
    root.home.view = View::Home;
}

fn sample_account(username: &str, email: &str) -> Account {
    Account {
        username: username.to_owned(),
        email: email.to_owned(),
        thumb: None,
        verified: true,
    }
}

fn sample_servers() -> Vec<ServerInfo> {
    vec![
        sample_server(
            "Home Server",
            "home-server",
            "http://192.168.1.10:32400",
            true,
        ),
        sample_server(
            "Studio NAS",
            "studio-nas",
            "https://10-0-0-5.83588b0fc21c4e24a7b6e75bd8875faf.plex.direct:32400",
            false,
        ),
        sample_server("Offline Box", "offline-box", "", false),
    ]
}

fn sample_server(name: &str, client_identifier: &str, url: &str, local: bool) -> ServerInfo {
    ServerInfo {
        name: name.to_owned(),
        client_identifier: client_identifier.to_owned(),
        url: url.to_owned(),
        token: "preview-token".to_owned(),
        local,
        online: !url.is_empty(),
    }
}

fn sample_sections() -> Vec<Section> {
    vec![
        Section {
            key: "1".to_owned(),
            title: "Music".to_owned(),
            section_type: "artist".to_owned(),
        },
        Section {
            key: "4".to_owned(),
            title: "Live sets".to_owned(),
            section_type: "artist".to_owned(),
        },
    ]
}

// ---------------------------------------------------------------------------
// Sample rows. No artwork paths, so every card exercises its fallback glyph.
// ---------------------------------------------------------------------------

fn sample_hubs() -> Vec<Hub> {
    vec![recently_played(), recently_added(), playlists()]
}

/// Six mixed cards: the preview's only row with track cards.
fn recently_played() -> Hub {
    Hub {
        title: "Recently Played".to_owned(),
        hub_identifier: "home.music.recent".to_owned(),
        key: "/hubs/home/music/recent".to_owned(),
        hub_type: "mixed".to_owned(),
        items: vec![
            track(
                "track-1",
                "Weird Fishes / Arpeggi",
                "Radiohead",
                "In Rainbows",
            ),
            album("album-1", "In Rainbows", "Radiohead"),
            artist("artist-1", "Big Thief"),
            track("track-2", "Not", "Big Thief", "Two Hands"),
            album("album-2", "A Moon Shaped Pool", "Radiohead"),
            playlist("playlist-9", "Late Night Drive", 42),
        ],
        ..Hub::default()
    }
}

/// Six albums, so the row shows "See all".
fn recently_added() -> Hub {
    Hub {
        title: "Recently Added".to_owned(),
        hub_identifier: "home.music.recent.added".to_owned(),
        key: "/hubs/home/music/added".to_owned(),
        hub_type: "album".to_owned(),
        items: vec![
            album("album-10", "Kid A", "Radiohead"),
            album(
                "album-11",
                "Dragon New Warm Mountain I Believe In You",
                "Big Thief",
            ),
            album("album-12", "Blonde", "Frank Ocean"),
            album("album-13", "Sound Ancestors", "Madlib"),
            album("album-14", "Promises", "Floating Points"),
            album("album-15", "Ants From Up There", "Black Country, New Road"),
        ],
        ..Hub::default()
    }
}

/// Three playlists — under the six-card preview size, so no "See all".
fn playlists() -> Hub {
    Hub {
        title: "Your Playlists".to_owned(),
        hub_identifier: "home.playlists".to_owned(),
        key: "/playlists".to_owned(),
        hub_type: "playlist".to_owned(),
        items: vec![
            playlist("playlist-1", "Deep Focus", 128),
            playlist("playlist-2", "Sunday Morning", 31),
            playlist("playlist-3", "Rainy Day Jazz", 0),
        ],
        ..Hub::default()
    }
}

/// The full "Recently Added" category: more than one grid row of cards.
fn category_albums() -> Vec<HubItem> {
    let mut items = recently_added().items;
    items.extend([
        album("album-16", "Ghosteen", "Nick Cave & The Bad Seeds"),
        album("album-17", "For Ever", "Jungle"),
        album("album-18", "Djesse Vol. 3", "Jacob Collier"),
        album(
            "album-19",
            "Little Simz: Sometimes I Might Be Introvert",
            "Little Simz",
        ),
        album("album-20", "An Evening With Silk Sonic", "Silk Sonic"),
        album("album-21", "Black Origami", "Jlin"),
    ]);
    items
}

fn track(rating_key: &str, title: &str, artist: &str, album: &str) -> HubItem {
    HubItem {
        grandparent_title: Some(artist.to_owned()),
        parent_title: Some(album.to_owned()),
        ..item(rating_key, title, "track")
    }
}

fn album(rating_key: &str, title: &str, artist: &str) -> HubItem {
    HubItem {
        parent_title: Some(artist.to_owned()),
        ..item(rating_key, title, "album")
    }
}

fn artist(rating_key: &str, title: &str) -> HubItem {
    item(rating_key, title, "artist")
}

fn playlist(rating_key: &str, title: &str, leaf_count: u64) -> HubItem {
    HubItem {
        playlist_type: Some("audio".to_owned()),
        leaf_count: Some(leaf_count),
        ..item(rating_key, title, "playlist")
    }
}

fn item(rating_key: &str, title: &str, item_type: &str) -> HubItem {
    HubItem {
        rating_key: rating_key.to_owned(),
        key: format!("/library/metadata/{rating_key}"),
        title: title.to_owned(),
        item_type: item_type.to_owned(),
        ..HubItem::default()
    }
}
