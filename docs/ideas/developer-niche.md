# Niching down: developers, vibecoders, AI-native founders

Status: exploration, not committed. Written 2026-08-10.
Companion to [shortcuts-quiet-mode-meeting-mode.md](./shortcuts-quiet-mode-meeting-mode.md).

---

## 0. What changed in the market (research, 2026)

The single most important fact: **the agents shipped their own voice input.**

- Claude Code shipped `/voice` in March 2026 — push-to-talk in the terminal,
  with project and git-branch names fed in as recognition hints. Transcription
  tokens are free and don't count against rate limits.
- OpenAI Codex added voice a week earlier. Cursor 2.0 added voice.
- Wispr Flow raised $25M at a $700M post-money valuation and is now the
  default answer to "dictation for devs" — cloud-only, no offline mode, $18/mo,
  and it uploads screenshots of the active window for context.
- Superwhisper remains the on-device cult favorite among developers.

The commodity read: **"speak your prompt into the agent" is now a free
built-in feature of the agent.** Any roadmap whose pitch is "dictate faster
into Claude Code" is competing with something that ships in the box, is free,
already has the repo's branch names, and doesn't need accessibility permissions.

The opportunity read: every one of those built-ins is **trapped inside one
app**. Claude Code's `/voice` can't type into Linear. Cursor's can't answer a
permission prompt in a tmux pane. None of them speak back, none of them know
what app has focus, and none of them can be scripted. Ghostly already spans
all of that — CLI, local HTTP API, frontmost-app detection, system-wide paste,
per-app profiles.

So the niche is not _voice input for developers_. It is:

> **The voice control surface for a machine that is running agents.**

Input is table stakes. The unmet needs are **accuracy on code-shaped
language**, **supervising agents without the keyboard**, and **closing the
loop so agents can talk back**.

---

## 1. The three personas, and what each actually lacks

| Persona               | What they do all day                                 | What breaks today                                                                                        |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Developer**         | Editor, terminal, PR reviews, Jira/Linear            | Dictation mangles identifiers, paths, flags. Falls back to typing for anything technical.                |
| **Vibecoder**         | 3–6 agents running, mostly approving and redirecting | The bottleneck moved from _typing prompts_ to _watching terminals_. Hands are free; attention isn't.     |
| **AI-native founder** | PRDs, specs, investor updates, Slack, agent briefs   | Speaks in long rambling arcs with mid-thought reversals. Gets a wall of run-on text, then hand-edits it. |

Note the vibecoder row. That's the wedge. The industry solved "get words in
faster" and created a new problem: **you now supervise more work than you can
watch.** Nobody is selling to that.

---

## 2. Ranked ideas

Effort figures are rough estimates, not commitments.

### Tier 1 — accuracy on code-shaped language (table stakes, currently a gap)

**1.1 Project vocabulary — auto-learn the repo you're dictating into**

When the frontmost app is in the `Coding` category, resolve the project root
and harvest a vocabulary from it: filenames and directory names, dependency
names from `package.json` / `Cargo.toml` / `pyproject.toml`, git branch names,
recent commit subjects, and exported top-level symbols. Merge into the custom
word list for that dictation only. Cache per repo path; invalidate on branch
change or lockfile mtime.

_Why it wins:_ this is the exact thing Claude Code's `/voice` does (project +
branch hints) — except Ghostly can apply it in your **editor, your browser,
your Linear ticket, and your Slack message about the bug**, not just inside
one CLI. It is also the number-one complaint in every dev dictation review.

_Substrate:_ `frontmost.rs` already returns bundle id + window title; terminal
and editor titles carry the cwd or folder name. Feed the harvested words into
`apply_custom_words` in `managers/transcription.rs` (fuzzy + phonetic, tunable
threshold) — **not** `initial_prompt`. That path was tried and deliberately
disabled (`managers/transcription.rs:583`) because tech-token prompts pushed
Whisper into a decoding mode that hallucinated "next week" → "Next.js". The
post-transcription corrector is the right injection point and already exists.

