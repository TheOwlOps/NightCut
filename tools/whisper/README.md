# whisper.cpp sidecar (local auto-captions)

Auto Captions run **fully on-device** with whisper.cpp — no audio ever
leaves the machine (unlike CapCut's cloud captions).

## What the app looks for

- Binary: `tools/whisper/whisper-cli` (or `whisper-cli.exe`) next to the
  app executable — or on `PATH`, or pointed to by `NIGHTCUT_WHISPER_BIN`.
- Model: `tools/whisper-models/ggml-<name>.bin` next to the executable —
  or `NIGHTCUT_WHISPER_MODEL`. The UI asks for `tiny.en` by default
  (~78 MB, fast); `base.en` / `small.en` are more accurate.

## Getting them

- Binary: build whisper.cpp from source
  (`cmake -B build && cmake --build build --target whisper-cli`) or grab
  a release from https://github.com/ggml-org/whisper.cpp/releases
- Models: https://huggingface.co/ggerganov/whisper.cpp/tree/main
  (e.g. `ggml-tiny.en.bin`, `ggml-base.en.bin` — use the non-`.en`
  variants for other languages)

Verified locally: whisper.cpp v1.9.5 + `ggml-tiny.en.bin` transcribed
the whisper.cpp `jfk.wav` sample correctly on the dev VM.
