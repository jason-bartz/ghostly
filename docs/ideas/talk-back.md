# Talk-back — hands-free conversation with any agent

Status: exploration, not committed. Written 2026-08-10.
Companion to [developer-niche.md](./developer-niche.md).

Ghostly speaks the agent's output in natural language; you answer out loud;
your answer lands back in the agent's conversation. No window focus, no
keyboard, no screen-scraping.

---

## 0. Verdict

**Buildable, and the hard part is already solved by someone else.**

The thing I assumed would be the blocker — getting the agent's output _out_,
and getting a spoken reply _back in_ — is a first-class supported path. Claude
Code's `Stop` hook hands you `last_assistant_message` and lets you return
`{"decision": "block", "additionalContext": "<what the user said>"}`, which
**keeps the conversation going with your spoken reply injected as context.**
That is the entire round trip, sanctioned, no PTY hacks.

Better: hooks can be `type: "http"`. Claude Code will POST the event straight
to a URL with a `Authorization: Bearer $TOKEN` header. **Ghostly's existing
localhost API can be the hook endpoint** — no shell script, no process spawn
per event, no CLI in the path. And the default HTTP-hook timeout is **600
seconds**, which is an enormous budget for a conversational turn.

Cursor has the same shape (`stop`, `afterAgentResponse`, `beforeShellExecution`
in `~/.cursor/hooks.json`), so the pattern generalizes.

The genuinely hard parts are not protocol. They're **acoustic echo**,
**turn-taking**, and **not being annoying**. Those are addressed in §4.

### Verified vs. assumed

| Claim                                                                                                      | Status                            |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `Stop` hook payload contains `last_assistant_message`, `stop_reason`                                       | Verified in docs                  |
| `Stop` can block + inject `additionalContext` to continue the turn                                         | Verified in docs                  |
| Hooks support `type: "http"` with URL + bearer header, 600s default timeout                                | Verified in docs                  |
| `Notification` fires with types `permission_prompt`, `agent_needs_input`, `agent_completed`, `idle_prompt` | Verified in docs                  |
| `PermissionRequest` hook can return `allow`/`deny` decisions                                               | Verified in docs                  |
| Cursor has `stop` / `afterAgentResponse` hooks in `hooks.json`                                             | Verified                          |
| AVSpeechSynthesizer premium voices are neural, on-device, <100 ms to first audio                           | Reported, needs a listening test  |
| Claude Code's HTTP hook client sends no `Origin`/`Sec-Fetch-*` header                                      | **Assumed** — must verify, see §6 |
| Hooks fire inside the **VS Code extension**                                                                | **Contested** — see §3            |
| MCP tools can block for minutes                                                                            | **False in practice** — see §3    |

---

## 1. The loop

```
agent finishes turn
      ↓  Stop hook, type:"http"  → POST 127.0.0.1:7543/hooks/claude-code
Ghostly receives last_assistant_message
      ↓  spoken-form transform (strip code blocks, 1–2 sentences)
Ghostly speaks:  "Done. Auth middleware is wired up, but the session test
                  is still failing on the refresh path. Want me to dig in?"
      ↓  opens mic for a bounded window
you say:         "yeah, and check whether the token TTL is the problem"
      ↓  VAD endpoint → transcribe → refine
Ghostly returns:  {"decision":"block",
                   "hookSpecificOutput":{"hookEventName":"Stop",
                     "additionalContext":"yeah, and check whether the token TTL is the problem"}}
      ↓
agent continues, same session, full context. Repeat.
```

You never touched the keyboard, never focused the window, and the agent
doesn't know it's talking to a voice.

**The permission variant is even better.** `PermissionRequest` fires with
`tool_name` and `tool_input`, and the hook returns the _decision_:

```
Ghostly: "The ghostly-app agent wants to run `rm -rf dist`. Allow?"
You:     "yeah, allow that one"
Ghostly: → {"hookSpecificOutput":{"decision":{"behavior":"allow"}}}
```

That's strictly better than the keystroke-injection idea in
[developer-niche.md](./developer-niche.md) §2.1: it needs no window focus, it
works on background and headless sessions, and Ghostly gets the actual command
text so it can _tell you what you're approving_ instead of you approving blind.
Keystroke injection stays as the fallback for agents without hooks.

---

## 2. Which events are worth speaking

Speaking everything is how this feature dies. Default to near-silent.

| Event                                | Speak?                                                | Why                                                               |
| ------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `Notification` / `permission_prompt` | **Yes, always**                                       | You are the blocker. Highest value.                               |
| `Notification` / `agent_needs_input` | **Yes**                                               | Same.                                                             |
| `PermissionRequest`                  | **Yes**                                               | Answerable by voice with a real decision.                         |
| `Stop`                               | Yes, if the session is backgrounded or >N seconds old | The "it's done" moment. Noise if you're staring at it.            |
| `SubagentStop`                       | No by default                                         | Too chatty in fan-out workflows.                                  |
| `Notification` / `idle_prompt`       | Yes, brief                                            | "still waiting on you."                                           |
| `StopFailure`                        | Yes                                                   | Rate limit / billing / auth death — you want to know immediately. |
| `MessageDisplay`                     | **Never**                                             | 10s timeout, fires on every streamed chunk. Wrong layer.          |
| `PostToolUse`                        | Never                                                 | Firehose.                                                         |

