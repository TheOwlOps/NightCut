import { useEffect, useRef } from "react";
import { useEditor } from "../../store/editor";
import { clipEnd, cssFilterFor, fadeOpacity, projectDuration } from "../../lib/project";

/**
 * Center preview. Phase 0 plays the active video clip through the WebView's
 * hardware-decoded <video> element and renders text clips as an overlay —
 * the same non-destructive data the Rust export engine renders at export.
 */
export default function Preview() {
  const { project, media, playhead, playing, setPlayhead, setPlaying } = useEditor();
  const videoRef = useRef<HTMLVideoElement>(null);

  const videoTrack = project.tracks.find((t) => t.kind === "video");
  const active = videoTrack?.clips.find(
    (c) => playhead >= c.timelineStart && playhead < clipEnd(c),
  );
  const activeMedia = active ? media.find((m) => m.name === active.source) : undefined;
  const activeText = project.tracks
    .find((t) => t.kind === "text")
    ?.clips.filter((c) => playhead >= c.timelineStart && playhead < clipEnd(c));

  // Keep the <video> element in sync with the timeline playhead.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !active) return;
    const target = active.inSec + (playhead - active.timelineStart) * active.speed;
    if (Math.abs(v.currentTime - target) > 0.35) v.currentTime = target;
    if (playing && v.paused) void v.play().catch(() => undefined);
    if (!playing && !v.paused) v.pause();
  }, [playhead, playing, active]);

  const { width, height } = project.canvas;
  return (
    <section className="preview-wrap">
      <div
        className="preview-stage"
        style={{ aspectRatio: `${width} / ${height}`, maxHeight: height > width ? "62vh" : undefined }}
      >
        {activeMedia ? (
          <video
            ref={videoRef}
            src={activeMedia.url}
            className="preview-video"
            style={
              active
                ? {
                    ...cssFilterFor(active),
                    opacity: fadeOpacity(active, playhead - active.timelineStart),
                  }
                : undefined
            }
            playsInline
            onTimeUpdate={(e) => {
              if (!active) return;
              const local = active.timelineStart + (e.currentTarget.currentTime - active.inSec) / active.speed;
              if (Math.abs(local - playhead) > 0.05) setPlayhead(local);
            }}
            onEnded={() => setPlaying(false)}
          />
        ) : (
          <div className="preview-empty">NightCut</div>
        )}
        {activeText?.map((c) => (
          <div key={c.id} className="preview-text" style={{ fontSize: (c.fontSize ?? 64) / 16 }}>
            {c.text}
          </div>
        ))}
      </div>
      <div className="transport">
        <button onClick={() => setPlayhead(0)} title="Back to start">⏮</button>
        <button className="play-btn" onClick={() => setPlaying(!playing)}>
          {playing ? "⏸" : "▶"}
        </button>
        <span className="timecode">
          {formatTime(playhead)} / {formatTime(projectDuration(project))}
        </span>
      </div>
    </section>
  );
}

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 30);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}
