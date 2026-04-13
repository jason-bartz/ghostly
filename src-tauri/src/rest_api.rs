//! Localhost REST API for external control of Ghostwriter.
//!
//! When `rest_api_enabled` is true in settings, this starts an HTTP server
//! bound to `127.0.0.1:<rest_api_port>` (default 7543).
//!
//! ## Endpoints
//!
//! | Method | Path                   | Description                                |
//! |--------|------------------------|--------------------------------------------|
//! | POST   | /api/transcribe/start  | Start transcription (toggle)               |
//! | POST   | /api/transcribe/stop   | Stop transcription (if recording)          |
//! | POST   | /api/transcribe/cancel | Cancel current operation                   |
//! | POST   | /api/paste             | Paste arbitrary text via Ghostwriter       |
//! | GET    | /api/history           | Latest N history entries (default 20)      |
//! | GET    | /api/status            | App status (is_recording, version, etc.)  |

use axum::{
    extract::State,
    http::{Method, StatusCode},
    response::Json,
    routing::{get, post},
    Router,
};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;
use tower_http::cors::{Any, CorsLayer};

use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::signal_handle::send_transcription_input;
use crate::utils::cancel_current_operation;

#[derive(Clone)]
struct ApiState {
    app: AppHandle,
}

#[derive(Serialize)]
struct ApiResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl ApiResponse {
    fn ok() -> Self {
        Self {
            ok: true,
            message: None,
        }
    }

    fn err(msg: impl Into<String>) -> (StatusCode, Json<Self>) {
        (
            StatusCode::BAD_REQUEST,
            Json(Self {
                ok: false,
                message: Some(msg.into()),
            }),
        )
    }
}

#[derive(Deserialize)]
struct PasteBody {
    text: String,
}

#[derive(Deserialize)]
struct HistoryQuery {
    limit: Option<usize>,
}

async fn handle_transcribe_start(State(state): State<ApiState>) -> Json<ApiResponse> {
    send_transcription_input(&state.app, "transcribe", "rest_api");
    Json(ApiResponse::ok())
}

async fn handle_transcribe_stop(State(state): State<ApiState>) -> Json<ApiResponse> {
    // "stop" in toggle mode is the same as "start" — sends the toggle input.
    // For push-to-talk, the coordinator handles the release correctly.
    send_transcription_input(&state.app, "transcribe", "rest_api_stop");
    Json(ApiResponse::ok())
}

async fn handle_cancel(State(state): State<ApiState>) -> Json<ApiResponse> {
    cancel_current_operation(&state.app);
    Json(ApiResponse::ok())
}

async fn handle_paste(
    State(state): State<ApiState>,
    Json(body): Json<PasteBody>,
) -> Result<Json<ApiResponse>, (StatusCode, Json<ApiResponse>)> {
    if body.text.is_empty() {
        return Err(ApiResponse::err("text must not be empty"));
    }
    crate::clipboard::paste(body.text, state.app).map_err(|e| ApiResponse::err(e))?;
    Ok(Json(ApiResponse::ok()))
}

async fn handle_history(
    State(state): State<ApiState>,
    axum::extract::Query(query): axum::extract::Query<HistoryQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiResponse>)> {
    use tauri::Manager;
    let hm = state
        .app
        .try_state::<Arc<HistoryManager>>()
        .ok_or_else(|| ApiResponse::err("History manager not available"))?;

    let limit = query.limit.unwrap_or(20).min(100);
    let result = hm
        .get_history_entries(None, Some(limit))
        .await
        .map_err(|e| ApiResponse::err(e.to_string()))?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "entries": result.entries,
        "has_more": result.has_more,
    })))
}

#[derive(Serialize)]
struct StatusResponse {
    ok: bool,
    is_recording: bool,
    version: &'static str,
}

async fn handle_status(State(state): State<ApiState>) -> Json<StatusResponse> {
    use tauri::Manager;
    let is_recording = state
        .app
        .try_state::<Arc<AudioRecordingManager>>()
        .map_or(false, |rm| rm.is_recording());

    Json(StatusResponse {
        ok: true,
        is_recording,
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Start the REST API server. Blocks until the server is stopped.
/// Should be called in a background thread/task.
pub async fn start_server(app: AppHandle, port: u16) {
    let state = ApiState { app };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let router = Router::new()
        .route("/api/transcribe/start", post(handle_transcribe_start))
        .route("/api/transcribe/stop", post(handle_transcribe_stop))
        .route("/api/cancel", post(handle_cancel))
        .route("/api/paste", post(handle_paste))
        .route("/api/history", get(handle_history))
        .route("/api/status", get(handle_status))
        .layer(cors)
        .with_state(state);

    let addr = format!("127.0.0.1:{}", port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            warn!("REST API: failed to bind on {}: {}", addr, e);
            return;
        }
    };

    info!("REST API listening on http://{}", addr);

    if let Err(e) = axum::serve(listener, router).await {
        warn!("REST API server error: {}", e);
    }
}
