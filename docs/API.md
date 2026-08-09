# Ghostly CLI and local API

Two ways to drive Ghostly from outside the app.

- The **`ghostly` command** is for triggers that run a shell command: foot pedals, Stream Deck, Raycast, Shortcuts, Alfred, cron, or your own scripts.
- The **local API** is an HTTP server on `127.0.0.1` for software that wants to read transcripts or react to state — sync scripts, status indicators, AI agents.

Commands that return a value (`--dictate`, `--status`, `--history`) are thin clients over the API, so they need it enabled. `--toggle-transcription` and `--cancel` work either way.

---

## Install the command

Settings → Developer → **Command line** → _Install command_. This symlinks the app binary into `/usr/local/bin` (you may be asked for your password) or `~/.local/bin` if you decline.

Or from a terminal:

```bash
/Applications/Ghostly.app/Contents/MacOS/ghostly --install-cli
```

Then:

```bash
ghostly --toggle-transcription        # start or stop recording
ghostly --cancel                      # abort whatever is in flight
ghostly --dictate                     # record, then print the transcript
ghostly --status                      # idle or recording?
ghostly --history --limit 5           # last 5 transcriptions
```

Launch flags, which apply when Ghostly is not already running:

```bash
ghostly --start-hidden                # launch to the tray only
ghostly --no-tray                     # quit when the window closes
ghostly --debug                       # verbose logging
```

> If Ghostly is already running, launch flags are ignored and the window is brought to the front instead.

### `--dictate`

The one that makes Ghostly composable. It starts recording, waits, and prints the transcript to stdout — progress messages go to stderr, so command substitution captures only the text.

```bash
git commit -m "$(ghostly --dictate)"
echo "$(ghostly --dictate)" >> notes.md
```

Recording stops when you press your normal Ghostly shortcut. For unattended scripts, give it a fixed duration instead:

```bash
ghostly --dictate --stop-after 10     # record exactly 10 seconds
```

Ctrl-C cancels the recording in the app, not just in your terminal.

| Flag                     | Meaning                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `--timeout <seconds>`    | How long to wait for a transcript. Default 120.                                     |
| `--stop-after <seconds>` | Stop recording automatically after this long.                                       |
| `--paste`                | Also paste into the focused app. Off by default — you are already getting the text. |
| `--json`                 | Print the full JSON response instead of just the text.                              |

---

## Enable the local API

Settings → Developer → **Local API**. It binds to `127.0.0.1` on port 7543 by default and is never reachable from the network. Turning it off stops the server immediately; changing the port rebinds without restarting the app.

### Authentication

Every request needs the per-install token shown in that settings pane. Send it any of three ways:

```bash
curl http://127.0.0.1:7543/api/status -H "Authorization: Bearer $TOKEN"
curl http://127.0.0.1:7543/api/status -H "X-Ghostly-Token: $TOKEN"
curl "http://127.0.0.1:7543/api/status?token=$TOKEN"      # for tools that cannot set headers
```

Treat the token like a password. It can read every transcript you have ever dictated and type into whatever app you have focused. _Generate a new token_ in settings invalidates the old one everywhere.

### Browser requests are refused

Any request carrying an `Origin`, `Sec-Fetch-Mode`, or `Sec-Fetch-Site` header gets a `403`, and there is no CORS layer at all. This is deliberate: without it, any web page you happened to have open could read your history and type into your machine. Native clients never send those headers, so nothing legitimate is affected — but it does mean you cannot call this API from a web page, including from browser devtools.

---

## Endpoints

All responses are JSON. Errors look like `{"ok": false, "error": "..."}` with a `4xx`/`5xx` status.

### `GET /api/status`

```bash
curl http://127.0.0.1:7543/api/status -H "Authorization: Bearer $TOKEN"
```

```json
{ "ok": true, "is_recording": false, "version": "0.1.25", "port": 7543 }
```

### `POST /api/dictate`

Start recording, wait for the transcript, return it. This blocks — that is the point.

```bash
curl -X POST http://127.0.0.1:7543/api/dictate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"stop_after_ms": 8000}'
```

```json
{
  "ok": true,
  "id": 1149,
  "text": "Fix the retry logic in the uploader.",
  "raw_text": "fix the retry logic in the uploader",
  "source_app": "Ghostly"
}
```

