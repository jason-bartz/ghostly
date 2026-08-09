//! Localhost REST API for external control of Ghostly.
//!
//! Enabled from Settings → Developer. Binds to `127.0.0.1:<rest_api_port>`
//! (default 7543) and is never reachable off the machine.
//!
//! ## Security model
//!
//! Two independent gates, because this API can type into whatever app has
//! focus and can read every transcript you have ever dictated:
//!
//! 1. **Bearer token.** Every request must carry the per-install token
//!    (`Authorization: Bearer <token>`, `X-Ghostly-Token: <token>`, or
//!    `?token=` for tools that cannot set headers). Compared in constant time.
//! 2. **No browsers.** Any request carrying an `Origin` or `Sec-Fetch-Mode`
//!    header is rejected outright. There is deliberately no CORS layer: native
//!    clients (curl, Raycast, Shortcuts, Keyboard Maestro, Stream Deck) never
//!    send `Origin`, so refusing it costs them nothing and shuts the door on
//!    drive-by requests from any web page the user happens to have open.
//!
//! ## Endpoints
//!
//! | Method | Path                    | Description                             |
//! |--------|-------------------------|-----------------------------------------|
//! | GET    | /api/status             | App status (is_recording, version, port)|
//! | POST   | /api/transcribe/start   | Begin recording (no-op if recording)    |
//! | POST   | /api/transcribe/stop    | End recording (no-op if idle)           |
//! | POST   | /api/transcribe/toggle  | Toggle recording                        |
//! | POST   | /api/cancel             | Cancel the current operation            |
//! | POST   | /api/dictate            | Record, block, return the transcript    |
//! | POST   | /api/paste              | Paste text through Ghostly              |
//! | GET    | /api/history            | Latest N history entries (default 20)   |
//! | GET    | /api/events             | SSE stream of status + transcript events|

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
    routing::{get, post},
    Router,
};
use futures_util::stream::Stream;
use log::{debug, info, warn};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, oneshot};

use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::{HistoryEntry, HistoryManager};
use crate::utils::cancel_current_operation;
use crate::TranscriptionCoordinator;

/// The binding the API drives. Matches the main dictation shortcut.
const TRANSCRIBE_BINDING: &str = "transcribe";

const DICTATE_DEFAULT_TIMEOUT_MS: u64 = 120_000;
const DICTATE_MAX_TIMEOUT_MS: u64 = 600_000;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Events published to `/api/events` subscribers and awaited by `/api/dictate`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApiEvent {
    /// A transcription finished and was written to history.
    Transcript {
        id: i64,
        /// Refined text when AI refinement ran, raw transcript otherwise.
        /// This is what was actually pasted.
        text: String,
        raw_text: String,
        source_app: Option<String>,
        timestamp: i64,
    },
    /// The recording pipeline changed state.
    Status { state: &'static str },
}

impl ApiEvent {
    fn name(&self) -> &'static str {
        match self {
            ApiEvent::Transcript { .. } => "transcript",
            ApiEvent::Status { .. } => "status",
        }
    }
}

/// Fan-out channel for API events. Registered at startup regardless of whether
/// the server is running, so publishers never need to care.
pub struct EventBus {
    tx: broadcast::Sender<ApiEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self { tx }
    }

    fn subscribe(&self) -> broadcast::Receiver<ApiEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

fn publish(app: &AppHandle, event: ApiEvent) {
    if let Some(bus) = app.try_state::<Arc<EventBus>>() {
        // Err just means nobody is subscribed; that is the normal case.
        let _ = bus.tx.send(event);
    }
}

/// Called from `HistoryManager::save_entry` — the one place every finished
/// transcription passes through.
pub fn publish_transcript(app: &AppHandle, entry: &HistoryEntry) {
    publish(
        app,
        ApiEvent::Transcript {
            id: entry.id,
            text: entry
                .post_processed_text
                .clone()
                .unwrap_or_else(|| entry.transcription_text.clone()),
            raw_text: entry.transcription_text.clone(),
            source_app: entry.source_app.clone(),
            timestamp: entry.timestamp,
        },
    );
}

/// Called from the transcription coordinator on every stage change.
pub fn publish_status(app: &AppHandle, state: &'static str) {
    publish(app, ApiEvent::Status { state });
}

// ---------------------------------------------------------------------------
// Paste suppression
// ---------------------------------------------------------------------------

/// One-shot flag armed by `/api/dictate` when the caller does not want the
/// transcript pasted into the focused app (the default — the caller is
/// receiving the text in the response instead).
#[derive(Default)]
pub struct PasteSuppressor {
    armed: AtomicBool,
}

impl PasteSuppressor {
    fn arm(&self) {
        self.armed.store(true, Ordering::SeqCst);
    }

    fn disarm(&self) {
        self.armed.store(false, Ordering::SeqCst);
    }
}

