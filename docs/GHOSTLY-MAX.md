# Ghostly Max — build handoff

Everything needed to finish Max in a fresh session. Written 2026-08-09.

Spans three repos:

| Repo | Path | Role |
|---|---|---|
| App | `~/Ghostly-App` | macOS app (Tauri, Rust + React) |
| Worker | `~/ghostly-license-server` | Cloudflare Worker: licensing, billing, AI gateway |
| Site | `~/try-ghostly` | try-ghostly.com, GitHub Pages off `main` |

---

## 1. The product decision

Pro (the $39 one-time licence) **is retired**. Two tiers now:

- **Free** — unlimited dictation, every feature, every Mac you own. AI features run on the user's own API key (Anthropic/OpenAI/Groq/Ollama) or on-device Apple Intelligence.
- **Max — $12/mo or $108/yr** — the same AI features with no API key and no setup, plus features that need a server.

**The test any Max feature must pass:** *could a user replicate this by pasting in their own API key?* If yes, it doesn't belong in Max. That rules out "better models" as the pitch — a determined user just doesn't buy. What survives is anything needing a server.

**Why Free went uncapped:** it's the strongest review-generator available (Wispr and Willow both cap free at 2k words/week), and it makes Max a purely additive sale rather than a hostage situation. Never gate an existing local feature behind Max — additive only.

**The privacy line that makes this work:** transcription is always on-device, on every tier. Max sends *text* to a model, never audio. Competitors stream your voice to their servers; you structurally can't. This is the pitch.

**Unit economics** (measured against real Anthropic pricing): ~$0.0017 per dictation on Haiku 4.5; a heavy user runs ~$3.70/month. Meetings are the tail risk at ~$0.08–0.12 per meeting-hour. Blended COGS ≈ $3–6/user/month against $12 revenue, so ~50–65% gross margin.

---

## 2. What is already done

### Site — **live**
Free/Max pricing, comparison table rebuilt (new row: "Fully usable without a subscription" — you Yes, three competitors No), FAQs, JSON-LD offers, all six `/for/` pages, `llms.txt`, `activated.html`.

`/ph/` (Product Hunt) was converted off the dead $19 Pro offer to **"hunters get 6 months of Max free"** — a Pro licence buys nothing once Free is uncapped, so it couldn't keep selling.

**Max is presented as early access with a `mailto:` waitlist, deliberately.** Nothing is charged. See §5 for how to flip it.

### Stripe — **live** (`acct_1TMBrCBH5FhMp4sK`)

| | |
|---|---|
| Product | `prod_V2ld2CpXRaY3p0` — Ghostly Max |
| $12/mo | `price_1U2g6PBH5FhMp4sKXBUpvQKF` |
| $108/yr | `price_1U2g6QBH5FhMp4sKGRaLZJVA` |
| Link (monthly) | `plink_1U2g6QBH5FhMp4sKvXspDYha` → `https://buy.stripe.com/8x26oGcuSdAi6oS9DoeME02` |
| Link (yearly) | `plink_1U2g6RBH5FhMp4sKgd08RrUx` → `https://buy.stripe.com/14A3cu3Ym1RA6oS3f0eME03` |
| Portal config | `bpc_1U2g6RBH5FhMp4sKmfHdT1aA` — self-serve cancel at period end |
| Webhook | `we_1TMa0UBH5FhMp4sKJ0Sl4l80` — 6 events (checkout, refund, 3× subscription, invoice.payment_failed) |

**Archived:** `prod_ULG39lQsFFAMxv` and `prod_UKrzmlZwucEndh` (there were two duplicate Pro products). Old link `plink_1TMZYaBH5FhMp4sKxGJ0gyhs` deactivated. Branding and Stripe Tax handled manually in the Dashboard.

The payment links exist but **are not published anywhere.** Don't publish until §4 is deployed and §5 done.

### App — **v0.1.26 shipped** (signed, notarized, on R2 + GitHub, auto-updater live)
- Free-tier 60-min/week cap removed (`managers/usage.rs`); `check_limit` is an always-allow shim kept so reintroducing metering is a one-function change.
- `PaywallModal` deleted; `PAYMENT_LINK` repointed off the dead Stripe URL.
- Usage pane reads `weekly_limit_secs == 0` as uncapped.

