# Contributing to Ghostly

Thank you for your interest in contributing to Ghostly! This guide will help you get started.

## Philosophy

Ghostly aims to be a simple, private, local speech-to-text app that stays out of your way. We prioritize:

- **Simplicity**: Clear, maintainable code over clever solutions
- **Privacy**: Keep everything local and offline
- **Accessibility**: Free tooling that belongs in everyone's hands

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) package manager
- Platform-specific build tools (see [BUILD.md](BUILD.md))

### Setting Up Your Development Environment

1. **Fork the repository** on GitHub

2. **Clone your fork**:

   ```bash
   git clone git@github.com:YOUR_USERNAME/ghostly.git
   cd ghostly
   ```

3. **Install dependencies**:

   ```bash
   bun install
   ```

4. **Download required models**:

   ```bash
   mkdir -p src-tauri/resources/models
   curl -o src-tauri/resources/models/silero_vad_v4.onnx https://blob.handy.computer/silero_vad_v4.onnx
   ```

5. **Run in development mode**:

   ```bash
   bun run tauri dev
   # On macOS if you encounter cmake errors:
   CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev
   ```

For detailed platform-specific setup instructions, see [BUILD.md](BUILD.md).

### Understanding the Codebase

**Backend (Rust - `src-tauri/src/`):**

- `lib.rs` - Main application entry point with Tauri setup
- `managers/` - Core business logic (audio, model, transcription)
- `audio_toolkit/` - Low-level audio processing (recording, VAD)
- `commands/` - Tauri command handlers for frontend communication
- `shortcut.rs` - Global keyboard shortcut handling
- `settings.rs` - Application settings management

**Frontend (React/TypeScript - `src/`):**

- `App.tsx` - Main application component
- `components/` - React UI components
- `hooks/` - Reusable React hooks
- `lib/types.ts` - Shared TypeScript types

For more details, see [AGENTS.md](AGENTS.md).

## Reporting Bugs

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md) when creating an issue.

When creating a bug report, please include:

- App version (found in settings or about section)
- Operating system (e.g., macOS 14.1, Windows 11)
- CPU and GPU (e.g., Apple M2, Intel i7-12700K)
- Clear description of the bug
- Steps to reproduce
- Expected vs. actual behavior
- Screenshots or logs if applicable

Enable debug mode (`Cmd/Ctrl+Shift+D`) to gather diagnostic information.

## Making Code Contributions

### Development Workflow

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make your changes** — follow existing code style and patterns.

3. **Test thoroughly** on your target platform(s).

4. **Commit your changes** using conventional commit messages:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `docs:` for documentation changes
   - `refactor:` for code refactoring
   - `test:` for test additions/changes
   - `chore:` for maintenance tasks

5. **Push and open a Pull Request** against the `main` branch. Fill out the PR template completely.

### AI Assistance Disclosure

AI-assisted PRs are welcome. In your PR description, please note whether AI was used and which tools.

### Code Style Guidelines

**Rust:**

- Follow standard Rust formatting (`cargo fmt`)
- Run `cargo clippy` and address warnings
- Use descriptive variable and function names
- Add doc comments for public APIs
- Handle errors explicitly (avoid unwrap in production code)

**TypeScript/React:**

- Use TypeScript strictly, avoid `any` types
- Follow React hooks best practices
- Use functional components
- Keep components small and focused
- Use Tailwind CSS for styling

### Testing Your Changes

```bash
bun run tauri dev        # Dev mode
bun run tauri build      # Production build
bun run test:playwright  # Playwright tests
```

## Documentation Contributions

Documentation improvements are highly valued! You can contribute by:

- Improving README.md, BUILD.md, or this CONTRIBUTING.md
- Adding code comments and doc comments
- Improving error messages

## Community Guidelines

- **Be respectful and inclusive**
- **Be patient** — this is maintained by a small team
- **Be constructive** — focus on solutions and improvements
- **Search first** — check existing issues before creating new ones

## Getting Help

- **Email**: [support@try-ghostly.com](mailto:support@try-ghostly.com)

## License

By contributing to Ghostly, you agree that your contributions will be licensed under the MIT License. See [LICENSE](LICENSE) for details.

Ghostly is built on [Handy](https://github.com/cjpais/Handy) by CJ Pais, used under the MIT License. See [NOTICE.md](NOTICE.md) for full attribution.
