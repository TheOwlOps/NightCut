import { create } from "zustand";
import {
  Clip,
  Effect,
  Project,
  clipEnd,
  defaultEffect,
  emptyProject,
  newId,
  parseSrt,
  projectDuration,
  splitClip,
} from "../lib/project";

export interface MediaItem {
  id: string;
  name: string;
  url: string; // object URL for preview playback
  duration: number;
  kind: "video" | "audio";
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
  applyFilterPreset: (effects: Effect[]) => void;
  applyTransition: (kind: string) => void;
  setSelectedSpeed: (speed: number) => void;
  setSelectedVolume: (volume: number) => void;
  setSelectedTransitionDuration: (duration: number) => void;
  removeSelectedTransition: () => void;
  setSelectedTextStyle: (patch: { fontSize?: number; textColor?: string }) => void;
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
  setCanvas: (preset: "9:16" | "16:9" | "1:1") => void;
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
      source: item.name,
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

  setCanvas: (preset) => {
    const s = get();
    const next = structuredClone(s.project);
    next.canvas =
      preset === "9:16"
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
