//! The authentication flow: the four stages and the state machine behind them.
//!
//! This is the gpui translation of `../src/mainview/auth/auth-flow.tsx` plus
//! the effects that live in `oauth-screen.tsx`. Every `plex::*` call is
//! blocking and therefore runs on the background executor; results are applied
//! back on the main thread through `Entity::update`.

pub mod connected;
pub mod oauth;
pub mod servers;
pub mod startup;
pub mod welcome;

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{AsyncApp, Context, RenderImage, WeakEntity, prelude::*};
use image::Frame;

use crate::plex::{self, Account, Config, PinStatus, ServerConfig, ServerInfo};

use super::root::{Root, Screen};

/// The four stages, in the order that decides transition direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Welcome,
    Oauth,
    Connected,
    Servers,
}

impl Stage {
    pub fn index(self) -> usize {
        match self {
            Self::Welcome => 0,
            Self::Oauth => 1,
            Self::Connected => 2,
            Self::Servers => 3,
        }
    }

    pub fn enter_id(self) -> &'static str {
        match self {
            Self::Welcome => "stage-welcome",
            Self::Oauth => "stage-oauth",
            Self::Connected => "stage-connected",
            Self::Servers => "stage-servers",
        }
    }

    pub fn exit_id(self) -> &'static str {
        match self {
            Self::Welcome => "stage-welcome-exit",
            Self::Oauth => "stage-oauth-exit",
            Self::Connected => "stage-connected-exit",
            Self::Servers => "stage-servers-exit",
        }
    }
}

/// The startup screen is held for at least this long so it never flashes.
const STARTUP_MIN: Duration = Duration::from_millis(700);
const NO_SERVERS_ERROR: &str = "No owned Plex media servers were found on this account.";
const NO_CONNECTION_ERROR: &str = "No server connection is available";
const MISSING_SESSION_ERROR: &str = "You are not signed in to Plex";

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

