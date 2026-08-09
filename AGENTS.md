# AGENTS.md

This file provides guidance to AI coding assistants working with code in this repository.

## Development Commands

**Prerequisites:**

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) package manager

**Core Development:**

```bash
# Install dependencies
bun install

# Run in development mode
bun run tauri dev
# If cmake error on macOS:
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev

# Build for production
bun run tauri build

# Frontend only development
bun run dev        # Start Vite dev server
bun run build      # Build frontend (TypeScript + Vite)
bun run preview    # Preview built frontend
```

**Linting and Formatting (run before committing):**

```bash
bun run lint              # ESLint for frontend
bun run lint:fix          # ESLint with auto-fix
bun run format            # Prettier + cargo fmt
bun run format:check      # Check formatting without changes
bun run format:frontend   # Prettier only
bun run format:backend    # cargo fmt only
```

**Model Setup (Required for Development):**

```bash
mkdir -p src-tauri/resources/models
curl -o src-tauri/resources/models/silero_vad_v4.onnx https://blob.handy.computer/silero_vad_v4.onnx
```

For detailed platform-specific build setup, see [BUILD.md](BUILD.md).

## Architecture Overview

Ghostly is a cross-platform desktop speech-to-text application built with Tauri 2.x (Rust backend + React/TypeScript frontend).

### Backend Structure (src-tauri/src/)

- `lib.rs` - Main entry point, Tauri setup, manager initialization
- `managers/` - Core business logic:
  - `audio.rs` - Audio recording and device management
  - `model.rs` - Model downloading and management
  - `transcription.rs` - Speech-to-text processing pipeline
  - `history.rs` - Transcription history storage
- `audio_toolkit/` - Low-level audio processing:
  - `audio/` - Device enumeration, recording, resampling
  - `vad/` - Voice Activity Detection (Silero VAD)
- `commands/` - Tauri command handlers for frontend communication
- `cli.rs` - CLI argument definitions (clap derive)
- `shortcut.rs` - Global keyboard shortcut handling
- `settings.rs` - Application settings management
- `overlay.rs` - Recording overlay window (platform-specific)
- `signal_handle.rs` - `send_transcription_input()` reusable function
- `utils.rs` - Platform detection helpers

### Frontend Structure (src/)

- `App.tsx` - Main component with onboarding flow
- `components/` - React UI components:
  - `settings/` - Settings UI
  - `model-selector/` - Model management interface
  - `onboarding/` - First-run experience
  - `overlay/` - Recording overlay UI
  - `update-checker/` - App update notifications
  - `shared/`, `ui/`, `icons/`, `footer/` - Shared components
- `hooks/useSettings.ts` - Settings state management hook
- `stores/settingsStore.ts` - Zustand store for settings
- `bindings.ts` - Auto-generated Tauri type bindings (via tauri-specta)
- `overlay/` - Recording overlay window entry point
- `lib/types.ts` - Shared TypeScript type definitions

### Key Architecture Patterns

**Manager Pattern:** Core functionality organized into managers (Audio, Model, Transcription) initialized at startup and managed via Tauri state.

**Command-Event Architecture:** Frontend → Backend via Tauri commands; Backend → Frontend via events.

**Pipeline Processing:** Audio → VAD → Whisper/Parakeet → Text output → Clipboard/Paste

**State Flow:** Zustand → Tauri Command → Rust State → Persistence (tauri-plugin-store)

### Technology Stack

**Core Libraries:**

- `whisper-rs` - Local Whisper inference with GPU acceleration
- `cpal` - Cross-platform audio I/O
- `vad-rs` - Voice Activity Detection
- `rdev` - Global keyboard shortcuts
- `rubato` - Audio resampling
- `rodio` - Audio playback for feedback sounds

### Application Flow

1. **Initialization:** App starts minimized to tray, loads settings, initializes managers
2. **Model Setup:** First-run downloads preferred Whisper model (Small/Medium/Turbo/Large)
3. **Recording:** Global shortcut triggers audio recording with VAD filtering
4. **Processing:** Audio sent to Whisper model for transcription
5. **Output:** Text pasted to active application via system clipboard

### Settings System

Settings are stored using Tauri's store plugin with reactive updates:

- Keyboard shortcuts (configurable, supports push-to-talk)
- Audio devices (microphone/output selection)
- Model preferences (Small/Medium/Turbo/Large Whisper variants)
- Audio feedback and translation options

### Single Instance Architecture

The app enforces single instance behavior — launching when already running brings the settings window to front rather than creating a new process. Remote control flags (`--toggle-transcription`, etc.) work by launching a second instance that sends args to the running instance via `tauri_plugin_single_instance`, then exits.

## Internationalization (i18n)

All user-facing strings must use i18next translations. ESLint enforces this (no hardcoded strings in JSX).

