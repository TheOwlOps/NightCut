# CapCut Desktop — feature study (2026-10-23)

Studied from CapCut help/guide coverage and desktop tutorials (sources at the
bottom). This is the map NightCut is being built against: layout and feature
names are learned, everything is implemented from scratch on FFmpeg/Rust.

## Layout (CapCut Desktop)

- **Top bar:** project name/settings, Export button top-right.
- **Left panel with tabs:** Media · Audio · Text · Stickers · Effects ·
  Transitions · Filters · Captions — asset/effect libraries live here.
- **Center:** preview/player.
- **Right panel:** properties of the selected clip, in sections
  (Video/Basic, Speed, Animation, Audio, Adjust).
- **Bottom:** multi-track timeline; transitions are applied *between* clips;
  captions live on their own track.

## Feature map

| CapCut feature | NightCut status |
|---|---|
| Import media, multi-track timeline, trim/split/move | ✅ Phase 0 |
| Effects library (adjust, blur, …) + filters | ✅ Phase 0 + Wave 2 presets |
| Transitions between clips (fade, dissolve, wipe, slide, …) | ✅ Wave 2 — FFmpeg `xfade`/`acrossfade` |
| Speed: Standard (constant) | ✅ Wave 2 — Inspector slider/presets |
| Speed: Curve (ramping) | ⏳ later — needs per-segment speed model |
| Reverse clip | ✅ Wave 2 — `reverse`/`areverse` (export-rendered) |
| Text presets/styles, colors | ✅ Wave 2 — Text tab presets + Inspector |
| Captions: import .SRT | ✅ Wave 2 — Captions tab, parser → text track |
| Captions: auto (speech-to-text) | ⏳ Phase 3 — whisper.cpp local, optional download |
| Audio: volume, fades | ✅ clip volume (Wave 2) + fade effects (Phase 0) |
| Audio: noise reduction, voice enhance | ⏳ later — `afftdn`/`arnndn` need model files |
| Freeze frame | ⏳ later — split + hold-frame export mode |
| Keyframe animation | ⏳ later — property keyframe model + zoompan/overlay interp |
| Chroma key (green screen) | ⏳ later — `chromakey` needs a background layer model |
| Background removal (AI) | ⏳ later — local segmentation model, optional download |
| Mask, motion tracking, stabilization | ⏳ later — `vidstab` is a 2-pass flow |
| Templates / stock / music library (cloud) | ❌ not copied — licensed cloud content (see BLUEPRINT §8) |
| Text-to-speech, AI avatar, relight (cloud AI) | ❌ not copied — server AI (see BLUEPRINT §8) |

## Sources

- CapCut PC complete guide — interface breakdown (left panel assets, center
  preview, right settings, bottom timeline): capeditcut.com
- Primal Video, CapCut for PC & Mac tutorial 2026 — layout consistency,
  right-side settings panel, export flow: primalvideo.com
- CapCut tutorials index — desktop specifics: Transitions tab between clips,
  Speed Standard/Curve on desktop, Text → Auto Captions: lilachbullock.com
- Feature roundups — keyframes, chroma key, speed ramping/curve, captions,
  freeze, reverse, filters/LUT/HSL, SRT import/export, beat sync:
  techspot.com, magnushelander.se
