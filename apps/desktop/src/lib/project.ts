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
  | { type: "reverse" }
  | { type: "chroma_key"; color: string; similarity: number; blend: number }
  | { type: "denoise"; strength: number }
  | { type: "mask"; shape: string; size: number; feather: number; invert: boolean }
  | { type: "stabilize"; smoothing: number }
  | { type: "pitch_shift"; semitones: number }
  | { type: "lut"; path: string }
  | { type: "loudnorm"; targetLufs: number }
  | { type: "video_denoise"; strength: number }
  | {
      type: "curves";
      master: string;
      red: string;
      green: string;
      blue: string;
    }
  | {
      type: "color_wheels";
      shadows: [number, number, number];
      midtones: [number, number, number];
      highlights: [number, number, number];
    }
  | { type: "hsl"; shifts: [number, number, number][] }
  | { type: "deflicker"; size: number };

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
  chroma_key: "Chroma key (green screen)",
  denoise: "Noise reduction (audio)",
  mask: "Mask (shape)",
  stabilize: "Stabilize",
  pitch_shift: "Pitch shift",
  lut: "LUT (.cube)",
  loudnorm: "Loudness normalization",
  video_denoise: "Video denoise",
  curves: "Curves (brighten)",
  color_wheels: "Color wheels (warm)",
  hsl: "HSL (per-range)",
  deflicker: "Deflicker",
};

export interface SpeedPoint {
  at: number; // fraction 0..1 of the source window
  speed: number;
}

export interface Keyframe {
  at: number; // seconds into the clip's played duration
  scale: number;
  posX: number;
  posY: number;
  rotation: number; // degrees
  opacity: number;
}

export const SPEED_CURVE_PRESETS: { name: string; points: SpeedPoint[] }[] = [
  { name: "Ramp up", points: [{ at: 0, speed: 0.5 }, { at: 0.5, speed: 1 }, { at: 0.8, speed: 2 }] },
  { name: "Ramp down", points: [{ at: 0, speed: 2 }, { at: 0.5, speed: 1 }, { at: 0.8, speed: 0.5 }] },
  { name: "Hero moment (slow middle)", points: [{ at: 0, speed: 1.5 }, { at: 0.35, speed: 0.4 }, { at: 0.65, speed: 1.5 }] },
  { name: "Montage (fast middle)", points: [{ at: 0, speed: 0.8 }, { at: 0.3, speed: 3 }, { at: 0.7, speed: 0.8 }] },
];

/** Played duration of a clip with a speed curve: sum of segment durations. */
export function curveDuration(clip: Clip): number | null {
  if (!clip.speedCurve || clip.speedCurve.length === 0) return null;
  const srcLen = Math.max(0, clip.outSec - clip.inSec);
  const pts = [...clip.speedCurve].sort((a, b) => a.at - b.at);
  let total = 0;
  pts.forEach((p, i) => {
    const start = Math.min(1, Math.max(0, p.at));
    const end = i + 1 < pts.length ? Math.min(1, Math.max(0, pts[i + 1].at)) : 1;
    if (end > start) total += (srcLen * (end - start)) / Math.max(0.01, p.speed);
  });
  return total;
}

/** Map played (timeline-local) time to source time for any clip. */
export function sourceAtPlayed(clip: Clip, played: number): number {
  if (clip.freezeDuration !== undefined) return clip.inSec;
  if (!clip.speedCurve || clip.speedCurve.length === 0) {
    return clip.inSec + played * clip.speed;
  }
  const srcLen = clip.outSec - clip.inSec;
  const pts = [...clip.speedCurve].sort((a, b) => a.at - b.at);
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const start = Math.min(1, Math.max(0, pts[i].at));
    const end = i + 1 < pts.length ? Math.min(1, Math.max(0, pts[i + 1].at)) : 1;
    if (end <= start) continue;
    const segPlayed = (srcLen * (end - start)) / Math.max(0.01, pts[i].speed);
    if (played <= acc + segPlayed) {
      return clip.inSec + srcLen * start + (played - acc) * pts[i].speed;
    }
    acc += segPlayed;
  }
  return clip.outSec;
}