| Field           | Default  | Meaning                                                                                         |
| --------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `timeout_ms`    | `120000` | Give up after this long. Max `600000`. On timeout the recording is cancelled and you get `408`. |
| `stop_after_ms` | —        | Stop recording automatically. Omit to let the user stop with the shortcut.                      |
| `paste`         | `false`  | Also paste into the focused app.                                                                |

`text` is the refined text when AI refinement ran, and the raw transcript otherwise — it is what would have been pasted. Returns `409` if a recording is already in progress.

### `POST /api/transcribe/start`, `/stop`, `/toggle`

```bash
curl -X POST http://127.0.0.1:7543/api/transcribe/start -H "Authorization: Bearer $TOKEN"
```

```json
{ "ok": true, "was_recording": false }
```

`start` never stops an in-flight recording and `stop` never starts one; use `toggle` for a single button that does both. `was_recording` tells you the state on arrival, so a toggle button can update itself without a second call.

### `POST /api/cancel`

Abort the current recording or refinement. Nothing is pasted or saved.

### `POST /api/paste`

Type text into the focused app using Ghostly's paste machinery.

```bash
curl -X POST http://127.0.0.1:7543/api/paste \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from a script"}'
```

Set `"submit": true` to press your auto-submit key afterwards. It defaults to `false` — an API caller should have to ask before Ghostly hits Enter in someone's shell.

### `GET /api/history`

```bash
curl "http://127.0.0.1:7543/api/history?limit=5" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "ok": true,
  "entries": [
    {
      "id": 1148,
      "timestamp": 1786289500,
      "transcription_text": "...",
      "post_processed_text": "...",
      "source_app": "Slack",
      "title": "...",
      "tags": []
    }
  ],
  "has_more": true
}
```

`limit` defaults to 20 and is capped at 100.

### `GET /api/events`

A server-sent events stream, so indicators and sync scripts do not have to poll.

```bash
curl -N http://127.0.0.1:7543/api/events -H "Authorization: Bearer $TOKEN"
```

```
event: status
data: {"type":"status","state":"recording"}

event: transcript
data: {"type":"transcript","id":1149,"text":"…","raw_text":"…","source_app":"Slack","timestamp":1786289500}
```

`state` is one of `recording`, `processing`, `idle`.

---

## Recipes

### Raycast script command

```bash
#!/bin/bash
# @raycast.title Dictate
# @raycast.mode silent
ghostly --toggle-transcription
```

### Stream Deck button with a live indicator

Set the button's action to run `ghostly --toggle-transcription`. For the indicator, point a status widget at:

```
http://127.0.0.1:7543/api/status?token=YOUR_TOKEN
```

and key the icon off `is_recording`. If your tool supports SSE, use `/api/events` instead and react instantly.

### Append every transcript to an Obsidian daily note

```bash
#!/bin/bash
VAULT="$HOME/Obsidian/Personal"
curl -sN "http://127.0.0.1:7543/api/events?token=$GHOSTLY_TOKEN" \
| while IFS= read -r line; do
    case "$line" in
      data:*)
        payload="${line#data: }"
        [ "$(jq -r .type <<<"$payload")" = "transcript" ] || continue
        note="$VAULT/Daily/$(date +%Y-%m-%d).md"
        printf -- "- %s %s\n" "$(date +%H:%M)" "$(jq -r .text <<<"$payload")" >> "$note"
        ;;
    esac
  done
```

Run it with `launchd` or `tmux` and every dictation lands in today's note.

### macOS Shortcut

Add a _Run Shell Script_ action:

```bash
/usr/local/bin/ghostly --dictate --stop-after 15
```

The transcript comes back on stdout, ready to feed into any other Shortcuts action.

### Dictate into an AI coding agent

```bash
claude "$(ghostly --dictate)"
```

---

## Troubleshooting

**`ghostly: command not found`** — install it from Settings → Developer, or run the bundle path directly: `/Applications/Ghostly.app/Contents/MacOS/ghostly`. If you installed to `~/.local/bin`, that folder may still need adding to your `PATH`.

**`The Ghostly local API is off`** — enable it in Settings → Developer → Local API. `--dictate`, `--status`, and `--history` need it; `--toggle-transcription` and `--cancel` do not.

**`Ghostly is not running`** — the API only exists while the app is running. Launch it first.

**`Port 7543 is already in use`** — something else holds the port. Pick another one in settings; it rebinds immediately.

**`401 Invalid API token`** — the token was regenerated. Copy the current one from settings.

**`403 Browser requests are not accepted`** — you are calling from a web page or devtools. That is intentional and cannot be turned off; use a native client.
