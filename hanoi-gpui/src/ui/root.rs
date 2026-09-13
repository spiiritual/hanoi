//! The window's root view: all of the flow's state plus the stage stack that
//! cross-fades between screens.

use std::sync::Arc;

use gpui::{
    Animation, AnimationExt as _, AnyElement, Context, Div, ElementId, FontWeight, IntoElement,
    Render, RenderImage, SharedString, Stateful, Task, Window, div, prelude::*, px, relative,
};

use crate::plex::{Account, Config, ServerInfo};

use super::auth::{self, Stage};
use super::home;
use super::home::state::{ArtworkState, HomeState};
use super::preview::Preview;
use super::scrollbar::ScrollbarState;
use super::theme::{BG, FONT_BODY, LINE_HEIGHT_NORMAL, TEXT_PRIMARY};
use super::transition::{self, Direction, Role};

/// Which of the three top-level surfaces is on screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    /// The saved session is being checked (`AuthStartupScreen`).
    Startup,
    /// The four-stage authentication flow.
    Auth,
    /// The authenticated shell: sidebar, topbar and the Plex Home dashboard.
    Home,
}

/// State of the OAuth stage, mirroring the hooks in `oauth-screen.tsx`.
pub struct OAuthState {
    pub code: SharedString,
    pub url: Option<String>,
    pub status: SharedString,
    pub copied: bool,
    /// Bumped whenever a new authorization attempt starts so stale polls are
    /// ignored — the equivalent of the reference's `runRef`.
    pub run: usize,
}

impl Default for OAuthState {
    fn default() -> Self {
        Self {
            code: auth::oauth::PLACEHOLDER_CODE.into(),
            url: None,
            status: auth::oauth::STATUS_WAITING.into(),
            copied: false,
            run: 0,
        }
    }
}

pub struct Root {
    pub screen: Screen,
    pub stage: Stage,
    pub exiting: Option<Stage>,
    pub direction: Direction,
    /// Incremented per transition so the animation element restarts.
    pub transition: usize,

    /// Preview mode never touches the network or the config file.
    pub preview: bool,

    pub config: Option<Config>,
    pub account: Option<Account>,
    pub avatar: Option<Arc<RenderImage>>,

    pub oauth: OAuthState,

    /// The directional lock shared by the shell's scrolling surfaces.
    pub scroll: super::scroll::Gesture,

    pub servers: Vec<ServerInfo>,
    pub selected_server: Option<String>,
    pub server_loading: bool,
    pub server_starting: bool,
    pub server_error: Option<SharedString>,
    /// The equivalent of `serverRun` in `auth-flow.tsx`.
    pub server_run: usize,

    /// Everything the authenticated shell renders from.
    pub home: HomeState,
    /// The artwork cache plus one slot per card.
    pub artwork: ArtworkState,
    /// The overlay scrollbars' drag state.
    pub scrollbar: ScrollbarState,

    pub startup_task: Option<Task<()>>,
    pub oauth_task: Option<Task<()>>,
    pub server_task: Option<Task<()>>,
    pub avatar_task: Option<Task<()>>,
    pub copied_task: Option<Task<()>>,
    pub transition_task: Option<Task<()>>,
    pub config_task: Option<Task<()>>,
    pub home_task: Option<Task<()>>,
    pub sections_task: Option<Task<()>>,
    pub category_task: Option<Task<()>>,
    pub menu_task: Option<Task<()>>,
}

impl Root {
    /// The live app: show the startup screen and check the saved session.
    pub fn new(cx: &mut Context<Self>) -> Self {
        let mut root = Self::empty(false);
        root.start_startup_check(cx);
        root
    }

    /// A single stage rendered from the sample data in `DESIGN.md`.
    pub fn preview(preview: Preview) -> Self {
        let mut root = Self::empty(true);
        preview.apply(&mut root);
        root
    }

    fn empty(preview: bool) -> Self {
        Self {
            screen: Screen::Startup,
            stage: Stage::Welcome,
            exiting: None,
            direction: Direction::Forward,
            transition: 0,
            preview,
            config: None,
            account: None,
            avatar: None,
            oauth: OAuthState::default(),
            scroll: super::scroll::Gesture::default(),
            servers: Vec::new(),
            selected_server: None,
            server_loading: false,
            server_starting: false,
            server_error: None,
            server_run: 0,
            home: HomeState::default(),
            artwork: ArtworkState::default(),
            scrollbar: ScrollbarState::default(),
            startup_task: None,
            oauth_task: None,
            server_task: None,
            avatar_task: None,
            copied_task: None,
            transition_task: None,
            config_task: None,
            home_task: None,
            sections_task: None,
            category_task: None,
            menu_task: None,
        }
    }

    /// Jump straight to a stage with no transition (startup and preview only).
    pub fn show(&mut self, stage: Stage) {
        self.screen = Screen::Auth;
        self.stage = stage;
        self.exiting = None;
    }

