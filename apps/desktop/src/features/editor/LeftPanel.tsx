import { useRef, useState, ReactNode } from "react";
import {
  IconMedia, IconText, IconEffects, IconFilters, IconTransitions,
  IconAudio, IconCaptions, IconTemplates, IconStickers,
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
  curves: "📈", color_wheels: "🎡",
};

const STICKERS = ["🔥", "❤️", "😂", "🎉", "⭐", "👍", "💯", "🚀", "🎬", "🎵", "⚡", "🌙", "✅", "❌", "➡️", "💥"];

function StickersPanel() {
  const { addTextClip } = useEditor();
  return (
    <div className="dock-panel">
      <div className="panel-title">Stickers</div>
      <p className="hint">Stickers ride the text track (huge emoji glyphs) — they preview and export like text.</p>
      <div className="lib-grid">
        {STICKERS.map((s) => (
          <button key={s} className="lib-card" onClick={() => addTextClip(s, { fontSize: 160, color: "#ffffff" })}>
            <span className="lib-tile" style={{ background: "#17171c", fontSize: 30 }}>{s}</span>
            <span className="lib-name">Sticker</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Tab = "media" | "text" | "effects" | "filters" | "transitions" | "audio" | "captions" | "templates" | "stickers";

const TABS: { id: Tab; icon: ReactNode; label: string }[] = [
  { id: "media", icon: <IconMedia />, label: "Media" },
  { id: "text", icon: <IconText />, label: "Text" },
  { id: "effects", icon: <IconEffects />, label: "Effects" },
  { id: "filters", icon: <IconFilters />, label: "Filters" },
  { id: "transitions", icon: <IconTransitions />, label: "Transitions" },
  { id: "audio", icon: <IconAudio />, label: "Audio" },
  { id: "captions", icon: <IconCaptions />, label: "Captions" },
  { id: "templates", icon: <IconTemplates />, label: "Templates" },
  { id: "stickers", icon: <IconStickers />, label: "Stickers" },
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
        {tab === "stickers" && <StickersPanel />}
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
  const selected = useEditor((s) => s.selected);
  const types = Object.keys(EFFECT_LABELS) as Effect["type"][];
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
  const media = useEditor((s) => s.media);
  const project = useEditor((s) => s.project);
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);

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
  return (
    <div className="dock-panel">
      <div className="panel-title">Captions</div>
      <button className="primary" onClick={() => fileRef.current?.click()}>
        Import .srt subtitles
      </button>
      <input ref={fileRef} type="file" accept=".srt,text/plain" hidden onChange={(e) => importSrt(e.target.files?.[0])} />
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
