//! The persisted config file (`plex-config.json`), mirroring
//! `../../src/bun/plex/config.ts`: camelCase JSON, zod-equivalent validation
//! and owner-only (0600) permissions.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use super::Config;

/// Location of the config file. `HANOI_CONFIG` overrides it; otherwise
/// `<data dir>/hanoi-gpui/plex-config.json` (on macOS
/// `~/Library/Application Support/hanoi-gpui/plex-config.json`).
pub fn config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("HANOI_CONFIG") {
        return PathBuf::from(path);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hanoi-gpui")
        .join("plex-config.json")
}

/// Read and validate the config; `None` when missing or invalid.
pub fn load_config() -> Option<Config> {
    load_config_from(&config_path())
}

/// Write the config with mode 0o600 (owner read/write only), creating the
/// parent directory as needed.
pub fn save_config(config: &Config) -> Result<()> {
    save_config_to(&config_path(), config)
}

/// Remove the config file if present.
pub fn delete_config() -> Result<()> {
    delete_config_at(&config_path())
}

/// `load_config` against an explicit path (used by the tests).
fn load_config_from(path: &Path) -> Option<Config> {
    // An unreadable/absent file is simply "unconfigured", exactly like the
    // reference's `try { readFileSync } catch { return null }`.
    let raw = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<Config>(&raw) {
        Ok(config) if is_valid(&config) => Some(config),
        Ok(_) => {
            log::error!("plex-config.json failed validation; treating as unconfigured");
            None
        }
        Err(error) => {
            log::error!("plex-config.json failed validation; treating as unconfigured: {error}");
            None
        }
    }
}

/// `save_config` against an explicit path (used by the tests).
fn save_config_to(path: &Path, config: &Config) -> Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }
    let mut json =
        serde_json::to_string_pretty(config).context("Failed to serialize the config")?;
    json.push('\n');
    write_private(path, json.as_bytes())
        .with_context(|| format!("Failed to write {}", path.display()))
}

fn delete_config_at(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(anyhow::Error::new(error).context(format!("Failed to delete {}", path.display())))
        }
    }
}

