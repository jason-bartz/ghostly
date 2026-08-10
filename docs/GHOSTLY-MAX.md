# Ghostly Max — build handoff

Everything needed to finish Max in a fresh session. Written 2026-08-09.

Spans three repos:

| Repo   | Path                       | Role                                              |
| ------ | -------------------------- | ------------------------------------------------- |
| App    | `~/Ghostly-App`            | macOS app (Tauri, Rust + React)                   |
| Worker | `~/ghostly-license-server` | Cloudflare Worker: licensing, billing, AI gateway |
| Site   | `~/try-ghostly`            | try-ghostly.com, GitHub Pages off `main`          |

---

## 1. The product decision

Pro (the $39 one-time licence) **is retired**. Two tiers now:

- **Free** — unlimited dictation, every feature, every Mac you own. AI features run on the user's own API key (Anthropic/OpenAI/Groq/Ollama) or on-device Apple Intelligence.
- **Max — $12/mo or $108/yr** — the same AI features with no API key and no setup, plus features that need a server.

**The test any Max feature must pass:** _could a user replicate this by pasting in their own API key?_ If yes, it doesn't belong in Max. That rules out "better models" as the pitch — a determined user just doesn't buy. What survives is anything needing a server.

**Why Free went uncapped:** it's the strongest review-generator available (Wispr and Willow both cap free at 2k words/week), and it makes Max a purely additive sale rather than a hostage situation. Never gate an existing local feature behind Max — additive only.

**The privacy line that makes this work:** transcription is always on-device, on every tier. Max sends _text_ to a model, never audio. Competitors stream your voice to their servers; you structurally can't. This is the pitch.

**Unit economics** (measured against real Anthropic pricing): ~$0.0017 per dictation on Haiku 4.5; a heavy user runs ~$3.70/month. Meetings are the tail risk at ~$0.08–0.12 per meeting-hour. Blended COGS ≈ $3–6/user/month against $12 revenue, so ~50–65% gross margin.

---

## 2. What is already done

### Site — **live**

Free/Max pricing, comparison table rebuilt (new row: "Fully usable without a subscription" — you Yes, three competitors No), FAQs, JSON-LD offers, all six `/for/` pages, `llms.txt`, `activated.html`.

`/ph/` (Product Hunt) was converted off the dead $19 Pro offer to **"hunters get 6 months of Max free"** — a Pro licence buys nothing once Free is uncapped, so it couldn't keep selling.

**Max is presented as early access with a `mailto:` waitlist, deliberately.** Nothing is charged. See §5 for how to flip it.

### Stripe — **live** (`acct_1TMBrCBH5FhMp4sK`)

|                |                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| Product        | `prod_V2ld2CpXRaY3p0` — Ghostly Max                                                                  |
| $12/mo         | `price_1U2g6PBH5FhMp4sKXBUpvQKF`                                                                     |
| $108/yr        | `price_1U2g6QBH5FhMp4sKGRaLZJVA`                                                                     |
| Link (monthly) | `plink_1U2g6QBH5FhMp4sKvXspDYha` → `https://buy.stripe.com/8x26oGcuSdAi6oS9DoeME02`                  |
| Link (yearly)  | `plink_1U2g6RBH5FhMp4sKgd08RrUx` → `https://buy.stripe.com/14A3cu3Ym1RA6oS3f0eME03`                  |
| Portal config  | `bpc_1U2g6RBH5FhMp4sKmfHdT1aA` — self-serve cancel at period end                                     |
| Webhook        | `we_1TMa0UBH5FhMp4sKJ0Sl4l80` — 6 events (checkout, refund, 3× subscription, invoice.payment_failed) |

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

### App — Phase 1c, **in the working tree, not yet committed or released**

Backend:

- `license::ai_status()` + `get_ai_status` command → `GET /ai/status`. `LicenseState.tier` exposes the token's tier, so every UI gate is offline and instant.
- **`max_gateway.rs`** — the one new module. Parses the gateway's `error.code` out of `llm_client`'s error strings, remembers `fair_use_exceeded` for the current UTC month, and wraps all four `llm_client` entry points with the BYO overflow retry. Pass-through for every other provider.
- Every hosted-AI call site now goes through those wrappers: refinement (streaming), voice edit, AI metadata, meeting refine + summarise, screenshot Q&A. `test_post_process_connection` deliberately does **not** — a diagnostic that silently succeeds via the fallback would report a broken gateway as healthy.
- `post-process-failed` gained a `code` field, set only for gateway rejections.
- `sync_max_provider_key` now also **deletes the keychain entry** on lapse and selects the Max provider **only on the transition** into entitlement.

Frontend: `stores/maxStore.ts` (shared entitlement, 30 s TTL on `/ai/status`), `lib/maxErrors.ts` (code → i18n key, one mapping for toast + both panes), `settings/max/{MaxProviderPanel,MaxOverflowKey,MaxAccountSection}.tsx`.

> **Two traps worth knowing about, both found by review after the code looked finished:**
>
> 1. **Dropping a key from `post_process_api_keys` does not remove it.** `write_settings` never deletes keychain entries (deleting on empty once turned a locked keychain into permanent key loss), so `hydrate_api_keys_from_keychain` puts it straight back on the next `get_settings`. A deactivated Mac kept authenticating and spending the subscriber's allowance. The Max key is the one safe exception to the no-delete rule because it is _derived_ from the token — see the comment at the `None` branch.
> 2. **`ghostly_max` is in every install's provider list**, seeded by `ensure_post_process_defaults` so the backend can resolve it the instant a subscription activates. The picker and the profile editor must filter it out for non-subscribers, or a free user can select a provider that 402s on every dictation.

### Worker — **DEPLOYED 2026-08-10**, version `102231a6-e624-41b2-ba0b-b4cdb3822fbc`

New: `migrations/0003_subscriptions.sql`, `src/entitlement.ts`, `src/subscriptions.ts`, `src/ai.ts`. Modified: `src/index.ts`, `src/tokens.ts`, `src/licenses.ts`.

Routes added: `POST /v1/chat/completions`, `GET /ai/status`. `ANTHROPIC_API_KEY` is set; `wrangler secret list` shows all five.

**Migrations `0002` and `0003` both applied** — `0002_error_reports` had never been run either, so the live worker had been serving April code. The deploy therefore also switched on the opt-in error-reporting endpoint.

> ⚠️ **`src/ai.ts` is deployed but uncommitted.** The refusal message was a single ternary that told every non-`not_max` reason to "update billing" — including refunded customers, who cannot fix anything on a billing screen. Replaced with `refusalMessage(reason)`. Commit before the next deploy from a clean checkout, or it regresses.

---

## 3. Architecture decisions — do not relitigate

**The gateway speaks the OpenAI dialect, not Anthropic's.** `llm_client.rs` already has a tested OpenAI-format client with SSE streaming and cancellation, and explicitly does _not_ stream Anthropic's `/v1/messages` (different event schema). Translating server-side cost the app one provider entry instead of a second HTTP client.

**Auth is the licence key as a bearer token.** Same secret the app already sends to `/license/activate`, over TLS to our own origin, and every request needs a D1 round-trip for quota anyway — so verifying a signed token would save nothing.

**`current_period_end` means PAID THROUGH — nothing else may write it.** This is the load-bearing invariant of the whole billing model, and it was wrong until 2026-08-10.

Entitlement trusts the window over `subscription_status`, so that a late, dropped, or out-of-order webhook can't lock out a paying customer. That is only safe if the window can never run ahead of money received. Stripe advances a subscription's period when it **invoices**, not when it **collects** — so `onSubscriptionChanged` writing `periodEnd(sub)` handed out a full free period on every failed renewal, and a full free year to anyone who started an annual checkout and abandoned 3-D Secure.

The rules now:

