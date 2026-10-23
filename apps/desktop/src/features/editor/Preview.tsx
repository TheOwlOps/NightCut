import { useEffect, useRef, useState } from "react";
import { useEditor } from "../../store/editor";
import { IconPlay, IconPause, IconPrev, IconFullscreen } from "./Icons";
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
  const { project, media, playhead, playing, setPlayhead, setPlaying, setCanvas } = useEditor();
  const [proxyMode, setProxyMode] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const videoTrack = project.tracks.find((t) => t.kind === "video");
  const textTrack = project.tracks.find((t) => t.kind === "text");
  const active = videoTrack?.hidden
    ? undefined
    : videoTrack?.clips.find(
        (c) => playhead >= c.timelineStart && playhead < clipEnd(c),
      );
  const activeMedia = active
    ? media.find((m) => m.path === active.source || m.name === active.source)
    : undefined;
  const activeText = textTrack?.hidden
    ? []
    : textTrack?.clips.filter((c) => playhead >= c.timelineStart && playhead < clipEnd(c));
  const overlayTrack = project.tracks.find((t) => t.id === "track-overlay");
  const activeOverlay = overlayTrack?.hidden
    ? undefined
    : overlayTrack?.clips.find((c) => playhead >= c.timelineStart && playhead < clipEnd(c));
  const overlayMedia = activeOverlay
    ? media.find((m) => m.path === activeOverlay.source || m.name === activeOverlay.source)
    : undefined;

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
            src={proxyMode && activeMedia.proxyUrl ? activeMedia.proxyUrl : activeMedia.url}
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
        {activeOverlay && overlayMedia && (
          <video
            src={overlayMedia.url}
            muted
            playsInline
            ref={(el) => {
              if (el && activeOverlay) {
                const t = activeOverlay.inSec + (playhead - activeOverlay.timelineStart) * activeOverlay.speed;
                if (Math.abs(el.currentTime - t) > 0.4) el.currentTime = t;
                if (playing) void el.play().catch(() => {});
                else el.pause();
              }
            }}
            style={{
              position: "absolute",
              width: `${(activeOverlay.overlayScale ?? 0.35) * 100}%`,
              left: `${(activeOverlay.overlayX ?? 0.9) * (1 - (activeOverlay.overlayScale ?? 0.35)) * 100}%`,
              top: `${(activeOverlay.overlayY ?? 0.9) * (1 - (activeOverlay.overlayScale ?? 0.35) * (height / Math.max(1, width))) * 100}%`,
              borderRadius: 6,
              boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
        )}
        {activeText && activeText.length > 0 && (
          <div className="preview-text-stack">
            {activeText.map((c) => (
              <div
                key={c.id}
                className="preview-text"
                style={{
                  fontSize: (c.fontSize ?? 64) / 16,
                  color: c.textColor ?? "#ffffff",
                  ...(c.textBg
                    ? {
                        background: `${c.textBg}cc`,
                        padding: "0.1em 0.45em",
                        borderRadius: "0.35em",
                      }
                    : {}),
                  ...(c.textShadow ? { textShadow: "0.08em 0.08em 0.15em rgba(0,0,0,0.85)" } : {}),
                }}
              >
                {c.text}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="player-bar">
        <div className="transport">
          <button className="play-btn ghost" onClick={() => setPlayhead(0)} title="Back to start"><IconPrev /></button>
          <button className="play-btn" onClick={() => setPlaying(!playing)} title={playing ? "Pause (Space)" : "Play (Space)"}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <span className="timecode">
            <b>{formatTime(playhead)}</b> / {formatTime(projectDuration(project))}
          </span>
        </div>
        <span className="spacer" />
        <div className="aspect-group" title="Canvas aspect ratio">
          {([
            { label: "9:16", w: 1080, h: 1920 },
            { label: "16:9", w: 1920, h: 1080 },
            { label: "1:1", w: 1080, h: 1080 },
            { label: "4:3", w: 1440, h: 1080 },
          ]).map((p) => (
            <button
              key={p.label}
              className={project.canvas.width === p.w && project.canvas.height === p.h ? "active" : ""}
              onClick={() => setCanvas(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          className={proxyMode ? "chip active" : "chip"}
          title="Proxy mode: preview from the low-res proxy for smooth scrubbing (export always uses the original)"
          onClick={() => setProxyMode(!proxyMode)}
        >
          Proxy
        </button>
        <button
          className="play-btn ghost"
          title="Fullscreen preview"
          onClick={() => {
            const el = document.querySelector(".preview-stage");
            if (el) void el.requestFullscreen?.();
          }}
        >
          <IconFullscreen size={19} />
        </button>
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
