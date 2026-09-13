//! The artwork network layer: `../../src/bun/plex/artwork/fetcher.ts`
//! (`buildArtworkUrl`, `fetchArtwork`) plus the response validation
//! `cache.ts` performs in `normalizeResponse`.
//!
//! The token lives in `Credentials` and reaches exactly one place: the
//! `X-Plex-Token` header of a relative-source request. It is never a query
//! parameter, and an absolute source is fetched without it.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use ureq::Agent;

use super::key::{Variant, contains_token_material, has_control_characters, is_absolute};

/// `IMAGE_MIME_TYPES`: the only content types an artwork object may have.
const IMAGE_MIME_TYPES: [&str; 15] = [
    "image/apng",
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/jp2",
    "image/jxl",
    "image/png",
    "image/svg+xml",
    "image/tiff",
    "image/webp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
];

/// Artwork is bigger than a JSON payload and often comes from a transcoder
/// that has to render it first, so the ceiling is generous — but it exists so
/// a stalled socket cannot pin a background thread forever.
const ARTWORK_TIMEOUT: Duration = Duration::from_secs(60);

/// One conditional artwork request. The credentials are the caller's; nothing
/// here is persisted.
pub(crate) struct FetchRequest<'a> {
    /// The media server's base URL, or plex.tv for an account source.
    pub base_url: &'a str,
    pub token: &'a str,
    /// The canonical (token-free) source.
    pub source: &'a str,
    pub variant: Variant,
    pub etag: Option<&'a str>,
    pub last_modified: Option<&'a str>,
    pub max_object_bytes: u64,
}

/// What the network said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FetchOutcome {
    /// HTTP 304: the cached object is still current.
    NotModified {
        etag: Option<String>,
        last_modified: Option<String>,
    },
    /// HTTP 200 with a validated image body.
    Body {
        data: Vec<u8>,
        content_type: String,
        etag: Option<String>,
        last_modified: Option<String>,
    },
}

/// The injectable network layer (`ArtworkFetcher`). Tests substitute their own.
pub(crate) trait Fetch: Send + Sync {
    fn fetch(&self, request: FetchRequest<'_>) -> Result<FetchOutcome>;
}

/// `createArtworkFetcher`: blocking HTTP through ureq.
pub(crate) struct HttpFetcher;

impl Fetch for HttpFetcher {
    fn fetch(&self, request: FetchRequest<'_>) -> Result<FetchOutcome> {
        let url = build_artwork_url(request.base_url, request.source, request.variant);
        let mut builder = agent().get(&url).header("Accept", "image/*");
        // `fetchArtwork`: an absolute source is somebody else's host, so the
        // token stays at home.
        if !is_absolute(request.source) {
            builder = builder.header("X-Plex-Token", request.token);
        }
        if let Some(etag) = request.etag.filter(|value| !value.is_empty()) {
            builder = builder.header("If-None-Match", etag);
        }
        if let Some(last_modified) = request.last_modified.filter(|value| !value.is_empty()) {
            builder = builder.header("If-Modified-Since", last_modified);
        }

        let mut response = builder.call().map_err(|error| match error {
            ureq::Error::StatusCode(code) => anyhow!("Artwork request failed: {code}"),
            other => anyhow!("Artwork request failed: {other}"),
        })?;

        let etag = safe_header(header(&response, "etag"))?;
        let last_modified = safe_header(header(&response, "last-modified"))?;
        if response.status().as_u16() == 304 {
            return Ok(FetchOutcome::NotModified {
                etag,
                last_modified,
            });
        }
        if !response.status().is_success() {
            bail!("Artwork request failed: {}", response.status().as_u16());
        }

        let content_type = header(&response, "content-type")
            .unwrap_or_default()
            .to_owned();
        // Reject on the advertised length before reading a byte of a huge object.
        if let Some(length) =
            header(&response, "content-length").and_then(|value| value.parse::<u64>().ok())
            && length > request.max_object_bytes
        {
            bail!(
                "Artwork exceeds the {}-byte limit",
                request.max_object_bytes
            );
        }
        let data = response
            .body_mut()
            .with_config()
            // One byte past the cap, so an oversized body is detected rather
            // than silently truncated.
            .limit(request.max_object_bytes.saturating_add(1))
            .read_to_vec()
            .map_err(|error| anyhow!("Artwork request failed: {error}"))?;
        let content_type = validate_body(&data, &content_type, request.max_object_bytes)?;
        Ok(FetchOutcome::Body {
            data,
            content_type,
            etag,
            last_modified,
        })
    }
}

/// `buildArtworkUrl`: a transcode URL, an absolute source as-is, or the path
/// hung off the base URL. The token is never part of it.
pub(crate) fn build_artwork_url(base_url: &str, path: &str, variant: Variant) -> String {
    let base = base_url.trim_end_matches('/');
    if let Some((width, height)) = variant.transcode_size() {
        // `URLSearchParams` insertion order: width, height, url.
        return format!(
            "{base}/photo/:/transcode?width={width}&height={height}&url={}",
            form_urlencoded(path)
        );
    }
    if is_absolute(path) {
        return path.to_owned();
    }
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

/// `assertImageContentType` + `normalizeContentType` + the body checks in
/// `normalizeResponse`: an object is cached only if it really is an image.
pub(crate) fn validate_body(
    data: &[u8],
    content_type: &str,
    max_object_bytes: u64,
) -> Result<String> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !IMAGE_MIME_TYPES.contains(&mime.as_str()) {
        bail!("Artwork response must have an image content type");
    }
    if data.is_empty() {
        bail!("Artwork response has an empty body");
    }
    if data.len() as u64 > max_object_bytes {
        bail!("Artwork exceeds the {max_object_bytes}-byte limit");
    }
    Ok(mime)
}

/// Whether a stored content type is still one of the allowed image types.
pub(crate) fn is_image_content_type(content_type: &str) -> bool {
    IMAGE_MIME_TYPES.contains(&content_type)
}

/// `safeHeader`: a validator that is echoed back to Plex must not smuggle
/// control characters or token material into the cache.
pub(crate) fn safe_header(value: Option<&str>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(value) if value.is_empty() => Ok(None),
        Some(value) if has_control_characters(value) || contains_token_material(value) => {
            Err(anyhow!("Artwork response contains an unsafe validator"))
        }
        Some(value) => Ok(Some(value.to_owned())),
    }
}

