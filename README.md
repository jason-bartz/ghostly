<div align="center">

<img src="src/assets/ghostly_wordmark.svg" alt="Ghostly" width="320"><br><br>

**Voice-first typing for your Mac. Press a key, speak, done.**

<br>

<a href="https://get-ghostly.com/download">
  <img src="https://img.shields.io/badge/-Download%20for%20macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" height="46">
</a>
&nbsp;&nbsp;
<a href="https://github.com/jason-bartz/ghostly/releases/latest">
  <img src="https://img.shields.io/badge/-All%20Releases-24292e?style=for-the-badge&logo=github&logoColor=white" alt="GitHub Releases" height="46">
</a>

<br><br>

<sub>macOS 10.15 Catalina and later &nbsp;·&nbsp; Apple Silicon &amp; Intel &nbsp;·&nbsp; Runs entirely on your device</sub>

</div>

---

Ghostly is a speech-to-text app that lives in your menu bar. Press a shortcut, speak, and your words appear directly in whatever app you're using — no cloud, no subscription, no audio leaving your machine.

## Features

### Per-App Profiles

Ghostly automatically switches context when you switch apps. Set a different vocabulary, prompt, or transcription style for Slack, your code editor, your email client — Ghostly detects the frontmost app at transcription time and applies the right profile.

### Voice Editing Loop

Made a mistake? Just say what to fix. After transcribing, you can speak an edit command to revise what was just pasted. No re-recording the whole thing — just describe the change and Ghostly handles it.

### Completely Offline

Your audio never leaves your computer. Transcription runs on-device using your choice of Whisper models, with GPU acceleration on Apple Silicon and supported Intel/AMD/NVIDIA hardware.

### Multiple Model Options

| Model | Size | Notes |
|---|---|---|
| Small | 487 MB | Fast, good for quick dictation |
| Medium | 492 MB | Balanced accuracy and speed |
| Turbo | 1.6 GB | High accuracy, reasonable speed |
| Large | 1.1 GB | Maximum accuracy |

### Push-to-Talk or Toggle

Hold to record and release to transcribe, or tap once to start and again to stop.

### Always-on Shortcut

Works from any app, any window. Configure any key combination in Settings.

## How It Works

1. Press your keyboard shortcut to start recording
2. Speak — silence is automatically filtered out
3. Release (or press again) to stop
4. Your transcribed text is pasted directly into the active field — no copy-paste, no window switching

## Getting Started

1. [Download the latest release](https://get-ghostly.com/download) and open the `.dmg`
2. Drag Ghostly to your Applications folder
3. Launch Ghostly — it will appear in your menu bar
4. Grant microphone and accessibility permissions when prompted
5. Set your preferred keyboard shortcut in Settings
6. Start speaking

On first launch, Ghostly will download a transcription model. This is a one-time step that requires an internet connection. After that, everything runs offline.

## System Requirements

- macOS 10.15 Catalina or later
- Apple Silicon (M1 and up) — recommended for best performance
- Intel Mac — fully supported
- Microphone access
- Accessibility access (required to paste into other apps)

## CLI Flags

Ghostly supports command-line flags for scripting, window managers, and autostart configurations.

**Control a running instance:**

```bash
ghostly --toggle-transcription     # Toggle recording on/off
ghostly --toggle-post-process      # Toggle with voice editing
ghostly --cancel                   # Cancel the current operation
```

**Startup options:**

```bash
ghostly --start-hidden             # Launch to tray without opening the window
ghostly --no-tray                  # Closing the window quits the app
ghostly --debug                    # Verbose logging
```

When installed as an app bundle, invoke the binary directly:

```bash
/Applications/Ghostly.app/Contents/MacOS/ghostly --toggle-transcription
```

## License & Attribution

Ghostly is built on [Handy](https://github.com/cjpais/Handy) by CJ Pais, used under the MIT License.

See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for full attribution.
