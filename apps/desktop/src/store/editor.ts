import { create } from "zustand";
import {
  Clip,
  Effect,
  Keyframe,
  Project,
  SpeedPoint,
  clipDuration,
  clipEnd,
  defaultEffect,
  emptyProject,
  interpKeyframes,
  newId,
  parseSrt,
  projectDuration,
  sourceAtPlayed,
  splitClip,
} from "../lib/project";

export interface MediaItem {
  id: string;
  name: string;
  url: string; // object URL (browser) or asset URL (desktop) for preview
  duration: number;
  kind: "video" | "audio";
  /** Real filesystem path in the desktop build (native import). Needed
   * for probing, proxies and auto-captions; absent for browser blobs. */
  path?: string;
  /** Captured poster frame (data URL) shown on timeline clips. */
  thumb?: string;
  /** Low-res proxy file (desktop): path + preview URL for smooth scrubbing. */
  proxyPath?: string;
  proxyUrl?: string;
}

interface Selection {
  trackId: string;
  clipId: string;
}

interface EditorState {
  project: Project;
  media: MediaItem[];
  selected: Selection | null;
  playhead: number; // seconds
  playing: boolean;
  zoom: number; // px per second
  past: Project[];
  future: Project[];
  addMedia: (item: MediaItem) => void;
  addToTimeline: (mediaId: string) => void;
  addTextClip: (text: string, style?: { fontSize: number; color: string }) => void;
  addCaptionsFromSrt: (content: string) => number;
  addCaptionCues: (cues: { start: number; end: number; text: string }[], offset: number) => number;
  addAudioAtPlayhead: (mediaId: string) => void;
  setMediaThumb: (mediaId: string, thumb: string) => void;
  setMediaProxy: (mediaId: string, proxyPath: string, proxyUrl: string) => void;
  toggleTrack: (trackId: string, flag: "muted" | "hidden" | "locked") => void;
  applyFilterPreset: (effects: Effect[]) => void;
  applyTransition: (kind: string) => void;
  setSelectedSpeed: (speed: number) => void;
  setSelectedVolume: (volume: number) => void;
  setSelectedTransitionDuration: (duration: number) => void;
  removeSelectedTransition: () => void;
  setSelectedTextStyle: (patch: {
    fontSize?: number;
    textColor?: string;
    textBg?: string;
    textShadow?: boolean;
  }) => void;
  setSpeedCurve: (points: SpeedPoint[] | null) => void;
  addKeyframeAtPlayhead: () => void;
  /** Set beat markers (seconds) — view/edit state, no history entry. */
  setMarkers: (markers: number[]) => void;
  setProjectName: (name: string) => void;
  /** Apply a named animation preset (keyframes) to the selected clip. */
  applyAnimationPreset: (name: string) => void;
  setSelectedSmoothSlowmo: (on: boolean) => void;
  /** Replace the selected clip's keyframes wholesale (motion tracking). */
  setSelectedKeyframes: (kfs: import("../lib/project").Keyframe[]) => void;
  /** Add a media item as a PiP overlay clip at the playhead. */
  addOverlayClip: (mediaId: string) => void;
  setSelectedOverlay: (patch: { overlayScale?: number; overlayX?: number; overlayY?: number }) => void;
  updateKeyframe: (index: number, patch: Partial<Keyframe>) => void;
  removeKeyframe: (index: number) => void;
  freezeAtPlayhead: () => void;
  applyTemplate: (kind: "hook" | "intro" | "tutorial") => void;
  select: (sel: Selection | null) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (b: boolean) => void;
  setZoom: (z: number) => void;
  moveClip: (trackId: string, clipId: string, start: number) => void;
  trimClip: (trackId: string, clipId: string, edge: "left" | "right", at: number) => void;
  splitSelected: () => void;
  deleteSelected: () => void;
  updateSelectedText: (text: string) => void;
  addEffect: (type: Effect["type"]) => void;
  removeEffect: (index: number) => void;
  updateEffect: (index: number, effect: Effect) => void;
  setCanvas: (preset: "9:16" | "16:9" | "1:1" | { w: number; h: number }) => void;
  loadProject: (p: Project) => void;
  undo: () => void;
  redo: () => void;
}

