// Project model — mirrors crates/editor-core (Rust) field-for-field.
// The project is pure metadata: editing never touches source media.

export type TrackKind = "video" | "audio" | "text";

/** Effects — mirror of editor-core's Effect enum (serde tag = "type"). */
export type Effect =
  | { type: "adjust"; brightness: number; contrast: number; saturation: number }
  | { type: "grayscale" }
  | { type: "sepia"; intensity: number }
  | { type: "blur"; sigma: number }
  | { type: "sharpen"; amount: number }
  | { type: "vignette"; strength: number }
  | { type: "temperature"; kelvin: number }
  | { type: "mirror" }
  | { type: "invert" }
  | { type: "fade_in"; duration: number }
  | { type: "fade_out"; duration: number }
  | { type: "reverse" };

export const EFFECT_LABELS: Record<Effect["type"], string> = {
  adjust: "Brightness / Contrast",
  grayscale: "Grayscale",
  sepia: "Sepia (vintage)",
  blur: "Blur",
  sharpen: "Sharpen",
  vignette: "Vignette",
  temperature: "Warm / Cool",
  mirror: "Mirror",
  invert: "Invert colors",
  fade_in: "Fade in",
  fade_out: "Fade out",
  reverse: "Reverse (export only)",
};

/** Transition presets — names are FFmpeg xfade transitions (CapCut-style). */
export const TRANSITION_PRESETS: { kind: string; label: string }[] = [
  { kind: "fade", label: "Fade" },
  { kind: "fadeblack", label: "Fade to black" },
  { kind: "fadewhite", label: "Fade to white" },
  { kind: "dissolve", label: "Dissolve" },
  { kind: "wipeleft", label: "Wipe left" },
  { kind: "wiperight", label: "Wipe right" },
  { kind: "slideleft", label: "Slide left" },
  { kind: "slideright", label: "Slide right" },
  { kind: "circleopen", label: "Circle open" },
  { kind: "radial", label: "Radial" },
  { kind: "smoothleft", label: "Smooth left" },
  { kind: "zoomin", label: "Zoom in" },
];

/** One-click filter presets: named stacks of effects (CapCut Filters tab). */
export const FILTER_PRESETS: { name: string; effects: Effect[] }[] = [
  { name: "Vivid", effects: [{ type: "adjust", brightness: 0.03, contrast: 1.25, saturation: 1.5 }] },
  { name: "Warm", effects: [{ type: "temperature", kelvin: 4800 }, { type: "adjust", brightness: 0.03, contrast: 1.05, saturation: 1.15 }] },
  { name: "Cool", effects: [{ type: "temperature", kelvin: 8200 }, { type: "adjust", brightness: 0, contrast: 1.08, saturation: 0.95 }] },
  { name: "Mono", effects: [{ type: "grayscale" }, { type: "adjust", brightness: 0, contrast: 1.2, saturation: 0 }] },
  { name: "Vintage", effects: [{ type: "sepia", intensity: 0.65 }, { type: "vignette", strength: 0.55 }, { type: "adjust", brightness: 0.04, contrast: 0.92, saturation: 0.85 }] },
  { name: "Soft", effects: [{ type: "blur", sigma: 1.6 }, { type: "adjust", brightness: 0.07, contrast: 0.95, saturation: 1.05 }] },
  { name: "Faded", effects: [{ type: "adjust", brightness: 0.1, contrast: 0.8, saturation: 0.75 }, { type: "vignette", strength: 0.3 }] },
  { name: "Sharp", effects: [{ type: "sharpen", amount: 1.4 }, { type: "adjust", brightness: 0, contrast: 1.12, saturation: 1.1 }] },
];

/** Text style presets (CapCut Text tab). */
export const TEXT_PRESETS: { name: string; fontSize: number; color: string }[] = [
  { name: "Title", fontSize: 110, color: "#ffffff" },
  { name: "Subtitle", fontSize: 64, color: "#ffffff" },
  { name: "Caption", fontSize: 48, color: "#ffe14d" },
  { name: "Neon", fontSize: 72, color: "#22d3ee" },
  { name: "Alert", fontSize: 80, color: "#ff5252" },
];

