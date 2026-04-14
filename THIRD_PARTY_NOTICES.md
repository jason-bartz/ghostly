# Third-Party Notices

Ghostly includes open-source software from the following projects. Each is governed by its own license, reproduced below. Your rights in these components under their respective open-source licenses are not limited by the Ghostly EULA.

---

## Handy

- Source: https://github.com/cjpais/Handy
- Copyright (c) 2025 CJ Pais
- License: MIT

Ghostly is a derivative work of Handy. Portions of the Ghostly source code originate from Handy and remain under the MIT License.

```
MIT License

Copyright (c) 2025 CJ Pais

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## whisper.cpp

- Source: https://github.com/ggerganov/whisper.cpp
- Copyright (c) 2023-2025 Georgi Gerganov
- License: MIT

---

## Silero VAD

- Source: https://github.com/snakers4/silero-vad
- License: MIT

---

## Rust crates

Ghostly links against numerous Rust crates including `whisper-rs`, `cpal`, `vad-rs`, `rdev`, `rubato`, `rodio`, `tauri`, and others. A complete list of crates and their licenses can be generated with:

```
cargo about generate about.hbs > licenses.html
```

The generated `licenses.html` is bundled with release builds and accessible from the About screen.

---

## JavaScript / TypeScript packages

Ghostly's frontend uses packages including React, Vite, Zustand, Tailwind CSS, i18next, and others. License information for all bundled npm packages is generated at build time via:

```
bun x license-checker --production --json > licenses-frontend.json
```

---

## Silero VAD Model Weights

The `silero_vad_v4.onnx` model weights are downloaded at build time from a separate source and are governed by the Silero VAD license terms.

## Whisper Model Weights

Whisper model weights downloaded by Ghostly at runtime are distributed by OpenAI under the MIT License. See https://github.com/openai/whisper for details.
