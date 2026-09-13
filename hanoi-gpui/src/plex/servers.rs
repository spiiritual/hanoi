//! Server discovery: `discoverServers` / `connectionCandidates` in
//! `../../src/bun/plex/auth.ts` plus `discoverPlexServers`,
//! `selectReachableConnection` and `checkPlexServerStatus` in `client.ts`,
//! and `findPersistedServer` from `server-selection.ts`.

use std::sync::mpsc;
use std::thread;

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use super::http::{device_headers, plex_tv_agent, request_error, status_agent};
use super::{PLEX_TV_URL, ServerConfig, ServerInfo};

const RESOURCES_CONTEXT: &str = "plex.tv /api/v2/resources";

/// `serverResourceSchema`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceResponse {
    name: String,
    client_identifier: String,
    owned: bool,
    /// null on non-server devices (e.g. Plexamp clients); servers may also omit it.
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    provides: Option<String>,
    #[serde(default)]
    connections: Option<Vec<ConnectionResponse>>,
}

/// `connectionSchema`; only `uri`, `local` and `relay` are consumed here.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ConnectionResponse {
    uri: String,
    local: bool,
    #[serde(default)]
    relay: Option<bool>,
}

/// One resource with everything the probe threads need.
struct PreparedServer {
    resource: ResourceResponse,
    /// Per-server access token, falling back to the account token.
    token: String,
    candidates: Vec<ConnectionResponse>,
}

/// `GET {PLEX_TV_URL}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`,
/// keep resources that are `owned` and whose `provides` contains "server",
/// then for each one probe its connections (local direct first, then other
/// direct, then relay) with `check_server_status` and pick the first
/// reachable one. `online` is whether any probe succeeded; `url` falls back
/// to the first candidate when none is reachable (or "" with no candidates).
/// Servers are probed in parallel (one thread per server).
pub fn discover_servers(token: &str, client_identifier: &str) -> Result<Vec<ServerInfo>> {
    let prepared: Vec<PreparedServer> = fetch_resources(token, client_identifier)?
        .into_iter()
        .map(|resource| PreparedServer {
            token: resource
                .access_token
                .clone()
                .unwrap_or_else(|| token.to_owned()),
            candidates: connection_candidates(&resource),
            resource,
        })
        .collect();

    let selected: Vec<Option<ConnectionResponse>> = thread::scope(|scope| {
        let handles: Vec<_> = prepared
            .iter()
            .map(|server| {
                scope.spawn(move || select_reachable_connection(&server.candidates, &server.token))
            })
            .collect();
        handles
            .into_iter()
            // A panicking probe thread would be a bug; treat it as unreachable
            // rather than failing the whole discovery.
            .map(|handle| handle.join().unwrap_or_default())
            .collect()
    });

    Ok(prepared
        .into_iter()
        .zip(selected)
        .map(|(server, selected)| to_server_info(server, selected))
        .collect())
}

/// The `discoverPlexServers` mapping: the reachable connection if there is
/// one, otherwise the best candidate as an offline fallback.
fn to_server_info(server: PreparedServer, selected: Option<ConnectionResponse>) -> ServerInfo {
    let online = selected.is_some();
    let connection = selected.or_else(|| server.candidates.into_iter().next());
    ServerInfo {
        name: server.resource.name,
        client_identifier: server.resource.client_identifier,
        local: connection.as_ref().is_some_and(|c| c.local),
        online,
        url: connection.map_or_else(String::new, |c| c.uri),
        token: server.token,
    }
}

/// `GET {url}/identity` with a `STATUS_TIMEOUT_MS` timeout; `true` on 2xx.
pub fn check_server_status(url: &str, token: &str) -> bool {
    let base = url.trim_end_matches('/');
    if base.is_empty() {
        return false;
    }
    match status_agent()
        .get(format!("{base}/identity"))
        .header("Accept", "application/json")
        .header("X-Plex-Token", token)
        .call()
    {
        Ok(response) => response.status().is_success(),
        // Unreachable, timed out, TLS failure or a 4xx/5xx status: not online.
        Err(_) => false,
    }
}

