# Build Instructions

Ghostly is a macOS-only application. This guide covers setting up the development environment and building from source.

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) package manager
- [Tauri Prerequisites](https://tauri.app/start/prerequisites/)
- Xcode Command Line Tools: `xcode-select --install`

macOS 10.15 (Catalina) or later. Apple Silicon or Intel.

## Setup

### 1. Clone

```bash
git clone git@github.com:jason-bartz/ghostly.git
cd ghostly
```

### 2. Install dependencies

```bash
bun install
```

### 3. Download the VAD model

```bash
mkdir -p src-tauri/resources/models
curl -o src-tauri/resources/models/silero_vad_v4.onnx https://blob.handy.computer/silero_vad_v4.onnx
```

### 4. Run in dev mode

```bash
bun tauri dev
```

If you hit a cmake policy error:

```bash
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
```

### 5. Build for production

```bash
bun run tauri build
```

Produces a signed `.dmg` and `.app` bundle under `src-tauri/target/release/bundle/`.