- `invoice.paid` / `invoice.payment_succeeded` is the **only** thing that extends the window, via `extendPaidThrough`, taking the latest `period.end` across the invoice's lines (a proration stub can sit at index 0).
- `extendPaidThrough` is `MAX(COALESCE(current_period_end, 0), ?)` — **monotonic**. Stripe does not guarantee webhook ordering, and a replayed old event must never claw back paid time.
- `customer.subscription.*` writes `subscription_status` and the subscription id, and nothing else. `setSubscriptionState` has no window parameter, deliberately.
- `incomplete` / `incomplete_expired` refuse service regardless of the window — Stripe creates a full-period Subscription object before the first payment clears.
- `markSubscriptionCanceled` still preserves the window, which is now correct: it only ever describes time already paid for.

> **If you add a Stripe event handler, do not write `current_period_end` from it.** That is the mistake, and it looks reasonable every time.

**`checkout.session.completed` creates the Max licence**, not `customer.subscription.created` — it's the only event carrying the buyer's email, and the worker makes no Stripe API calls. The subscription events only move the billing window afterwards.

**Model aliases, not model ids.** The app asks for a job (`ghostly-fast`, `ghostly-balanced`, `ghostly-vision`); the gateway resolves to `claude-haiku-4-5` / `claude-sonnet-5`. Routing retunes in a Worker deploy with no app release — one of the few things Max offers that BYO-key can't replicate.

**Fair use is a cost cap, so it meters every dimension that costs money.** Requests alone is not a budget: 8,000 dictations is the intended ~$14 of Haiku, but 8,000 requests each carrying 200k tokens of context is four orders of magnitude more. Caps are requests (8,000), input tokens (40M), output tokens (4M), plus per-request ceilings on `max_tokens` (8,192), body size (6 MB — screenshots are inline base64) and message count (64).

**The request slot is claimed before the model is called, not after.** `reserveRequest` increments and returns the new count in one statement; the handler judges that. Reading the counter and then deciding lets concurrent requests all see the same under-cap value and all proceed — the cap stops working exactly when someone is trying hardest to exceed it. `releaseRequest` gives the slot back when the request never reached the model.

**Streaming output is metered from a character floor when the stream is cut.** Anthropic reports output tokens once, on `message_delta`, at the very end; a client that reads a long completion and hangs up one event short would be billed by Anthropic and metered here as zero. `settledOutputTokens()` takes `max(reported, chars/3.5)` — biased high on purpose.

**PRIVACY INVARIANT (`src/ai.ts`):** never log, persist, or forward message content anywhere but Anthropic. `ai_usage` stores token counts only. Audit any new `console.*` in that file against this.

---

## 4. The gateway — deployed and verified

Done on 2026-08-10. Every path below was exercised against the live worker:

| Request                                 | Result                                          |
| --------------------------------------- | ----------------------------------------------- |
| `GET /ai/status`, Pro key               | 200 `{tier:"pro", ai_enabled:false, not_max}`   |
| `GET /ai/status`, Max key               | 200 `{tier:"max", ai_enabled:true, ok}` + quota |
| `POST /v1/chat/completions`, Pro key    | **402 `not_max`**                               |
| Max key, `ghostly-fast`, `stream:true`  | **200**, OpenAI SSE chunks then `[DONE]`        |
| Max key, `ghostly-balanced`, non-stream | **200**, `chat.completion` shape                |
| Max key, `ghostly-vision`, inline PNG   | **200**, model described the image              |
| Usage row at the cap                    | **429 `fair_use_exceeded`**                     |
| Revoked licence                         | **403 `revoked`**                               |
| Unknown key                             | **401 `invalid_key`**                           |
| `ai_usage` after all of it              | request + token counts only, **no content**     |

The 429 body was captured verbatim into a Rust test
(`parses_the_gateway_body_the_live_worker_actually_returns`) — it is the one
contract between the two repos that nothing else type-checks, since the app
recovers the code by string-parsing `llm_client`'s error text.

Re-run any of it with:

```bash
KEY=GHOSTLY-XXXX-XXXX-XXXX-XXXX-XXXX
BASE=https://ghostly-license-server.aged-art-e321.workers.dev
curl -s  $BASE/ai/status -H "Authorization: Bearer $KEY"
curl -sN -X POST $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ghostly-fast","stream":true,"messages":[{"role":"user","content":"say ok"}]}'
```