/** Inverse of sourceAtPlayed: played local time for a source time. */
export function playedAtSource(clip: Clip, source: number): number {
  if (clip.freezeDuration !== undefined) return 0;
  if (!clip.speedCurve || clip.speedCurve.length === 0) {
    return (source - clip.inSec) / Math.max(0.01, clip.speed);
  }
  const srcLen = clip.outSec - clip.inSec;
  const pts = [...clip.speedCurve].sort((a, b) => a.at - b.at);
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const start = Math.min(1, Math.max(0, pts[i].at));
    const end = i + 1 < pts.length ? Math.min(1, Math.max(0, pts[i + 1].at)) : 1;
    if (end <= start) continue;
    const segSrcStart = clip.inSec + srcLen * start;
    const segSrcEnd = clip.inSec + srcLen * end;
    if (source <= segSrcEnd) {
      return acc + (source - segSrcStart) / Math.max(0.01, pts[i].speed);
    }
    acc += (srcLen * (end - start)) / Math.max(0.01, pts[i].speed);
  }
  return acc;
}

/** Interpolated keyframe transform at a played local time (preview + UI). */
export function interpKeyframes(clip: Clip, played: number): Keyframe {
  const base: Keyframe = { at: played, scale: 1, posX: 0, posY: 0, rotation: 0, opacity: 1 };
  const kfs = [...(clip.keyframes ?? [])].sort((a, b) => a.at - b.at);
  if (kfs.length === 0) return base;
  if (played <= kfs[0].at) return { ...kfs[0], at: played };
  if (played >= kfs[kfs.length - 1].at) return { ...kfs[kfs.length - 1], at: played };
  for (let i = 0; i + 1 < kfs.length; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (played >= a.at && played <= b.at) {
      const t = b.at === a.at ? 0 : (played - a.at) / (b.at - a.at);
      const lerp = (x: number, y: number) => x + (y - x) * t;
      return {
        at: played,
        scale: lerp(a.scale, b.scale),
        posX: lerp(a.posX, b.posX),
        posY: lerp(a.posY, b.posY),
        rotation: lerp(a.rotation, b.rotation),
        opacity: lerp(a.opacity, b.opacity),
      };
    }
  }
  return base;
}

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
    case "chroma_key": return { type, color: "#00ff00", similarity: 0.3, blend: 0.1 };
    case "denoise": return { type, strength: 0.5 };
    case "mask": return { type, shape: "circle", size: 0.7, feather: 0.2, invert: false };
    case "stabilize": return { type, smoothing: 10 };
    case "pitch_shift": return { type, semitones: 4 };
    case "lut": return { type, path: "" };
    case "loudnorm": return { type, targetLufs: -14 };
    case "video_denoise": return { type, strength: 0.5 };
    case "curves": return { type, master: "0/0 0.5/0.62 1/1", red: "", green: "", blue: "" };
    case "color_wheels":
      return { type, shadows: [0.08, 0, -0.08], midtones: [0, 0, 0], highlights: [0.06, 0.03, -0.04] };
    case "hsl":
      return { type, shifts: Array.from({ length: 8 }, () => [0, 0, 0] as [number, number, number]) };
    case "deflicker": return { type, size: 5 };
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
    case "chroma_key":
      return { video: [`chromakey=color=0x${fx.color.replace("#", "")}:similarity=${fx.similarity.toFixed(3)}:blend=${fx.blend.toFixed(3)}`], audio: [] };
    case "denoise":
      return { video: [], audio: [`afftdn=nr=${(1 + Math.min(1, Math.max(0, fx.strength)) * 40).toFixed(1)}`] };
    case "fade_in":
      return { video: [`fade=t=in:st=0.000:d=${fx.duration.toFixed(3)}`], audio: [`afade=t=in:st=0.000:d=${fx.duration.toFixed(3)}`] };
    case "fade_out": {
      const st = Math.max(0, clipDur - fx.duration);
      return {
        video: [`fade=t=out:st=${st.toFixed(3)}:d=${fx.duration.toFixed(3)}`],
        audio: [`afade=t=out:st=${st.toFixed(3)}:d=${fx.duration.toFixed(3)}`],
      };
    }
    case "mask":
    case "stabilize":
      // No direct filter: mask renders via the matte, stabilize via the
      // two-pass vidstab flow (see buildFfmpegCommand / export-engine).
      return { video: [], audio: [] };
    case "pitch_shift":
      return { video: [], audio: [`rubberband=pitch=${Math.pow(2, Math.min(12, Math.max(-12, fx.semitones)) / 12).toFixed(4)}`] };
    case "lut":
      return { video: [`lut3d=file='${fx.path.replace(/'/g, "\\'")}'`], audio: [] };
    case "loudnorm":
      return { video: [], audio: [`loudnorm=I=${fx.targetLufs.toFixed(1)}:TP=-1.5:LRA=11`] };
    case "video_denoise": {
      const s = Math.min(1, Math.max(0, fx.strength));
      return { video: [`hqdn3d=${(2 + s * 8).toFixed(1)}:${(2 + s * 8).toFixed(1)}:${(3 + s * 10).toFixed(1)}:${(3 + s * 10).toFixed(1)}`], audio: [] };
    }
    case "curves": {
      const parts: string[] = [];
      if (fx.master) parts.push(`master='${fx.master}'`);
      if (fx.red) parts.push(`red='${fx.red}'`);
      if (fx.green) parts.push(`green='${fx.green}'`);
      if (fx.blue) parts.push(`blue='${fx.blue}'`);
      return { video: parts.length ? [`curves=${parts.join(":")}`] : [], audio: [] };
    }
    case "color_wheels": {
      const n = (v: number) => Math.min(1, Math.max(-1, v)).toFixed(2);
      const [rs, gs, bs] = fx.shadows.map(n);
      const [rm, gm, bm] = fx.midtones.map(n);
      const [rh, gh, bh] = fx.highlights.map(n);
      return { video: [`colorbalance=rs=${rs}:gs=${gs}:bs=${bs}:rm=${rm}:gm=${gm}:bm=${bm}:rh=${rh}:gh=${gh}:bh=${bh}`], audio: [] };
    }
    case "deflicker":
      return { video: [`deflicker=size=${Math.round(Math.min(30, Math.max(2, fx.size)))}:mode=pm`], audio: [] };
    case "hsl":
      // The .cube LUT is generated by the Rust export engine from the
      // same shifts (this TS mirror runs no file IO).
      return { video: [], audio: [] };
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
  /** Caption pill background (#RRGGBB) — drawn as a box behind the text. */
  textBg?: string;
  /** Glow halo color (#rrggbb) drawn as a thick outline at export. */
  textGlow?: string;
  /** Drop shadow on text clips. */
  textShadow?: boolean;
  effects?: Effect[];
  transitionIn?: { kind: string; duration: number };
  speedCurve?: SpeedPoint[];
  keyframes?: Keyframe[];
  freezeDuration?: number;
  /** Smooth slow motion (motion interpolation under 1x). */
  smoothSlowmo?: boolean;
  /** PiP placement on overlay tracks: width fraction + position along
   * the free space (0 = top-left, 1 = bottom-right). */
  overlayScale?: number;
  overlayX?: number;
  overlayY?: number;
  /** Text vertical position: fraction of the free space (0=top, 1=bottom). */
  textY?: number;
  /** Overlay blend mode ("screen", "multiply", ...); unset = normal. */
  blendMode?: string;
}

