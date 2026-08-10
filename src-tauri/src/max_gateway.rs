//! Client-side policy for the Ghostly Max hosted-AI gateway.
//!
//! [`crate::llm_client`] stays a pure HTTP layer: it is handed a provider, a
//! key, and a model, and it speaks the OpenAI dialect. This module sits one
//! level up and holds the two things that are specific to Max being *hosted*
//! rather than bring-your-own-key:
//!
//!   1. **Error codes.** The gateway answers with a machine-readable `code`
//!      (`not_max`, `expired`, `unpaid`, `fair_use_exceeded`, `upstream_error`)
//!      so the UI can render a real state instead of a raw HTTP body.
//!   2. **Overflow fallback.** Max is the only provider that can run out of
//!      quota mid-month. When it does and the user also has a personal API key
//!      configured, the request falls through to that key rather than failing.
//!      Nothing else on the market can do that, and it costs us one retry.
//!
//! The wrappers here mirror `llm_client`'s functions one-for-one and are a
//! straight pass-through for every provider except Max, so call sites don't
//! have to know which provider they got.

use crate::settings::{
    AppSettings, PostProcessProvider, APPLE_INTELLIGENCE_PROVIDER_ID, MAX_PROVIDER_ID,
};
use log::{debug, warn};
use std::sync::Mutex;

/// Machine-readable failure codes `src/ai.ts` returns in `error.code`.
///
/// Kept as a closed enum rather than a bare string so a typo can't quietly
/// disable the fallback, and so the frontend contract is enumerable in one
/// place. Anything unrecognised is simply not one of ours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayCode {
    /// 401 — no bearer token reached the gateway.
    MissingKey,
    /// 401 — the gateway has never seen this licence key.
    InvalidKey,
    /// 402 — a Pro (or free) licence asking for hosted AI.
    NotMax,
    /// 402 — subscription lapsed past `current_period_end`.
    Expired,
    /// 402 — Stripe reports a non-serviceable subscription status.
    Unpaid,
    /// 403 — the licence was revoked (refund/chargeback).
    Revoked,
    /// 429 — this month's fair-use allowance is spent.
    FairUseExceeded,
    /// 502/429 — Anthropic itself is unavailable or rate limiting us.
    UpstreamError,
}

impl GatewayCode {
    pub fn as_str(self) -> &'static str {
        match self {
            GatewayCode::MissingKey => "missing_key",
            GatewayCode::InvalidKey => "invalid_key",
            GatewayCode::NotMax => "not_max",
            GatewayCode::Expired => "expired",
            GatewayCode::Unpaid => "unpaid",
            GatewayCode::Revoked => "revoked",
            GatewayCode::FairUseExceeded => "fair_use_exceeded",
            GatewayCode::UpstreamError => "upstream_error",
        }
    }

    fn from_wire(code: &str) -> Option<Self> {
        Some(match code {
            "missing_key" => GatewayCode::MissingKey,
            "invalid_key" => GatewayCode::InvalidKey,
            "not_max" => GatewayCode::NotMax,
            "expired" => GatewayCode::Expired,
            "unpaid" => GatewayCode::Unpaid,
            "revoked" => GatewayCode::Revoked,
            "fair_use_exceeded" => GatewayCode::FairUseExceeded,
            "upstream_error" => GatewayCode::UpstreamError,
            _ => return None,
        })
    }
}

/// What a request is *for*.
///
/// Max is asked for a job, never a model: the gateway maps the alias to a
/// concrete Anthropic model, so routing retunes in a Worker deploy with no app
/// release. Bring-your-own-key providers have one model configured for
/// everything, so the job is ignored for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Job {
    /// Per-dictation work: refinement, voice edit, note titles, live meeting
    /// line cleanup. Runs constantly, so it runs cheap.
    Fast,
    /// One-shot reasoning over a lot of text — meeting summaries, and
    /// questions asked of the transcript history.
    Balanced,
    /// Anything with an image attached.
    Vision,
}

impl Job {
    pub fn alias(self) -> &'static str {
        match self {
            Job::Fast => "ghostly-fast",
            Job::Balanced => "ghostly-balanced",
            Job::Vision => "ghostly-vision",
        }
    }
}