/** Parse an .srt subtitle file into cues. */
export function parseSrt(content: string): { start: number; end: number; text: string }[] {
  const cues: { start: number; end: number; text: string }[] = [];
  const blocks = content.replace(/\r\n/g, "\n").split(/\n\n+/);
  const toSec = (t: string) => {
    const m = t.trim().replace(",", ".").split(":").map(Number);
    if (m.length === 3) return m[0] * 3600 + m[1] * 60 + m[2];
    if (m.length === 2) return m[0] * 60 + m[1];
    return 0;
  };
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx].split("-->");
    const text = lines.slice(timeIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) cues.push({ start: toSec(a), end: toSec(b), text });
  }
  return cues;
}

export function defaultEffect(type: Effect["type"]): Effect {
  switch (type) {
    case "adjust": return { type, brightness: 0.05, contrast: 1.1, saturation: 1.1 };
    case "sepia": return { type, intensity: 0.7 };
    case "blur": return { type, sigma: 6 };
    case "sharpen": return { type, amount: 1 };
    case "vignette": return { type, strength: 0.6 };
    case "temperature": return { type, kelvin: 5200 };
    case "fade_in": return { type, duration: 0.5 };
    case "fade_out": return { type, duration: 0.5 };
    default: return { type } as Effect;
  }
}

/** CSS-filter approximation of a clip's effects, for the live preview. */
export function cssFilterFor(clip: Clip): { filter: string; transform: string } {
  const parts: string[] = [];
  let transform = "";
  for (const fx of clip.effects ?? []) {
    switch (fx.type) {
      case "adjust":
        parts.push(`brightness(${1 + fx.brightness})`, `contrast(${fx.contrast})`, `saturate(${fx.saturation})`);
        break;
      case "grayscale": parts.push("grayscale(1)"); break;
      case "sepia": parts.push(`sepia(${fx.intensity})`); break;
      case "blur": parts.push(`blur(${Math.min(20, fx.sigma / 2.5)}px)`); break;
      case "temperature":
        // CSS has no kelvin filter; approximate warm/cool with sepia/hue.
        parts.push(fx.kelvin < 6500 ? `sepia(${Math.min(0.5, (6500 - fx.kelvin) / 8000)})` : `hue-rotate(${Math.min(30, (fx.kelvin - 6500) / 150)}deg)`);
        break;
      case "invert": parts.push("invert(1)"); break;
      case "mirror": transform = "scaleX(-1)"; break;
      default: break; // sharpen/vignette/fades have no cheap CSS twin on <video>
    }
  }
  return { filter: parts.join(" "), transform };
}

/** Preview opacity from fade effects at a local clip time (seconds). */
export function fadeOpacity(clip: Clip, localTime: number): number {
  let opacity = 1;
  for (const fx of clip.effects ?? []) {
    if (fx.type === "fade_in" && fx.duration > 0) {
      opacity = Math.min(opacity, Math.max(0, localTime / fx.duration));
    }
    if (fx.type === "fade_out" && fx.duration > 0) {
      const remain = clipDuration(clip) - localTime;
      opacity = Math.min(opacity, Math.max(0, remain / fx.duration));
    }
  }
  return opacity;
}