export interface Track {
  id: string;
  kind: TrackKind;
  clips: Clip[];
  muted?: boolean;
  hidden?: boolean;
  locked?: boolean;
}

export interface Project {
  version: number;
  /** Display name, editable in the top bar (CapCut-style). */
  name?: string;
  canvas: { width: number; height: number; fps: number };
  tracks: Track[];
  /** Timeline markers (seconds) — beat detection results. */
  markers?: number[];
  /** Canvas fill for clips not covering the frame: "black" | "blur". */
  canvasFill?: string;
}

export const clipDuration = (c: Clip) => {
  if (c.freezeDuration !== undefined) return Math.max(0, c.freezeDuration);
  return curveDuration(c) ?? Math.max(0, (c.outSec - c.inSec) / Math.max(0.01, c.speed));
};
export const clipEnd = (c: Clip) => c.timelineStart + clipDuration(c);

export function projectDuration(p: Project): number {
  return p.tracks.flatMap((t) => t.clips).reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function emptyProject(): Project {
  return {
    version: 1,
    name: "Untitled project",
    canvas: { width: 1080, height: 1920, fps: 30 },
    tracks: [
      { id: "track-video", kind: "video", clips: [] },
      { id: "track-overlay", kind: "video", clips: [] },
      { id: "track-audio", kind: "audio", clips: [] },
      { id: "track-text", kind: "text", clips: [] },
    ],
    markers: [],
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
  const splitSource = sourceAtPlayed(clip, at - clip.timelineStart);
  // Splitting invalidates curve/freeze/keyframe semantics (they refer to
  // the whole clip) — both halves fall back to constant speed, as in Rust.
  const right: Clip = {
    ...clip, id: newId("clip"), inSec: splitSource, timelineStart: at,
    speedCurve: undefined, freezeDuration: undefined, keyframes: undefined,
  };
  const next = structuredClone(p);
  const t = next.tracks.find((x) => x.id === trackId)!;
  const idx = t.clips.findIndex((c) => c.id === clipId);
  t.clips[idx] = {
    ...t.clips[idx], outSec: splitSource,
    speedCurve: undefined, freezeDuration: undefined, keyframes: undefined,
  };
  t.clips.splice(idx + 1, 0, right);
  return next;
}

/** Serialize to the exact JSON shape editor-core (Rust) reads/writes. */
export function toRustJson(p: Project): string {
  return JSON.stringify(
    {
      version: p.version,
      ...(p.name ? { name: p.name } : {}),
      canvas: p.canvas,
      tracks: p.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        ...(t.muted ? { muted: true } : {}),
        ...(t.hidden ? { hidden: true } : {}),
        ...(t.locked ? { locked: true } : {}),
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
          ...(c.effects && c.effects.length > 0
            ? {
                effects: c.effects.map((fx) =>
                  fx.type === "loudnorm" ? { type: "loudnorm", target_lufs: fx.targetLufs } : fx,
                ),
              }
            : {}),
          ...(c.transitionIn ? { transitionIn: c.transitionIn } : {}),
          ...(c.textColor ? { textColor: c.textColor } : {}),
          ...(c.textBg ? { textBg: c.textBg } : {}),
          ...(c.textShadow ? { textShadow: true } : {}),
          ...(c.textGlow ? { textGlow: c.textGlow } : {}),
          ...(c.speedCurve ? { speedCurve: c.speedCurve } : {}),
          ...(c.keyframes && c.keyframes.length > 0 ? { keyframes: c.keyframes } : {}),
          ...(c.freezeDuration !== undefined ? { freezeDuration: c.freezeDuration } : {}),
          ...(c.smoothSlowmo ? { smoothSlowmo: true } : {}),
          ...(c.overlayScale !== undefined ? { overlayScale: c.overlayScale } : {}),
          ...(c.overlayX !== undefined ? { overlayX: c.overlayX } : {}),
          ...(c.overlayY !== undefined ? { overlayY: c.overlayY } : {}),
          ...(c.textY !== undefined ? { textY: c.textY } : {}),
          ...(c.blendMode ? { blendMode: c.blendMode } : {}),
        })),
      })),
      ...((p.markers?.length ?? 0) > 0 ? { markers: p.markers } : {}),
      ...(p.canvasFill ? { canvas_fill: p.canvasFill } : {}),
    },
    null,
    2,
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Build the FFmpeg command for a project — mirrors export-engine (Rust).
 * In the desktop (Tauri) build the same graph runs natively; in a plain
 * browser this command is what the Export panel shows/copies. */