/// Consume the suppression flag. Returns true if this paste should be skipped.
pub fn take_paste_suppression(app: &AppHandle) -> bool {
    app.try_state::<Arc<PasteSuppressor>>()
        .map_or(false, |s| s.armed.swap(false, Ordering::SeqCst))
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// Generate a fresh 256-bit API token, hex encoded.
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// Length-independent equality. Token length is fixed and public, so leaking
/// it through the early return costs nothing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/// Owns the running server so the settings toggle can actually stop it, and so
/// a port change can rebind without restarting the app.
#[derive(Default)]
pub struct RestApiServer {
    inner: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    shutdown: oneshot::Sender<()>,
    handle: tauri::async_runtime::JoinHandle<()>,
    port: u16,
}

/// Bind, tolerating the brief window where a server we just stopped has not
/// yet released the socket. Without this, changing the port back and forth or
/// regenerating the token would intermittently fail with "already in use"
/// against our own outgoing listener.
async fn bind_with_retry(addr: &str, restarting: bool) -> Result<tokio::net::TcpListener, String> {
    let attempts = if restarting { 20 } else { 1 };
    let mut last_err = None;

    for attempt in 0..attempts {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => return Ok(listener),
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last_err = Some(e);
                if attempt + 1 < attempts {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            Err(e) => return Err(format!("Could not listen on {}: {}", addr, e)),
        }
    }

    let port = addr.rsplit(':').next().unwrap_or(addr);
    Err(match last_err {
        Some(_) => format!("Port {} is already in use by another program.", port),
        None => format!("Could not listen on {}.", addr),
    })
}

impl RestApiServer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind and serve. Any currently running server is stopped first, so this
    /// doubles as "restart on the new port/token". Bind failures are returned
    /// to the caller rather than only logged, so the UI can show them.
    pub async fn start(&self, app: AppHandle, port: u16, token: String) -> Result<(), String> {
        let restarting = self.stop();

        let addr = format!("127.0.0.1:{}", port);
        let listener = bind_with_retry(&addr, restarting).await?;

        let router = build_router(ApiState {
            app,
            token: Arc::new(token),
            port,
        });

        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        let handle = tauri::async_runtime::spawn(async move {
            let served = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
            match served {
                Ok(()) => info!("REST API stopped"),
                Err(e) => warn!("REST API server error: {}", e),
            }
        });

        // Lock only after every await above, so we never hold a std Mutex
        // across a suspension point.
        if let Ok(mut guard) = self.inner.lock() {
            *guard = Some(RunningServer {
                shutdown: shutdown_tx,
                handle,
                port,
            });
        }

        info!("REST API listening on http://{}", addr);
        Ok(())
    }

    /// Stop the server if running. Returns whether anything was stopped.
    ///
    /// Signals a graceful shutdown and then aborts the task. The abort matters:
    /// graceful shutdown waits for in-flight connections, and an open
    /// `/api/events` stream never ends — so without it, turning the API off
    /// would leave an already-authenticated SSE client connected indefinitely.
    /// "Off" should mean off, including for streams holding an old token.
    pub fn stop(&self) -> bool {
        let Ok(mut guard) = self.inner.lock() else {
            return false;
        };
        match guard.take() {
            Some(running) => {
                let _ = running.shutdown.send(());
                running.handle.abort();
                debug!("REST API stopped on port {}", running.port);
                true
            }
            None => false,
        }
    }

    /// Port currently being served, if any.
    pub fn running_port(&self) -> Option<u16> {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|r| r.port))
    }
}

#[derive(Clone)]
struct ApiState {
    app: AppHandle,
    token: Arc<String>,
    port: u16,
}

fn build_router(state: ApiState) -> Router {
    Router::new()
        .route("/api/status", get(handle_status))
        .route("/api/transcribe/start", post(handle_start))
        .route("/api/transcribe/stop", post(handle_stop))
        .route("/api/transcribe/toggle", post(handle_toggle))
        .route("/api/cancel", post(handle_cancel))
        .route("/api/dictate", post(handle_dictate))
        .route("/api/paste", post(handle_paste))
        .route("/api/history", get(handle_history))
        .route("/api/events", get(handle_events))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Auth / browser guard
// ---------------------------------------------------------------------------

async fn guard(State(state): State<ApiState>, req: Request, next: Next) -> Response {
    // A browser fetch always sets one of these. Native clients never do.
    // Refusing them is what makes a token leak non-catastrophic and what stops
    // any open web page from driving the app.
    for header in ["origin", "sec-fetch-mode", "sec-fetch-site"] {
        if req.headers().contains_key(header) {
            warn!("REST API: rejected browser-originated request ({header} present)");
            return error(
                StatusCode::FORBIDDEN,
                "Browser requests are not accepted by the Ghostly API.",
            )
            .into_response();
        }
    }

    let presented = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
        .map(str::to_string)
        .or_else(|| {
            req.headers()
                .get("x-ghostly-token")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        })
        .or_else(|| {
            req.uri().query().and_then(|q| {
                q.split('&')
                    .filter_map(|pair| pair.split_once('='))
                    .find(|(k, _)| *k == "token")
                    .map(|(_, v)| v.to_string())
            })
        });

    match presented {
        Some(t) if constant_time_eq(t.as_bytes(), state.token.as_bytes()) => next.run(req).await,
        Some(_) => {
            warn!("REST API: rejected request with an invalid token");
            error(StatusCode::UNAUTHORIZED, "Invalid API token.").into_response()
        }
        None => error(
            StatusCode::UNAUTHORIZED,
            "Missing API token. Send it as 'Authorization: Bearer <token>'.",
        )
        .into_response(),
    }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ApiError {
    ok: bool,
    error: String,
}

fn error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            ok: false,
            error: message.into(),
        }),
    )
}

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct StatusResponse {
    ok: bool,
    is_recording: bool,
    version: &'static str,
    port: u16,
}

