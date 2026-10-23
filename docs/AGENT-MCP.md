# Editing video with AI agents — nightcut-mcp

NightCut ships an MCP server, **`nightcut-mcp`**, so AI agents (Claude,
local LLMs, Boom bots, your own scripts…) can edit video end-to-end
without the GUI: build a timeline, trim/split clips, apply effects, add
text and captions, run the local AI tools and render — all through
MCP tools over stdio (JSON-RPC 2.0).

The project format is exactly the JSON the desktop app reads and
writes, so an agent and a human can hand the same project back and
forth.

## Run it

```bash
cargo build --release -p agent-server   # binary: target/release/nightcut-mcp
```

Register it with any MCP client, e.g. Claude Code / Claude Desktop:

```json
{
  "mcpServers": {
    "nightcut": { "command": "/path/to/nightcut-mcp", "args": [] }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `nightcut_project_new` / `_open` / `_save` / `_info` | Project lifecycle (canvas size on new) |
| `nightcut_media_probe` | ffprobe info for a media file |
| `nightcut_clip_add` | Add a file as a clip (`track`: `video`, `overlay` = PiP, `audio`) |
| `nightcut_clip_trim` / `_move` / `_split` / `_delete` / `_set` | Timeline editing (set: speed, volume, PiP placement) |
| `nightcut_effect_add` | Any editor-core effect as JSON, e.g. `{"type":"loudnorm","target_lufs":-14}`, `{"type":"curves",...}`, `{"type":"color_wheels",...}`, `{"type":"lut","path":"…"}` |
| `nightcut_text_add` | Text/title clip |
| `nightcut_captions_import_srt` | .srt → caption clips |
| `nightcut_captions_auto` | Local whisper.cpp captions (pass `whisperBin` + `model` paths) |
| `nightcut_beats_detect` | Beat times → project markers |
| `nightcut_scenes_detect` / `nightcut_silences_detect` | Scene cuts / silent ranges |
| `nightcut_clip_split_scenes` | Split a clip at every scene change |
| `nightcut_track_motion` | Subject tracking positions over time |
| `nightcut_bg_remove` | AI background removal (u2netp ONNX; pass `onnxDir`) |
| `nightcut_export` | Render: `output`, `maxHeight`, `gif`, `audioOnly` (MP3/WAV/AAC by extension) |

## Notes

- One project is held in memory per server process; clips reference
  real file paths, which double as export sources.
- Text/captions render with an auto-discovered system font
  (`NIGHTCUT_FONT` overrides).
- Everything is local: no uploads, no API keys. FFmpeg must be on
  `PATH`; whisper.cpp and ONNX Runtime are optional sidecars (see
  `tools/`).