impl Root {
    /// Load the saved session while the startup screen is up.
    pub fn start_startup_check(&mut self, cx: &mut Context<Self>) {
        self.screen = Screen::Startup;
        self.startup_task = Some(cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let mut config = cx.background_spawn(async { plex::load_config() }).await;
            let mut account = config.as_ref().and_then(|config| config.account.clone());

            if account.is_none()
                && let Some(existing) = config.clone()
                && !existing.token.is_empty()
            {
                let token = existing.token.clone();
                account = cx
                    .background_spawn(async move { plex::get_account(&token).ok() })
                    .await;
                if let Some(found) = account.clone() {
                    let mut updated = existing;
                    updated.account = Some(found);
                    persist(cx, updated.clone()).await;
                    config = Some(updated);
                }
            }

            let elapsed = started.elapsed();
            if let Some(remaining) = STARTUP_MIN.checked_sub(elapsed)
                && !remaining.is_zero()
            {
                cx.background_executor().timer(remaining).await;
            }

            this.update(cx, |this, cx| this.finish_startup(config, account, cx))
                .ok();
        }));
    }

    fn finish_startup(
        &mut self,
        config: Option<Config>,
        account: Option<Account>,
        cx: &mut Context<Self>,
    ) {
        self.startup_task = None;
        self.account = account;
        self.config = config;

        let authenticated = self
            .config
            .as_ref()
            .is_some_and(|config| !config.token.is_empty());
        let server = self
            .config
            .as_ref()
            .and_then(|config| config.server.clone())
            .filter(|_| authenticated);

        self.load_avatar(cx);

        match (authenticated, server) {
            (true, Some(server)) => {
                self.selected_server = server.client_identifier.clone();
                self.enter_home(server.name.clone(), cx);
            }
            (true, None) => self.transition_to(Stage::Connected, cx),
            (false, _) => {
                self.screen = Screen::Auth;
                self.stage = Stage::Welcome;
                cx.notify();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Welcome
    // -----------------------------------------------------------------------

    /// "Sign in with Plex".
    pub fn sign_in(&mut self, cx: &mut Context<Self>) {
        self.transition_to(Stage::Oauth, cx);
    }

    // -----------------------------------------------------------------------
    // OAuth
    // -----------------------------------------------------------------------

    /// Create a PIN and start polling for its authorization.
    pub fn start_oauth(&mut self, cx: &mut Context<Self>) {
        self.oauth.run = self.oauth.run.wrapping_add(1);
        self.oauth.code = oauth::PLACEHOLDER_CODE.into();
        self.oauth.url = None;
        self.oauth.status = oauth::STATUS_WAITING.into();
        self.oauth.copied = false;
        self.copied_task = None;

        if self.preview {
            self.oauth_task = None;
            return;
        }

        let run = self.oauth.run;
        let client_identifier = self
            .config
            .as_ref()
            .map(|config| config.client_identifier.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        self.oauth_task = Some(cx.spawn(async move |this, cx| {
            authorize(this, cx, run, client_identifier).await;
        }));
    }

    /// "Cancel" on the OAuth screen.
    pub fn cancel_oauth(&mut self, cx: &mut Context<Self>) {
        self.transition_to(Stage::Welcome, cx);
    }

    /// "Copy link" — only meaningful once the authorization URL has arrived.
    pub fn copy_auth_link(&mut self, cx: &mut Context<Self>) {
        let Some(url) = self.oauth.url.clone().filter(|url| !url.is_empty()) else {
            return;
        };
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(url));
        self.oauth.copied = true;
        cx.notify();
        self.copied_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(oauth::COPIED_FEEDBACK).await;
            this.update(cx, |this, cx| {
                this.oauth.copied = false;
                cx.notify();
            })
            .ok();
        }));
    }

    /// "Open in Browser".
    pub fn open_auth_link(&self, cx: &mut Context<Self>) {
        if let Some(url) = self.oauth.url.as_ref().filter(|url| !url.is_empty()) {
            cx.open_url(url);
        }
    }

    fn set_oauth_status(&mut self, run: usize, status: impl Into<gpui::SharedString>) {
        if self.oauth.run == run {
            self.oauth.status = status.into();
        }
    }

    // -----------------------------------------------------------------------
    // Connected
    // -----------------------------------------------------------------------

    /// "Continue" — go to the server list and discover servers.
    pub fn continue_to_servers(&mut self, cx: &mut Context<Self>) {
        self.server_run = self.server_run.wrapping_add(1);
        let run = self.server_run;
        self.server_loading = true;
        self.server_error = None;
        self.servers.clear();
        self.selected_server = None;
        self.transition_to(Stage::Servers, cx);

        if self.preview {
            return;
        }

        let Some(config) = self.config.clone() else {
            self.server_loading = false;
            self.server_error =
                Some(format!("Couldn't load your Plex servers: {MISSING_SESSION_ERROR}").into());
            cx.notify();
            return;
        };

        self.server_task = Some(cx.spawn(async move |this, cx| {
            let token = config.token.clone();
            let client_identifier = config.client_identifier.clone();
            let found = cx
                .background_spawn(async move { plex::discover_servers(&token, &client_identifier) })
                .await;
            this.update(cx, |this, cx| {
                if this.server_run != run {
                    return;
                }
                match found {
                    Ok(servers) => this.apply_servers(servers),
                    Err(error) => {
                        this.server_error =
                            Some(format!("Couldn't load your Plex servers: {error}").into());
                    }
                }
                this.server_loading = false;
                cx.notify();
            })
            .ok();
        }));
    }

    fn apply_servers(&mut self, servers: Vec<ServerInfo>) {
        let first = servers
            .iter()
            .find(|server| !server.url.is_empty())
            .map(|server| server.client_identifier.clone());
        self.server_error = if first.is_none() {
            Some(NO_SERVERS_ERROR.into())
        } else {
            None
        };
        self.selected_server = first;
        self.servers = servers;
    }

    // -----------------------------------------------------------------------
    // Server selection
    // -----------------------------------------------------------------------

    /// Click on a usable server row.
    pub fn select_server(&mut self, client_identifier: String, cx: &mut Context<Self>) {
        if self.server_starting {
            return;
        }
        self.selected_server = Some(client_identifier);
        cx.notify();
    }

    /// "Sign in again" — drop the current session's poll and start a new PIN.
    pub fn sign_in_again(&mut self, cx: &mut Context<Self>) {
        if self.server_starting {
            return;
        }
        self.server_run = self.server_run.wrapping_add(1);
        self.server_task = None;
        self.cancel_oauth_poll();
        self.transition_to(Stage::Oauth, cx);
    }

    /// "Start listening" — persist the selected server and open the home screen.
    pub fn start_listening(&mut self, cx: &mut Context<Self>) {
        if self.server_starting {
            return;
        }
        let Some(selected) = self.selected_server.clone() else {
            return;
        };
        self.server_run = self.server_run.wrapping_add(1);
        let run = self.server_run;
        self.server_starting = true;
        cx.notify();

        if self.preview {
            return;
        }

        let Some(mut config) = self.config.clone() else {
            self.server_starting = false;
            self.server_error =
                Some(format!("Couldn't connect to that server: {MISSING_SESSION_ERROR}").into());
            cx.notify();
            return;
        };
        let server = self
            .servers
            .iter()
            .find(|server| server.client_identifier == selected)
            .cloned();

        self.server_task = Some(cx.spawn(async move |this, cx| {
            let saved = cx
                .background_spawn(async move {
                    let server = server.ok_or_else(|| anyhow::anyhow!(NO_CONNECTION_ERROR))?;
                    if server.url.is_empty() {
                        anyhow::bail!(NO_CONNECTION_ERROR);
                    }
                    config.server = Some(ServerConfig {
                        client_identifier: Some(server.client_identifier.clone()),
                        name: server.name.clone(),
                        url: server.url.clone(),
                        token: server.token.clone(),
                    });
                    plex::save_config(&config)?;
                    anyhow::Ok(config)
                })
                .await;

            this.update(cx, |this, cx| {
                if this.server_run != run {
                    return;
                }
                match saved {
                    Ok(config) => {
                        let name = config
                            .server
                            .as_ref()
                            .map(|server| server.name.clone())
                            .unwrap_or_default();
                        this.config = Some(config);
                        this.enter_home(name, cx);
                    }
                    Err(error) => {
                        this.server_error =
                            Some(format!("Couldn't connect to that server: {error}").into());
                    }
                }
                this.server_starting = false;
                cx.notify();
            })
            .ok();
        }));
    }

    // -----------------------------------------------------------------------
    // Sign-out
    // -----------------------------------------------------------------------

    /// Forget the session and return to Welcome.
    ///
    /// Nothing calls this yet: the sidebar's settings button — the only place
    /// the design signs out from — is inert until that surface is ported.
    #[allow(
        dead_code,
        reason = "the settings surface that calls it is out of scope"
    )]
    pub fn disconnect(&mut self, cx: &mut Context<Self>) {
        self.cancel_oauth_poll();
        self.server_run = self.server_run.wrapping_add(1);
        self.server_task = None;
        self.reset_home();
        self.config = None;
        self.account = None;
        self.avatar = None;
        self.avatar_task = None;
        self.servers.clear();
        self.selected_server = None;
        self.server_error = None;
        self.server_loading = false;
        self.server_starting = false;
        self.screen = Screen::Auth;
        self.stage = Stage::Welcome;
        self.exiting = None;
        cx.notify();

        if self.preview {
            return;
        }
        self.config_task = Some(cx.spawn(async move |_, cx| {
            if let Err(error) = cx.background_spawn(async { plex::delete_config() }).await {
                log::error!("failed to delete the Plex config: {error}");
            }
        }));
    }

    // -----------------------------------------------------------------------
    // Avatar
    // -----------------------------------------------------------------------

    /// Fetch and decode the account thumbnail; the initials stay as fallback.
    pub fn load_avatar(&mut self, cx: &mut Context<Self>) {
        self.avatar = None;
        self.avatar_task = None;
        if self.preview {
            return;
        }
        let Some(thumb) = self
            .account
            .as_ref()
            .and_then(|account| account.thumb.clone())
            .filter(|thumb| !thumb.is_empty())
        else {
            return;
        };
        let Some(token) = self
            .config
            .as_ref()
            .map(|config| config.token.clone())
            .filter(|token| !token.is_empty())
        else {
            return;
        };

        self.avatar_task = Some(cx.spawn(async move |this, cx| {
            let image = cx
                .background_spawn(async move {
                    match plex::get_avatar_bytes(&token, &thumb) {
                        Ok((bytes, _content_type)) => decode_avatar(&bytes),
                        Err(error) => {
                            log::warn!("failed to fetch the Plex avatar: {error}");
                            None
                        }
                    }
                })
                .await;
            if let Some(image) = image {
                this.update(cx, |this, cx| {
                    this.avatar = Some(image);
                    cx.notify();
                })
                .ok();
            }
        }));
    }
}