_Effort:_ 1–2 weeks. New `project_context.rs` + cache + a settings toggle.
_Tier:_ Free (fully local).

**1.2 Spoken casing and symbols — deterministic, zero latency**

"camel case user profile" → `userProfile`. Plus `snake_case`, `PascalCase`,
`SCREAMING_SNAKE`, `kebab-case`, "dot ts", "slash", "double dash".

_Why it wins:_ Wispr advertises camelCase/snake_case support; it's a checkbox
buyers look for. Deterministic means it works with **no API key and no
latency**, which matches the Free tier story.

_Substrate:_ a pure post-pass next to `edit_intent::apply_correction_phrases`.
_Effort:_ days. _Tier:_ Free.

**1.3 Literal mode**

A second binding that skips LLM cleanup entirely and applies only 1.2. AI
refinement actively damages code, paths, and shell commands — users need a way
to say "don't be clever."

_Effort:_ small — a binding plus a flag through the pipeline. _Tier:_ Free.

---

### Tier 2 — agent supervision (the actual differentiator)

**2.1 Spoken control commands — phrase → keystroke, scoped per app**

A user-editable table: "approve" → Enter, "reject" → Esc, "always allow" →
`2`+Enter, "stop" → Ctrl+C, "next" → Cmd+Shift+], scoped by profile so
"approve" only fires in your terminal and editor.

_Why it wins:_ this is the vibecoder's whole day. Six agents, each stopping
every 90 seconds for a permission prompt. Today you context-switch, find the
window, hit a key. With always-on VAD capture you say "approve" and keep
reading. **No competitor does this** — Wispr and Superwhisper are strictly
text-into-a-field. It is also the most demoable feature on this list.

_Substrate:_ ~80% built. `continuous.rs:543` `strip_trailing_submit_phrase`
already does word-boundary phrase matching in the always-on loop, but it's
hardcoded to a single phrase bound to Enter. Generalize to a phrase table;
`input.rs` already sends keystrokes; `profiles.rs` already scopes by app.

_Effort:_ ~1 week. _Tier:_ Free.

**2.2 Talk-back — Ghostly speaks when an agent finishes or needs you**

Ghostly is input-only today. Close the loop: a Claude Code hook (Stop /
Notification) POSTs to Ghostly's local API, and Ghostly speaks a one-line
summary — "backend agent finished, 3 files changed" or "auth agent is asking
for permission."

_Why it wins:_ it turns Ghostly from a keyboard replacement into the **ears
and mouth of headless agents**, and it's the natural pair to 2.1 — hear that
it's asking, say "approve", never look at the window. Nothing on the market
does this.

_Design constraint:_ speak **events and one-line summaries only**. Nobody
listens to a wall of read-aloud agent output; every product that tried this
failed on exactly that.

_Substrate:_ new `POST /api/speak` on `rest_api.rs` (auth and Origin guards
already correct); macOS `AVSpeechSynthesizer` is on-device and free; `rodio`
is already a dependency for audio feedback.

_Effort:_ 1–2 weeks for v1 plus a shipped Claude Code plugin.
_Tier:_ Free for local voices. **Max:** premium voices, and push to a _second_
device — agent finishes on the desktop, your laptop tells you. That passes the
"could they replicate it with their own API key?" test, because it needs a
server.

**2.3 Ghostly MCP server — let the agent ask _you_ out loud**

Expose a `ask_user_by_voice` tool. The agent hits an ambiguous fork, calls the
tool, your Mac chimes, you speak, the answer returns to the agent — no window
switch, no typing.

_Why it wins:_ this inverts the relationship. Ghostly stops being a
peripheral and becomes **part of the agent loop**. It's a story that gets
posted, and it's a natural extension of the existing local API rather than a
new subsystem.

_Substrate:_ `/api/dictate` already blocks and returns a transcript — the MCP
tool is a thin wrapper over an endpoint that exists.
_Effort:_ ~1 week on top of the API. _Tier:_ Free.

**2.4 Named targets — "send this to the backend agent"**