> **A live Max licence exists for dogfooding**, tier `max`, `subscription_status='active'`,
> `current_period_end` 30 days out, `stripe_subscription_id='sub_smoketest'`, on
> `jasonbartz28@gmail.com`. It is a real, working subscription as far as the gateway is
> concerned. Delete it with:
>
> ```bash
> npx wrangler d1 execute ghostly-licenses --remote \
>   --command "DELETE FROM ai_usage WHERE license_key='<key>'; DELETE FROM licenses WHERE key='<key>';"
> ```

**Gotcha found the hard way:** `wrangler`'s stored OAuth token had gone stale (last
refreshed in April), and `whoami` reports that as a flat "Not logged in" behind a
`400 Bad Request`. `npx wrangler login` fixes it.

---

## 5. Remaining work

### Phase 1c — Max settings UI — **done, in the working tree**

Built as specified. Notes on the two judgement calls:

- "Hide the pickers entirely" is honoured, with one addition: a **collapsed** "Personal API key (optional)" disclosure. Without it a Max subscriber has no way to configure the overflow key the fallback needs, and the feature would only ever fire for people who happened to be BYO users before subscribing. It changes nothing about the active provider — it parks a key the backend reaches for only after a 429.
- The panel reads the _active_ provider too. If a subscriber somehow isn't on `ghostly_max`, it says so and offers one button, rather than claiming Max is handling refinement when it isn't.

Error codes render through `lib/maxErrors.ts` — one mapping shared by the toast, the refinement pane, and the Account pane:

| Code                          | HTTP    | Meaning                       |
| ----------------------------- | ------- | ----------------------------- |
| `not_max`                     | 402     | Pro licence, no hosted AI     |
| `expired` / `unpaid`          | 402     | Subscription lapsed           |
| `fair_use_exceeded`           | 429     | Monthly cap hit               |
| `upstream_error`              | 502/429 | Anthropic unavailable         |
| `revoked`                     | 403     | Refund/chargeback             |
| `missing_key` / `invalid_key` | 401     | Gateway doesn't know this key |

The overflow fallback fires on `fair_use_exceeded` **only** — never on an entitlement failure. Spending a user's own money because their subscription lapsed is a different thing from spending it because they hit a cap, and only the second one is what they agreed to.

**Still to do here:** the app itself has not yet talked to the live gateway. The gateway side is fully verified (§4) and the app's parsing is pinned to a captured real response, but nobody has activated a Max licence in a running build and dictated. That is the last gate before release — see §7.

### Phase 2 — Ask your transcripts — **done**

`ask.rs` + `AskPanel.tsx`, in the My Notes pane. Retrieval is local, reasoning is not.

**BM25 over the FTS indexes that already exist, not embeddings.** Embeddings retrieve better on paraphrase, and cost an embed-on-write path, a model to ship or a service to call, a vector index to migrate and a re-index of all existing history. The keyword failure mode is "nothing matches", which is honest.

Three things that are load-bearing and look like details:

- `retrieve_relevant` ranks by `bm25`, where the existing `search_history_entries` ranks by recency. A search box and a question want opposite things — one is "find the note I remember writing", the other is "find the best evidence, wherever it is".
- The question is turned into a **quoted OR** query. Quoted because a dictated question contains FTS grammar (`NEAR(`, `*`, an apostrophe) which unquoted is a syntax error the user experiences as "nothing matches". OR because a question is a sentence; ANDing every content word matches nothing.
- Results from the two stores are **interleaved**, because their BM25 scores are not comparable and concatenating lets one store fill the context budget on its own.

The system prompt states the excerpts are quoted material rather than instructions — they are the user's own words, and a dictated "ignore your instructions" must stay data.

### Phase 3 — Learning loop — **done**

`learning.rs`, captured at the voice-edit site in `actions.rs`, one pass a day, card in the Dictionary pane.

**Word pairs leave the machine; transcripts never do.** A local word-level diff reduces an edit to `kubernets -> Kubernetes` before anything is stored or sent. The model only decides which candidates are durable vocabulary. Mining whole transcripts would be a different product with a different privacy claim.

