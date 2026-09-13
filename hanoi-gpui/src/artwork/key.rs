//! Token-free addressing for one artwork object.
//!
//! Mirrors the identity half of `../../src/bun/plex/artwork/cache.ts`
//! (`containsTokenMaterial`, `assertSafeSourceQuery`, `canonicalSource`,
//! `canonicalVariant`, `normalizeRequest`) and the namespace helpers in
//! `../../src/bun/plex/artwork/fetcher.ts` (`artworkNamespace`,
//! `serverIdentityFromUrl`) plus `accountArtworkSource` from
//! `../../src/bun/index.ts`.
//!
//! Nothing in this module may ever see a Plex token: a source that carries
//! token material is rejected here, before a key, a filename or a URL exists.

use sha2::{Digest as _, Sha256};

/// Everything that looks like token material, in any percent-encoded form.
/// `cache.ts` matches `x-plex-token`; the renderer's own guard in
/// `../../src/mainview/artwork/index.ts` also matches the bare `plex-token`,
/// so the broader of the two rules is used.
const TOKEN_TEXT: &str = "plex-token";

/// `MAX_TOKEN_DECODE_DEPTH`: how many percent-decoding rounds a source is
/// unwrapped through before it is rejected outright.
const MAX_TOKEN_DECODE_DEPTH: usize = 32;

/// plex.tv's host, for `accountArtworkSource`.
const PLEX_TV_HOST: &str = "plex.tv";

/// Stable, non-secret identity of a cache partition (`ArtworkNamespace`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Namespace {
    /// The Plex account identity — a username or the client identifier, never a token.
    pub account_id: String,
    /// The Plex server identity — its client identifier or its token-free URL.
    pub server_id: String,
}

impl Namespace {
    /// `artworkNamespace` for media-server artwork.
    pub fn server(
        account_username: Option<&str>,
        fallback_account_id: &str,
        server_client_identifier: Option<&str>,
        server_url: &str,
    ) -> Option<Self> {
        let account_id = account_identity(account_username, fallback_account_id)?;
        let server_id = first_non_empty(server_client_identifier)
            .map(str::to_owned)
            .unwrap_or_else(|| server_identity_from_url(server_url));
        Some(Self {
            account_id,
            server_id: normalize_identity(&server_id)?,
        })
    }

    /// `accountArtworkNamespaceForConfig`: server id `plex-account`.
    #[allow(dead_code, reason = "backend contract the UI does not call yet")]
    pub fn account(account_username: Option<&str>, fallback_account_id: &str) -> Option<Self> {
        Some(Self {
            account_id: account_identity(account_username, fallback_account_id)?,
            server_id: "plex-account".to_owned(),
        })
    }
}

/// Where the bytes come from.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    /// A media-server path, e.g. `/library/metadata/123/thumb/456`.
    Server(String),
    /// A plex.tv avatar path or absolute URL (`accountArtworkSource`).
    #[allow(dead_code, reason = "backend contract the UI does not call yet")]
    Account(String),
}

/// Rendering parameters that distinguish one artwork object from another.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Variant {
    /// The object exactly as Plex stores it.
    #[default]
    Native,
    /// `/photo/:/transcode?width=..&height=..&url=..`.
    Transcoded { width: u32, height: u32 },
}

/// The renderer's fallback when a native object fails to load
/// (`TRANSCODED_FALLBACK_VARIANT`).
pub const FALLBACK_VARIANT: Variant = Variant::Transcoded {
    width: 512,
    height: 512,
};

impl Variant {
    /// `serializeVariant(canonicalVariant(..))`: the JSON the cache key is
    /// built from. Keys are sorted the way `localeCompare` sorts them
    /// (`height`, `kind`, `width`), so a Rust key matches the Electrobun
    /// app's key for the same object.
    pub(crate) fn canonical(self) -> String {
        match self {
            Self::Native => "[]".to_owned(),
            Self::Transcoded { width, height } => {
                format!(r#"[["height",{height}],["kind","transcoded"],["width",{width}]]"#)
            }
        }
    }

    /// `isTranscodedVariant`: a zero dimension is not a usable transcode, and
    /// the reference falls back to the native URL for it.
    pub(crate) fn transcode_size(self) -> Option<(u32, u32)> {
        match self {
            Self::Transcoded { width, height } if width > 0 && height > 0 => Some((width, height)),
            _ => None,
        }
    }
}

/// A fully addressed artwork object.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ArtworkKey {
    pub namespace: Namespace,
    pub source: Source,
    pub variant: Variant,
}

