import { useEffect, useRef, useState, ReactNode } from "react";
import {
  IconMedia, IconText, IconEffects, IconFilters, IconTransitions,
  IconAudio, IconCaptions, IconTemplates, IconElements, IconBrand, IconPlugins,
} from "./Icons";
import MediaBin, { isTauri } from "./MediaBin";
import { useEditor } from "../../store/editor";
import {
  EFFECT_LABELS,
  FILTER_PRESETS,
  TEXT_PRESETS,
  TRANSITION_PRESETS,
  Effect,
  newId,
  splitClip,
  transcriptWords,
  Clip,
  Project,
} from "../../lib/project";

/** Tile icons for the Effects library grid. */
const EFFECT_ICONS: Partial<Record<Effect["type"], string>> = {
  adjust: "🎚", grayscale: "◐", sepia: "🟤", blur: "🌫", sharpen: "🔪",
  vignette: "◉", temperature: "🌡", mirror: "🪞", invert: "◑",
  fade_in: "↗", fade_out: "↘", reverse: "⏪", chroma_key: "🟢",
  denoise: "🔇", mask: "🎭", stabilize: "🎯",
  pitch_shift: "🎤", lut: "🎞", loudnorm: "🔊", video_denoise: "✨",
  curves: "📈", color_wheels: "🎡", hsl: "🌈", deflicker: "💡",
  enhance_voice: "🎙", vocal_isolate: "🗣",
};

const STICKERS = ["🔥", "❤️", "😂", "🎉", "⭐", "👍", "💯", "🚀", "🎬", "🎵", "⚡", "🌙", "✅", "❌", "➡️", "💥"];
/** Shape glyphs covered by the export font (DejaVu): they ride the text
 * track like stickers and render identically in preview and export. */
const SHAPES = ["●", "■", "▲", "◆", "★", "♥", "⬟", "⬢", "➜", "➤", "✚", "✖", "─", "│", "↗", "↘"];
const BADGES = [
  { text: "NEW", bg: "#e8890c" },
  { text: "SALE", bg: "#d43a2f" },
  { text: "-50%", bg: "#d43a2f" },
  { text: "HOT", bg: "#8b5cf6" },
  { text: "LIVE", bg: "#d43a2f" },
  { text: "4K", bg: "#17171c" },
];

/** CapCut's Elements tab, local edition: shapes, badges and stickers.
 * Everything here drops a real text-track clip — no placeholders. */