/// One resolved LLM destination: which provider, which model, which key.
///
/// Every call site already assembles exactly this triple out of settings, so
/// naming it lets the overflow swap happen in one place instead of three lines
/// repeated at each site.
#[derive(Debug, Clone)]
pub struct Target {
    pub provider: PostProcessProvider,
    pub model: String,
    pub api_key: String,
}

impl Target {
    /// Resolve the triple for `provider_id`, or `None` if that provider isn't
    /// configured with a model.
    pub fn resolve(settings: &AppSettings, provider_id: &str) -> Option<Self> {
        let provider = settings.post_process_provider(provider_id)?.clone();
        let model = settings
            .post_process_models
            .get(&provider.id)
            .cloned()
            .unwrap_or_default();
        if model.trim().is_empty() {
            return None;
        }
        let api_key = settings
            .post_process_api_keys
            .get(&provider.id)
            .cloned()
            .unwrap_or_default();
        Some(Target {
            provider,
            model,
            api_key,
        })
    }

    pub fn is_max(&self) -> bool {
        self.provider.id == MAX_PROVIDER_ID
    }

    /// Point this target at the model that suits `job`.
    ///
    /// Only meaningful for Max. Every other provider has exactly one model the
    /// user configured, and silently swapping it for a name they never entered
    /// would fail — their key is for their model.
    pub fn for_job(mut self, job: Job) -> Self {
        if self.is_max() {
            self.model = job.alias().to_string();
        }
        self
    }
}

// ── Error parsing ───────────────────────────────────────────────────────────

/// Pull the gateway's error code out of an `llm_client` error string.
///
/// `llm_client` formats HTTP failures as `"… failed with status 429: {body}"`,
/// so the JSON body is recoverable from the first `{`. Parsing the string back
/// out is less invasive than threading a structured error type through four
/// public functions and every one of their call sites — and non-Max providers
/// never produce one of our codes, so a false positive isn't reachable.
pub fn parse_code(err: &str) -> Option<GatewayCode> {
    let start = err.find('{')?;
    let value: serde_json::Value = serde_json::from_str(&err[start..]).ok()?;
    let code = value.get("error")?.get("code")?.as_str()?;
    GatewayCode::from_wire(code)
}

// ── Fair-use state ──────────────────────────────────────────────────────────
//
// Once the gateway says the month is spent, every further request would get
// the same 429. Remembering it means the rest of the month goes straight to
// the personal key instead of paying a wasted round-trip per dictation.
//
// In-memory on purpose: the worst case on restart is one extra 429 that
// re-learns the state, which is cheaper than another persisted settings field
// to migrate and keep honest.

static FAIR_USE_EXHAUSTED_MONTH: Mutex<Option<String>> = Mutex::new(None);

/// `YYYY-MM` in UTC — the same bucket key the Worker meters against
/// (`usageMonth()` in `entitlement.ts`).
fn current_month() -> String {
    chrono::Utc::now().format("%Y-%m").to_string()
}

fn set_fair_use_exhausted() {
    let mut guard = FAIR_USE_EXHAUSTED_MONTH
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(current_month());
}

/// True when the gateway has already told us this calendar month is spent.
pub fn fair_use_exhausted() -> bool {
    let guard = FAIR_USE_EXHAUSTED_MONTH
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard.as_deref() == Some(current_month().as_str())
}