/** Snapshot history — edits are metadata-only so snapshots are cheap. */
function withHistory(s: EditorState, next: Project): Partial<EditorState> {
  return { project: next, past: [...s.past.slice(-49), s.project], future: [] };
}

export const useEditor = create<EditorState>((set, get) => ({
  project: emptyProject(),
  media: [],
  selected: null,
  playhead: 0,
  playing: false,
  zoom: 48,
  past: [],
  future: [],

  addMedia: (item) => {
    set((s) => ({ media: [...s.media, item] }));
    get().addToTimeline(item.id);
  },

  addToTimeline: (mediaId) => {
    const s = get();
    const item = s.media.find((m) => m.id === mediaId);
    if (!item) return;
    const trackId = item.kind === "video" ? "track-video" : "track-audio";
    const track = s.project.tracks.find((t) => t.id === trackId)!;
    const start = track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    const clip: Clip = {
      id: newId("clip"),
      // Desktop clips reference the real path (export resolves it 1:1);
      // browser clips reference the file name.
      source: item.path ?? item.name,
      inSec: 0,
      outSec: item.duration,
      timelineStart: start,
      speed: 1,
      volume: 1,
    };
    const next = structuredClone(s.project);
    next.tracks.find((t) => t.id === trackId)!.clips.push(clip);
    set({ ...withHistory(s, next), selected: { trackId, clipId: clip.id } });
  },

  addTextClip: (text, style) => {
    const s = get();
    const clip: Clip = {
      id: newId("text"),
      source: "",
      inSec: 0,
      outSec: 3,
      timelineStart: s.playhead,
      speed: 1,
      volume: 1,
      text,
      fontSize: style?.fontSize ?? 64,
      textColor: style?.color ?? "#ffffff",
    };
    const next = structuredClone(s.project);
    next.tracks.find((t) => t.id === "track-text")!.clips.push(clip);
    set({ ...withHistory(s, next), selected: { trackId: "track-text", clipId: clip.id } });
  },

  addCaptionsFromSrt: (content) => {
    const cues = parseSrt(content);
    if (cues.length === 0) return 0;
    const s = get();
    const next = structuredClone(s.project);
    const track = next.tracks.find((t) => t.id === "track-text")!;
    for (const cue of cues) {
      // A caption is a text clip whose local window is [0, cue length] and
      // whose timeline position is the cue start (clipDuration semantics).
      track.clips.push({
        id: newId("caption"),
        source: "",
        inSec: 0,
        outSec: Math.max(0.5, cue.end - cue.start),
        timelineStart: cue.start,
        speed: 1,
        volume: 1,
        text: cue.text,
        fontSize: 48,
        textColor: "#ffffff",
      });
    }
    track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
    set(withHistory(s, next));
    return cues.length;
  },

  addCaptionCues: (cues, offset) => {
    if (cues.length === 0) return 0;
    const s = get();
    const next = structuredClone(s.project);
    const track = next.tracks.find((t) => t.id === "track-text")!;
    for (const cue of cues) {
      track.clips.push({
        id: newId("caption"),
        source: "",
        inSec: 0,
        outSec: Math.max(0.5, cue.end - cue.start),
        timelineStart: offset + cue.start,
        speed: 1,
        volume: 1,
        text: cue.text,
        fontSize: 48,
        textColor: "#ffffff",
      });
    }
    track.clips.sort((a, b) => a.timelineStart - b.timelineStart);
    set(withHistory(s, next));
    return cues.length;
  },

  addAudioAtPlayhead: (mediaId) => {
    const s = get();
    const item = s.media.find((m) => m.id === mediaId);
    if (!item) return;
    const clip: Clip = {
      id: newId("clip"),
      source: item.path ?? item.name,
      inSec: 0,
      outSec: item.duration,
      timelineStart: s.playhead,
      speed: 1,
      volume: 1,
    };
    const next = structuredClone(s.project);
    next.tracks.find((t) => t.id === "track-audio")!.clips.push(clip);
    set({
      ...withHistory(s, next),
      selected: { trackId: "track-audio", clipId: clip.id },
    });
  },

  toggleTrack: (trackId, flag) => {
    const s = get();
    const next = structuredClone(s.project);
    const track = next.tracks.find((t) => t.id === trackId);
    if (!track) return;
    track[flag] = !track[flag];
    set({ project: next });
  },

  setMediaThumb: (mediaId, thumb) => {
    set({ media: get().media.map((m) => (m.id === mediaId ? { ...m, thumb } : m)) });
  },

  setMediaProxy: (mediaId, proxyPath, proxyUrl) => {
    set({ media: get().media.map((m) => (m.id === mediaId ? { ...m, proxyPath, proxyUrl } : m)) });
  },

  applyFilterPreset: (effects) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip) return;
    clip.effects = [...(clip.effects ?? []), ...structuredClone(effects)];
    set(withHistory(s, next));
  },

  applyTransition: (kind) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const track = next.tracks.find((t) => t.id === s.selected!.trackId);
    const clip = track?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip || !track || track.clips[0]?.id === clip.id) return;
    clip.transitionIn = { kind, duration: 0.5 };
    set(withHistory(s, next));
  },

  setSelectedSpeed: (speed) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (clip) clip.speed = Math.min(4, Math.max(0.25, speed));
    set(withHistory(s, next));
  },

  setSelectedVolume: (volume) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (clip) clip.volume = Math.min(2, Math.max(0, volume));
    set(withHistory(s, next));
  },

  setSelectedTransitionDuration: (duration) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (clip?.transitionIn) clip.transitionIn.duration = Math.min(3, Math.max(0.1, duration));
    set(withHistory(s, next));
  },

  removeSelectedTransition: () => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (clip) delete clip.transitionIn;
    set(withHistory(s, next));
  },

  setSelectedTextStyle: (patch) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip) return;
    if (patch.fontSize !== undefined) clip.fontSize = patch.fontSize;
    if (patch.textColor !== undefined) clip.textColor = patch.textColor;
    if (patch.textBg !== undefined) {
      if (patch.textBg) clip.textBg = patch.textBg;
      else delete clip.textBg;
    }
    if (patch.textShadow !== undefined) clip.textShadow = patch.textShadow;
    set(withHistory(s, next));
  },

  select: (sel) => set({ selected: sel }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (b) => set({ playing: b }),
  setZoom: (z) => set({ zoom: Math.min(240, Math.max(12, z)) }),

  moveClip: (trackId, clipId, start) => {
    const s = get();
    const next = structuredClone(s.project);
    const clip = next.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    if (!clip) return;
    clip.timelineStart = Math.max(0, start);
    set(withHistory(s, next));
  },

  trimClip: (trackId, clipId, edge, at) => {
    const s = get();
    const next = structuredClone(s.project);
    const clip = next.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
    if (!clip || clip.text !== undefined) return;
    if (edge === "left") {
      const delta = Math.min(Math.max(at, clip.timelineStart) - clip.timelineStart, (clip.outSec - clip.inSec) - 0.1);
      clip.inSec += delta;
      clip.timelineStart += delta;
    } else {
      const end = Math.max(clip.timelineStart + 0.1, Math.min(at, clip.timelineStart + (clip.outSec - clip.inSec)));
      clip.outSec = clip.inSec + (end - clip.timelineStart);
    }
    set(withHistory(s, next));
  },

  splitSelected: () => {
    const s = get();
    if (!s.selected) return;
    const next = splitClip(s.project, s.selected.trackId, s.selected.clipId, s.playhead);
    if (next) set(withHistory(s, next));
  },

  deleteSelected: () => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const track = next.tracks.find((t) => t.id === s.selected!.trackId)!;
    track.clips = track.clips.filter((c) => c.id !== s.selected!.clipId);
    set({ ...withHistory(s, next), selected: null });
  },

  updateSelectedText: (text) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (clip) clip.text = text;
    set(withHistory(s, next));
  },

  addEffect: (type) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip) return;
    clip.effects = [...(clip.effects ?? []), defaultEffect(type)];
    set(withHistory(s, next));
  },

  removeEffect: (index) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip?.effects) return;
    clip.effects = clip.effects.filter((_, i) => i !== index);
    set(withHistory(s, next));
  },

  updateEffect: (index, effect) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip?.effects) return;
    clip.effects = clip.effects.map((fx, i) => (i === index ? effect : fx));
    set(withHistory(s, next));
  },

  setSpeedCurve: (points) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip) return;
    if (points) clip.speedCurve = points;
    else delete clip.speedCurve;
    set(withHistory(s, next));
  },

  addKeyframeAtPlayhead: () => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip || clip.text !== undefined) return;
    const local = Math.max(0, s.playhead - clip.timelineStart);
    const current = interpKeyframes(clip, local);
    const kf: Keyframe = { ...current, at: Math.round(local * 100) / 100 };
    clip.keyframes = [...(clip.keyframes ?? []).filter((k) => Math.abs(k.at - kf.at) > 0.01), kf]
      .sort((a, b) => a.at - b.at);
    set(withHistory(s, next));
  },

  updateKeyframe: (index, patch) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip?.keyframes?.[index]) return;
    clip.keyframes[index] = { ...clip.keyframes[index], ...patch };
    clip.keyframes.sort((a, b) => a.at - b.at);
    set(withHistory(s, next));
  },

  removeKeyframe: (index) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip?.keyframes) return;
    clip.keyframes = clip.keyframes.filter((_, i) => i !== index);
    set(withHistory(s, next));
  },

  setMarkers: (markers) => set({ project: { ...get().project, markers } }),
  setProjectName: (name: string) => set({ project: { ...get().project, name } }),

  addOverlayClip: (mediaId) => {
    const s = get();
    const item = s.media.find((m) => m.id === mediaId);
    if (!item || item.kind !== "video") return;
    const next = structuredClone(s.project);
    let track = next.tracks.find((t) => t.id === "track-overlay");
    if (!track) {
      track = { id: "track-overlay", kind: "video", clips: [] };
      next.tracks.splice(1, 0, track);
    }
    const clip: Clip = {
      id: newId("clip"),
      source: item.path ?? item.name,
      inSec: 0,
      outSec: item.duration,
      timelineStart: Math.round(s.playhead * 100) / 100,
      speed: 1,
      volume: 1,
      overlayScale: 0.35,
      overlayX: 0.9,
      overlayY: 0.9,
    };
    track.clips.push(clip);
    set({
      ...withHistory(s, next),
      selected: { trackId: "track-overlay", clipId: clip.id },
    });
  },

  setSelectedOverlay: (patch) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip) return;
    Object.assign(clip, patch);
    set(withHistory(s, next));
  },

  setSelectedKeyframes: (kfs) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip) return;
    clip.keyframes = [...kfs].sort((a, b) => a.at - b.at);
    set(withHistory(s, next));
  },

  setSelectedSmoothSlowmo: (on) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip) return;
    clip.smoothSlowmo = on;
    set(withHistory(s, next));
  },

  applyAnimationPreset: (name) => {
    const s = get();
    if (!s.selected) return;
    const next = structuredClone(s.project);
    const clip = next.tracks
      .find((t) => t.id === s.selected!.trackId)
      ?.clips.find((c) => c.id === s.selected!.clipId);
    if (!clip || clip.text !== undefined) return;
    const dur = Math.max(0.2, (clip.outSec - clip.inSec) / Math.max(0.05, clip.speed));
    const base = { scale: 1, posX: 0, posY: 0, rotation: 0, opacity: 1 };
    const mid = Math.min(0.6, dur / 2);
    const presets: Record<string, Keyframe[]> = {
      "Zoom in": [
        { ...base, at: 0 },
        { ...base, at: dur, scale: 1.35 },
      ],
      "Zoom out": [
        { ...base, at: 0, scale: 1.35 },
        { ...base, at: dur },
      ],
      "Fade in": [
        { ...base, at: 0, opacity: 0 },
        { ...base, at: mid, opacity: 1 },
      ],
      "Slide in": [
        { ...base, at: 0, posX: -0.6, opacity: 0 },
        { ...base, at: mid, opacity: 1 },
      ],
      "Spin in": [
        { ...base, at: 0, rotation: -30, scale: 0.6, opacity: 0 },
        { ...base, at: mid, opacity: 1 },
      ],
      "Pulse": [
        { ...base, at: 0 },
        { ...base, at: dur * 0.25, scale: 1.12 },
        { ...base, at: dur * 0.5 },
        { ...base, at: dur * 0.75, scale: 1.12 },
        { ...base, at: dur },
      ],
    };
    const kfs = presets[name];
    if (!kfs) return;
    clip.keyframes = kfs;
    set(withHistory(s, next));
  },

  freezeAtPlayhead: () => {
    const s = get();
    const track = s.project.tracks.find((t) => t.id === "track-video");
    const clip = track?.clips.find(
      (c) => s.playhead >= c.timelineStart && s.playhead < clipEnd(c) && c.freezeDuration === undefined,
    );
    if (!track || !clip) return;
    const FREEZE_LEN = 2;
    // Split at the playhead first (same semantics as the Split tool)…
    let next = splitClip(s.project, track.id, clip.id, s.playhead) ?? structuredClone(s.project);
    const t = next.tracks.find((x) => x.id === track.id)!;
    // …then shift everything from the playhead onward to make room…
    for (const c of t.clips) {
      if (c.timelineStart >= s.playhead - 1e-9) c.timelineStart += FREEZE_LEN;
    }
    // …and insert the freeze clip holding the frame at the playhead.
    const sourceTime = sourceAtPlayed(clip, s.playhead - clip.timelineStart);
    const freeze: Clip = {
      id: newId("freeze"),
      source: clip.source,
      inSec: Math.round(sourceTime * 1000) / 1000,
      outSec: Math.round(sourceTime * 1000) / 1000,
      timelineStart: s.playhead,
      speed: 1,
      volume: 0,
      freezeDuration: FREEZE_LEN,
    };
    t.clips.push(freeze);
    t.clips.sort((a, b) => a.timelineStart - b.timelineStart);
    set({
      ...withHistory(s, next),
      selected: { trackId: track.id, clipId: freeze.id },
    });
  },

  applyTemplate: (kind) => {
    const s = get();
    const next = structuredClone(s.project);
    const textTrack = next.tracks.find((t) => t.id === "track-text")!;
    const dur = projectDuration(next);
    const addText = (text: string, start: number, len: number, fontSize: number, color: string) => {
      textTrack.clips.push({
        id: newId("text"), source: "", inSec: 0, outSec: len, timelineStart: start,
        speed: 1, volume: 1, text, fontSize, textColor: color,
      });
    };
    if (kind === "hook") {
      next.canvas = { width: 1080, height: 1920, fps: 30 };
      addText("STOP scrolling!", 0, 3, 110, "#ffe14d");
      if (dur > 6) addText("Watch till the end →", Math.max(3, dur - 3), 3, 56, "#ffffff");
    } else if (kind === "intro") {
      addText("Your Channel", 0, 2.5, 110, "#ffffff");
      addText("new video every week", 0, 3, 48, "#22d3ee");
    } else {
      addText("Step 1:", s.playhead, 3, 72, "#ffe14d");
      addText("do this first", s.playhead, 3, 48, "#ffffff");
    }
    textTrack.clips.sort((a, b) => a.timelineStart - b.timelineStart);
    set({ ...withHistory(s, next), project: next });
  },

  setCanvas: (preset) => {
    const s = get();
    const next = structuredClone(s.project);
    next.canvas =
      typeof preset === "object"
        ? { width: preset.w, height: preset.h, fps: 30 }
        : preset === "9:16"
          ? { width: 1080, height: 1920, fps: 30 }
          : preset === "16:9"
            ? { width: 1920, height: 1080, fps: 30 }
            : { width: 1080, height: 1080, fps: 30 };
    set({ project: next });
  },

  loadProject: (p) => set({ project: p, past: [], future: [], selected: null, playhead: 0 }),

  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({ project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future] });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({ project: next, future: s.future.slice(1), past: [...s.past, s.project] });
  },
}));

export const useProjectDuration = () => useEditor((s) => projectDuration(s.project));
