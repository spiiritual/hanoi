//! Plex backend: plex.tv PIN authentication, account lookup, server discovery
//! and the persisted config file.
//!
//! CONTRACT: every item below that is `pub` is the API the UI layer codes
//! against. The implementation is split into submodules (`config.rs`,
//! `auth.rs`, `account.rs`, `servers.rs`, `http.rs`); everything is
//! re-exported from here so `crate::plex::<item>` keeps working. All
//! functions are *blocking* (they use `ureq`); the UI calls them from
//! `cx.background_spawn`.
//!
//! Behaviour matches the TypeScript reference in `../../src/bun/plex/`
//! (`auth.ts`, `client.ts`, `config.ts`, `server-selection.ts`) and the RPC
//! handlers in `../../src/bun/index.ts`.

use serde::{Deserialize, Serialize};

mod account;
mod auth;
mod config;
mod http;
mod hubs;
mod servers;

pub use account::{get_account, get_avatar_bytes};
pub use auth::{auth_url, create_pin, poll_pin};
#[allow(unused_imports, reason = "backend contract the UI does not call yet")]
pub use hubs::{Hub, HubItem, Section, get_home_hub_items, get_home_hubs, get_music_sections};
// `config_path` and `check_server_status` are part of the contract above but
// are currently only called from inside this module, so the binary's
// unused-import pass sees the re-export itself as unused. Drop the attributes
// once the UI calls them.
#[allow(unused_imports, reason = "backend contract the UI does not call yet")]
pub use config::{config_path, delete_config, load_config, save_config};
#[allow(unused_imports, reason = "backend contract the UI does not call yet")]
pub use servers::{check_server_status, discover_servers, find_persisted_server};

/// plex.tv account profile (`GET https://plex.tv/api/v2/user`).
/// `verified` is plex.tv's `confirmed` flag.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub username: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    pub verified: bool,
}

/// The selected server as persisted in the config file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// Plex resource identifier; optional for configs written before server switching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_identifier: Option<String>,
    pub name: String,
    /// Best connection URI (local connection preferred).
    pub url: String,
    /// Per-server access token.
    pub token: String,
}

/// Persisted config. JSON shape is identical to the Electrobun app's
/// `plex-config.json` (camelCase keys) so a config can be shared between the two.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub client_identifier: String,
    /// Account token from the plex.tv PIN flow.
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    /// Selected server only; the full list is re-discovered each session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerConfig>,
}

/// A discovered, owned media server ready for the Server Selection screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerInfo {
    pub name: String,
    pub client_identifier: String,
    /// Best connection URI; empty string when the server has no usable connection.
    pub url: String,
    /// Per-server access token (falls back to the account token).
    pub token: String,
    pub local: bool,
    /// Whether the `/identity` reachability probe succeeded.
    pub online: bool,
}

/// A PIN created at plex.tv that the user authorizes in the browser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pin {
    pub id: String,
    pub code: String,
    pub client_identifier: String,
    pub expires_in: u64,
}

/// Outcome of one `poll_pin` call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PinStatus {
    /// Not yet authorized; poll again after the interval.
    Pending,
    /// The user approved the PIN; this is the account token.
    Authorized(String),
}

/// Poll interval used by the OAuth screen (matches `waitForPin` default).
pub const PIN_POLL_INTERVAL_MS: u64 = 2000;
/// Give up waiting for the PIN after this long (matches `waitForPin` default).
pub const PIN_TIMEOUT_MS: u64 = 5 * 60_000;
/// Reachability probe timeout for `/identity` (matches `DEFAULT_STATUS_TIMEOUT_MS`).
pub const STATUS_TIMEOUT_MS: u64 = 3000;

pub const PLEX_TV_URL: &str = "https://plex.tv";
pub const PRODUCT_NAME: &str = "hanoi";