Route dictation to a named window/session instead of whatever has focus.

_Why it wins:_ the multi-agent user's other half of the problem — right now
every dictation goes to the frontmost window, so you still have to click.
_Effort:_ medium-high; needs AX window targeting. Defer until 2.1/2.2 land.

---

### Tier 3 — the founder persona

**3.1 Brief mode — ramble in, structured spec out**

A long-form binding that returns a shaped artifact — goal, constraints,
acceptance criteria, explicitly out of scope — instead of a transcript.

_Why it wins:_ it's how founders actually talk to agents and to Linear. This
is a prompt and a shape on top of the pipeline you already have, not a new
engine.
_Effort:_ small. _Tier:_ Free on own key; **Max** with no key.

**3.2 Reversal resolution**

Speech contains mid-thought reversals — "use Redis, actually no, Postgres."
Raw transcripts hand the agent both. Resolve reversals in refinement so the
final instruction is coherent.

_Why it wins:_ Claude Code's `/voice` explicitly sends the raw transcript.
This is a quality gap you can demonstrate side by side.
_Effort:_ small — a refinement prompt change plus tests. _Tier:_ Free.

**3.3 Clipboard/selection as refinement context**

The error you just copied, or the code you selected, becomes context for the
refinement pass, so "fix this" resolves against something real.
_Effort:_ small–medium. `clipboard.rs` exists.

---

## 3. Recommended sequence

**Ship 1.2 + 1.3 first** (days) — cheap, deterministic, immediately quotable
on the comparison table, and they make every later feature more accurate.

**Then 2.1** (~1 week) — the wedge. Most of the code exists. It is the single
most demoable thing on this list and nothing else on the market does it.

**Then 1.1** (1–2 weeks) — the accuracy story that makes the niche credible.

**Then 2.2 + 2.3 together** (2–3 weeks) — ship as one release with a Claude
Code plugin. This is the release that has a story: _"Your agents can finally
talk to you, and you can answer without touching the keyboard."_

3.x lands whenever there's a gap; it's mostly prompt work.

---

## 4. What not to build

- **Voice mode inside the terminal.** Claude Code ships it, free, with better
  context than you can get from outside the process. Compete on span and
  control, not on being another prompt box.
- **Reading full agent output aloud.** Events only.
- **Cloud transcription for accuracy.** On-device is the structural moat and
  the reason the privacy pitch works — Wispr is cloud-only and uploads
  screenshots. Never trade that for a few accuracy points.
- **Gating anything local behind Max.** Per [GHOSTLY-MAX.md](../GHOSTLY-MAX.md):
  additive only. Project vocabulary and spoken commands are local and must
  stay Free.

---

## 5. Distribution, since the niche is developers

Developers don't find apps on landing pages.

- `brew install --cask ghostly`. The CLI already installs itself
  (`cli_install.rs`); a cask is a weekend and a real discovery channel.
- **Ship a Claude Code plugin** — the natural home for 2.1/2.2/2.3, and it
  puts Ghostly in a marketplace developers already browse.
- Raycast extension, Warp workflow, tmux/Starship recording indicator (the
  SSE stream at `/api/events` already supports all three).
- **Publish an identifier-accuracy benchmark.** A reproducible corpus of
  spoken identifiers, paths, and flags, scored across Ghostly / Wispr /
  Superwhisper / built-in `/voice`. Developers trust benchmarks, it's
  defensible marketing, and 1.1 is how you win it.

---

## Sources

- <https://techcrunch.com/2026/03/03/claude-code-rolls-out-a-voice-mode-capability/>
- <https://unmarkdown.com/blog/claude-code-voice-mode-guide>
- <https://aquavoice.com/blog/voice-coding-cursor-claude-code>
- <https://codepick.dev/en/compare/voice-tools-global/>
- <https://ertiqah.com/blog/best-dictation-for-developers-final>
- <https://dictaflow.io/blog/best-dictation-tools-developers-2026.html>
- <https://hns-cli.dev/docs/drive-coding-agents/>
