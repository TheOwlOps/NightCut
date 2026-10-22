# FFmpeg sidecar

NightCut does **not** bundle FFmpeg in the installer (it would add ~30MB and
FFmpeg's LGPL/GPL builds need care when redistributing). Instead the desktop
app downloads a static build into this folder on first run:

```
tools/ffmpeg/bin/ffmpeg(.exe)
tools/ffmpeg/bin/ffprobe(.exe)
```

`bin/` is git-ignored. For development you can also just install FFmpeg on
your PATH — media-engine/export-engine call `ffmpeg`/`ffprobe` by name.

Manual fetch (any platform with curl):

```sh
# Linux (x86_64 static build)
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar -xJ
# then copy ffmpeg + ffprobe into tools/ffmpeg/bin/
```

Windows/macOS: use the builds from https://www.gyan.dev/ffmpeg/builds/
(Windows) or https://evermeet.cx/ffmpeg/ (macOS), same target folder.