function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = Math.max(0.01, speed);
  while (s > 2) { out.push("atempo=2.000"); s /= 2; }
  while (s < 0.5) { out.push("atempo=0.500"); s /= 0.5; }
  out.push(`atempo=${s.toFixed(3)}`);
  return out;
}

function piecewise(points: [number, number][], varName: string): string {
  if (points.length === 0) return "0";
  if (points.length === 1) return points[0][1].toFixed(4);
  const [t0, v0] = points[0];
  const [t1, v1] = points[1];
  const seg = t1 === t0 ? v1.toFixed(4) : `${v0.toFixed(4)}+(${v1.toFixed(4)}-${v0.toFixed(4)})*(${varName}-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)}`;
  if (points.length === 2) return `if(lt(${varName},${t1.toFixed(3)}),${seg},${v1.toFixed(4)})`;
  return `if(lt(${varName},${t1.toFixed(3)}),${seg},${piecewise(points.slice(1), varName)})`;
}

function keyframeFiltersTs(c: Clip, w: number, h: number, fps: number): string[] {
  const kfs = [...(c.keyframes ?? [])].sort((a, b) => a.at - b.at);
  if (kfs.length === 0) return [];
  const out: string[] = [];
  const scaleVaries = kfs.some((k) => Math.abs(k.scale - kfs[0].scale) > 0.001) || Math.abs(kfs[0].scale - 1) > 0.001;
  const posVaries = kfs.some((k) => Math.abs(k.posX) > 0.001 || Math.abs(k.posY) > 0.001);
  if (scaleVaries || posVaries) {
    const z = piecewise(kfs.map((k) => [k.at * fps, Math.max(1, k.scale)] as [number, number]), "on");
    const x = piecewise(kfs.map((k) => [k.at * fps, k.posX] as [number, number]), "on");
    const y = piecewise(kfs.map((k) => [k.at * fps, k.posY] as [number, number]), "on");
    out.push(`zoompan=z='${z}':x='(iw-iw/zoom)/2+(${x})*(iw/zoom)':y='(ih-ih/zoom)/2+(${y})*(ih/zoom)':d=1:s=${w}x${h}:fps=${fps}`);
  }
  if (kfs.some((k) => Math.abs(k.rotation) > 0.01)) {
    const r = piecewise(kfs.map((k) => [k.at, (k.rotation * Math.PI) / 180] as [number, number]), "t");
    out.push(`rotate=a='${r}':ow=iw:oh=ih:c=black`);
  }
  return out;
}

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
    const hasChroma = (c.effects ?? []).some((fx) => fx.type === "chroma_key");
    // Combined matte (opacity curve x shape mask), mirroring export-engine.
    const maskFx = (c.effects ?? []).find((fx) => fx.type === "mask");
    const kfsSorted = [...(c.keyframes ?? [])].sort((a, b) => a.at - b.at);
    const opExpr = kfsSorted.some((k) => k.opacity < 0.999)
      ? piecewise(kfsSorted.map((k) => [k.at, Math.min(1, Math.max(0, k.opacity))] as [number, number]), "T")
      : null;
    let maskExpr: string | null = null;
    if (maskFx && maskFx.type === "mask") {
      const size = Math.min(1, Math.max(0.05, maskFx.size));
      const featherPx = Math.max(1, Math.min(1, Math.max(0, maskFx.feather)) * Math.min(w, h) * 0.5);
      const sd = maskFx.shape === "circle"
        ? `hypot(X-W/2,H/2-Y)-${(Math.min(w, h) * size / 2).toFixed(1)}`
        : `max(abs(X-W/2)-${(w * size / 2).toFixed(1)},abs(Y-H/2)-${(h * size / 2).toFixed(1)})`;
      const v = `min(1,max(0,0.5-(${sd})/${featherPx.toFixed(1)}))`;
      maskExpr = maskFx.invert ? `(1-(${v}))` : v;
    }
    const matte = opExpr && maskExpr ? `(${opExpr})*(${maskExpr})` : opExpr ?? maskExpr;
    const needsAlpha = hasChroma || matte !== null;
    const baseFmt = hasChroma ? "format=rgba" : "format=yuv420p";
    const scalePad = [
      `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
      `fps=${fps}`,
      "setsar=1",
      baseFmt,
    ];
    // step 1: base streams [vb{i}] / [ab{i}]
    if (c.freezeDuration !== undefined) {
      const fd = c.freezeDuration;
      chains.push(
        `[${i}:v]${[`trim=start=${c.inSec.toFixed(3)}:end=${(c.inSec + 0.1).toFixed(3)}`, "setpts=PTS-STARTPTS", ...scalePad, `tpad=stop_mode=clone:stop_duration=${fd.toFixed(3)}`, `trim=duration=${fd.toFixed(3)}`, "setpts=PTS-STARTPTS"].join(",")}[vb${i}]`,
        `anullsrc=r=48000:cl=stereo,atrim=duration=${fd.toFixed(3)}[ab${i}]`,
      );
    } else if (c.speedCurve && c.speedCurve.length > 0) {
      const pts = [...c.speedCurve].sort((a, b) => a.at - b.at);
      const srcLen = Math.max(0, c.outSec - c.inSec);
      const segs = pts
        .map((pt, j) => ({
          start: Math.min(1, Math.max(0, pt.at)),
          end: j + 1 < pts.length ? Math.min(1, Math.max(0, pts[j + 1].at)) : 1,
          speed: Math.max(0.01, pt.speed),
        }))
        .filter((s) => s.end > s.start);
      segs.forEach((s, j) => {
        const sIn = c.inSec + srcLen * s.start;
        const sOut = c.inSec + srcLen * s.end;
        chains.push(
          `[${i}:v]${[`trim=start=${sIn.toFixed(3)}:end=${sOut.toFixed(3)}`, `setpts=(PTS-STARTPTS)/${s.speed.toFixed(3)}`, ...scalePad].join(",")}[vb${i}s${j}]`,
          `[${i}:a]${[`atrim=start=${sIn.toFixed(3)}:end=${sOut.toFixed(3)}`, "asetpts=PTS-STARTPTS", ...atempoChain(s.speed), "aresample=48000", `volume=${c.volume.toFixed(2)}`].join(",")}[ab${i}s${j}]`,
        );
      });
      chains.push(
        `${segs.map((_, j) => `[vb${i}s${j}]`).join("")}concat=n=${segs.length}:v=1:a=0[vb${i}]`,
        `${segs.map((_, j) => `[ab${i}s${j}]`).join("")}concat=n=${segs.length}:v=0:a=1[ab${i}]`,
      );
    } else {
      chains.push(
        `[${i}:v]${[`trim=start=${c.inSec.toFixed(3)}:end=${c.outSec.toFixed(3)}`, `setpts=(PTS-STARTPTS)/${c.speed}`, ...scalePad].join(",")}[vb${i}]`,
        `[${i}:a]${[`atrim=start=${c.inSec.toFixed(3)}:end=${c.outSec.toFixed(3)}`, "asetpts=PTS-STARTPTS", `atempo=${Math.min(2, Math.max(0.5, c.speed))}`, "aresample=48000", `volume=${c.volume.toFixed(2)}`].join(",")}[ab${i}]`,
      );
    }
    // step 2: stabilize, keyframes, matte, video effects -> [v{i}]
    let vlabel = `vb${i}`;
    const stabFx = (c.effects ?? []).find((fx) => fx.type === "stabilize");
    if (stabFx && stabFx.type === "stabilize") {
      // The desktop render runs vidstabdetect first and substitutes the
      // real transforms path (see export-engine render()).
      chains.push(
        `[${vlabel}]vidstabtransform=input='transforms/${c.id}.trf':smoothing=${stabFx.smoothing}:optalgo=gauss,unsharp=5:5:0.8:3:3:0.4[vst${i}]`,
      );
      vlabel = `vst${i}`;
    }
    keyframeFiltersTs(c, w, h, fps).forEach((f, step) => {
      const next = `vk${i}_${step}`;
      chains.push(`[${vlabel}]${f}[${next}]`);
      vlabel = next;
    });
    if (matte !== null) {
      chains.push(
        `color=c=black:s=${w}x${h}:r=${fps}:d=${dur.toFixed(3)},format=gray,geq=lum='255*(${matte})'[vam${i}]`,
      );
    }
    if (matte !== null && !hasChroma) {
      chains.push(`[${vlabel}][vam${i}]alphamerge[va${i}]`);
      vlabel = `va${i}`;
    }
    const vFx = (c.effects ?? []).flatMap((fx) => effectFfmpegFilters(fx, dur).video);
    if (vFx.length > 0) {
      chains.push(`[${vlabel}]${vFx.join(",")}[ve${i}]`);
      vlabel = `ve${i}`;
    }
    if (matte !== null && hasChroma) {
      chains.push(`[${vlabel}][vam${i}]alphamerge[va${i}]`);
      vlabel = `va${i}`;
    }
    if (needsAlpha) {
      chains.push(
        `color=c=black:s=${w}x${h}:r=${fps}:d=${dur.toFixed(3)}[vbg${i}]`,
        `[vbg${i}][${vlabel}]overlay=0:0,format=yuv420p[v${i}]`,
      );
    } else {
      chains.push(`[${vlabel}]format=yuv420p[v${i}]`);
    }
    // step 3: audio effects -> [a{i}]
    const aFx = (c.effects ?? []).flatMap((fx) => effectFfmpegFilters(fx, dur).audio);
    chains.push(aFx.length > 0 ? `[ab${i}]${aFx.join(",")}[a${i}]` : `[ab${i}]anull[a${i}]`);
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