/** FFmpeg filter fragments for an effect — mirrors export-engine (Rust). */
export function effectFfmpegFilters(fx: Effect, clipDur: number): { video: string[]; audio: string[] } {
  switch (fx.type) {
    case "adjust":
      return { video: [`eq=brightness=${fx.brightness.toFixed(3)}:contrast=${fx.contrast.toFixed(3)}:saturation=${fx.saturation.toFixed(3)}`], audio: [] };
    case "grayscale": return { video: ["hue=s=0"], audio: [] };
    case "sepia": {
      const sepia = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
      const vals: string[] = [];
      sepia.forEach((row, r) => {
        row.forEach((target, c) => {
          const id = r === c ? 1 : 0;
          vals.push((id + (target - id) * Math.min(1, Math.max(0, fx.intensity))).toFixed(3));
        });
        vals.push("0");
      });
      vals.push("0", "0", "0", "1");
      return { video: [`colorchannelmixer=${vals.join(":")}`], audio: [] };
    }
    case "blur": return { video: [`gblur=sigma=${fx.sigma.toFixed(2)}`], audio: [] };
    case "sharpen": return { video: [`unsharp=5:5:${fx.amount.toFixed(2)}:5:5:0`], audio: [] };
    case "vignette": return { video: [`vignette=angle=${Math.max(0.35, 1.35 - fx.strength).toFixed(3)}`], audio: [] };
    case "temperature": return { video: [`colortemperature=temperature=${fx.kelvin.toFixed(0)}:mix=1`], audio: [] };
    case "mirror": return { video: ["hflip"], audio: [] };
    case "invert": return { video: ["negate"], audio: [] };
    case "reverse": return { video: ["reverse"], audio: ["areverse"] };
    case "fade_in":
      return { video: [`fade=t=in:st=0.000:d=${fx.duration.toFixed(3)}`], audio: [`afade=t=in:st=0.000:d=${fx.duration.toFixed(3)}`] };
    case "fade_out": {
      const st = Math.max(0, clipDur - fx.duration);
      return {
        video: [`fade=t=out:st=${st.toFixed(3)}:d=${fx.duration.toFixed(3)}`],
        audio: [`afade=t=out:st=${st.toFixed(3)}:d=${fx.duration.toFixed(3)}`],
      };
    }
  }
}

export interface Clip {
  id: string;
  source: string; // file name in the browser build, path in the desktop build
  proxy?: string;
  inSec: number;
  outSec: number;
  timelineStart: number;
  speed: number;
  volume: number;
  text?: string;
  fontSize?: number;
  textColor?: string;
  effects?: Effect[];
  transitionIn?: { kind: string; duration: number };
}

export interface Track {
  id: string;
  kind: TrackKind;
  clips: Clip[];
}

export interface Project {
  version: number;
  canvas: { width: number; height: number; fps: number };
  tracks: Track[];
}

export const clipDuration = (c: Clip) =>
  Math.max(0, (c.outSec - c.inSec) / Math.max(0.01, c.speed));
export const clipEnd = (c: Clip) => c.timelineStart + clipDuration(c);

export function projectDuration(p: Project): number {
  return p.tracks.flatMap((t) => t.clips).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function emptyProject(): Project {
  return {
    version: 1,
    canvas: { width: 1080, height: 1920, fps: 30 },
    tracks: [
      { id: "track-video", kind: "video", clips: [] },
      { id: "track-audio", kind: "audio", clips: [] },
      { id: "track-text", kind: "text", clips: [] },
    ],
  };
}

let seq = 0;
export const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Split a clip at an absolute timeline time. Returns the new project or null. */
export function splitClip(p: Project, trackId: string, clipId: string, at: number): Project | null {
  const track = p.tracks.find((t) => t.id === trackId);
  const clip = track?.clips.find((c) => c.id === clipId);
  if (!track || !clip || at <= clip.timelineStart || at >= clipEnd(clip)) return null;
  const splitSource = clip.inSec + (at - clip.timelineStart) * clip.speed;
  const right: Clip = { ...clip, id: newId("clip"), inSec: splitSource, timelineStart: at };
  const next = structuredClone(p);
  const t = next.tracks.find((x) => x.id === trackId)!;
  const idx = t.clips.findIndex((c) => c.id === clipId);
  t.clips[idx] = { ...t.clips[idx], outSec: splitSource };
  t.clips.splice(idx + 1, 0, right);
  return next;
}

/** Serialize to the exact JSON shape editor-core (Rust) reads/writes. */
export function toRustJson(p: Project): string {
  return JSON.stringify(
    {
      version: p.version,
      canvas: p.canvas,
      tracks: p.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        clips: t.clips.map((c) => ({
          id: c.id,
          source: c.source,
          ...(c.proxy ? { proxy: c.proxy } : {}),
          inSec: round(c.inSec),
          outSec: round(c.outSec),
          timelineStart: round(c.timelineStart),
          speed: c.speed,
          volume: c.volume,
          ...(c.text !== undefined ? { text: c.text } : {}),
          ...(c.fontSize !== undefined ? { fontSize: c.fontSize } : {}),
          ...(c.effects && c.effects.length > 0 ? { effects: c.effects } : {}),
          ...(c.transitionIn ? { transitionIn: c.transitionIn } : {}),
          ...(c.textColor ? { textColor: c.textColor } : {}),
        })),
      })),
    },
    null,
    2,
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Build the FFmpeg command for a project — mirrors export-engine (Rust).
 * In the desktop (Tauri) build the same graph runs natively; in a plain
 * browser this command is what the Export panel shows/copies. */
