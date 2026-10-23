# ONNX sidecar for AI background removal

NightCut's **Remove background** (CapCut's "Remove BG") runs a u2netp
segmentation model fully on-device — the local equivalent of CapCut's
cloud feature. Like the whisper sidecar, the runtime is a downloadable
tool folder, not bundled code:

```
tools/onnx/
  libonnxruntime.so      (Windows: onnxruntime.dll, macOS: libonnxruntime.dylib)
  u2netp.onnx            (~4.4 MB)
```

Where NightCut looks (first match wins):

1. `$NIGHTCUT_ONNX_DIR`
2. `<folder of the NightCut executable>/tools/onnx/`

Getting the files:

- ONNX Runtime: https://github.com/microsoft/onnxruntime/releases
  (extract `lib/libonnxruntime.so*` from the `onnxruntime-<os>-x64-*` archive;
  rename/symlink to `libonnxruntime.so`)
- Model: `u2netp.onnx` from https://github.com/danielgatis/rembg/releases
  (the portable u2net variant; Apache-2.0 code / model per its repo terms)

The output is a new `<name>.nobg.mp4` next to the source: the subject
composited over black at up to 15 fps, ready to drop on the timeline
(overlays composite over the canvas the same way chroma-keyed clips do).