Precision over recall everywhere, because a wrong entry corrupts every future transcript and a missed one costs nothing: word-count changes are dropped whole, only case changes and close mis-hearings qualify, words under four characters never do, a pair must be seen twice, and the model's reply is intersected with what was sent so a hallucinated pair cannot reach the vocabulary.

Candidates are cleared after every pass, accepted or not — a rejected pair re-sent nightly spends money to reach the same answer forever. If the user keeps making the correction it accumulates again.

**Not the Batch API, despite the plan.** After the local diff the daily payload is a few dozen short pairs, well under a cent. Halving that does not pay for submit/poll/retrieve plumbing, a 24-hour SLA, and gateway endpoints `/v1/chat/completions` already provides.

### Phase 4 — Encrypted sync — **foundation done, transport and bridge remain**

The three questions this section demanded be settled first are settled, and `sync/crypto.rs` + `sync/records.rs` implement them, with 18 tests. Nothing is wired to real data yet, deliberately.

| Decision    | Answer                                                           |
| ----------- | ---------------------------------------------------------------- |
| Key custody | Passphrase → Argon2id → key. No recovery, no escrow, no reset.   |
| Conflicts   | Last write wins per record, ties to the tombstone.               |
| Server sees | Opaque blobs. `kind` is folded into the record id, not a column. |

Scope is settings-shaped data — vocabulary, word corrections, prompts, profiles, correction phrases. **Not history.** Carrying vocabulary to a new Mac is what people want, it is kilobytes, and every record is independently replaceable; syncing transcripts would be gigabytes of the most sensitive data the app holds to solve a problem nobody asked for.

Two details in the code that are easy to undo by accident:

- The record id is authenticated as AAD. A server that shuffles blobs between records gets a decryption failure rather than plausible wrong data.
- `record_id` lowercases the natural key where the data is case-insensitive (a word) and leaves it where it is not (a profile id). Backwards either way duplicates words or merges distinct profiles.

**What remains:** a D1 table and push/pull endpoints on the Worker; a transport client; the bridge that maps `AppSettings` collections to `Record`s and back; settings fields (`sync_enabled`, `sync_salt`, verifier blob); and the UI — passphrase setup with blunt copy about there being no recovery, a new-device join flow, and sync status.

Do the bridge last and test it against a throwaway account. It is the only part that can destroy data, and it is the part where "last write wins" stops being a table and starts being someone's vocabulary list.

### Flipping the site to live checkout — **done 2026-08-10**

`index.html`: the Max card now points at the live monthly payment link with a yearly link beneath it, the JSON-LD offer moved from `PreOrder` to `InStock`, and the FAQ no longer says "early access". `/ph/` keeps its mailto, because "6 months free" is a comp that a plain payment link cannot express.

**The three `In development` badges were deliberately kept.** The old plan said to delete them when flipping, on the assumption phases 2–4 would be done. They aren't — "Ask your transcripts", "Learns your vocabulary" and "Encrypted sync" are all unbuilt. Removing the badges while charging $12/month would be selling three features that do not exist. The footnote now says what Max does today and that the badged items arrive as they ship, at no extra cost. Delete a badge when — and only when — its feature ships.

---

## 6. Gotchas that cost time

**`scripts/release.sh` has no staging gate.** The moment CI goes green, `downloads.try-ghostly.com` serves the DMG and the auto-updater offers it to every install. Publishing the GitHub draft later changes nothing. Smoke-test _before_ running it.

**Stripe CLI (v1.40.5):** global flags go **after** the subcommand (`stripe products create --live --project-name ghostly …`). `--format` doesn't exist (JSON is default). Archiving is `-d "active=false"`, not `--no-active`.

**The `stripe login` CLI key can never write.** It's Stripe-managed and hard-locked at Read on every resource. Use `~/.ghostly-keys/stripe-admin.key` (a restricted `rk_live`, `0600`) — `scripts/setup-max-billing.sh` reads it automatically. `rm` it when done.

**Stripe account branding is Dashboard-only.** `/v1/accounts` only accepts branding writes for Connect accounts.

