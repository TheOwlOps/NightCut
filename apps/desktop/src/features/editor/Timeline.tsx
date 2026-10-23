import { useRef, useState } from "react";
import { useEditor } from "../../store/editor";
import Waveform from "./Waveform";
import {
  IconUndo, IconRedo, IconSplit, IconTrash, IconText, IconFreeze,
  IconMagnet, IconFit, IconFilm, IconAudio, IconEye, IconEyeOff,
  IconVolume, IconVolumeX, IconLock, IconUnlock,
} from "./Icons";
import { Clip, clipDuration, projectDuration } from "../../lib/project";
import { formatTime } from "./Preview";

type DragMode =
  | { type: "move"; trackId: string; clipId: string; grabOffset: number }
  | { type: "trim"; trackId: string; clipId: string; edge: "left" | "right" }
  | { type: "scrub" };

/**
 * Bottom timeline. Clips are metadata blocks: dragging/trimming only edits
 * numbers in the project (editor-core semantics), never the media itself.
 * Video clips show a captured poster frame; audio/video clips show a
 * WebAudio-decoded waveform strip.
 */
export default function Timeline() {
  const state = useEditor();
  const { project, zoom, playhead, selected } = state;
  const selectedClip = selected
    ? project.tracks.find((t) => t.id === selected.trackId)?.clips.find((c) => c.id === selected.clipId)
    : undefined;
  const inMulti = (trackId: string, clipId: string) =>
    state.multiSel.some((x) => x.trackId === trackId && x.clipId === clipId);
  const drag = useRef<DragMode | null>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState(true);

  /** Magnet snapping (CapCut's main-track magnet): pull a time to the
   * nearest clip edge or the playhead when within 0.3s. */
  const snapTime = (t: number) => {
    if (!snap) return t;
    const points = [playhead, ...(project.markers ?? [])];
    for (const track of project.tracks)
      for (const c of track.clips) points.push(c.timelineStart, c.timelineStart + (c.outSec - c.inSec) / c.speed);
    let best = t;
    let bestDist = 0.3;
    for (const p of points) {
      const d = Math.abs(p - t);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  };

  const duration = Math.max(30, projectDuration(project) + 5);
  const width = duration * zoom;

  const timeAt = (clientX: number) => {
    const rect = tracksRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + tracksRef.current!.scrollLeft) / zoom);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(e.clientX);
    if (d.type === "scrub") state.setPlayhead(t);
    else if (d.type === "move") state.moveClip(d.trackId, d.clipId, snapTime(t - d.grabOffset));
    else state.trimClip(d.trackId, d.clipId, d.edge, snapTime(t));
  };
  const stopDrag = () => (drag.current = null);

  const rowHeight = (kind: string) => (kind === "video" ? 56 : kind === "audio" ? 40 : 30);

  const startClipDrag = (e: React.PointerEvent, trackId: string, clip: Clip, mode: DragMode["type"], edge?: "left" | "right") => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && state.selected) {
      state.toggleMultiSel({ trackId, clipId: clip.id });
      return;
    }
    state.select({ trackId, clipId: clip.id });
    if (project.tracks.find((t) => t.id === trackId)?.locked) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (mode === "move") {
      drag.current = { type: "move", trackId, clipId: clip.id, grabOffset: timeAt(e.clientX) - clip.timelineStart };
    } else {
      drag.current = { type: "trim", trackId, clipId: clip.id, edge: edge! };
    }
  };

  return (
    <section className="timeline" onPointerMove={onPointerMove} onPointerUp={stopDrag}>
      <div className="timeline-toolbar">
        <button className="tool-btn" onClick={state.undo} disabled={state.past.length === 0} title="Undo (Ctrl+Z)">
          <IconUndo size={18} />
        </button>
        <button className="tool-btn" onClick={state.redo} disabled={state.future.length === 0} title="Redo (Ctrl+Y)">
          <IconRedo size={18} />
        </button>
        <span className="tool-sep" />
        <button className="tool-btn" onClick={state.splitSelected} disabled={!selected} title="Split selected clip at playhead (Ctrl+B)">
          <IconSplit size={18} />
        </button>
        <button className="tool-btn" onClick={state.deleteSelected} disabled={!selected} title="Delete selected clip">
          <IconTrash size={18} />
        </button>
        <button className="tool-btn" onClick={() => state.addTextClip("Your text")} title="Add a text clip at the playhead">
          <IconText size={18} />
        </button>
        <button className="tool-btn" onClick={state.freezeAtPlayhead} title="Freeze the frame at the playhead for 2s (CapCut Freeze)">
          <IconFreeze size={18} />
        </button>
        <button
          className="tool-btn txt"
          onClick={state.createCompound}
          disabled={!selected}
          title="Compound: group the selected clips (Ctrl+click to add more) into one nested clip"
        >
          🧩 Compound{state.multiSel.length > 0 ? ` (${state.multiSel.length + 1})` : ""}
        </button>
        {selectedClip?.compoundId && (
          <button className="tool-btn txt" onClick={state.uncompoundSelected} title="Uncompound: restore the nested clips">
            Ungroup
          </button>
        )}
        <button
          className={snap ? "tool-btn active" : "tool-btn"}
          onClick={() => setSnap(!snap)}
          title="Magnet: snap clips to edges and the playhead"
        >
          <IconMagnet size={18} />
        </button>
        <span className="spacer" />
        <button
          className="tool-btn"
          onClick={() => {
            const el = tracksRef.current;
            if (el) state.setZoom(Math.max(8, Math.floor(el.clientWidth / duration)));
          }}
          title="Fit the whole project to the visible width"
        >
          <IconFit size={18} />
        </button>
        <label className="zoom-label">
          <input
            type="range"
            min={12}
            max={240}
            value={zoom}
            onChange={(e) => state.setZoom(Number(e.target.value))}
          />
        </label>
        <span className="timecode">{formatTime(playhead)}</span>
      </div>

      <div className="timeline-body">
        <div className="track-headers">
          <div className="ruler-spacer" />
          {project.tracks.map((track) => (
            <div key={track.id} className="track-header" style={{ height: rowHeight(track.kind) }}>
              <span className="th-icon">
                {track.kind === "video" ? <IconFilm size={15} /> : track.kind === "audio" ? <IconAudio size={15} /> : <IconText size={15} />}
              </span>
              <button
                className={track.hidden ? "off" : ""}
                title={track.hidden ? "Show track" : "Hide track (preview)"}
                onClick={() => state.toggleTrack(track.id, "hidden")}
              >
                {track.hidden ? <IconEyeOff /> : <IconEye />}
              </button>
              <button
                className={track.muted ? "off" : ""}
                title={track.muted ? "Unmute track" : "Mute track"}
                onClick={() => state.toggleTrack(track.id, "muted")}
              >
                {track.muted ? <IconVolumeX /> : <IconVolume />}
              </button>
              <button
                className={track.locked ? "" : "off"}
                title={track.locked ? "Unlock track" : "Lock track"}
                onClick={() => state.toggleTrack(track.id, "locked")}
              >
                {track.locked ? <IconLock /> : <IconUnlock />}
              </button>
            </div>
          ))}
        </div>

        <div className="timeline-scroll" ref={tracksRef}>
          <div className="timeline-inner" style={{ width }}>
            <div
              className="ruler"
              onPointerDown={(e) => {
                drag.current = { type: "scrub" };
                state.setPlayhead(timeAt(e.clientX));
              }}
            >
              {Array.from({ length: Math.ceil(duration) + 1 }, (_, s) => (
                <span key={s} className="tick" style={{ left: s * zoom }}>
                  {s % 5 === 0 ? `${s}s` : ""}
                </span>
              ))}
              {(project.markers ?? []).map((m, i) => (
                <span key={`mk${i}`} className="beat-marker" style={{ left: m * zoom }} title={`Beat ${m.toFixed(2)}s`} />
              ))}
            </div>

            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={`track track-${track.kind}${track.hidden ? " dim" : ""}`}
                style={{ height: rowHeight(track.kind) }}
              >
                {track.clips.map((clip) => {
                  const isSel = selected?.clipId === clip.id;
                  const item = state.media.find(
                    (m) => m.path === clip.source || m.name === clip.source,
                  );
                  const dur = clipDuration(clip);
                  return (
                    <div
                      key={clip.id}
                      className={`clip clip-${track.kind}${isSel ? " selected" : ""}${clip.freezeDuration !== undefined ? " frozen" : ""}${clip.compoundId ? " compound" : ""}${inMulti(track.id, clip.id) ? " in-multi" : ""}`}
                      style={{
                        left: clip.timelineStart * zoom,
                        width: Math.max(8, dur * zoom),
                        height: rowHeight(track.kind) - 8,
                      }}
                      onPointerDown={(e) => startClipDrag(e, track.id, clip, "move")}
                      title={clip.text ?? clip.source}
                    >
                      <span
                        className="trim-handle left"
                        onPointerDown={(e) => startClipDrag(e, track.id, clip, "trim", "left")}
                      />
                      {item?.thumb && track.kind === "video" && (
                        <span
                          className="clip-filmstrip"
                          style={{ backgroundImage: `url(${item.thumb})` }}
                        />
                      )}
                      {clip.compoundId && <span className="clip-badge">🧩</span>}
                      {clip.transitionIn && <span className="clip-badge">⇄</span>}
                      {clip.freezeDuration !== undefined && <span className="clip-badge">❄</span>}
                      <span className="clip-name">{clip.text ?? clip.source}</span>
                      {item && track.kind === "audio" && (
                        <Waveform url={item.url} color="#4ade80" />
                      )}
                      {item && track.kind === "video" && (
                        <Waveform url={item.url} color="rgba(120,180,255,0.55)" />
                      )}
                      {(clip.keyframes?.length ?? 0) > 0 && dur > 0 && (
                        <span className="clip-kfs">
                          {clip.keyframes!.map((kf, ki) => (
                            <i key={ki} style={{ left: `${(kf.at / dur) * 100}%` }}>◆</i>
                          ))}
                        </span>
                      )}
                      <span
                        className="trim-handle right"
                        onPointerDown={(e) => startClipDrag(e, track.id, clip, "trim", "right")}
                      />
                    </div>
                  );
                })}
              </div>
            ))}

            <div className="playhead" style={{ left: playhead * zoom }} />
          </div>
        </div>
      </div>
    </section>
  );
}