    /// Move to `next`, cross-fading the stage that is leaving.
    ///
    /// Mirrors `transitionStage`: a transition started mid-flight drops the
    /// previous exiting stage and makes the current one the exiting one.
    pub fn transition_to(&mut self, next: Stage, cx: &mut Context<Self>) {
        if self.screen == Screen::Auth && next == self.stage {
            return;
        }
        let current = self.stage;
        self.direction = if next.index() >= current.index() {
            Direction::Forward
        } else {
            Direction::Backward
        };
        self.exiting = Some(current);
        self.stage = next;
        self.screen = Screen::Auth;
        self.transition = self.transition.wrapping_add(1);

        self.transition_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(transition::CLEANUP_DELAY)
                .await;
            this.update(cx, |this, cx| {
                this.exiting = None;
                cx.notify();
            })
            .ok();
        }));

        // Leaving the OAuth stage for any reason must cancel its poll, and
        // arriving on it always starts a fresh PIN.
        if current == Stage::Oauth && next != Stage::Oauth {
            self.cancel_oauth_poll();
        }
        if next == Stage::Oauth {
            self.start_oauth(cx);
        }
        cx.notify();
    }

    /// Invalidate any in-flight PIN poll and drop its task.
    pub fn cancel_oauth_poll(&mut self) {
        self.oauth.run = self.oauth.run.wrapping_add(1);
        self.oauth_task = None;
    }

    fn render_stage(&self, stage: Stage, cx: &mut Context<Self>) -> AnyElement {
        match stage {
            Stage::Welcome => auth::welcome::render(cx),
            Stage::Oauth => auth::oauth::render(self, cx),
            Stage::Connected => auth::connected::render(self, cx),
            Stage::Servers => auth::servers::render(self, cx),
        }
    }

    /// `.auth-stage` — a full-window layer that centres its screen on `bg`.
    fn stage_layer(id: impl Into<ElementId>, content: AnyElement) -> Stateful<Div> {
        div()
            .id(id)
            .absolute()
            .top_0()
            .left_0()
            .w_full()
            .h_full()
            .bg(BG)
            .flex()
            .items_center()
            .justify_center()
            .child(content)
    }

    fn animated_layer(
        &self,
        id: impl Into<ElementId>,
        animation_id: ElementId,
        role: Role,
        content: AnyElement,
    ) -> AnyElement {
        let direction = self.direction;
        Self::stage_layer(id, content)
            .with_animation(
                animation_id,
                Animation::new(transition::DURATION).with_easing(transition::ease),
                move |layer, delta| {
                    // The layer stays absolutely positioned with a definite
                    // width, so `left` shifts it the way `translateX` does in
                    // the CSS instead of resizing it.
                    let (opacity, offset) = transition::frame(role, direction, delta);
                    layer.left(px(offset)).opacity(opacity)
                },
            )
            .into_any_element()
    }

    /// `.auth-stage-stack` — the exiting stage underneath, the current one on
    /// top, exactly like the reference's DOM order.
    fn render_auth(&self, cx: &mut Context<Self>) -> AnyElement {
        let transition = self.transition;
        let mut stack = div().absolute().top_0().left_0().size_full();

        if let Some(exiting) = self.exiting {
            let content = self.render_stage(exiting, cx);
            stack = stack.child(self.animated_layer(
                ElementId::named_usize(exiting.exit_id(), transition),
                ("auth-stage-exit", transition).into(),
                Role::Exit,
                content,
            ));
        }

        let content = self.render_stage(self.stage, cx);
        let entering = if self.exiting.is_some() {
            self.animated_layer(
                ElementId::named_usize(self.stage.enter_id(), transition),
                ("auth-stage-enter", transition).into(),
                Role::Enter,
                content,
            )
        } else {
            Self::stage_layer(self.stage.enter_id(), content).into_any_element()
        };

        stack.child(entering).into_any_element()
    }
}

impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Artwork loads are started before the tree is built so a render pass
        // never re-spawns one, and so `card::render` can stay a `&Root` read.
        // The scroll handles both of them measure are allocated first.
        if self.screen == Screen::Home {
            self.ensure_scrollbars(window);
            self.ensure_artwork(window, cx);
        }

        let body = match self.screen {
            Screen::Startup => {
                Self::stage_layer("startup", auth::startup::render()).into_any_element()
            }
            // The shell fills the window instead of being centred like a stage.
            Screen::Home => div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .bg(BG)
                .child(home::render(self, cx))
                .into_any_element(),
            Screen::Auth => self.render_auth(cx),
        };

        div()
            .relative()
            .size_full()
            .bg(BG)
            .font_family(FONT_BODY)
            .font_weight(FontWeight::NORMAL)
            .text_color(TEXT_PRIMARY)
            .text_size(px(16.))
            .line_height(relative(LINE_HEIGHT_NORMAL))
            .child(body)
            // A scrollbar thumb keeps following the pointer once it has left
            // the row it belongs to, so the drag is resolved by window-level
            // listeners that only exist while one is in flight.
            .when(self.scrollbar.is_dragging(), |window_layer| {
                window_layer.child(self.scrollbar_drag_listener(cx))
            })
    }
}