/// The secrets used to fetch one object; they never reach the cache key, the
/// disk or a URL.
#[derive(Clone)]
pub struct Credentials {
    /// Media-server base URL (ignored for `Source::Account`, which is plex.tv).
    pub base_url: String,
    pub token: String,
}

/// Redacted by hand: a derived `Debug` would put a live Plex token into the
/// first log line that formats a request.
impl std::fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Credentials")
            .field("base_url", &self.base_url)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// `normalizeRequest`: the canonical, token-free form of an `ArtworkKey`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Addressed {
    pub namespace: Namespace,
    /// The canonical source — what the sidecar stores and the URL is built from.
    pub source: String,
    pub variant: Variant,
    /// `sha256(account \0 server \0 source \0 variant)`, hex. Also the filename stem.
    pub digest: String,
    /// plex.tv rather than the media server (`Source::Account`).
    pub account: bool,
}

impl Addressed {
    /// `None` when the source is empty, malformed or carries token material —
    /// a rejected source never reaches the network.
    pub(crate) fn new(key: &ArtworkKey) -> Option<Self> {
        let namespace = Namespace {
            account_id: normalize_identity(&key.namespace.account_id)?,
            server_id: normalize_identity(&key.namespace.server_id)?,
        };
        let source = canonical_source(&key.source)?;
        let digest = artwork_digest(&namespace, &source, &key.variant.canonical());
        Some(Self {
            namespace,
            source,
            variant: key.variant,
            digest,
            account: matches!(key.source, Source::Account(_)),
        })
    }
}

/// `createHash("sha256").update([account, server, source, variant].join("\0"))`.
pub(crate) fn artwork_digest(
    namespace: &Namespace,
    canonical_source: &str,
    canonical_variant: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.account_id.as_bytes());
    hasher.update([0]);
    hasher.update(namespace.server_id.as_bytes());
    hasher.update([0]);
    hasher.update(canonical_source.as_bytes());
    hasher.update([0]);
    hasher.update(canonical_variant.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        // Writing into a String cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// `canonicalSource`: trim, reject token material and control characters, then
/// normalise the URL so two spellings of one object share a key.
pub(crate) fn canonical_source(source: &Source) -> Option<String> {
    let raw = match source {
        Source::Server(path) => path.trim().to_owned(),
        // plex.tv avatars are stored as a path so the key does not change when
        // plex.tv moves the object between hosts (`accountArtworkSource`).
        Source::Account(path) => account_artwork_source(path.trim()),
    };
    if raw.is_empty() || contains_token_material(&raw) || has_control_characters(&raw) {
        return None;
    }
    if is_absolute(&raw) {
        canonical_absolute(&raw)
    } else {
        canonical_relative(&raw)
    }
}

/// `accountArtworkSource`: a plex.tv URL becomes its path + query, any other
/// absolute URL is kept, an unparsable URL is dropped.
fn account_artwork_source(input: &str) -> String {
    if !is_absolute(input) {
        return input.to_owned();
    }
    let Some((_, authority, path_and_query)) = split_absolute(input) else {
        return String::new();
    };
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if host == PLEX_TV_HOST {
        let (path, query) = split_query(strip_fragment(path_and_query));
        let path = if path.is_empty() { "/" } else { path };
        return match query {
            Some(query) => format!("{path}?{query}"),
            None => path.to_owned(),
        };
    }
    input.to_owned()
}

/// `containsTokenMaterial`: the value, and every percent-decoding of it, must
/// be free of token material. An undecodable escape is treated as hostile.
pub(crate) fn contains_token_material(value: &str) -> bool {
    let mut candidate = value.to_owned();
    for _ in 0..=MAX_TOKEN_DECODE_DEPTH {
        if candidate.to_ascii_lowercase().contains(TOKEN_TEXT) {
            return true;
        }
        let Some(decoded) = percent_decode(&candidate) else {
            return true;
        };
        if decoded == candidate {
            return false;
        }
        candidate = decoded;
    }
    true
}

/// `hasControlCharacters`.
pub(crate) fn has_control_characters(value: &str) -> bool {
    value
        .chars()
        .any(|character| (character as u32) <= 31 || character == '\u{7f}')
}

/// `normalizeIdentity`: a trimmed, non-empty, non-secret identifier.
pub(crate) fn normalize_identity(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || contains_token_material(trimmed) || has_control_characters(trimmed) {
        return None;
    }
    Some(trimmed.to_owned())
}

/// The account half of `artworkNamespace`: the username, else the config's
/// client identifier.
fn account_identity(account_username: Option<&str>, fallback_account_id: &str) -> Option<String> {
    let account_id = first_non_empty(account_username).unwrap_or(fallback_account_id);
    normalize_identity(account_id)
}

fn first_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// `serverIdentityFromUrl`: the URL without credentials, query or fragment,
/// and without a trailing slash. `""` when it is not a URL at all.
fn server_identity_from_url(server_url: &str) -> String {
    let trimmed = server_url.trim();
    let Some((scheme, authority, path_and_query)) = split_absolute(trimmed) else {
        return String::new();
    };
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .to_ascii_lowercase();
    if authority.is_empty() {
        return String::new();
    }
    let (path, _) = split_query(strip_fragment(path_and_query));
    format!("{scheme}://{authority}{path}")
        .trim_end_matches('/')
        .to_owned()
}

/// `/^https?:\/\//iu`.
pub(crate) fn is_absolute(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered.starts_with("http://") || lowered.starts_with("https://")
}

/// Split an absolute URL into `(scheme, authority, path+query+fragment)`.
fn split_absolute(input: &str) -> Option<(String, &str, &str)> {
    let (scheme, rest) = input.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let split = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(split);
    if authority.is_empty() {
        return None;
    }
    Some((scheme, authority, tail))
}

fn strip_fragment(value: &str) -> &str {
    value.split('#').next().unwrap_or_default()
}

fn split_query(value: &str) -> (&str, Option<&str>) {
    match value.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (value, None),
    }
}

