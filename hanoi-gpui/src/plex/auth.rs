//! The plex.tv PIN flow, mirroring `createPin` / `buildAuthUrl` / `waitForPin`
//! in `../../src/bun/plex/auth.ts`. `waitForPin`'s loop lives in the UI (one
//! `poll_pin` call per tick) so the flow stays cancellable.

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use super::http::{device_headers, plex_tv_agent, request_error};
use super::{PLEX_TV_URL, PRODUCT_NAME, Pin, PinStatus};

const CREATE_CONTEXT: &str = "plex.tv /api/v2/pins (create)";
const POLL_CONTEXT: &str = "plex.tv /api/v2/pins poll";

/// `pinSchema`. Unknown fields are tolerated (`z.looseObject`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinResponse {
    client_identifier: String,
    code: String,
    expires_in: f64,
    /// plex.tv sends a JSON number; `z.coerce.string()` turns it into a string.
    id: CoercedString,
}

/// `pinPollSchema`: only `authToken` is consumed, and it may be null.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinPollResponse {
    #[serde(default)]
    auth_token: Option<String>,
}

/// A JSON scalar that `z.coerce.string()` would turn into a string.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CoercedString {
    Text(String),
    Number(serde_json::Number),
}

impl CoercedString {
    fn into_string(self) -> String {
        match self {
            Self::Text(text) => text,
            Self::Number(number) => number.to_string(),
        }
    }
}

/// `POST {PLEX_TV_URL}/api/v2/pins?strong=true` with the device headers.
pub fn create_pin(client_identifier: &str) -> Result<Pin> {
    const PREFIX: &str = "Failed to create Plex PIN";

    let url = format!("{PLEX_TV_URL}/api/v2/pins?strong=true");
    let mut response = device_headers(plex_tv_agent().post(&url), client_identifier)
        .send_empty()
        .map_err(|error| request_error(PREFIX, &error))?;
    let payload = response
        .body_mut()
        .read_json::<Value>()
        .map_err(|error| request_error(PREFIX, &error))?;
    parse_pin(payload).ok_or_else(|| anyhow::anyhow!("{PREFIX}: unexpected response from plex.tv"))
}

/// Browser URL the user opens to authorize the app:
/// `https://app.plex.tv/auth#?clientID=..&code=..&context[device][product]=hanoi`
/// (query keys percent-encoded exactly like `URLSearchParams`).
pub fn auth_url(pin: &Pin) -> String {
    let params = [
        ("clientID", pin.client_identifier.as_str()),
        ("code", pin.code.as_str()),
        ("context[device][product]", PRODUCT_NAME),
    ];
    let mut query = String::new();
    for (key, value) in params {
        if !query.is_empty() {
            query.push('&');
        }
        form_urlencode(key, &mut query);
        query.push('=');
        form_urlencode(value, &mut query);
    }
    format!("https://app.plex.tv/auth#?{query}")
}

/// `GET {PLEX_TV_URL}/api/v2/pins/{id}`; `Authorized` once `authToken` is a
/// non-empty string, `Pending` otherwise. An unparsable body counts as `Pending`.
pub fn poll_pin(pin: &Pin) -> Result<PinStatus> {
    const PREFIX: &str = "Failed to check Plex PIN";

    let url = format!("{PLEX_TV_URL}/api/v2/pins/{}", pin.id);
    let mut response = device_headers(plex_tv_agent().get(&url), &pin.client_identifier)
        .call()
        .map_err(|error| request_error(PREFIX, &error))?;
    let payload = response
        .body_mut()
        .read_json::<Value>()
        .map_err(|error| request_error(PREFIX, &error))?;
    Ok(pin_status(payload))
}

/// `parseStrict(pinSchema, ...)`: a response missing a required field is
/// logged and rejected.
fn parse_pin(payload: Value) -> Option<Pin> {
    match serde_json::from_value::<PinResponse>(payload) {
        Ok(parsed) => Some(Pin {
            id: parsed.id.into_string(),
            code: parsed.code,
            client_identifier: parsed.client_identifier,
            expires_in: parsed.expires_in.max(0.0) as u64,
        }),
        Err(error) => {
            log::error!("Plex response failed validation ({CREATE_CONTEXT}): {error}");
            None
        }
    }
}

/// Any shape that lacks a usable token means "not authorized yet".
fn pin_status(payload: Value) -> PinStatus {
    match serde_json::from_value::<PinPollResponse>(payload) {
        Ok(parsed) => match parsed.auth_token {
            Some(token) if !token.is_empty() => PinStatus::Authorized(token),
            _ => PinStatus::Pending,
        },
        Err(error) => {
            // The error never contains the payload, so no token can leak here.
            log::error!("Plex response failed validation ({POLL_CONTEXT}): {error}");
            PinStatus::Pending
        }
    }
}