function ElementsPanel() {
  const { addTextClip } = useEditor();
  return (
    <div className="dock-panel">
      <div className="panel-title">Elements</div>
      <div className="field">
        <span>Shapes</span>
        <div className="lib-grid">
          {SHAPES.map((s) => (
            <button key={s} className="lib-card" onClick={() => addTextClip(s, { fontSize: 140, color: "#ffffff" })}>
              <span className="lib-tile" style={{ background: "#17171c", fontSize: 26, color: "#fff" }}>{s}</span>
              <span className="lib-name">Shape</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Badges</span>
        <div className="lib-grid">
          {BADGES.map((b) => (
            <button
              key={b.text}
              className="lib-card"
              onClick={() => addTextClip(b.text, { fontSize: 56, color: "#ffffff", bg: b.bg, shadow: true })}
            >
              <span className="lib-tile" style={{ background: "#17171c" }}>
                <span style={{ background: b.bg, color: "#fff", borderRadius: 6, padding: "2px 8px", fontWeight: 800, fontSize: 13 }}>
                  {b.text}
                </span>
              </span>
              <span className="lib-name">{b.text}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Stickers</span>
        <div className="lib-grid">
          {STICKERS.map((s) => (
            <button key={s} className="lib-card" onClick={() => addTextClip(s, { fontSize: 160, color: "#ffffff" })}>
              <span className="lib-tile" style={{ background: "#17171c", fontSize: 30 }}>{s}</span>
              <span className="lib-name">Sticker</span>
            </button>
          ))}
        </div>
      </div>
      <p className="hint">Elements ride the text track — restyle color/size in the Inspector, position via keyframes.</p>
    </div>
  );
}

const BRAND_KEY = "nightcut-brand-kit";
interface BrandKit {
  colors: string[];
  fontSize: number;
}
const defaultBrand = (): BrandKit => ({
  colors: ["#00e0bd", "#f5c518", "#ffffff", "#e8890c", "#d43a2f", "#17171c"],
  fontSize: 72,
});

function loadBrand(): BrandKit {
  try {
    const raw = localStorage.getItem(BRAND_KEY);
    if (raw) return { ...defaultBrand(), ...(JSON.parse(raw) as BrandKit) };
  } catch { /* fresh start */ }
  return defaultBrand();
}

/** CapCut's Brand Kit, local edition: your palette + logo, applied to
 * real clips. The kit is stored on this machine (localStorage +
 * imported media), never uploaded anywhere. */
function BrandKitPanel() {
  const { media, addOverlayClip, selected, setSelectedTextStyle, addTextClip, project } = useEditor();
  const [kit, setKit] = useState<BrandKit>(loadBrand);
  const logos = media.filter((m) => m.kind === "image");
  const save = (next: BrandKit) => {
    setKit(next);
    try { localStorage.setItem(BRAND_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  return (
    <div className="dock-panel">
      <div className="panel-title">Brand kit</div>
      <div className="field">
        <span>Brand colors — click a swatch to paint the selected text</span>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {kit.colors.map((c, i) => (
            <span key={i} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <button
                className="swatch"
                style={{ background: c, width: 34, height: 34 }}
                title={selected ? `Apply ${c} to the selected text clip` : "Select a text clip first"}
                onClick={() => setSelectedTextStyle({ textColor: c })}
              />
              <input
                type="color"
                value={c}
                style={{ width: 34, height: 18, padding: 0, border: "none", background: "transparent" }}
                onChange={(e) => {
                  const next = { ...kit, colors: kit.colors.map((x, j) => (j === i ? e.target.value : x)) };
                  save(next);
                }}
              />
            </span>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Brand headline (your colors, one click)</span>
        <button
          className="primary"
          onClick={() => addTextClip("Your headline", { fontSize: kit.fontSize, color: kit.colors[0], shadow: true })}
        >
          Add headline in brand color
        </button>
        <label className="row">
          <span className="hint">Size</span>
          <input
            type="range" min={32} max={160} value={kit.fontSize}
            onChange={(e) => save({ ...kit, fontSize: Number(e.target.value) })}
          />
          <span className="hint">{kit.fontSize}px</span>
        </label>
      </div>
      <div className="field">
        <span>Logo watermark</span>
        {logos.length === 0 ? (
          <p className="hint">
            Import a logo image in the Media tab first — it lands here automatically.
            Project “{project.name ?? "Untitled project"}” will carry it as an overlay.
          </p>
        ) : (
          <div className="row" style={{ flexWrap: "wrap" }}>
            {logos.map((m) => (
              <button key={m.id} className="chip" onClick={() => addOverlayClip(m.id)} title={`Watermark with ${m.name} at the playhead`}>
                🖼 {m.name.length > 16 ? `${m.name.slice(0, 16)}…` : m.name}
              </button>
            ))}
          </div>
        )}
        <p className="hint">The logo rides the PiP track — resize/reposition in the Inspector; stills loop in export like video.</p>
      </div>
    </div>
  );
}

/** CapCut's Plugins tab, local edition: declarative content packs from
 * plugin.json folders (desktop). Effects and text presets apply through
 * the normal editing paths — plugins are data, never code. */
function PluginsPanel() {
  const { plugins, loadPlugins, addEffectInstance, addTextClip } = useEditor();
  useEffect(() => { void loadPlugins(); }, [loadPlugins]);
  return (
    <div className="dock-panel">
      <div className="panel-title">Plugins</div>
      {plugins.length === 0 ? (
        <p className="hint">
          No plugins found. In the desktop app, drop a folder with a plugin.json into
          ~/.nightcut/plugins (or set NIGHTCUT_PLUGINS_DIR) — the repo ships an example
          pack under plugins/. A plugin is pure data: effect stacks and text presets.
        </p>
      ) : (
        plugins.map((pl) => (
          <div key={pl.name} className="field">
            <span>{pl.name}</span>
            {pl.description && <p className="hint">{pl.description}</p>}
            {(pl.effects ?? []).map((e) => (
              <button key={e.label} className="preset-card" onClick={() => addEffectInstance(e.effect)}>
                <strong>{e.label}</strong>
                <span className="hint">Apply effect to the selected clip</span>
              </button>
            ))}
            {(pl.textPresets ?? []).map((t) => (
              <button
                key={t.label}
                className="preset-card"
                onClick={() => addTextClip(t.text, { fontSize: t.fontSize ?? 64, color: t.color ?? "#ffffff", bg: t.bg })}
              >
                <strong>{t.label}</strong>
                <span className="hint">Add text preset at the playhead</span>
              </button>
            ))}
          </div>
        ))
      )}
      <button onClick={() => void loadPlugins()}>↻ Rescan plugin folders</button>
    </div>
  );
}

type Tab = "media" | "text" | "effects" | "filters" | "transitions" | "audio" | "captions" | "templates" | "elements" | "brandkit" | "plugins";

const TABS: { id: Tab; icon: ReactNode; label: string }[] = [
  { id: "media", icon: <IconMedia />, label: "Media" },
  { id: "text", icon: <IconText />, label: "Text" },
  { id: "effects", icon: <IconEffects />, label: "Effects" },
  { id: "filters", icon: <IconFilters />, label: "Filters" },
  { id: "transitions", icon: <IconTransitions />, label: "Transitions" },
  { id: "audio", icon: <IconAudio />, label: "Audio" },
  { id: "captions", icon: <IconCaptions />, label: "Captions" },
  { id: "templates", icon: <IconTemplates />, label: "Templates" },
  { id: "elements", icon: <IconElements />, label: "Elements" },
  { id: "brandkit", icon: <IconBrand />, label: "Brand kit" },
  { id: "plugins", icon: <IconPlugins />, label: "Plugins" },
];

/**
 * CapCut-style left dock: a narrow tab rail + the active library panel.
 * Every button here performs a real edit on the project — no dead UI.
 */
export default function LeftPanel() {
  const [tab, setTab] = useState<Tab>("media");
  return (
    <div className="leftpanel">
      <nav className="rail">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "rail-btn active" : "rail-btn"}
            onClick={() => setTab(t.id)}
          >
            <span className="rail-icon">{t.icon}</span>
            <span className="rail-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="dock">
        {tab === "media" && <MediaBin />}
        {tab === "text" && <TextPanel />}
        {tab === "effects" && <EffectsPanel />}
        {tab === "filters" && <FiltersPanel />}
        {tab === "transitions" && <TransitionsPanel />}
        {tab === "audio" && <AudioPanel />}
        {tab === "captions" && <CaptionsPanel />}
        {tab === "templates" && <TemplatesPanel />}
        {tab === "elements" && <ElementsPanel />}
        {tab === "brandkit" && <BrandKitPanel />}
        {tab === "plugins" && <PluginsPanel />}
      </div>
    </div>
  );
}

function TemplatesPanel() {
  const applyTemplate = useEditor((s) => s.applyTemplate);
  const templates = [
    { kind: "hook" as const, name: "TikTok Hook", desc: "9:16 canvas, big hook title at 0s, watch-till-end card at the end" },
    { kind: "intro" as const, name: "Channel Intro", desc: "Channel name title + weekly subtitle cards at the start" },
    { kind: "tutorial" as const, name: "Tutorial Step", desc: "“Step 1:” label + hint text at the playhead" },
  ];
  return (
    <div className="dock-panel">
      <div className="panel-title">Templates</div>
      <p className="hint">
        NightCut templates are local project recipes (not CapCut's cloud library) — they insert
        real, editable clips you can restyle.
      </p>
      {templates.map((t) => (
        <button key={t.kind} className="preset-card" onClick={() => applyTemplate(t.kind)}>
          <strong>{t.name}</strong>
          <span className="hint">{t.desc}</span>
        </button>
      ))}
    </div>
  );
}

function TextPanel() {
  const addTextClip = useEditor((s) => s.addTextClip);
  const [custom, setCustom] = useState("");
  return (
    <div className="dock-panel">
      <div className="panel-title">Text presets</div>
      <div className="lib-grid">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.name}
            className="lib-card"
            onClick={() => addTextClip(p.name === "Title" ? "Your title" : "Your text", { fontSize: p.fontSize, color: p.color })}
          >
            <span className="lib-tile" style={{ background: "#17171c" }}>
              <span style={{ color: p.color, fontSize: Math.min(28, p.fontSize / 3), fontWeight: 800 }}>Ag</span>
            </span>
            <span className="lib-name">{p.name}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <span>Custom text at playhead</span>
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Type text…" />
        <button className="primary" disabled={!custom.trim()} onClick={() => addTextClip(custom.trim())}>
          Add text
        </button>
      </div>
    </div>
  );
}

function EffectsPanel() {
  const addEffect = useEditor((s) => s.addEffect);
  const addEffectInstance = useEditor((s) => s.addEffectInstance);
  const selected = useEditor((s) => s.selected);
  const plugins = useEditor((s) => s.plugins);
  const types = Object.keys(EFFECT_LABELS) as Effect["type"][];
  const pluginEffects = plugins.flatMap((pl) => (pl.effects ?? []).map((e) => ({ ...e, plugin: pl.name })));
  return (
    <div className="dock-panel">
      <div className="panel-title">Effects</div>
      {!selected && <p className="hint">Select a video clip first — effects apply to it.</p>}
      <div className="lib-grid">
        {types.map((t, i) => (
          <button key={t} className="lib-card" disabled={!selected} onClick={() => addEffect(t)}>
            <span className="lib-tile" style={{ background: `linear-gradient(135deg, hsl(${i * 47} 45% 30%), hsl(${i * 47 + 40} 45% 14%))` }}>
              {EFFECT_ICONS[t] ?? "✨"}
            </span>
            <span className="lib-name">{EFFECT_LABELS[t]}</span>
          </button>
        ))}
      </div>
      <p className="hint">Applied effects appear in the Inspector on the right, with sliders.</p>
      {pluginEffects.length > 0 && (
        <div className="field">
          <span>From plugins</span>
          {pluginEffects.map((e) => (
            <button key={`${e.plugin}:${e.label}`} className="preset-card" disabled={!selected} onClick={() => addEffectInstance(e.effect)}>
              <strong>{e.label}</strong>
              <span className="hint">{e.plugin}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FiltersPanel() {
  const applyFilterPreset = useEditor((s) => s.applyFilterPreset);
  const selected = useEditor((s) => s.selected);
  return (
    <div className="dock-panel">
      <div className="panel-title">Filters</div>
      {!selected && <p className="hint">Select a video clip first — the filter applies to it.</p>}
      <div className="lib-grid">
        {FILTER_PRESETS.map((f) => (
          <button key={f.name} className="lib-card" disabled={!selected} onClick={() => applyFilterPreset(f.effects)}>
            <span className="lib-tile" style={{ padding: 0 }}>
              <span className="filter-swatch" data-filter={f.name} style={{ height: "100%", borderRadius: 0 }} />
            </span>
            <span className="lib-name">{f.name}</span>
          </button>
        ))}
      </div>
      <p className="hint">A filter is a stack of effects — you can fine-tune each one in the Inspector.</p>
    </div>
  );
}

function TransitionsPanel() {
  const applyTransition = useEditor((s) => s.applyTransition);
  const selected = useEditor((s) => s.selected);
  return (
    <div className="dock-panel">
      <div className="panel-title">Transitions</div>
      <p className="hint">
        Select a clip (not the first one) and pick a transition — it blends that clip in from the
        previous clip. Duration is adjustable in the Inspector.
      </p>
      <div className="lib-grid">
        {TRANSITION_PRESETS.map((t, i) => (
          <button key={t.kind} className="lib-card" disabled={!selected} onClick={() => applyTransition(t.kind)}>
            <span className="lib-tile" style={{ background: `linear-gradient(${90 + i * 30}deg, #20303c 45%, #3d5a66 55%)` }}>
              ⇄
            </span>
            <span className="lib-name">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function VoiceoverRecorder() {
  const { addMedia, addAudioAtPlayhead } = useEditor();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const countRef = useRef(0);

  const toggle = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        const probe = document.createElement("audio");
        probe.preload = "metadata";
        countRef.current += 1;
        const name = `Voiceover ${countRef.current}`;
        probe.onloadedmetadata = () => {
          const id = newId("media");
          addMedia({ id, name, url, duration: probe.duration || 0, kind: "audio" });
          addAudioAtPlayhead(id);
        };
        probe.src = url;
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setError("");
    } catch {
      setError("Microphone unavailable — check the browser/OS permission.");
    }
  };

  return (
    <div className="field">
      <span>Voiceover</span>
      <button className={recording ? "danger" : "primary"} onClick={() => void toggle()}>
        {recording ? "■ Stop recording" : "🎙 Record voiceover at playhead"}
      </button>
      {error && <p className="hint">{error}</p>}
    </div>
  );
}

/** Text-to-speech (desktop): local flite voices -> wav on the audio track. */
function TextToSpeech() {
  const { addMedia } = useEditor();
  const [text, setText] = useState("Hello from NightCut");
  const [voice, setVoice] = useState("slt");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (!isTauri()) return null;
  const run = async () => {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const path = await invoke<string>("text_to_speech", { text, voice });
      const probe = document.createElement("audio");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        addMedia({
          id: newId("media"),
          name: path.split("/").pop() ?? "tts.wav",
          url: convertFileSrc(path),
          path,
          duration: probe.duration || 1,
          kind: "audio",
        });
        setNote("Added to the audio track.");
      };
      probe.src = convertFileSrc(path);
    } catch (e) {
      setNote(`TTS failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <span>Text to speech (local)</span>
      <textarea
        className="caption-input"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <select value={voice} onChange={(e) => setVoice(e.target.value)}>
          {["slt", "kal", "awb", "rms"].map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <button onClick={() => void run()} disabled={busy || !text.trim()}>
          {busy ? "…" : "🔊 Generate"}
        </button>
      </div>
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

/** Beat detection (desktop): onsets of the first music clip become
 * timeline markers; snapping can target them. */
function BeatDetect() {
  const { media, setMarkers } = useEditor();
  const [note, setNote] = useState("");
  if (!isTauri()) return null;
  const run = async () => {
    const music = media.find((m) => m.kind === "audio" && m.path);
    if (!music?.path) {
      setNote("Import an audio file with a real path first (desktop import).");
      return;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke<string>("detect_beats", { path: music.path });
      const parsed = JSON.parse(raw) as { beats: number[]; bpm: number };
      setMarkers(parsed.beats);
      setNote(`${parsed.beats.length} beats · ≈${Math.round(parsed.bpm)} BPM — markers are on the ruler.`);
    } catch (e) {
      setNote(`Beat detection failed: ${String(e)}`);
    }
  };
  return (
    <div className="field">
      <span>Beat sync</span>
      <button onClick={() => void run()}>🥁 Detect beats → markers</button>
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

function AudioPanel() {
  const { media, addMedia, addToTimeline } = useEditor();
  const fileRef = useRef<HTMLInputElement>(null);
  const importAudio = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file);
      const probe = document.createElement("audio");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        addMedia({ id: newId("media"), name: file.name, url, duration: probe.duration || 0, kind: "audio" });
      };
      probe.src = url;
    }
  };
  const audio = media.filter((m) => m.kind === "audio");
  return (
    <div className="dock-panel">
      <div className="panel-title">Audio</div>
      <button className="primary" onClick={() => fileRef.current?.click()}>
        + Import music / audio
      </button>
      <VoiceoverRecorder />
      <TextToSpeech />
      <BeatDetect />
      <input ref={fileRef} type="file" accept="audio/*" multiple hidden onChange={(e) => importAudio(e.target.files)} />
      <div className="media-list">
        {audio.length === 0 && <p className="hint">Imported audio lands on the audio track. Select it there to set volume and fades.</p>}
        {audio.map((m) => (
          <div key={m.id} className="media-item">
            <div className="audio-thumb">♪</div>
            <div className="media-meta">
              <span className="media-name" title={m.name}>{m.name}</span>
              <span className="media-dur">{m.duration.toFixed(1)}s</span>
            </div>
            <button onClick={() => addToTimeline(m.id)}>+</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CaptionsPanel() {
  const addCaptionsFromSrt = useEditor((s) => s.addCaptionsFromSrt);
  const addCaptionCues = useEditor((s) => s.addCaptionCues);
  const addTextClip = useEditor((s) => s.addTextClip);
  const cutRanges = useEditor((s) => s.cutRanges);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const media = useEditor((s) => s.media);
  const project = useEditor((s) => s.project);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileRef2 = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [rangeSel, setRangeSel] = useState<[number, number] | null>(null);

  const words = transcriptWords(project);
  const fillerCount = words.filter((w) => w.filler).length;
  const clickWord = (i: number, shift: boolean) => {
    setPlayhead(words[i].start + 0.01);
    if (shift && anchor !== null) {
      setRangeSel([Math.min(anchor, i), Math.max(anchor, i)]);
    } else {
      setAnchor(i);
      setRangeSel([i, i]);
    }
  };
  const cutSelectedWords = () => {
    if (!rangeSel) return;
    const [a, b] = rangeSel;
    const pad = 0.03;
    cutRanges([[Math.max(0, words[a].start - pad), words[b].end + pad]]);
    setRangeSel(null);
    setAnchor(null);
    setMsg(`Cut words ${a + 1}–${b + 1} from the video (captions shifted to match).`);
  };
  const removeFillers = () => {
    const ranges: [number, number][] = words
      .filter((w) => w.filler)
      .map((w) => [Math.max(0, w.start - 0.02), w.end + 0.02]);
    cutRanges(ranges);
    setMsg(`Removed ${ranges.length} filler word(s).`);
  };

  const autoCaptions = async () => {
    // The clip whose captions we generate: first video clip on the timeline.
    const firstClip = project.tracks
      .find((t) => t.kind === "video")
      ?.clips.find((c) => c.source);
    const item = media.find((m) => m.path && (m.path === firstClip?.source || m.name === firstClip?.source));
    if (!item?.path) {
      setMsg("Auto captions need a desktop-imported clip (native picker keeps its file path).");
      return;
    }
    setBusy(true);
    setMsg("Transcribing locally with whisper.cpp…");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cues = await invoke<{ start: number; end: number; text: string }[]>("auto_captions", {
        path: item.path,
        model: "tiny.en",
      });
      const n = addCaptionCues(cues, firstClip?.timelineStart ?? 0);
      setMsg(n > 0 ? `Added ${n} auto-caption lines from ${item.name}.` : "Whisper found no speech in that clip.");
    } catch (err) {
      setMsg(`Auto captions failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const importSrt = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      const n = addCaptionsFromSrt(text);
      setMsg(n > 0 ? `Imported ${n} caption lines onto the text track.` : "No captions found in that file — is it a valid .srt?");
    });
  };
  const importSrt2 = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      const n = addCaptionsFromSrt(text, "track-text-2", 0.97);
      setMsg(n > 0 ? `Imported ${n} second-language lines (bottom track).` : "No captions found in that file — is it a valid .srt?");
    });
  };
  return (
    <div className="dock-panel">
      <div className="panel-title">Captions</div>
      <button className="primary" onClick={() => fileRef.current?.click()}>
        Import .srt subtitles
      </button>
      <input ref={fileRef} type="file" accept=".srt,text/plain" hidden onChange={(e) => importSrt(e.target.files?.[0])} />
      <button onClick={() => fileRef2.current?.click()}>
        Import .srt — 2nd language (bilingual)
      </button>
      <input ref={fileRef2} type="file" accept=".srt,text/plain" hidden onChange={(e) => importSrt2(e.target.files?.[0])} />
      {words.length > 0 && (
        <div className="field">
          <span>Transcript — click a word to seek, Shift+click to select a range</span>
          <div className="transcript-box">
            {words.map((w, i) => (
              <span
                key={i}
                className={
                  "tword" +
                  (w.filler ? " filler" : "") +
                  (rangeSel && i >= rangeSel[0] && i <= rangeSel[1] ? " insel" : "")
                }
                onClick={(e) => clickWord(i, e.shiftKey)}
              >
                {w.word}{" "}
              </span>
            ))}
          </div>
          <div className="row">
            <button disabled={!rangeSel} onClick={cutSelectedWords}>✂ Cut selected words</button>
            <button disabled={fillerCount === 0} onClick={removeFillers}>
              🧹 Remove fillers ({fillerCount})
            </button>
          </div>
          <p className="hint">
            Cutting words removes those moments from the main video track and shifts
            everything after them — edit the video by editing the text.
          </p>
        </div>
      )}
      {msg && <p className="status">{msg}</p>}
      <div className="field">
        <span>Add one caption at playhead</span>
        <input value={line} onChange={(e) => setLine(e.target.value)} placeholder="Caption text…" />
        <button
          disabled={!line.trim()}
          onClick={() => addTextClip(line.trim(), { fontSize: 48, color: "#ffffff" })}
        >
          Add caption
        </button>
      </div>
      {isTauri() ? (
        <>
          <SceneTools setMsg={setMsg} />
          <button className="primary" disabled={busy} onClick={() => void autoCaptions()}>
            {busy ? "Transcribing…" : "✨ Auto captions (whisper.cpp, local)"}
          </button>
          <p className="hint">
            Runs whisper.cpp fully on this machine — no cloud upload like CapCut. Needs the
            whisper-cli sidecar + a model in tools/ (see tools/whisper/README.md in the repo).
          </p>
        </>
      ) : (
        <p className="hint">
          Automatic speech-to-text captions (whisper.cpp, fully local) run in the desktop app —
          no cloud upload like CapCut.
        </p>
      )}
    </div>
  );
}

/** Scene split + silence cutting for the first video clip (desktop only). */
function SceneTools({ setMsg }: { setMsg: (m: string) => void }) {
  const project = useEditor((s) => s.project);
  const media = useEditor((s) => s.media);
  const loadProject = useEditor((s) => s.loadProject);
  const [busy, setBusy] = useState(false);

  const firstVideo = () => {
    const track = project.tracks.find((t) => t.id === "track-video");
    const clip = track?.clips.find((c) => c.source);
    const item = media.find((m) => m.path && (m.path === clip?.source || m.name === clip?.source));
    return clip && item?.path ? { clip, path: item.path } : null;
  };

  const splitScenes = async () => {
    const found = firstVideo();
    if (!found) return setMsg("Scene tools need a desktop-imported clip on the video track.");
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke<string>("detect_scenes", { path: found.path, threshold: 0.4 });
      const scenes = (JSON.parse(raw) as { scenes: number[] }).scenes;
      const inside = scenes.filter(
        (t) => t > found.clip.inSec + 0.05 && t < found.clip.outSec - 0.05,
      );
      if (!inside.length) return setMsg("No scene changes detected in the first video clip.");
      let next: Project = project;
      // Split from the last cut backwards so earlier ids stay valid.
      for (const t of [...inside].sort((a, b) => b - a)) {
        const at = found.clip.timelineStart + (t - found.clip.inSec) / Math.max(0.01, found.clip.speed);
        next = splitClip(next, "track-video", found.clip.id, at) ?? next;
      }
      loadProject(next);
      setMsg(`Split the first clip at ${inside.length} scene change(s).`);
    } catch (err) {
      setMsg(`Scene detection failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const cutSilences = async () => {
    const found = firstVideo();
    if (!found) return setMsg("Scene tools need a desktop-imported clip on the video track.");
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const raw = await invoke<string>("detect_silences", { path: found.path });
      const silences = (JSON.parse(raw) as { silences: [number, number][] }).silences;
      const { clip } = found;
      // Kept segments of the clip with silences (in source time) removed.
      const kept: [number, number][] = [];
      let cursor = clip.inSec;
      for (const [s, e] of silences) {
        if (e <= clip.inSec || s >= clip.outSec) continue;
        const cs = Math.max(s, clip.inSec);
        const ce = Math.min(e, clip.outSec);
        if (cs > cursor) kept.push([cursor, cs]);
        cursor = Math.max(cursor, ce);
      }
      if (cursor < clip.outSec) kept.push([cursor, clip.outSec]);
      if (!kept.length || (kept.length === 1 && kept[0][0] === clip.inSec && kept[0][1] === clip.outSec)) {
        return setMsg("No silences long enough to cut in the first clip.");
      }
      const next = structuredClone(project);
      const track = next.tracks.find((t) => t.id === "track-video")!;
      const idx = track.clips.findIndex((c) => c.id === clip.id);
      const base: Clip = track.clips[idx];
      const rebuilt: Clip[] = [];
      let at = clip.timelineStart;
      kept.forEach(([s, e], i) => {
        const c: Clip = {
          ...structuredClone(base),
          id: i === 0 ? base.id : newId("clip"),
          inSec: s,
          outSec: e,
          timelineStart: at,
          speedCurve: undefined,
          keyframes: undefined,
          freezeDuration: undefined,
        };
        at += (e - s) / Math.max(0.01, clip.speed);
        rebuilt.push(c);
      });
      track.clips.splice(idx, 1, ...rebuilt);
      loadProject(next);
      setMsg(`Cut ${silences.length} silent range(s) — clip is now ${rebuilt.length} segment(s).`);
    } catch (err) {
      setMsg(`Silence detection failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <span>Smart cut (first video clip)</span>
      <button disabled={busy} onClick={() => void splitScenes()}>🎬 Split at scene changes</button>
      <button disabled={busy} onClick={() => void cutSilences()}>✂️ Cut silences (jump cut)</button>
    </div>
  );
}