async fn handle_status(State(state): State<ApiState>) -> Json<StatusResponse> {
    Json(StatusResponse {
        ok: true,
        is_recording: is_recording(&state.app),
        version: env!("CARGO_PKG_VERSION"),
        port: state.port,
    })
}

#[derive(Serialize)]
struct RecordingResponse {
    ok: bool,
    /// Whether a recording was already in progress when the call arrived.
    was_recording: bool,
}

async fn handle_start(State(state): State<ApiState>) -> ApiResult<RecordingResponse> {
    let was_recording = is_recording(&state.app);
    let coordinator = coordinator(&state.app)?;
    coordinator.send_start(TRANSCRIBE_BINDING, "rest_api");
    Ok(Json(RecordingResponse {
        ok: true,
        was_recording,
    }))
}

async fn handle_stop(State(state): State<ApiState>) -> ApiResult<RecordingResponse> {
    let was_recording = is_recording(&state.app);
    let coordinator = coordinator(&state.app)?;
    coordinator.send_stop(TRANSCRIBE_BINDING, "rest_api");
    Ok(Json(RecordingResponse {
        ok: true,
        was_recording,
    }))
}

async fn handle_toggle(State(state): State<ApiState>) -> ApiResult<RecordingResponse> {
    let was_recording = is_recording(&state.app);
    let coordinator = coordinator(&state.app)?;
    coordinator.send_input(TRANSCRIBE_BINDING, "rest_api", true, false);
    Ok(Json(RecordingResponse {
        ok: true,
        was_recording,
    }))
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

async fn handle_cancel(State(state): State<ApiState>) -> Json<OkResponse> {
    cancel_current_operation(&state.app);
    Json(OkResponse { ok: true })
}

#[derive(Deserialize, Default)]
struct DictateBody {
    /// How long to wait for a transcript before giving up. Default 120s.
    timeout_ms: Option<u64>,
    /// Stop recording automatically after this long. Omit to let the user stop
    /// with the shortcut, the tray, or a POST to /api/transcribe/stop.
    stop_after_ms: Option<u64>,
    /// Also paste into the focused app. Defaults to false, because the caller
    /// is already receiving the text in the response.
    paste: Option<bool>,
}

#[derive(Serialize)]
struct DictateResponse {
    ok: bool,
    id: i64,
    text: String,
    raw_text: String,
    source_app: Option<String>,
}

/// Start recording, wait for the resulting transcript, return it.
///
/// This is what makes Ghostly scriptable: `git commit -m "$(ghostly --dictate)"`.
async fn handle_dictate(
    State(state): State<ApiState>,
    body: Option<Json<DictateBody>>,
) -> ApiResult<DictateResponse> {
    let body = body.map(|Json(b)| b).unwrap_or_default();

    if is_recording(&state.app) {
        return Err(error(
            StatusCode::CONFLICT,
            "A recording is already in progress.",
        ));
    }

    let timeout = Duration::from_millis(
        body.timeout_ms
            .unwrap_or(DICTATE_DEFAULT_TIMEOUT_MS)
            .min(DICTATE_MAX_TIMEOUT_MS),
    );

    let bus = state
        .app
        .try_state::<Arc<EventBus>>()
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "Event bus not available."))?;
    // Subscribe *before* starting, so a fast transcript cannot land in the gap.
    let mut rx = bus.subscribe();

    let suppressor = state.app.try_state::<Arc<PasteSuppressor>>();
    let should_paste = body.paste.unwrap_or(false);
    if !should_paste {
        if let Some(s) = &suppressor {
            s.arm();
        }
    }

    let coordinator = coordinator(&state.app)?;
    coordinator.send_start(TRANSCRIBE_BINDING, "rest_api_dictate");

    if let Some(ms) = body.stop_after_ms {
        let app = state.app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            if let Some(c) = app.try_state::<TranscriptionCoordinator>() {
                c.send_stop(TRANSCRIBE_BINDING, "rest_api_dictate_timer");
            }
        });
    }

    let waited = tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(ApiEvent::Transcript {
                    id,
                    text,
                    raw_text,
                    source_app,
                    ..
                }) => return Some((id, text, raw_text, source_app)),
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
    .await;

    // Never leave the flag armed — it would swallow the user's next real paste.
    if let Some(s) = &suppressor {
        s.disarm();
    }

    match waited {
        Ok(Some((id, text, raw_text, source_app))) => Ok(Json(DictateResponse {
            ok: true,
            id,
            text,
            raw_text,
            source_app,
        })),
        Ok(None) => Err(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Event stream closed before a transcript arrived.",
        )),
        Err(_) => {
            cancel_current_operation(&state.app);
            Err(error(
                StatusCode::REQUEST_TIMEOUT,
                "Timed out waiting for a transcript. Recording cancelled.",
            ))
        }
    }
}