/// Find the discovered server that matches a persisted one: by
/// `client_identifier`, then by `url`, then by `name` (legacy configs).
#[allow(dead_code, reason = "backend contract the UI does not call yet")]
pub fn find_persisted_server<'a>(
    persisted: &ServerConfig,
    discovered: &'a [ServerInfo],
) -> Option<&'a ServerInfo> {
    let by_identifier = persisted
        .client_identifier
        .as_deref()
        .filter(|identifier| !identifier.is_empty())
        .and_then(|identifier| {
            discovered
                .iter()
                .find(|server| server.client_identifier == identifier)
        });
    by_identifier
        .or_else(|| discovered.iter().find(|s| s.url == persisted.url))
        .or_else(|| discovered.iter().find(|s| s.name == persisted.name))
}

fn fetch_resources(token: &str, client_identifier: &str) -> Result<Vec<ResourceResponse>> {
    const PREFIX: &str = "Failed to discover Plex servers";

    let url = format!("{PLEX_TV_URL}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1");
    let mut response = device_headers(plex_tv_agent().get(&url), client_identifier)
        .header("X-Plex-Token", token)
        .call()
        .map_err(|error| request_error(PREFIX, &error))?;
    let payload = response
        .body_mut()
        .read_json::<Value>()
        .map_err(|error| request_error(PREFIX, &error))?;
    Ok(owned_servers(parse_resources(&payload)))
}

/// `filterItems(serverResourceSchema, ...)`: one malformed device must not
/// wipe the whole list, so invalid items are logged and dropped.
fn parse_resources(payload: &Value) -> Vec<ResourceResponse> {
    let Some(items) = payload.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(
            |item| match serde_json::from_value::<ResourceResponse>(item.clone()) {
                Ok(resource) => Some(resource),
                Err(error) => {
                    log::error!(
                        "Plex item failed validation ({RESOURCES_CONTEXT}); dropped: {error}"
                    );
                    None
                }
            },
        )
        .collect()
}

fn owned_servers(resources: Vec<ResourceResponse>) -> Vec<ResourceResponse> {
    resources
        .into_iter()
        .filter(|resource| {
            resource.owned
                && resource
                    .provides
                    .as_deref()
                    .is_some_and(|provides| provides.contains("server"))
        })
        .collect()
}

/// Local direct first, then other direct connections (such as Tailscale),
/// then relay. Plex's own order is preserved within each tier.
fn connection_candidates(resource: &ResourceResponse) -> Vec<ConnectionResponse> {
    let mut candidates: Vec<ConnectionResponse> = resource
        .connections
        .iter()
        .flatten()
        .filter(|connection| !connection.uri.is_empty())
        .cloned()
        .collect();
    // `sort_by_key` is stable, which is what the reference's index tiebreak does.
    candidates.sort_by_key(connection_priority);
    candidates
}

fn connection_priority(connection: &ConnectionResponse) -> u8 {
    if connection.relay == Some(true) {
        2
    } else if connection.local {
        0
    } else {
        1
    }
}