### App — Max provider, **committed `3a7993b`, not yet released**
- `TokenPayload.tier` (`Option<String>`, serde default) — entitlement known offline.
- `MAX_PROVIDER_ID = "ghostly_max"`, `MAX_DEFAULT_MODEL = "ghostly-fast"`, provider `base_url = {license_base}/v1`.
- `settings::sync_max_provider_key(app)` mirrors the licence key into `post_process_api_keys["ghostly_max"]`, called on activate / deactivate / revalidate.

> **Why that mirroring matters:** every existing call site reads provider credentials out of `post_process_api_keys`. Putting the licence key there meant **zero changes** to `actions.rs`, `ai_metadata.rs`, `llm_client.rs`, or the meeting summariser. Don't "clean this up" into a special-case lookup — the indirection is the point.

### Worker — **committed `7d9aece`, NOT deployed**
New: `migrations/0003_subscriptions.sql`, `src/entitlement.ts`, `src/subscriptions.ts`, `src/ai.ts`. Modified: `src/index.ts`, `src/tokens.ts`, `src/licenses.ts`.

Routes added: `POST /v1/chat/completions`, `GET /ai/status`.

---

## 3. Architecture decisions — do not relitigate

**The gateway speaks the OpenAI dialect, not Anthropic's.** `llm_client.rs` already has a tested OpenAI-format client with SSE streaming and cancellation, and explicitly does *not* stream Anthropic's `/v1/messages` (different event schema). Translating server-side cost the app one provider entry instead of a second HTTP client.

**Auth is the licence key as a bearer token.** Same secret the app already sends to `/license/activate`, over TLS to our own origin, and every request needs a D1 round-trip for quota anyway — so verifying a signed token would save nothing.

**Entitlement trusts `current_period_end` over `subscription_status`.** If a webhook is late, dropped, or out of order, someone who paid through the 20th keeps working until the 20th. The failure mode worth avoiding is locking out a paying customer.

**`checkout.session.completed` creates the Max licence**, not `customer.subscription.created` — it's the only event carrying the buyer's email, and the worker makes no Stripe API calls. The subscription events only move the billing window afterwards.

**Model aliases, not model ids.** The app asks for a job (`ghostly-fast`, `ghostly-balanced`, `ghostly-vision`); the gateway resolves to `claude-haiku-4-5` / `claude-sonnet-5`. Routing retunes in a Worker deploy with no app release — one of the few things Max offers that BYO-key can't replicate.

**PRIVACY INVARIANT (`src/ai.ts`):** never log, persist, or forward message content anywhere but Anthropic. `ai_usage` stores token counts only. Audit any new `console.*` in that file against this.

---

## 4. Deploy the gateway — three commands

```bash
cd ~/ghostly-license-server
wrangler secret put ANTHROPIC_API_KEY
wrangler d1 migrations apply ghostly-licenses --remote
wrangler deploy
```

Then smoke-test — the app can't be the first client:

```bash
# Should return tier/ai_enabled/quota for a real key
curl -s https://ghostly-license-server.aged-art-e321.workers.dev/ai/status \
  -H "Authorization: Bearer GHOSTLY-XXXX-XXXX-XXXX-XXXX"

# Should 402 on a Pro key, stream on a Max key
curl -sN https://ghostly-license-server.aged-art-e321.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer GHOSTLY-XXXX-XXXX-XXXX-XXXX" \
  -H "Content-Type: application/json" \
  -d '{"model":"ghostly-fast","stream":true,"messages":[{"role":"user","content":"say ok"}]}'
```

`wrangler.toml` has an uncommitted `DOWNLOAD_URL` edit — decide on it before deploying.

---

## 5. Remaining work

### Phase 1c — Max settings UI *(small; do first)*
`src/components/settings/` — when `tier == "max"`: hide the provider picker, model picker, and API-key field entirely (the whole pitch is "no config screen"). Render the gateway's error codes as real UI states, not raw toasts:

| Code | HTTP | Meaning |
|---|---|---|
| `not_max` | 402 | Pro licence, no hosted AI |
| `expired` / `unpaid` | 402 | Subscription lapsed |
| `fair_use_exceeded` | 429 | Monthly cap hit |
| `upstream_error` | 502/429 | Anthropic unavailable |

Then the **BYO-key overflow fallback**: on `fair_use_exceeded`, if the user has a personal key configured, silently fall through to it. Nobody else can offer that, and the plumbing already exists.

Add a Max section to the Account pane showing `requests_used / requests_limit` from `GET /ai/status`.

### Phase 2 — Ask your transcripts *(medium; the demo feature)*
Hotkey → prompt → search the local history DB and meeting store → send only the top-k matching snippets to `ghostly-balanced` → answer.

**Retrieval stays local, reasoning goes to the cloud.** Nothing is uploaded or indexed server-side; that's what keeps the privacy story intact. Existing surfaces: `managers/history.rs`, `meetings/store.rs`. Cost ≈ $0.015/query.

### Phase 3 — Learning loop *(medium; the retention argument)*
Every correction via the voice-edit loop (`edit_intent.rs`) or a post-paste edit is a labelled training pair. Batch them nightly through the **Batch API at 50% off** (no latency requirement) to update custom vocabulary and per-app prompts. Surface a weekly "Ghostly learned 7 new terms" card. Cost ≈ $0.35/user/month.

This is the honest answer to "why a subscription and not a one-time purchase."

### Phase 4 — Encrypted sync *(large — design before coding)*
Vocabulary, profiles, prompts, correction phrases, history — E2E encrypted across a user's Macs, restorable on a new machine. **Do not start coding this without settling:** key derivation and custody (what happens when a device is lost?), conflict resolution across three machines, and what the server can see. Rushed, this produces a data-loss bug rather than a feature.

### Flipping the site to live checkout
Only after phase 1c ships and the gateway is serving. In `~/try-ghostly/index.html`, the Max pricing card contains a marked comment block with the exact `<a>` to paste in. Then delete the three `In development` badges and swap the footnote. Same in `/ph/`.

---

## 6. Gotchas that cost time

**`scripts/release.sh` has no staging gate.** The moment CI goes green, `downloads.try-ghostly.com` serves the DMG and the auto-updater offers it to every install. Publishing the GitHub draft later changes nothing. Smoke-test *before* running it.

**Stripe CLI (v1.40.5):** global flags go **after** the subcommand (`stripe products create --live --project-name ghostly …`). `--format` doesn't exist (JSON is default). Archiving is `-d "active=false"`, not `--no-active`.

**The `stripe login` CLI key can never write.** It's Stripe-managed and hard-locked at Read on every resource. Use `~/.ghostly-keys/stripe-admin.key` (a restricted `rk_live`, `0600`) — `scripts/setup-max-billing.sh` reads it automatically. `rm` it when done.

**Stripe account branding is Dashboard-only.** `/v1/accounts` only accepts branding writes for Connect accounts.

**`bun run check:translations` fails 0/19.** Long-standing, expected, non-blocking — only add new strings to `en/`.

**Existing Pro holders.** The v0.1.26 release notes promise *"Email support@try-ghostly.com and we will make it right."* That commitment is live and undefined. Their $39 now buys nothing over Free; comping them Max is the obvious make-good but hasn't been decided.

---

## 7. Verification commands

```bash
# App
cd ~/Ghostly-App
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo check --manifest-path src-tauri/Cargo.toml
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib   # 244 passing
bun run build && bun run lint
bun run bindings:check     # fails if Rust types drifted from src/bindings.ts

# Worker
cd ~/ghostly-license-server && npx tsc --noEmit

# Release (only after smoke-testing)
cd ~/Ghostly-App && ./scripts/release.sh 0.1.27   # needs release-notes/v0.1.27.md first
```

Release notes format: plain-text bullets under a bare heading line — **no markdown headers or bold**, the in-app updater renders them literally. See `release-notes/v0.1.26.md`.