fn header<'a>(response: &'a ureq::http::Response<ureq::Body>, name: &str) -> Option<&'a str> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

fn agent() -> Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            Agent::new_with_config(
                Agent::config_builder()
                    .timeout_global(Some(ARTWORK_TIMEOUT))
                    .build(),
            )
        })
        .clone()
}

/// `URLSearchParams` encoding: unreserved characters pass through, a space
/// becomes `+`, everything else is percent-encoded from its UTF-8 bytes.
fn form_urlencoded(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                encoded.push(byte as char);
            }
            b' ' => encoded.push('+'),
            other => {
                use std::fmt::Write as _;
                // Writing into a String cannot fail.
                let _ = write!(encoded, "%{other:02X}");
            }
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{build_artwork_url, safe_header, validate_body};
    use crate::artwork::key::{FALLBACK_VARIANT, Variant};

    #[test]
    fn native_sources_hang_off_the_base_url() {
        assert_eq!(
            build_artwork_url(
                "http://192.168.1.10:32400/",
                "/library/metadata/1/thumb/2",
                Variant::Native
            ),
            "http://192.168.1.10:32400/library/metadata/1/thumb/2"
        );
        assert_eq!(
            build_artwork_url("http://host:32400", "library/metadata/1", Variant::Native),
            "http://host:32400/library/metadata/1"
        );
    }

    #[test]
    fn absolute_sources_are_used_verbatim() {
        assert_eq!(
            build_artwork_url(
                "http://host:32400",
                "https://images.plex.tv/photo/abc",
                Variant::Native
            ),
            "https://images.plex.tv/photo/abc"
        );
    }

    #[test]
    fn transcoded_sources_percent_encode_the_path() {
        assert_eq!(
            build_artwork_url(
                "http://host:32400/",
                "/library/metadata/1/thumb/2?a=b c",
                FALLBACK_VARIANT
            ),
            "http://host:32400/photo/:/transcode?width=512&height=512&url=%2Flibrary%2Fmetadata%2F1%2Fthumb%2F2%3Fa%3Db+c"
        );
        assert_eq!(
            build_artwork_url(
                "http://host",
                "https://images.plex.tv/x",
                Variant::Transcoded {
                    width: 300,
                    height: 200
                }
            ),
            "http://host/photo/:/transcode?width=300&height=200&url=https%3A%2F%2Fimages.plex.tv%2Fx",
            "a transcode always goes through the server, even for an absolute source"
        );
    }

    #[test]
    fn a_degenerate_transcode_falls_back_to_the_native_url() {
        assert_eq!(
            build_artwork_url(
                "http://host",
                "/thumb/1",
                Variant::Transcoded {
                    width: 0,
                    height: 512
                }
            ),
            "http://host/thumb/1"
        );
    }

    #[test]
    fn only_allowlisted_image_types_are_accepted() {
        assert_eq!(
            validate_body(b"x", "image/jpeg", 100).expect("valid"),
            "image/jpeg"
        );
        assert_eq!(
            validate_body(b"x", "Image/PNG; charset=binary", 100).expect("valid"),
            "image/png"
        );
        assert!(validate_body(b"x", "text/html", 100).is_err());
        assert!(validate_body(b"x", "", 100).is_err());
        assert!(validate_body(b"", "image/png", 100).is_err());
        assert!(validate_body(b"xxx", "image/png", 2).is_err());
    }

    #[test]
    fn unsafe_validators_are_rejected() {
        assert_eq!(safe_header(None).expect("none"), None);
        assert_eq!(safe_header(Some("")).expect("empty"), None);
        assert_eq!(
            safe_header(Some("W/\"abc\"")).expect("etag"),
            Some("W/\"abc\"".to_owned())
        );
        assert!(safe_header(Some("x-plex-token=secret")).is_err());
        assert!(safe_header(Some("bad\u{1}etag")).is_err());
    }
}