Add a hard rule: **if the agent's window is frontmost and has been for the
last few seconds, don't speak.** You're already looking at it. `frontmost.rs`
answers this for free, and it single-handedly removes most of the annoyance.

---

## 3. Three transports, one engine

The engine is one thing: _given text and a session identity, speak it, listen,
return a transcript_. Only the transport differs per agent.

**A. Claude Code — native HTTP hooks.** Best path. Zero processes, 600s
budget, bidirectional. Shipped as a Ghostly plugin (`hooks/hooks.json` +
`${CLAUDE_PLUGIN_ROOT}`) so install is one command instead of a settings-JSON
paste.

**B. Cursor and anything with command hooks — a CLI shim.** Cursor's hooks are
command-type, so `ghostly hook` reads the event JSON on stdin, POSTs to the
same endpoint, prints the response JSON to stdout. `cli_install.rs` already
puts the binary on PATH.

**C. MCP — for everything else, with a real caveat.** An MCP server exposing
`ask_user_by_voice` works in any MCP client, but **do not design it as a
long-blocking call.** Claude Code's MCP request timeout defaults to 60s,
`MCP_TOOL_TIMEOUT` is documented as inconsistently honored across versions and
platforms, and long calls fail with socket hang-ups around the 30–60s mark.

So the MCP tool must either return within ~20 seconds or use a ticket pattern:
`ask_user_by_voice` returns `{"ticket":"abc"}` immediately, the agent calls
`get_voice_answer("abc")` and gets `{"status":"waiting"}` or the answer. Uglier,
but it survives the timeout. Also note transport C requires the agent to
_choose_ to call the tool — that needs a line in the project rules, and it will
be less reliable than hooks.

