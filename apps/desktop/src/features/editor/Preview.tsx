import { useEffect, useRef } from "react";
import { useEditor } from "../../store/editor";
import {
  clipEnd, cssFilterFor, fadeOpacity, interpKeyframes, playedAtSource, projectDuration,
  sourceAtPlayed,
} from "../../lib/project";

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
  // sourceAtPlayed handles constant speed, speed curves and freeze frames.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !active) return;
    const local = playhead - active.timelineStart;
    const target = sourceAtPlayed(active, local);
    if (Math.abs(v.currentTime - target) > 0.35) v.currentTime = target;
    // Approximate the curve's current speed with the element's playbackRate.
    if (active.speedCurve && active.speedCurve.length > 0) {
      const ahead = sourceAtPlayed(active, local + 0.1) - target;
      v.playbackRate = Math.min(4, Math.max(0.25, ahead / 0.1));
    } else {
      v.playbackRate = active.speed;
    }
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
                ? (() => {
                    const local = playhead - active.timelineStart;
                    const fxCss = cssFilterFor(active);
                    const kf = interpKeyframes(active, local);
                    const transform = [
                      fxCss.transform,
                      `scale(${kf.scale})`,
                      `translate(${kf.posX * 100}%, ${kf.posY * 100}%)`,
                      `rotate(${kf.rotation}deg)`,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return {
                      filter: fxCss.filter,
                      transform,
                      opacity: fadeOpacity(active, local) * kf.opacity,
                    };
                  })()
                : undefined
            }
            playsInline
            onTimeUpdate={(e) => {
              if (!active) return;
              const local = active.timelineStart + playedAtSource(active, e.currentTarget.currentTime);
              if (Math.abs(local - playhead) > 0.05) setPlayhead(local);
            }}
            onEnded={() => setPlaying(false)}
          />
        ) : (
          <div className="preview-empty">NightCut</div>
        )}
        {activeText && activeText.length > 0 && (
          <div className="preview-text-stack">
            {activeText.map((c) => (
              <div
                key={c.id}
                className="preview-text"
                style={{ fontSize: (c.fontSize ?? 64) / 16, color: c.textColor ?? "#ffffff" }}
              >
                {c.text}
              </div>
            ))}
          </div>
        )}
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
