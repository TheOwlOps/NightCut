# NightCut plugins

NightCut's answer to CapCut's Plugins tab — local-first and safe by
construction: **a plugin is data, never code.** A plugin is a folder
with one `plugin.json` manifest describing effect stacks and text
presets. Nothing is executed, nothing is downloaded, nothing phones
home.

## Install

Copy a plugin folder into any of these locations (first match wins):

1. `$NIGHTCUT_PLUGINS_DIR/<plugin>/plugin.json`
2. `<folder of the NightCut executable>/plugins/<plugin>/plugin.json`
3. `~/.nightcut/plugins/<plugin>/plugin.json`

Then open the **Plugins** tab in the editor (it rescans on open, and
has a Rescan button). Plugin effects also appear in the Effects tab
under "From plugins".

This repo ships an example: `plugins/warm-look/`.

## Manifest format

```json
{
  "name": "My Pack",
  "description": "Shown in the Plugins tab.",
  "effects": [
    { "label": "Warm cinematic", "effect": { "type": "temperature", "kelvin": 3800 } }
  ],
  "textPresets": [
    { "label": "Sale badge", "text": "SALE -50%", "fontSize": 64,
      "color": "#ffffff", "bg": "#d43a2f" }
  ]
}
```

- `effects[].effect` is exactly one editor-core `Effect` object (the
  same JSON the project file uses — `adjust`, `sepia`, `temperature`,
  `curves`, `color_wheels`, `lut`, `loudnorm`, …). It is applied to
  the selected clip through the normal effect path, so it shows up in
  the Inspector and can be removed like any effect.
- `textPresets[]` drop a text clip at the playhead with the given
  style; `bg` is the pill background color.
- Unknown fields are ignored; a manifest without a `name` is skipped.

## Brand kit & Elements

The neighboring rail tabs are the local counterparts of CapCut's
cloud tabs:

- **Elements** — shapes, badges and stickers that drop as text-track
  clips (they preview and export like text).
- **Brand kit** — your palette (click a swatch to paint the selected
  text), a brand headline button, and logo watermarking: import a logo
  image in Media and it can be placed as a PiP overlay (still images
  loop in the export engine, so logos render for their whole clip).
