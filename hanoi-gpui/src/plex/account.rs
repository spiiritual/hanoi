//! The plex.tv account profile (`getPlexAccount` in `../../src/bun/plex/client.ts`)
//! and the avatar bytes behind `Account::thumb`.

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use super::http::{plex_tv_agent, request_error};
use super::{Account, PLEX_TV_URL, PRODUCT_NAME};

const ACCOUNT_CONTEXT: &str = "plex.tv /api/v2/user";

/// `plexAccountSchema`: the wire shape of `/api/v2/user`.
#[derive(Debug, Deserialize)]
struct AccountResponse {
    email: String,
    username: String,
    #[serde(default)]
    thumb: Option<String>,
    /// The Connected card's "verified" badge; the app maps it to `verified`.
    #[serde(default)]
    confirmed: Option<bool>,
}

/// `GET {PLEX_TV_URL}/api/v2/user` with `X-Plex-Token`.
pub fn get_account(token: &str) -> Result<Account> {
    const PREFIX: &str = "Failed to fetch Plex account";

    let url = format!("{PLEX_TV_URL}/api/v2/user");
    let mut response = plex_tv_agent()
        .get(&url)
        .header("Accept", "application/json")
        .header("X-Plex-Product", PRODUCT_NAME)
        .header("X-Plex-Device-Name", PRODUCT_NAME)
        .header("X-Plex-Platform", std::env::consts::OS)
        .header("X-Plex-Token", token)
        .call()
        .map_err(|error| request_error(PREFIX, &error))?;
    let payload = response
        .body_mut()
        .read_json::<Value>()
        .map_err(|error| request_error(PREFIX, &error))?;
    parse_account(payload)
        .ok_or_else(|| anyhow::anyhow!("{PREFIX}: unexpected response from plex.tv"))
}

/// Fetch raw image bytes for the account avatar (`Account::thumb`), sending
/// the token as `X-Plex-Token`. Returns `(bytes, content_type)`.
pub fn get_avatar_bytes(token: &str, thumb_url: &str) -> Result<(Vec<u8>, String)> {
    const PREFIX: &str = "Failed to fetch the Plex avatar";

    let mut request = plex_tv_agent().get(thumb_url).header("Accept", "image/*");
    // Plex artwork URLs are token-free; only plex.tv's own avatar endpoint
    // needs the account token, and it never travels in the URL.
    if is_plex_tv_host(thumb_url) {
        request = request.header("X-Plex-Token", token);
    }
    let mut response = request
        .call()
        .map_err(|error| request_error(PREFIX, &error))?;
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map_or_else(|| "image/jpeg".to_owned(), str::to_owned);
    // `read_to_vec` caps the body at ureq's 10 MB default, plenty for an avatar.
    let bytes = response
        .body_mut()
        .read_to_vec()
        .map_err(|error| request_error(PREFIX, &error))?;
    Ok((bytes, content_type))
}

/// `parseStrict(plexAccountSchema, ...)` plus the `confirmed` -> `verified` mapping.
fn parse_account(payload: Value) -> Option<Account> {
    match serde_json::from_value::<AccountResponse>(payload) {
        Ok(parsed) => Some(Account {
            username: parsed.username,
            email: parsed.email,
            thumb: parsed.thumb,
            verified: parsed.confirmed == Some(true),
        }),
        Err(error) => {
            log::error!("Plex response failed validation ({ACCOUNT_CONTEXT}): {error}");
            None
        }
    }
}

/// Whether a URL points at plex.tv itself (as opposed to a media server).
fn is_plex_tv_host(url: &str) -> bool {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    host == "plex.tv" || host.ends_with(".plex.tv")
}

#[cfg(test)]
mod tests {
    use super::{Account, is_plex_tv_host, parse_account};

    #[test]
    fn confirmed_becomes_verified() {
        let payload = serde_json::json!({
            "id": 1234,
            "uuid": "abc",
            "username": "alexr",
            "title": "Alex Rivera",
            "email": "alex@example.com",
            "thumb": "https://plex.tv/users/abc/avatar?c=1",
            "confirmed": true,
            "emailOnlyAuth": false
        });
        assert_eq!(
            parse_account(payload),
            Some(Account {
                username: "alexr".to_owned(),
                email: "alex@example.com".to_owned(),
                thumb: Some("https://plex.tv/users/abc/avatar?c=1".to_owned()),
                verified: true,
            })
        );
    }

    #[test]
    fn an_absent_or_false_confirmed_is_unverified() {
        let without = serde_json::json!({ "username": "u", "email": "e@x" });
        let account = parse_account(without).expect("account");
        assert!(!account.verified);
        assert_eq!(account.thumb, None);

        let explicit = serde_json::json!({ "username": "u", "email": "e@x", "confirmed": false });
        assert!(!parse_account(explicit).expect("account").verified);
    }

    #[test]
    fn a_response_without_an_email_is_rejected() {
        assert_eq!(parse_account(serde_json::json!({ "username": "u" })), None);
    }

    #[test]
    fn only_plex_tv_avatars_receive_the_token() {
        assert!(is_plex_tv_host("https://plex.tv/users/abc/avatar?c=1"));
        assert!(is_plex_tv_host("https://PLEX.TV/users/abc/avatar"));
        assert!(is_plex_tv_host("https://images.plex.tv/photo/abc"));
        assert!(!is_plex_tv_host(
            "http://192.168.1.10:32400/library/thumb/1"
        ));
        assert!(!is_plex_tv_host("https://notplex.tv/avatar"));
        assert!(!is_plex_tv_host("https://plex.tv.evil.example/avatar"));
    }
}