/// The runtime shape `plexConfigSchema` accepts: every string the app reads
/// back must be non-empty.
fn is_valid(config: &Config) -> bool {
    if config.client_identifier.is_empty() || config.token.is_empty() {
        return false;
    }
    if let Some(account) = &config.account
        && (account.username.is_empty() || account.email.is_empty())
    {
        return false;
    }
    if let Some(server) = &config.server {
        if server.name.is_empty() || server.url.is_empty() || server.token.is_empty() {
            return false;
        }
        if server
            .client_identifier
            .as_ref()
            .is_some_and(String::is_empty)
        {
            return false;
        }
    }
    true
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    // `mode()` only applies when the file is created; a pre-existing config
    // would keep its old (possibly permissive) permissions without this.
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::{Config, delete_config_at, load_config_from, save_config_to};
    use crate::plex::{Account, ServerConfig};

    /// A unique directory under the system temp dir; never the real config.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "hanoi-plex-tests-{}-{label}-{unique}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn config(&self) -> std::path::PathBuf {
            self.0.join("plex-config.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sample() -> Config {
        Config {
            client_identifier: "11111111-2222-3333-4444-555555555555".to_owned(),
            token: "account-token".to_owned(),
            account: Some(Account {
                username: "alexr".to_owned(),
                email: "alex@example.com".to_owned(),
                thumb: Some("https://plex.tv/users/abc/avatar?c=1".to_owned()),
                verified: true,
            }),
            server: Some(ServerConfig {
                client_identifier: Some("server-id".to_owned()),
                name: "Home Server".to_owned(),
                url: "http://192.168.1.10:32400".to_owned(),
                token: "server-token".to_owned(),
            }),
        }
    }

    #[test]
    fn round_trips_through_the_electrobun_json_shape() {
        let dir = TempDir::new("round-trip");
        let path = dir.config();
        save_config_to(&path, &sample()).expect("save");

        // Byte-for-byte the layout `JSON.stringify(config, null, 2) + "\n"`
        // produces, so the Electrobun app can read the same file.
        let raw = std::fs::read_to_string(&path).expect("read");
        assert_eq!(
            raw,
            concat!(
                "{\n",
                "  \"clientIdentifier\": \"11111111-2222-3333-4444-555555555555\",\n",
                "  \"token\": \"account-token\",\n",
                "  \"account\": {\n",
                "    \"username\": \"alexr\",\n",
                "    \"email\": \"alex@example.com\",\n",
                "    \"thumb\": \"https://plex.tv/users/abc/avatar?c=1\",\n",
                "    \"verified\": true\n",
                "  },\n",
                "  \"server\": {\n",
                "    \"clientIdentifier\": \"server-id\",\n",
                "    \"name\": \"Home Server\",\n",
                "    \"url\": \"http://192.168.1.10:32400\",\n",
                "    \"token\": \"server-token\"\n",
                "  }\n",
                "}\n",
            )
        );
        assert_eq!(load_config_from(&path), Some(sample()));
    }

    #[test]
    fn optional_sections_are_omitted_and_reload_as_none() {
        let dir = TempDir::new("minimal");
        let path = dir.config();
        let minimal = Config {
            client_identifier: "client".to_owned(),
            token: "token".to_owned(),
            account: None,
            server: None,
        };
        save_config_to(&path, &minimal).expect("save");

        let raw = std::fs::read_to_string(&path).expect("read");
        assert!(!raw.contains("account"), "{raw}");
        assert!(!raw.contains("server"), "{raw}");
        assert_eq!(load_config_from(&path), Some(minimal));
    }

    #[cfg(unix)]
    #[test]
    fn saving_over_a_permissive_file_restores_owner_only_mode() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = TempDir::new("mode");
        let path = dir.config();
        save_config_to(&path, &sample()).expect("save");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "fresh file mode was {mode:o}");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        save_config_to(&path, &sample()).expect("re-save");
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "re-saved file mode was {mode:o}");
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let dir = TempDir::new("missing");
        assert_eq!(load_config_from(&dir.config()), None);
        delete_config_at(&dir.config()).expect("delete is idempotent");
    }

    #[test]
    fn delete_removes_the_file() {
        let dir = TempDir::new("delete");
        let path = dir.config();
        save_config_to(&path, &sample()).expect("save");
        delete_config_at(&path).expect("delete");
        assert!(!path.exists());
    }

    #[track_caller]
    fn assert_invalid(label: &str, json: &str) {
        let dir = TempDir::new(label);
        let path = dir.config();
        std::fs::write(&path, json).expect("write");
        assert_eq!(load_config_from(&path), None, "{label} should be rejected");
    }

    #[test]
    fn validation_rejects_the_same_documents_as_the_zod_schema() {
        assert_invalid("not-json", "{ this is not json ");
        assert_invalid(
            "empty-client-identifier",
            r#"{"clientIdentifier": "", "token": "t"}"#,
        );
        assert_invalid("empty-token", r#"{"clientIdentifier": "c", "token": ""}"#);
        assert_invalid("missing-token", r#"{"clientIdentifier": "c"}"#);
        assert_invalid(
            "empty-server-url",
            r#"{"clientIdentifier":"c","token":"t","server":{"name":"n","url":"","token":"s"}}"#,
        );
        assert_invalid(
            "missing-server-token",
            r#"{"clientIdentifier":"c","token":"t","server":{"name":"n","url":"u"}}"#,
        );
        assert_invalid(
            "empty-server-client-identifier",
            r#"{"clientIdentifier":"c","token":"t","server":{"clientIdentifier":"","name":"n","url":"u","token":"s"}}"#,
        );
        assert_invalid(
            "empty-account-email",
            r#"{"clientIdentifier":"c","token":"t","account":{"username":"u","email":"","verified":false}}"#,
        );
        assert_invalid(
            "missing-account-verified",
            r#"{"clientIdentifier":"c","token":"t","account":{"username":"u","email":"e@x"}}"#,
        );
    }

    #[test]
    fn legacy_servers_without_a_client_identifier_stay_loadable() {
        let dir = TempDir::new("legacy");
        let path = dir.config();
        std::fs::write(
            &path,
            r#"{"clientIdentifier":"c","token":"t","server":{"name":"n","url":"u","token":"s"},"unknownField":1}"#,
        )
        .expect("write");
        let loaded = load_config_from(&path).expect("legacy config loads");
        assert_eq!(
            loaded.server.expect("server").client_identifier,
            None,
            "an absent clientIdentifier must stay absent"
        );
    }
}