/// Forget the cap. Called when licence state changes — a new subscription, a
/// different key, or a support-raised cap all invalidate what we learned.
pub fn clear_fair_use_flag() {
    let mut guard = FAIR_USE_EXHAUSTED_MONTH
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

/// Record what an error tells us and hand back the parsed code.
///
/// Call sites use the return value to decide whether to retry; the recording
/// side effect is what makes the *next* request skip the gateway entirely.
pub fn note_error(target: &Target, err: &str) -> Option<GatewayCode> {
    if !target.is_max() {
        return None;
    }
    let code = parse_code(err)?;
    if code == GatewayCode::FairUseExceeded {
        warn!("Ghostly Max monthly fair-use cap reached; falling back to a personal key if one is configured");
        set_fair_use_exhausted();
    }
    Some(code)
}

// ── Overflow fallback ───────────────────────────────────────────────────────

/// The personal-key provider to fall through to when Max is out of quota.
///
/// Picks the first configured HTTP provider with both a key and a model. Apple
/// Intelligence is excluded deliberately: it is not an HTTP provider at all —
/// it runs through a separate Swift FFI path — so it cannot be substituted at
/// this layer. A Max subscriber who wants the on-device model as their
/// overflow can select it as their provider outright.
pub fn overflow_target(settings: &AppSettings) -> Option<Target> {
    settings
        .post_process_providers
        .iter()
        .filter(|p| p.id != MAX_PROVIDER_ID && p.id != APPLE_INTELLIGENCE_PROVIDER_ID)
        .find_map(|p| {
            let target = Target::resolve(settings, &p.id)?;
            (!target.api_key.trim().is_empty()).then_some(target)
        })
}

/// The target a request should actually use.
///
/// Normally the one that was resolved from settings — but when the gateway has
/// already told us the month is spent, this skips it and returns the personal
/// key directly, so the user pays no extra latency for a request we know will
/// be rejected.
pub fn effective_target(settings: &AppSettings, target: Target) -> Target {
    if !target.is_max() || !fair_use_exhausted() {
        return target;
    }
    match overflow_target(settings) {
        Some(fallback) => {
            debug!(
                "Ghostly Max cap already spent this month; routing to '{}'",
                fallback.provider.id
            );
            fallback
        }
        // No personal key configured. Still hit the gateway so the user gets
        // the real 429 and the UI can explain it, rather than failing silently
        // with a stale local flag.
        None => target,
    }
}

/// Whether a failed Max request should be retried against a personal key, and
/// which target to use if so.
fn retry_target(settings: &AppSettings, target: &Target, err: &str) -> Option<Target> {
    if note_error(target, err)? != GatewayCode::FairUseExceeded {
        return None;
    }
    let fallback = overflow_target(settings)?;
    debug!(
        "Retrying against '{}' after Ghostly Max fair-use rejection",
        fallback.provider.id
    );
    Some(fallback)
}

// ── Wrappers ────────────────────────────────────────────────────────────────
//
// One per `llm_client` entry point the app actually reaches with a hosted
// target. Each is a pass-through plus "on a fair-use rejection, run it once
// more against the personal key."

pub async fn send_chat_completion(
    settings: &AppSettings,
    target: Target,
    prompt: String,
    reasoning_effort: Option<String>,
    reasoning: Option<crate::llm_client::ReasoningConfig>,
) -> Result<Option<String>, String> {
    let target = effective_target(settings, target);
    let first = crate::llm_client::send_chat_completion(
        &target.provider,
        target.api_key.clone(),
        &target.model,
        prompt.clone(),
        reasoning_effort.clone(),
        reasoning.clone(),
    )
    .await;

    let Err(err) = &first else { return first };
    let Some(fallback) = retry_target(settings, &target, err) else {
        return first;
    };

    crate::llm_client::send_chat_completion(
        &fallback.provider,
        fallback.api_key,
        &fallback.model,
        prompt,
        reasoning_effort,
        reasoning,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn send_chat_completion_with_schema(
    settings: &AppSettings,
    target: Target,
    user_content: String,
    system_prompt: Option<String>,
    json_schema: Option<serde_json::Value>,
    reasoning_effort: Option<String>,
    reasoning: Option<crate::llm_client::ReasoningConfig>,
) -> Result<Option<String>, String> {
    let target = effective_target(settings, target);
    let first = crate::llm_client::send_chat_completion_with_schema(
        &target.provider,
        target.api_key.clone(),
        &target.model,
        user_content.clone(),
        system_prompt.clone(),
        json_schema.clone(),
        reasoning_effort.clone(),
        reasoning.clone(),
    )
    .await;

    let Err(err) = &first else { return first };
    let Some(fallback) = retry_target(settings, &target, err) else {
        return first;
    };

    // The fallback provider may not support structured output; drop the schema
    // rather than sending one it will reject. Callers already parse defensively
    // because the legacy path exists for exactly this case.
    let schema = fallback
        .provider
        .supports_structured_output
        .then_some(json_schema)
        .flatten();
    crate::llm_client::send_chat_completion_with_schema(
        &fallback.provider,
        fallback.api_key,
        &fallback.model,
        user_content,
        system_prompt,
        schema,
        reasoning_effort,
        reasoning,
    )
    .await
}

pub async fn send_chat_completion_with_image(
    settings: &AppSettings,
    target: Target,
    user_text: String,
    image_png: &[u8],
    system_prompt: Option<String>,
) -> Result<Option<String>, String> {
    let target = effective_target(settings, target);
    let first = crate::llm_client::send_chat_completion_with_image(
        &target.provider,
        target.api_key.clone(),
        &target.model,
        user_text.clone(),
        image_png,
        system_prompt.clone(),
    )
    .await;

    let Err(err) = &first else { return first };
    let Some(fallback) = retry_target(settings, &target, err) else {
        return first;
    };
    if !fallback.provider.supports_vision {
        return first;
    }

    crate::llm_client::send_chat_completion_with_image(
        &fallback.provider,
        fallback.api_key,
        &fallback.model,
        user_text,
        image_png,
        system_prompt,
    )
    .await
}

/// Streaming variant.
///
/// `on_delta` must be `Clone` because a retry needs a second copy. That is
/// safe here specifically because a fair-use rejection is a non-2xx *before*
/// the stream opens, so the first attempt emits no deltas — the only error we
/// ever retry on cannot have produced partial output.
pub async fn send_chat_completion_stream<F>(
    settings: &AppSettings,
    target: Target,
    user_content: String,
    system_prompt: Option<String>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    on_delta: F,
) -> Result<String, String>
where
    F: FnMut(&str) + Clone,
{
    let target = effective_target(settings, target);
    let first = crate::llm_client::send_chat_completion_stream(
        &target.provider,
        target.api_key.clone(),
        &target.model,
        user_content.clone(),
        system_prompt.clone(),
        std::sync::Arc::clone(&cancel),
        on_delta.clone(),
    )
    .await;

    let Err(err) = &first else { return first };
    let Some(fallback) = retry_target(settings, &target, err) else {
        return first;
    };

    crate::llm_client::send_chat_completion_stream(
        &fallback.provider,
        fallback.api_key,
        &fallback.model,
        user_content,
        system_prompt,
        cancel,
        on_delta,
    )
    .await
}

/// A short, user-facing explanation for a gateway failure.
///
/// Returned alongside the code so the frontend can show a localized string but
/// still has something sane if it doesn't recognise the code.
pub fn describe(code: GatewayCode) -> &'static str {
    match code {
        GatewayCode::MissingKey | GatewayCode::InvalidKey => {
            "Ghostly Max didn't recognise this licence. Try reactivating it in Settings → Account."
        }
        GatewayCode::NotMax => {
            "This licence doesn't include hosted AI. Subscribe to Ghostly Max, or add your own API key."
        }
        GatewayCode::Expired | GatewayCode::Unpaid => {
            "Your Ghostly Max subscription isn't active. Update billing, or add your own API key."
        }
        GatewayCode::Revoked => "This licence has been revoked.",
        GatewayCode::FairUseExceeded => {
            "You've reached this month's Ghostly Max fair-use limit. Add your own API key to keep going."
        }
        GatewayCode::UpstreamError => "The AI service is temporarily unavailable. Try again shortly.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fair-use flag is process-global, and `cargo test` runs these in
    /// parallel — without this they clear each other's state at random.
    static FLAG_LOCK: Mutex<()> = Mutex::new(());

    fn lock_flag() -> std::sync::MutexGuard<'static, ()> {
        let guard = FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_fair_use_flag();
        guard
    }

    fn provider(id: &str) -> PostProcessProvider {
        PostProcessProvider {
            id: id.to_string(),
            label: id.to_string(),
            base_url: "https://example.test/v1".to_string(),
            allow_base_url_edit: false,
            models_endpoint: None,
            supports_structured_output: false,
            supports_vision: false,
        }
    }

    fn target(id: &str) -> Target {
        Target {
            provider: provider(id),
            model: "m".to_string(),
            api_key: "k".to_string(),
        }
    }

    #[test]
    fn parses_gateway_codes_out_of_llm_client_errors() {
        let err = r#"API request failed with status 429: {"error":{"message":"nope","type":"invalid_request_error","code":"fair_use_exceeded"}}"#;
        assert_eq!(parse_code(err), Some(GatewayCode::FairUseExceeded));

        let err =
            r#"API request failed with status 402: {"error":{"message":"x","code":"not_max"}}"#;
        assert_eq!(parse_code(err), Some(GatewayCode::NotMax));
    }

    #[test]
    fn ignores_errors_that_are_not_ours() {
        assert_eq!(parse_code("HTTP request failed: connection refused"), None);
        assert_eq!(
            parse_code(
                r#"API request failed with status 401: {"error":{"code":"invalid_api_key"}}"#
            ),
            None
        );
        assert_eq!(
            parse_code(r#"API request failed with status 500: not json {"#),
            None
        );
    }

    #[test]
    fn only_max_targets_set_the_fair_use_flag() {
        let _guard = lock_flag();
        let err = r#"status 429: {"error":{"code":"fair_use_exceeded"}}"#;

        // An OpenAI 429 that happens to echo the string must not disable Max.
        assert_eq!(note_error(&target("openai"), err), None);
        assert!(!fair_use_exhausted());

        assert_eq!(
            note_error(&target(MAX_PROVIDER_ID), err),
            Some(GatewayCode::FairUseExceeded)
        );
        assert!(fair_use_exhausted());
        clear_fair_use_flag();
        assert!(!fair_use_exhausted());
    }

    /// Settings with hosted AI selected and, optionally, a personal key parked
    /// on another provider.
    fn settings_with(byo: &[(&str, &str, &str)]) -> AppSettings {
        let mut settings = crate::settings::get_default_settings();
        settings.post_process_provider_id = MAX_PROVIDER_ID.to_string();
        settings
            .post_process_api_keys
            .insert(MAX_PROVIDER_ID.to_string(), "GHOSTLY-KEY".to_string());
        for (id, key, model) in byo {
            settings
                .post_process_api_keys
                .insert(id.to_string(), key.to_string());
            settings
                .post_process_models
                .insert(id.to_string(), model.to_string());
        }
        settings
    }

    #[test]
    fn overflow_needs_both_a_key_and_a_model() {
        // A key with no model is not a usable destination.
        let settings = settings_with(&[("openai", "sk-test", "")]);
        assert!(overflow_target(&settings).is_none());

        let settings = settings_with(&[("openai", "sk-test", "gpt-4o-mini")]);
        assert_eq!(
            overflow_target(&settings).map(|t| t.provider.id),
            Some("openai".to_string())
        );
    }

    #[test]
    fn overflow_never_picks_the_gateway_or_apple_intelligence() {
        // Both are configured with a model; neither is a valid overflow — the
        // gateway is what ran out, and Apple Intelligence is not HTTP.
        let settings = settings_with(&[(APPLE_INTELLIGENCE_PROVIDER_ID, "x", "4096")]);
        assert!(overflow_target(&settings).is_none());
    }

    #[test]
    fn a_spent_month_reroutes_before_the_request_is_made() {
        let _guard = lock_flag();
        let settings = settings_with(&[("openai", "sk-test", "gpt-4o-mini")]);
        let max = Target::resolve(&settings, MAX_PROVIDER_ID).expect("max target");

        // Nothing known yet: the gateway still gets the request.
        assert!(effective_target(&settings, max.clone()).is_max());

        note_error(&max, r#"429: {"error":{"code":"fair_use_exceeded"}}"#);
        assert_eq!(
            effective_target(&settings, max.clone()).provider.id,
            "openai"
        );

        // With no personal key there is nothing to reroute to, so the request
        // goes to the gateway and the user gets the real 429 to act on.
        let bare = settings_with(&[]);
        let bare_max = Target::resolve(&bare, MAX_PROVIDER_ID).expect("max target");
        assert!(effective_target(&bare, bare_max).is_max());
        clear_fair_use_flag();
    }

    #[test]
    fn parses_the_gateway_body_the_live_worker_actually_returns() {
        // Captured verbatim from a 429 against the deployed worker, wrapped the
        // way `llm_client` formats HTTP failures. Guards the one string contract
        // between the two repos that nothing else type-checks.
        let err = "API request failed with status 429: {\"error\":{\"message\":\"You've reached this month's fair-use limit of 8000 AI requests. It resets next month. Add your own API key in Settings to keep going now, or email support and we'll raise the cap.\",\"type\":\"invalid_request_error\",\"code\":\"fair_use_exceeded\"}}";
        assert_eq!(parse_code(err), Some(GatewayCode::FairUseExceeded));
    }

    #[test]
    fn entitlement_failures_do_not_trip_the_cap() {
        let _guard = lock_flag();
        let err = r#"status 402: {"error":{"code":"expired"}}"#;
        assert_eq!(
            note_error(&target(MAX_PROVIDER_ID), err),
            Some(GatewayCode::Expired)
        );
        assert!(!fair_use_exhausted());
    }
}