**On the VS Code Claude extension specifically:** the sources conflict. One
says the extension shares `~/.claude/settings.json` and runs the same engine
with the same hooks; there is also an open feature request (anthropics/claude-code
#21736) reporting that hooks configured in settings.json do not fire inside the
extension. **This needs a 20-minute empirical test before promising VS Code
support.** If hooks don't fire there, transport C (MCP) is the VS Code answer,
with its shorter turns.

---

## 4. The four hard problems

### 4.1 Acoustic echo — the mic hears the TTS

The real blocker for full-duplex. Three layers, ship them in order:

1. **Headphones.** No echo at all. A large share of the target user is already
   wearing them while multitasking. Detect output route and note it in
   onboarding.
2. **Text-domain echo rejection** — the cheap trick, and it's genuinely good.
   You know _exactly_ what you just said. Keep the mic open during TTS, and
   discard any transcript whose similarity to the currently-speaking text
   crosses a threshold. **`strsim` is already a dependency** (used for custom
   word correction), so this is a few dozen lines. It gives you barge-in on
   speakers without touching CoreAudio.
3. **Real AEC** — `AVAudioEngine.setVoiceProcessingEnabled(true)` /
   `kAudioUnitSubType_VoiceProcessingIO`, which does echo cancellation and
   noise suppression. `cpal` can't reach it, so it needs a Swift shim — but
   that pattern is already established twice in this repo
   (`swift/system_audio.swift` for CATap process taps,
   `swift/apple_intelligence.swift` for the on-device LLM). Defer to v2.

Half-duplex (mute the mic while speaking) is the trivial fallback and kills
barge-in. Don't ship it as the only mode — being unable to interrupt a talking
computer is infuriating.

### 4.2 Turn-taking — when is the mic listening, and to whom?

The elegant answer: **the mic only opens in the window after Ghostly asks a
question.** No wake word, no always-on ambiguity. Ghostly asked, so anything
you say in the next N seconds is the answer. Close the window on VAD silence,
on a timeout, or on a "never mind."

Endpointing reuses `continuous.rs` (`continuous_silence_ms`,
`continuous_max_segment_ms`) — a solved problem in this codebase.

If nothing is said before the timeout, the hook returns "no reply" and the
agent proceeds normally. **A talk-back failure must always degrade to the
current behavior, never to a hang.** The 600s timeout means a bug here would
otherwise wedge someone's agent for ten minutes.

### 4.3 Multi-agent — who's speaking, and don't talk over yourself

`SessionStart` gives `session_id` and `cwd`; `SubagentStart` gives `agent_type`.
Build a session registry keyed on `session_id`, named from the repo directory,
with a user-editable nickname. Then Ghostly says "**ghostly-app** needs
permission" rather than "an agent needs permission."

Speech must be a **priority queue, strictly serialized** — two agents finishing
at once cannot produce overlapping audio. Permission prompts jump the queue
ahead of completion announcements. When you answer, the reply routes to the
session that asked, which is why the queue must be one-at-a-time.

This is also where the vibecoder value concentrates: with six agents running,
being told _which one_ needs you is most of the product.

### 4.4 Spoken form — `last_assistant_message` is markdown, not speech

Reading raw agent output aloud is the failure mode every previous attempt died
on. Code blocks, file paths, and bullet lists are unspeakable.

Three tiers, all worth having:

- **Deterministic** (0 ms): strip code fences, collapse lists, take the first
  sentence plus any trailing question. Surprisingly serviceable.
- **On-device LLM** (~1–2 s): `apple_intelligence.rs` already exposes
  `process_text_with_system_prompt` over Swift FFI. Prompt it for one or two
  spoken sentences. **Free, private, no key** — and it makes talk-back a Free
  feature, which matters for the tier story.
- **Cloud** (~1 s): existing `llm_client.rs` path on the user's key, or Max.

### Latency budget (per turn, excluding human speech)

| Stage                                         | Cost                                 |
| --------------------------------------------- | ------------------------------------ |
| Hook POST to localhost                        | ~1 ms                                |
| Spoken-form transform                         | 0 ms deterministic / 1–2 s on-device |
| TTS first audio (AVSpeechSynthesizer premium) | <100 ms reported                     |
| Speaking 1–2 sentences                        | 3–5 s                                |
| VAD endpoint after you stop                   | 600–900 ms                           |
| Transcribe short utterance (Parakeet int8)    | ~300–800 ms                          |
| Return `additionalContext`                    | ~1 ms                                |

**~1.5–4 s of machine overhead per turn.** That's conversational. It is _not_
tight enough for interrupting mid-stream, which is another reason to hang this
on `Stop`/`Notification` rather than `MessageDisplay`.

---

## 5. What v1 is

Deliberately small. One release, one story.

- `POST /hooks/claude-code` on `rest_api.rs` — one endpoint, dispatch on
  `hook_event_name`.
- TTS via a Swift `AVSpeechSynthesizer` shim, serialized priority queue.
- Deterministic spoken-form transform; on-device LLM behind a toggle.
- Listen window after speaking; VAD endpointing; text-domain echo rejection.
- Events: `permission_prompt`, `agent_needs_input`, `Stop`. Nothing else.
- Suppress when the agent's window is frontmost.
- A Ghostly plugin for Claude Code so setup is one command.
- Kill switch in the menu bar and a global "shut up" shortcut. Non-negotiable.

**Cut from v1:** Cursor shim, MCP transport, real AEC, subagent narration,
custom voices, cross-device.

**Estimate:** ~2–3 weeks, of which the TTS shim and the echo/turn-taking
tuning are the bulk. The protocol side is genuinely a few days because the
API's auth, event bus, and VAD loop all already exist.

---

## 6. De-risk first — a one-day spike

Four unknowns, all cheap to resolve, and one of them can invalidate the whole
design. Do these before writing the feature.

1. **Does the existing Origin guard reject Claude Code's HTTP hook?**
   `rest_api.rs` rejects any request carrying `Origin` or `Sec-Fetch-*` with a
   403, deliberately and correctly. Node's fetch shouldn't send those, but if
   the hook client does, the endpoint is dead on arrival. Test with a stub
   server that logs headers. **Do not weaken the guard to fix this** — if it
   sends `Origin`, add a narrow allowance for the hook route with its own token,
   and nothing else.
2. **Does `{"decision":"block"}` + `additionalContext` from an HTTP `Stop` hook
   actually continue the conversation?** Stub it with a hardcoded string. This
   is the load-bearing claim of the entire design.
3. **Do hooks fire in the VS Code extension?** Twenty minutes, and it decides
   whether VS Code gets transport A or the weaker transport C.
4. **Listen to the premium voices.** Speak three real agent messages through
   AVSpeechSynthesizer premium. If it's grating, the feature has a ceiling and
   Max-tier cloud TTS moves from nice-to-have to required.

---

## 7. Tier split

Per the [Max test](../GHOSTLY-MAX.md) — could a user replicate it with their
own API key?

**Free:** the whole loop. Hooks, on-device TTS, on-device summaries, echo
rejection, session registry. It's all local, so it must be Free, and it's the
strongest word-of-mouth feature on the roadmap.

**Max:** premium cloud voices (ElevenLabs Flash v2.5 / Cartesia, ~75 ms class
latency); **cross-device push** — the agent finishes on the Mac Studio and your
laptop tells you, which is impossible without a server and is the cleanest Max
justification on the list; and team-shared session nicknames.

---

## Sources

- <https://code.claude.com/docs/en/hooks>
- <https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation>
- <https://cursor.com/docs/hooks>
- <https://github.com/anthropics/claude-code/issues/21736>
- <https://github.com/anthropics/claude-code/issues/17662>
- <https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer>
- <https://fazm.ai/t/local-text-to-speech-ai>