/// `application/x-www-form-urlencoded` serialization, byte for byte what
/// `URLSearchParams.toString()` produces.
fn form_urlencode(value: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(HEX[usize::from(byte >> 4)] as char);
                out.push(HEX[usize::from(byte & 0x0f)] as char);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Pin, PinStatus, auth_url, parse_pin, pin_status};

    fn pin(client_identifier: &str, code: &str) -> Pin {
        Pin {
            id: "123".to_owned(),
            code: code.to_owned(),
            client_identifier: client_identifier.to_owned(),
            expires_in: 1800,
        }
    }

    #[test]
    fn auth_url_matches_url_search_params() {
        let url = auth_url(&pin("11111111-2222-3333-4444-555555555555", "A1B2"));
        assert_eq!(
            url,
            "https://app.plex.tv/auth#?clientID=11111111-2222-3333-4444-555555555555&code=A1B2&context%5Bdevice%5D%5Bproduct%5D=hanoi"
        );
    }

    #[test]
    fn auth_url_form_encodes_its_values() {
        // URLSearchParams: space -> "+", `*-._` literal, everything else %XX.
        let url = auth_url(&pin("a b+c/d", "*-._~!"));
        assert_eq!(
            url,
            "https://app.plex.tv/auth#?clientID=a+b%2Bc%2Fd&code=*-._%7E%21&context%5Bdevice%5D%5Bproduct%5D=hanoi"
        );
    }

    #[test]
    fn auth_url_percent_encodes_non_ascii_as_utf8() {
        assert!(auth_url(&pin("id", "é")).contains("code=%C3%A9"));
    }

    #[test]
    fn create_response_coerces_the_numeric_id() {
        let payload = serde_json::json!({
            "id": 3_582_921_641_u64,
            "code": "A1B2",
            "product": "hanoi",
            "trusted": false,
            "clientIdentifier": "11111111-2222-3333-4444-555555555555",
            "location": { "code": "GB", "city": "London" },
            "expiresIn": 1800,
            "createdAt": "2026-09-12T00:00:00Z",
            "expiresAt": "2026-09-12T00:30:00Z",
            "authToken": null,
            "newRegistration": null
        });
        assert_eq!(
            parse_pin(payload),
            Some(Pin {
                id: "3582921641".to_owned(),
                code: "A1B2".to_owned(),
                client_identifier: "11111111-2222-3333-4444-555555555555".to_owned(),
                expires_in: 1800,
            })
        );
    }

    #[test]
    fn create_response_accepts_a_string_id() {
        let payload = serde_json::json!({
            "id": "42", "code": "ZZZZ", "clientIdentifier": "c", "expiresIn": 900
        });
        assert_eq!(parse_pin(payload).expect("pin").id, "42");
    }

    #[test]
    fn create_response_without_a_code_is_rejected() {
        let payload = serde_json::json!({ "id": 1, "clientIdentifier": "c", "expiresIn": 900 });
        assert_eq!(parse_pin(payload), None);
    }

    #[test]
    fn poll_response_with_a_null_token_is_pending() {
        let payload = serde_json::json!({ "id": 1, "code": "A1B2", "authToken": null });
        assert_eq!(pin_status(payload), PinStatus::Pending);
    }

    #[test]
    fn poll_response_without_a_token_field_is_pending() {
        assert_eq!(
            pin_status(serde_json::json!({ "id": 1, "code": "A1B2" })),
            PinStatus::Pending
        );
    }

    #[test]
    fn poll_response_with_an_empty_token_is_pending() {
        assert_eq!(
            pin_status(serde_json::json!({ "authToken": "" })),
            PinStatus::Pending
        );
    }

    #[test]
    fn poll_response_with_a_token_authorizes() {
        let payload = serde_json::json!({
            "id": 1, "code": "A1B2", "authToken": "xyzzy", "newRegistration": false
        });
        assert_eq!(
            pin_status(payload),
            PinStatus::Authorized("xyzzy".to_owned())
        );
    }

    #[test]
    fn an_unparsable_poll_body_is_pending() {
        assert_eq!(
            pin_status(serde_json::json!(["not", "an", "object"])),
            PinStatus::Pending
        );
    }

    /// Network test: creates a real (unauthorised, harmless) PIN at plex.tv.
    /// Run with `cargo test -- --ignored`.
    #[test]
    #[ignore = "hits the real plex.tv API"]
    fn create_pin_against_plex_tv() {
        let client_identifier = uuid::Uuid::new_v4().to_string();
        let created = super::create_pin(&client_identifier).expect("plex.tv should issue a PIN");
        assert!(
            created.code.chars().count() >= 4,
            "unexpected code: {:?}",
            created.code
        );
        assert_eq!(created.client_identifier, client_identifier);
        assert!(!created.id.is_empty());
        assert!(created.expires_in > 0);
        assert_eq!(
            super::poll_pin(&created).expect("poll"),
            PinStatus::Pending,
            "a fresh PIN cannot already be authorized"
        );
    }
}