**`STRIPE_SECRET_KEY` in the Worker was an invalid placeholder for months and nothing noticed**, because webhook signature verification is local HMAC over `STRIPE_WEBHOOK_SECRET` and never touches the Stripe API. `/billing/portal` and the chargeback handler are the first code that actually calls Stripe. It is now set to the `rk_live` key from `~/.ghostly-keys/stripe-admin.key`. **Replace it with a key scoped to `billing_portal:write` + `charges:read` and do not revoke the admin key until you have**, or the Manage-billing button starts returning 502.

**Adding a webhook handler is two steps, and the second is invisible from the code.** The Stripe endpoint (`we_1TMa0UBH5FhMp4sKJ0Sl4l80`) only delivers events it is subscribed to. Shipping the `invoice.paid` handler without adding `invoice.paid` to `enabled_events` would have meant no subscriber was ever granted entitlement, with nothing in the code to hint at why. Current list: `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`, 3× `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`.

**`bun run check:translations` fails 0/19.** Long-standing, expected, non-blocking — only add new strings to `en/`.

**Existing Pro holders.** The v0.1.26 release notes promise _"Email support@try-ghostly.com and we will make it right."_ That commitment is live and undefined. Their $39 now buys nothing over Free; comping them Max is the obvious make-good but hasn't been decided.

**The provider list is not a menu of what you're entitled to.** `ensure_post_process_defaults` seeds every provider Ghostly ships — including `ghostly_max` — into every install, on every launch, so the backend can resolve one the instant it becomes usable. Any new UI that renders `post_process_providers` has to filter for entitlement itself. Two places do: `usePostProcessProviderState` and `ProfileEditor`.

**Screenshotting the UI needs a settings fixture, not a hand-written stub.** The generated bindings already wrap results in `{status, data}`, so a Playwright stub must return raw values, and half the app crashes on a partial `AppSettings`. Copy `~/Library/Application Support/com.getghostly.desktop/settings_store.json` instead — API keys live in the keychain, so the on-disk copy has them blanked.

---

## 7. Verification commands

```bash
# App
cd ~/Ghostly-App
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo check --manifest-path src-tauri/Cargo.toml
CMAKE_POLICY_VERSION_MINIMUM=3.5 cargo test --manifest-path src-tauri/Cargo.toml --lib   # 262 passing
bun run build && bun run lint
bun run bindings:check     # fails if Rust types drifted from src/bindings.ts

# Worker
cd ~/ghostly-license-server && npx tsc --noEmit

# Release (only after smoke-testing)
cd ~/Ghostly-App && ./scripts/release.sh 0.1.27   # needs release-notes/v0.1.27.md first
```

### The one remaining gate: the app against the live gateway

Quit the installed Ghostly first — dev shares the real settings store and keychain.

```bash
cd ~/Ghostly-App && CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
```

Then, in order:

1. Account → paste the Max key → activate. Expect: plan row reads **Ghostly Max**, the
   usage badge flips to **MAX**, and a **Ghostly Max** section appears with the quota bar.
2. Refinement should now show the Max card and **no** provider / model / API-key pickers.
   `sync_max_provider_key` selects `ghostly_max` on the activation transition.
3. Dictate something. It should refine. `SELECT requests FROM ai_usage` increments by one.
4. Park a personal key in "Personal API key (optional)", then
   `UPDATE ai_usage SET requests = 8000` and dictate again — it must refine anyway, via
   the overflow. Reset the row afterwards.
5. `UPDATE licenses SET subscription_status='canceled', current_period_end=0` and dictate:
   expect the raw transcript plus a **Ghostly Max** toast with an "Open Account" button,
   not a raw HTTP body.
6. Deactivate the device, then confirm the keychain entry is really gone:
   `security find-generic-password -s computer.ghostly.api_keys -a ghostly_max` should
   fail. That is the bug §2 describes; it is the single most important step here.

Release notes format: plain-text bullets under a bare heading line — **no markdown headers or bold**, the in-app updater renders them literally. See `release-notes/v0.1.26.md`.
