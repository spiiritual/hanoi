//! Shared HTTP plumbing: the plex.tv device headers, the blocking agents and
//! the error messages the TypeScript client produces (`"<what>: 401 Unauthorized"`).

use std::sync::OnceLock;
use std::time::Duration;

use ureq::{Agent, RequestBuilder};

use super::{PRODUCT_NAME, STATUS_TIMEOUT_MS};

/// How long a plex.tv call may take before it is treated as a network
/// failure. The reference `fetch` calls set no timeout, but ureq would then
/// block a background thread forever on a stalled connection and the OAuth
/// screen's poll loop would never tick again; 30 s is far longer than any
/// healthy plex.tv response.
const PLEX_TV_TIMEOUT: Duration = Duration::from_secs(30);

/// Agent for plex.tv calls; the UI runs every call on a background thread.
pub(super) fn plex_tv_agent() -> Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            Agent::new_with_config(
                Agent::config_builder()
                    .timeout_global(Some(PLEX_TV_TIMEOUT))
                    .build(),
            )
        })
        .clone()
}

/// Agent for media-server calls (`/hubs`, `/library/...`). The reference
/// `PlexClient.request` sets no timeout either, but a stalled socket would pin
/// a background thread forever; a home screen that has not answered in 30 s is
/// a failure the retry button exists for.
pub(super) fn media_agent() -> Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            Agent::new_with_config(
                Agent::config_builder()
                    .timeout_global(Some(PLEX_TV_TIMEOUT))
                    .build(),
            )
        })
        .clone()
}

/// Agent for `/identity` reachability probes: `STATUS_TIMEOUT_MS` end-to-end,
/// matching `AbortSignal.timeout(DEFAULT_STATUS_TIMEOUT_MS)` in `client.ts`.
pub(super) fn status_agent() -> Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            Agent::new_with_config(
                Agent::config_builder()
                    .timeout_global(Some(Duration::from_millis(STATUS_TIMEOUT_MS)))
                    .build(),
            )
        })
        .clone()
}

/// The headers every plex.tv call identifies this client with (`DEVICE_HEADERS`
/// plus `Accept` and the client identifier in `auth.ts`).
pub(super) fn device_headers<Any>(
    request: RequestBuilder<Any>,
    client_identifier: &str,
) -> RequestBuilder<Any> {
    request
        .header("Accept", "application/json")
        .header("X-Plex-Client-Identifier", client_identifier)
        .header("X-Plex-Product", PRODUCT_NAME)
        .header("X-Plex-Device-Name", PRODUCT_NAME)
        .header("X-Plex-Platform", std::env::consts::OS)
}

/// Turn a transport/status failure into the message the reference throws:
/// `"Failed to create Plex PIN: 401 Unauthorized"`. ureq reports 4xx/5xx as
/// `Error::StatusCode`, so the reason phrase is recovered from the code.
pub(super) fn request_error(prefix: &str, error: &ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::StatusCode(code) => {
            let reason: &str = ureq::http::StatusCode::from_u16(*code)
                .ok()
                .and_then(|status| status.canonical_reason())
                .unwrap_or_default();
            if reason.is_empty() {
                anyhow::anyhow!("{prefix}: {code}")
            } else {
                anyhow::anyhow!("{prefix}: {code} {reason}")
            }
        }
        other => anyhow::anyhow!("{prefix}: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::request_error;

    #[test]
    fn status_errors_read_like_the_reference() {
        let error = request_error("Failed to create Plex PIN", &ureq::Error::StatusCode(401));
        assert_eq!(
            error.to_string(),
            "Failed to create Plex PIN: 401 Unauthorized"
        );
    }

    #[test]
    fn unknown_status_codes_drop_the_reason_phrase() {
        let error = request_error("Failed to check Plex PIN", &ureq::Error::StatusCode(599));
        assert_eq!(error.to_string(), "Failed to check Plex PIN: 599");
    }

    #[test]
    fn transport_errors_keep_their_own_message() {
        let error = request_error(
            "Failed to discover Plex servers",
            &ureq::Error::HostNotFound,
        );
        assert!(
            error
                .to_string()
                .starts_with("Failed to discover Plex servers: "),
            "unexpected message: {error}"
        );
    }
}
