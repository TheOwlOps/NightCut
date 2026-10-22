import { useRef } from "react";
import { useEditor } from "../../store/editor";
import { Clip, clipDuration, projectDuration } from "../../lib/project";
import { formatTime } from "./Preview";

type DragMode =
  | { type: "move"; trackId: string; clipId: string; grabOffset: number }
  | { type: "trim"; trackId: string; clipId: string; edge: "left" | "right" }
  | { type: "scrub" };

/**
 * Bottom timeline. Clips are metadata blocks: dragging/trimming only edits
 * numbers in the project (editor-core semantics), never the media itself.
 * Thumbnails/waveforms arrive with the media-engine cache in Phase 2.
 */
export default function Timeline() {
  const state = useEditor();
  const { project, zoom, playhead, selected } = state;
  const drag = useRef<DragMode | null>(null);
  const tracksRef = useRef<HTMLDivElement>(null);

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
    else if (d.type === "move") state.moveClip(d.trackId, d.clipId, t - d.grabOffset);
    else state.trimClip(d.trackId, d.clipId, d.edge, t);
  };
  const stopDrag = () => (drag.current = null);

  const startClipDrag = (e: React.PointerEvent, trackId: string, clip: Clip, mode: DragMode["type"], edge?: "left" | "right") => {
    e.stopPropagation();
    state.select({ trackId, clipId: clip.id });
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
        <button onClick={state.splitSelected} disabled={!selected} title="Split selected clip at playhead">
          ✂ Split
        </button>
        <button onClick={state.deleteSelected} disabled={!selected} title="Delete selected clip">
          🗑 Delete
        </button>
        <button onClick={() => state.addTextClip("Your text")} title="Add a text clip at the playhead">
          T+ Text
        </button>
        <span className="spacer" />
        <label>
          Zoom{" "}
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
          </div>

          {project.tracks.map((track) => (
            <div key={track.id} className={`track track-${track.kind}`}>
              <div className="track-label">{track.kind}</div>
              {track.clips.map((clip) => {
                const isSel = selected?.clipId === clip.id;
                return (
                  <div
                    key={clip.id}
                    className={`clip clip-${track.kind}${isSel ? " selected" : ""}`}
                    style={{
                      left: clip.timelineStart * zoom,
                      width: Math.max(8, clipDuration(clip) * zoom),
                    }}
                    onPointerDown={(e) => startClipDrag(e, track.id, clip, "move")}
                    title={clip.text ?? clip.source}
                  >
                    <span
                      className="trim-handle left"
                      onPointerDown={(e) => startClipDrag(e, track.id, clip, "trim", "left")}
                    />
                    <span className="clip-name">{clip.text ?? clip.source}</span>
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
    </section>
  );
}