#[derive(Deserialize)]
struct PasteBody {
    text: String,
    /// Press the auto-submit key after pasting. Defaults to false: an API
    /// caller should have to ask before Ghostly hits Enter in someone's shell.
    submit: Option<bool>,
}

async fn handle_paste(
    State(state): State<ApiState>,
    Json(body): Json<PasteBody>,
) -> ApiResult<OkResponse> {
    if body.text.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "text must not be empty"));
    }

    let options = crate::clipboard::PasteOptions {
        suppress_auto_submit: !body.submit.unwrap_or(false),
        ..Default::default()
    };

    crate::clipboard::paste_with_options(body.text, state.app.clone(), options)
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(OkResponse { ok: true }))
}

#[derive(Deserialize)]
struct HistoryQuery {
    limit: Option<usize>,
}

async fn handle_history(
    State(state): State<ApiState>,
    axum::extract::Query(query): axum::extract::Query<HistoryQuery>,
) -> ApiResult<serde_json::Value> {
    let hm = state
        .app
        .try_state::<Arc<HistoryManager>>()
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "History not available."))?;

    let limit = query.limit.unwrap_or(20).min(100);
    let result = hm
        .get_history_entries(None, Some(limit))
        .await
        .map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "entries": result.entries,
        "has_more": result.has_more,
    })))
}

/// Server-sent events: recording state changes and finished transcripts.
/// Lets status indicators and sync scripts react instead of polling.
async fn handle_events(
    State(state): State<ApiState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, Json<ApiError>)> {
    let bus = state
        .app
        .try_state::<Arc<EventBus>>()
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "Event bus not available."))?;
    let rx = bus.subscribe();

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let name = event.name();
                    match Event::default().event(name).json_data(&event) {
                        Ok(sse) => return Some((Ok(sse), rx)),
                        Err(e) => {
                            warn!("REST API: failed to serialise {name} event: {e}");
                            continue;
                        }
                    }
                }
                // A slow client missing events is not a reason to drop it.
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    debug!("REST API: SSE client lagged {n} events");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_recording(app: &AppHandle) -> bool {
    app.try_state::<Arc<AudioRecordingManager>>()
        .map_or(false, |rm| rm.is_recording())
}

fn coordinator(
    app: &AppHandle,
) -> Result<tauri::State<'_, TranscriptionCoordinator>, (StatusCode, Json<ApiError>)> {
    app.try_state::<TranscriptionCoordinator>().ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Transcription coordinator not initialized.",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_only_identical_input() {
        assert!(constant_time_eq(b"abc123", b"abc123"));
        assert!(!constant_time_eq(b"abc123", b"abc124"));
        assert!(!constant_time_eq(b"abc123", b"abc1234"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    #[tokio::test]
    async fn bind_succeeds_on_a_free_port() {
        // Port 0 lets the OS pick, so this cannot collide with a real service.
        let listener = bind_with_retry("127.0.0.1:0", false).await;
        assert!(listener.is_ok());
    }

    #[tokio::test]
    async fn bind_reports_a_port_already_taken() {
        let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = occupied.local_addr().unwrap().to_string();

        let err = bind_with_retry(&addr, false).await.unwrap_err();
        assert!(err.contains("already in use"), "unexpected message: {err}");
    }

    #[tokio::test]
    async fn bind_retries_until_the_previous_listener_lets_go() {
        let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = occupied.local_addr().unwrap().to_string();

        // Mimics our own outgoing server releasing the socket a moment after
        // being told to stop — the case the retry exists for.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            drop(occupied);
        });

        let listener = bind_with_retry(&addr, true).await;
        assert!(listener.is_ok(), "retry should have won the port back");
    }

    #[test]
    fn generated_tokens_are_unique_and_hex() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