/// The absolute branch of `canonicalSource`: no credentials, no fragment,
/// sorted query, lower-cased scheme and authority.
fn canonical_absolute(input: &str) -> Option<String> {
    let (scheme, authority, tail) = split_absolute(input)?;
    // `url.username || url.password` — an absolute source must not carry
    // credentials of any kind.
    if authority.contains('@') {
        return None;
    }
    let authority = authority.to_ascii_lowercase();
    let (path, query) = split_query(strip_fragment(tail));
    let path = normalize_path(path);
    Some(format!(
        "{scheme}://{authority}{path}{}",
        canonical_query(query)
    ))
}

/// The relative branch: resolved against a dummy origin, so the result is
/// `${pathname}${search}` exactly as the reference produces it.
fn canonical_relative(input: &str) -> Option<String> {
    // A protocol-relative source would silently change hosts.
    if input.starts_with("//") {
        return None;
    }
    let (path, query) = split_query(strip_fragment(input));
    Some(format!(
        "{}{}",
        normalize_path(path),
        canonical_query(query)
    ))
}

/// A leading slash plus RFC 3986 dot-segment removal, which is what resolving
/// against a base URL does.
fn normalize_path(path: &str) -> String {
    if path.is_empty() {
        return "/".to_owned();
    }
    let trailing_slash = path.ends_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.trim_start_matches('/').split('/') {
        match segment {
            "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    let mut normalized = format!("/{}", segments.join("/"));
    if trailing_slash && !normalized.ends_with('/') {
        normalized.push('/');
    }
    normalized
}

/// `searchParams.sort()`: a stable sort by parameter name, empty pairs
/// dropped. The values are left exactly as Plex spelled them — they have
/// already been proven token-free.
fn canonical_query(query: Option<&str>) -> String {
    let Some(query) = query else {
        return String::new();
    };
    let mut pairs: Vec<&str> = query.split('&').filter(|pair| !pair.is_empty()).collect();
    if pairs.is_empty() {
        return String::new();
    }
    pairs.sort_by_key(|pair| pair.split_once('=').map_or(*pair, |(name, _)| name));
    format!("?{}", pairs.join("&"))
}

/// `decodeURIComponent`: `None` when the escape sequence is malformed or the
/// bytes are not UTF-8, which the reference treats as a failed decode.
fn percent_decode(value: &str) -> Option<String> {
    if !value.contains('%') {
        return Some(value.to_owned());
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::{
        Addressed, ArtworkKey, FALLBACK_VARIANT, Namespace, Source, Variant, artwork_digest,
        canonical_source, contains_token_material, normalize_identity, server_identity_from_url,
    };

    fn namespace() -> Namespace {
        Namespace {
            account_id: "alexr".to_owned(),
            server_id: "home-id".to_owned(),
        }
    }

    fn addressed(source: Source, variant: Variant) -> Option<Addressed> {
        Addressed::new(&ArtworkKey {
            namespace: namespace(),
            source,
            variant,
        })
    }

    #[test]
    fn server_namespaces_prefer_the_username_and_the_client_identifier() {
        assert_eq!(
            Namespace::server(
                Some("alexr"),
                "client-id",
                Some("home-id"),
                "http://x:32400"
            ),
            Some(namespace())
        );
    }

    #[test]
    fn a_missing_username_or_identifier_falls_back() {
        let derived = Namespace::server(None, "client-id", None, "http://192.168.1.10:32400/")
            .expect("namespace");
        assert_eq!(derived.account_id, "client-id");
        assert_eq!(
            derived.server_id, "http://192.168.1.10:32400",
            "the token-free, query-free URL identifies the server"
        );
        let blank = Namespace::server(
            Some("  "),
            "client-id",
            Some(""),
            "http://192.168.1.10:32400",
        )
        .expect("namespace");
        assert_eq!(blank, derived, "empty strings fall back too");
    }

    #[test]
    fn a_namespace_without_a_stable_identity_is_rejected() {
        assert_eq!(
            Namespace::server(None, "   ", Some("home-id"), "http://x"),
            None
        );
        assert_eq!(
            Namespace::server(Some("alexr"), "c", None, "not-a-url"),
            None
        );
        assert_eq!(
            Namespace::server(Some("alexr"), "c", Some("x-plex-token=abc"), "http://x"),
            None,
            "token material can never become an identity"
        );
        assert_eq!(normalize_identity("bad\u{1}id"), None);
    }

    #[test]
    fn account_namespaces_use_the_plex_account_server_id() {
        let account = Namespace::account(Some("alexr"), "client-id").expect("namespace");
        assert_eq!(account.account_id, "alexr");
        assert_eq!(account.server_id, "plex-account");
        assert_eq!(
            Namespace::account(None, "client-id")
                .expect("namespace")
                .account_id,
            "client-id"
        );
        assert_eq!(Namespace::account(None, ""), None);
    }

    #[test]
    fn server_identities_drop_credentials_and_queries() {
        assert_eq!(
            server_identity_from_url("https://user:pass@Home.plex.direct:32400/base/?x=1#f"),
            "https://home.plex.direct:32400/base"
        );
        assert_eq!(server_identity_from_url("ftp://host"), "");
        assert_eq!(server_identity_from_url(""), "");
    }

    #[test]
    fn token_material_is_detected_through_percent_encoding() {
        assert!(contains_token_material("/photo?X-Plex-Token=abc"));
        assert!(contains_token_material("/photo?%78-plex-token=abc"));
        assert!(contains_token_material("/photo?%2578-plex-token=abc"));
        assert!(contains_token_material("/photo?url=%25%32%35x-plex-token"));
        assert!(contains_token_material("/photo?plex-token=abc"));
        assert!(
            contains_token_material("/photo?x=%zz"),
            "an undecodable escape is treated as hostile"
        );
        assert!(!contains_token_material(
            "/library/metadata/1/thumb/1700000000"
        ));
        assert!(!contains_token_material("/photo/:/transcode?width=512"));
    }

    #[test]
    fn a_source_carrying_a_token_never_produces_a_key() {
        assert_eq!(
            addressed(
                Source::Server("/photo?X-Plex-Token=secret".to_owned()),
                Variant::Native
            ),
            None
        );
        assert_eq!(
            addressed(
                Source::Server("https://host/photo?url=%78-plex-token%3Dsecret".to_owned()),
                Variant::Native
            ),
            None
        );
        assert_eq!(
            addressed(Source::Server("   ".to_owned()), Variant::Native),
            None
        );
        assert_eq!(
            addressed(Source::Server("//evil/thumb".to_owned()), Variant::Native),
            None
        );
        assert_eq!(
            addressed(
                Source::Server("https://user:pw@host/thumb".to_owned()),
                Variant::Native
            ),
            None
        );
    }

    #[test]
    fn sources_are_canonicalised_before_they_are_hashed() {
        let canonical = |source: &str| {
            canonical_source(&Source::Server(source.to_owned())).expect("canonical source")
        };
        assert_eq!(
            canonical("  /library/metadata/1/thumb/2  "),
            "/library/metadata/1/thumb/2"
        );
        assert_eq!(
            canonical("library/metadata/1/thumb/2"),
            "/library/metadata/1/thumb/2"
        );
        assert_eq!(canonical("/a/./b/../c?b=2&a=1#frag"), "/a/c?a=1&b=2");
        assert_eq!(
            canonical("HTTPS://Images.Plex.TV/photo?b=2&a=1"),
            "https://images.plex.tv/photo?a=1&b=2"
        );
        assert_eq!(
            canonical("https://images.plex.tv"),
            "https://images.plex.tv/"
        );
    }

    #[test]
    fn account_sources_are_reduced_to_a_plex_tv_path() {
        let canonical =
            |source: &str| canonical_source(&Source::Account(source.to_owned())).expect("source");
        assert_eq!(
            canonical("https://plex.tv/users/abc/avatar?c=1"),
            "/users/abc/avatar?c=1"
        );
        assert_eq!(canonical("/users/abc/avatar?c=1"), "/users/abc/avatar?c=1");
        assert_eq!(
            canonical("https://images.plex.tv/photo/abc"),
            "https://images.plex.tv/photo/abc",
            "only plex.tv itself is reduced to a path"
        );
        assert_eq!(
            canonical_source(&Source::Account("http://".to_owned())),
            None
        );
    }

    #[test]
    fn keys_are_stable_and_partitioned_by_every_component() {
        let native =
            addressed(Source::Server("/thumb/1".to_owned()), Variant::Native).expect("addressed");
        assert_eq!(native.digest.len(), 64);
        assert!(native.digest.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            native,
            addressed(Source::Server(" /thumb/1 ".to_owned()), Variant::Native).expect("addressed"),
            "a re-spelled source addresses the same object"
        );

        let transcoded =
            addressed(Source::Server("/thumb/1".to_owned()), FALLBACK_VARIANT).expect("addressed");
        assert_ne!(
            native.digest, transcoded.digest,
            "the variant partitions the key"
        );

        let other_source =
            addressed(Source::Server("/thumb/2".to_owned()), Variant::Native).expect("addressed");
        assert_ne!(native.digest, other_source.digest);

        let other_namespace = Addressed::new(&ArtworkKey {
            namespace: Namespace {
                account_id: "someone-else".to_owned(),
                server_id: "home-id".to_owned(),
            },
            source: Source::Server("/thumb/1".to_owned()),
            variant: Variant::Native,
        })
        .expect("addressed");
        assert_ne!(
            native.digest, other_namespace.digest,
            "the namespace partitions the key"
        );
    }

    #[test]
    fn the_digest_matches_the_typescript_cache() {
        // sha256("alexr\0home-id\0/thumb/1\0[]") — the same bytes
        // `normalizeRequest` hashes, so both implementations name one object
        // identically.
        assert_eq!(
            artwork_digest(&namespace(), "/thumb/1", &Variant::Native.canonical()),
            "c0fc524d0b928160c0736ac93d8ae5a9413190f4040fb8205101623840706212"
        );
        assert_eq!(
            artwork_digest(&namespace(), "/thumb/1", &FALLBACK_VARIANT.canonical()),
            "ab6113a2d2f942ce703fd069b9e4f706c26a19fc7c2caaca9ff083eaf29fef68"
        );
        assert_eq!(
            FALLBACK_VARIANT.canonical(),
            r#"[["height",512],["kind","transcoded"],["width",512]]"#
        );
        assert_eq!(Variant::Native.canonical(), "[]");
    }
}