export function buildFfmpegCommand(p: Project, output = "nightcut-export.mp4"): string {
  const video = [...(p.tracks.find((t) => t.kind === "video")?.clips ?? [])]
    .filter((c) => c.source)
    .sort((a, b) => a.timelineStart - b.timelineStart);
  if (video.length === 0) return "# Add a video clip to the timeline first.";
  const { width: w, height: h, fps } = p.canvas;
  const inputs = video.map((c) => `-i "${c.source}"`).join(" ");
  const chains: string[] = [];
  video.forEach((c, i) => {
    const dur = clipDuration(c);
    const vFx = (c.effects ?? []).flatMap((fx) => effectFfmpegFilters(fx, dur).video);
    const aFx = (c.effects ?? []).flatMap((fx) => effectFfmpegFilters(fx, dur).audio);
    chains.push(
      `[${i}:v]${[`trim=start=${c.inSec.toFixed(3)}:end=${c.outSec.toFixed(3)}`, `setpts=(PTS-STARTPTS)/${c.speed}`, `scale=${w}:${h}:force_original_aspect_ratio=decrease`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, `fps=${fps}`, "setsar=1", "format=yuv420p", ...vFx].join(",")}[v${i}]`,
      `[${i}:a]${[`atrim=start=${c.inSec.toFixed(3)}:end=${c.outSec.toFixed(3)}`, "asetpts=PTS-STARTPTS", `atempo=${Math.min(2, Math.max(0.5, c.speed))}`, "aresample=48000", `volume=${c.volume.toFixed(2)}`, ...aFx].join(",")}[a${i}]`,
    );
  });
  // Merge in order: xfade where a clip has a transition, concat otherwise.
  let vcur = "v0";
  let acur = "a0";
  let acc = clipDuration(video[0]);
  video.forEach((c, i) => {
    if (i === 0) return;
    const dur = clipDuration(c);
    const t = c.transitionIn;
    if (t && t.duration > 0 && t.duration < acc && t.duration < dur) {
      chains.push(
        `[${vcur}][v${i}]xfade=transition=${t.kind}:duration=${t.duration.toFixed(3)}:offset=${(acc - t.duration).toFixed(3)}[vx${i}]`,
        `[${acur}][a${i}]acrossfade=d=${t.duration.toFixed(3)}[ax${i}]`,
      );
      vcur = `vx${i}`;
      acur = `ax${i}`;
      acc += dur - t.duration;
    } else {
      chains.push(`[${vcur}][${acur}][v${i}][a${i}]concat=n=2:v=1:a=1[vc${i}][ac${i}]`);
      vcur = `vc${i}`;
      acur = `ac${i}`;
      acc += dur;
    }
  });
  return `ffmpeg -y ${inputs} -filter_complex "${chains.join(";")}" -map "[${vcur}]" -map "[${acur}]" -c:v libx264 -crf 20 -c:a aac -b:a 160k -movflags +faststart "${output}"`;
}