/// Decode avatar bytes into the BGRA frame gpui's renderer expects.
fn decode_avatar(bytes: &[u8]) -> Option<Arc<RenderImage>> {
    let mut rgba = image::load_from_memory(bytes)
        .inspect_err(|error| log::warn!("failed to decode the Plex avatar: {error}"))
        .ok()?
        .into_rgba8();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(vec![Frame::new(rgba)])))
}

/// Save the config off the main thread, logging rather than surfacing failures
/// (the reference treats persistence as best effort too).
async fn persist(cx: &mut AsyncApp, config: Config) {
    if let Err(error) = cx
        .background_spawn(async move { plex::save_config(&config) })
        .await
    {
        log::error!("failed to save the Plex config: {error}");
    }
}

/// The whole PIN dance: create, poll, approve.
///
/// `run` is checked after every await so a cancelled or superseded attempt can
/// never mutate the view — the equivalent of `runRef` in `oauth-screen.tsx`.
async fn authorize(
    this: WeakEntity<Root>,
    cx: &mut AsyncApp,
    run: usize,
    client_identifier: String,
) {
    let created = {
        let client_identifier = client_identifier.clone();
        cx.background_spawn(async move { plex::create_pin(&client_identifier) })
            .await
    };
    let pin = match created {
        Ok(pin) => pin,
        Err(error) => {
            this.update(cx, |this, cx| {
                this.set_oauth_status(run, format!("Something went wrong: {error}"));
                cx.notify();
            })
            .ok();
            return;
        }
    };

    let url = plex::auth_url(&pin);
    let code = pin.code.clone();
    let still_current = this
        .update(cx, |this, cx| {
            if this.oauth.run != run {
                return false;
            }
            this.oauth.code = code.into();
            this.oauth.url = Some(url);
            cx.notify();
            true
        })
        .unwrap_or(false);
    if !still_current {
        return;
    }

    let deadline = Instant::now() + Duration::from_millis(plex::PIN_TIMEOUT_MS);
    let interval = Duration::from_millis(plex::PIN_POLL_INTERVAL_MS);
    loop {
        let polled = {
            let pin = pin.clone();
            cx.background_spawn(async move { plex::poll_pin(&pin) })
                .await
        };
        match polled {
            Ok(PinStatus::Authorized(token)) => {
                approved(this, cx, run, client_identifier, token).await;
                return;
            }
            Ok(PinStatus::Pending) => {}
            Err(error) => {
                log::error!("failed to check Plex authorization: {error}");
                let current = this
                    .update(cx, |this, cx| {
                        this.set_oauth_status(run, oauth::STATUS_STILL_WAITING);
                        cx.notify();
                        this.oauth.run == run
                    })
                    .unwrap_or(false);
                if !current {
                    return;
                }
            }
        }

        if Instant::now() >= deadline {
            this.update(cx, |this, cx| {
                this.set_oauth_status(
                    run,
                    format!("Something went wrong: {}", oauth::TIMEOUT_MESSAGE),
                );
                cx.notify();
            })
            .ok();
            return;
        }
        cx.background_executor().timer(interval).await;
    }
}

/// The PIN came back authorized: persist the token, hydrate the account and
/// move to the connected stage.
async fn approved(
    this: WeakEntity<Root>,
    cx: &mut AsyncApp,
    run: usize,
    client_identifier: String,
    token: String,
) {
    let current = this
        .update(cx, |this, cx| {
            this.set_oauth_status(run, oauth::STATUS_APPROVED);
            cx.notify();
            this.oauth.run == run
        })
        .unwrap_or(false);
    if !current {
        return;
    }

    let mut config = Config {
        client_identifier,
        token: token.clone(),
        account: None,
        server: None,
    };
    persist(cx, config.clone()).await;

    let account = cx
        .background_spawn(async move { plex::get_account(&token).ok() })
        .await;
    if let Some(account) = account.clone() {
        config.account = Some(account);
        persist(cx, config.clone()).await;
    }

    this.update(cx, |this, cx| {
        if this.oauth.run != run {
            return;
        }
        this.config = Some(config);
        this.account = account;
        this.load_avatar(cx);
        this.transition_to(Stage::Connected, cx);
    })
    .ok();
}