**Adding new text:**

1. Add key to `src/i18n/locales/en/translation.json`
2. Use in component: `const { t } = useTranslation(); t('key.path')`

**File structure:**

```
src/i18n/
├── index.ts           # i18n setup
├── languages.ts       # Language metadata
└── locales/
    ├── en/translation.json  # English (source)
    ├── de/, es/, fr/, ja/, ru/, zh/, ...
    └── ...
```

For translation contribution guidelines, see [CONTRIBUTING_TRANSLATIONS.md](CONTRIBUTING_TRANSLATIONS.md).

## Code Style

**Rust:**

- Run `cargo fmt` and `cargo clippy` before committing
- Handle errors explicitly (avoid unwrap in production)
- Use descriptive names, add doc comments for public APIs

**TypeScript/React:**

- Strict TypeScript, avoid `any` types
- Functional components with hooks
- Tailwind CSS for styling
- Path aliases: `@/` → `./src/`

## Commit Guidelines

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

## CLI Parameters

Ghostly supports command-line parameters for integration with scripts and autostart configurations.

**Implementation:** `cli.rs` (definitions), `main.rs` (parsing/dispatch), `lib.rs` (applying), `signal_handle.rs` (shared logic), `cli_client.rs` (flags that need a response), `cli_install.rs` (PATH installer)

Flags fall into three groups, and the group determines the transport:

| Flag                     | Group          | Description                                                |
| ------------------------ | -------------- | ---------------------------------------------------------- |
| `--start-hidden`         | Launch         | Launch without showing the main window (tray icon visible) |
| `--no-tray`              | Launch         | Launch without system tray (closing window quits the app)  |
| `--debug`                | Launch         | Enable debug mode with verbose (Trace) logging             |
| `--toggle-transcription` | Remote control | Toggle recording on/off on a running instance              |
| `--toggle-post-process`  | Remote control | Deprecated alias for `--toggle-transcription`              |
| `--cancel`               | Remote control | Cancel the current operation on a running instance         |
| `--dictate`              | API client     | Record, block, print the transcript to stdout              |
| `--status`               | API client     | Print idle/recording state                                 |
| `--history`              | API client     | Print recent transcriptions                                |
| `--install-cli`          | Local          | Symlink the binary onto PATH                               |

**Key design decisions:**

- CLI flags are runtime-only overrides — they do NOT modify persisted settings
- Launch flags only apply to a new instance; passing them to a running app just shows the window
- Remote control flags work via `tauri_plugin_single_instance`: second instance sends args, then exits
- `send_transcription_input()` in `signal_handle.rs` is shared between signal handlers and CLI
- Single-instance IPC is one-way, so anything needing a **return value** goes over the localhost API instead (`cli_client.rs`). It reads port and token straight from `settings_store.json`, so scripts never handle tokens. These flags require the API to be enabled; the remote-control flags do not.

## Localhost API

`rest_api.rs`. Off by default; enabled in Settings → Developer. Binds `127.0.0.1:<rest_api_port>`.

**Security model — do not weaken either gate:**

- Bearer token (`rest_api_token`, minted on first enable) required on every request, compared in constant time. It lives in settings rather than the keychain because the CLI is a separate process and must read it without a keychain prompt.
- Any request with an `Origin` / `Sec-Fetch-*` header is rejected with 403, and there is deliberately **no CORS layer**. Without this, any open web page could read the user's history and type into their machine. Native clients never send those headers.

**Wiring:** `EventBus`, `PasteSuppressor`, and `RestApiServer` are managed state registered unconditionally at startup, so publishers never check whether the server is running. Transcripts are published from `HistoryManager::save_entry` — the single choke point every finished transcription passes through — and recording state from the coordinator's `start`/`stop`. `/api/dictate` and `/api/events` both read from that one bus.

**Lifecycle:** `set_rest_api_enabled(false)` actually stops the socket, and a port change rebinds live. `stop()` aborts the serve task rather than only signalling graceful shutdown, because an open SSE stream would otherwise keep an old (possibly revoked) connection alive forever.

Reference docs live in [docs/API.md](docs/API.md) — update them with any endpoint change.

## Debug Mode

Access debug features: `Cmd+Shift+D`

## Platform Notes

Ghostly is macOS-only. Metal acceleration, accessibility permissions required for keyboard shortcuts. Minimum macOS 10.15.

## Troubleshooting

See the [Troubleshooting](README.md#troubleshooting) section in README.md.

## Contributing & PR Guidelines

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow and [PR template](.github/PULL_REQUEST_TEMPLATE.md) when submitting pull requests. For translations, see [CONTRIBUTING_TRANSLATIONS.md](CONTRIBUTING_TRANSLATIONS.md).