/// `selectReachableConnection`: probe every candidate at once and take the
/// first that answers (`Promise.any`). The probes are detached because the
/// losers only run until their 3 s timeout expires.
fn select_reachable_connection(
    candidates: &[ConnectionResponse],
    token: &str,
) -> Option<ConnectionResponse> {
    if candidates.is_empty() {
        return None;
    }
    let (sender, receiver) = mpsc::channel();
    for candidate in candidates {
        let sender = sender.clone();
        let candidate = candidate.clone();
        let token = token.to_owned();
        thread::spawn(move || {
            let reachable = check_server_status(&candidate.uri, &token);
            // The receiver is gone once a winner is found; that is expected.
            let _ = sender.send(reachable.then_some(candidate));
        });
    }
    drop(sender);
    // Ends when a probe succeeds, or when every probe has reported a failure.
    receiver.into_iter().flatten().next()
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectionResponse, PreparedServer, ServerConfig, ServerInfo, connection_candidates,
        find_persisted_server, owned_servers, parse_resources, select_reachable_connection,
        to_server_info,
    };

    fn resources_fixture() -> serde_json::Value {
        serde_json::json!([
            {
                "name": "Alex's iPhone",
                "product": "Plexamp",
                "clientIdentifier": "phone-id",
                "provides": "client,controller,player,pubsub-player",
                "owned": true,
                "accessToken": null,
                "connections": []
            },
            {
                "name": "Home Server",
                "product": "Plex Media Server",
                "clientIdentifier": "home-id",
                "provides": "server",
                "owned": true,
                "accessToken": "server-token",
                "connections": [
                    { "protocol": "https", "address": "1.2.3.4", "port": 32400,
                      "uri": "https://1-2-3-4.abc.plex.direct:32400", "local": false, "relay": false, "IPv6": false },
                    { "protocol": "http", "address": "192.168.1.10", "port": 32400,
                      "uri": "http://192.168.1.10:32400", "local": true, "relay": false, "IPv6": false },
                    { "protocol": "https", "address": "1.2.3.4", "port": 8443,
                      "uri": "https://abc.plex.direct:8443", "local": false, "relay": true, "IPv6": false }
                ]
            },
            {
                "name": "A Friend's Server",
                "clientIdentifier": "friend-id",
                "provides": "server",
                "owned": false,
                "accessToken": "shared-token"
            },
            { "name": "Broken", "provides": "server", "owned": true }
        ])
    }

    #[test]
    fn resources_parse_leniently_and_filter_to_owned_servers() {
        let parsed = parse_resources(&resources_fixture());
        // The device with `accessToken: null` parses; only the entry missing
        // `clientIdentifier` is dropped.
        assert_eq!(parsed.len(), 3, "one invalid item should be dropped");
        assert_eq!(parsed[0].access_token, None);

        let owned = owned_servers(parsed);
        let names: Vec<&str> = owned.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["Home Server"]);
        assert_eq!(owned[0].access_token.as_deref(), Some("server-token"));
        assert_eq!(owned[0].connections.as_ref().expect("connections").len(), 3);
    }

    #[test]
    fn a_non_array_payload_yields_no_resources() {
        assert!(parse_resources(&serde_json::json!({ "MediaContainer": {} })).is_empty());
    }

    #[test]
    fn candidates_are_ordered_local_then_direct_then_relay() {
        let resources = parse_resources(&resources_fixture());
        let server = resources
            .into_iter()
            .find(|r| r.client_identifier == "home-id")
            .expect("server");
        let uris: Vec<String> = connection_candidates(&server)
            .into_iter()
            .map(|c| c.uri)
            .collect();
        assert_eq!(
            uris,
            vec![
                "http://192.168.1.10:32400",
                "https://1-2-3-4.abc.plex.direct:32400",
                "https://abc.plex.direct:8443",
            ]
        );
    }

    #[test]
    fn ordering_is_stable_within_a_tier_and_drops_empty_uris() {
        let payload = serde_json::json!([{
            "name": "Multi", "clientIdentifier": "multi", "provides": "server", "owned": true,
            "connections": [
                { "uri": "https://relay-a", "local": false, "relay": true },
                { "uri": "", "local": true },
                { "uri": "https://direct-a", "local": false },
                { "uri": "http://local-a", "local": true },
                { "uri": "https://direct-b", "local": false, "relay": false },
                { "uri": "https://relay-b", "local": false, "relay": true },
                { "uri": "http://local-b", "local": true, "relay": false }
            ]
        }]);
        let resources = parse_resources(&payload);
        let uris: Vec<String> = connection_candidates(&resources[0])
            .into_iter()
            .map(|c| c.uri)
            .collect();
        assert_eq!(
            uris,
            vec![
                "http://local-a",
                "http://local-b",
                "https://direct-a",
                "https://direct-b",
                "https://relay-a",
                "https://relay-b",
            ],
            "empty URIs are dropped and Plex's order is kept inside each tier"
        );
    }

    #[test]
    fn a_resource_without_connections_has_no_candidates() {
        let resources = parse_resources(&serde_json::json!([
            { "name": "Bare", "clientIdentifier": "bare", "provides": "server", "owned": true }
        ]));
        assert!(connection_candidates(&resources[0]).is_empty());
    }

    #[test]
    fn unreachable_candidates_select_nothing() {
        // Port 1 on the loopback interface refuses instantly.
        let candidates = vec![ConnectionResponse {
            uri: "http://127.0.0.1:1".to_owned(),
            local: true,
            relay: None,
        }];
        assert_eq!(select_reachable_connection(&candidates, "token"), None);
        assert_eq!(select_reachable_connection(&[], "token"), None);
    }

    fn prepared(uris: &[(&str, bool)]) -> PreparedServer {
        let resources = parse_resources(&serde_json::json!([
            { "name": "Home Server", "clientIdentifier": "home-id", "provides": "server",
              "owned": true, "accessToken": "server-token" }
        ]));
        PreparedServer {
            resource: resources.into_iter().next().expect("resource"),
            token: "server-token".to_owned(),
            candidates: uris
                .iter()
                .map(|(uri, local)| ConnectionResponse {
                    uri: (*uri).to_owned(),
                    local: *local,
                    relay: None,
                })
                .collect(),
        }
    }

    #[test]
    fn a_reachable_connection_becomes_the_server_url() {
        let server = prepared(&[
            ("https://remote:32400", false),
            ("http://local:32400", true),
        ]);
        let selected = server.candidates.last().cloned();
        let info = to_server_info(server, selected);
        assert_eq!(info.url, "http://local:32400");
        assert!(info.online);
        assert!(info.local);
        assert_eq!(info.token, "server-token");
    }

    #[test]
    fn an_unreachable_server_falls_back_to_its_first_candidate() {
        let info = to_server_info(
            prepared(&[
                ("http://local:32400", true),
                ("https://remote:32400", false),
            ]),
            None,
        );
        assert_eq!(info.url, "http://local:32400");
        assert!(!info.online);
        assert!(info.local);
    }

    #[test]
    fn a_server_without_candidates_has_an_empty_url() {
        let info = to_server_info(prepared(&[]), None);
        assert_eq!(info.url, "");
        assert!(!info.online);
        assert!(!info.local);
        assert_eq!(info.name, "Home Server");
        assert_eq!(info.client_identifier, "home-id");
    }

    fn server(name: &str, client_identifier: &str, url: &str) -> ServerInfo {
        ServerInfo {
            name: name.to_owned(),
            client_identifier: client_identifier.to_owned(),
            url: url.to_owned(),
            token: "token".to_owned(),
            local: false,
            online: true,
        }
    }

    fn persisted(client_identifier: Option<&str>, name: &str, url: &str) -> ServerConfig {
        ServerConfig {
            client_identifier: client_identifier.map(str::to_owned),
            name: name.to_owned(),
            url: url.to_owned(),
            token: "token".to_owned(),
        }
    }

    #[test]
    fn persisted_servers_match_by_identifier_first() {
        let discovered = vec![
            server("Renamed Server", "home-id", "http://10.0.0.9:32400"),
            server("Home Server", "other-id", "http://192.168.1.10:32400"),
        ];
        let found = find_persisted_server(
            &persisted(Some("home-id"), "Home Server", "http://192.168.1.10:32400"),
            &discovered,
        );
        assert_eq!(found, Some(&discovered[0]));
    }

    #[test]
    fn persisted_servers_fall_back_to_the_url() {
        let discovered = vec![server("Renamed", "new-id", "http://192.168.1.10:32400")];
        let found = find_persisted_server(
            &persisted(Some("stale-id"), "Old Name", "http://192.168.1.10:32400"),
            &discovered,
        );
        assert_eq!(found, Some(&discovered[0]));

        // Legacy configs have no identifier at all.
        let legacy = find_persisted_server(
            &persisted(None, "Old Name", "http://192.168.1.10:32400"),
            &discovered,
        );
        assert_eq!(legacy, Some(&discovered[0]));
    }

    #[test]
    fn persisted_servers_fall_back_to_the_name() {
        let discovered = vec![server("Home Server", "new-id", "https://moved:32400")];
        let found = find_persisted_server(
            &persisted(Some(""), "Home Server", "http://192.168.1.10:32400"),
            &discovered,
        );
        assert_eq!(found, Some(&discovered[0]));
    }

    #[test]
    fn an_unknown_persisted_server_is_not_found() {
        let discovered = vec![server(
            "Home Server",
            "home-id",
            "http://192.168.1.10:32400",
        )];
        assert_eq!(
            find_persisted_server(&persisted(Some("gone"), "Gone", "http://gone"), &discovered),
            None
        );
        assert_eq!(
            find_persisted_server(&persisted(Some("gone"), "Gone", "http://gone"), &[]),
            None
        );
    }
}
