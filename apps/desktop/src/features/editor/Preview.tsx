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
  const [showScopes, setShowScopes] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const histRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const vecRef = useRef<HTMLCanvasElement>(null);

  // Scopes: sample the actual preview frame and draw histogram,
  // luma waveform and vectorscope — the same trio CapCut shows.
  useEffect(() => {
    if (!showScopes) return;
    let stop = false;
    const sample = () => {
      if (stop) return;
      const v = videoRef.current;
      const hc = histRef.current, wc = waveRef.current, vc = vecRef.current;
      if (v && hc && wc && vc && v.readyState >= 2 && v.videoWidth > 0) {
        try { drawScopes(v, hc, wc, vc); } catch { /* tainted frame */ }
      }
    };
    sample();
    const id = setInterval(sample, 180);
    return () => { stop = true; clearInterval(id); };
  }, [showScopes, playhead]);

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
        {activeOverlay && overlayMedia && (() => {
          const overlayStyle = {
            position: "absolute" as const,
            width: `${(activeOverlay.overlayScale ?? 0.35) * 100}%`,
            left: `${(activeOverlay.overlayX ?? 0.9) * (1 - (activeOverlay.overlayScale ?? 0.35)) * 100}%`,
            top: `${(activeOverlay.overlayY ?? 0.9) * (1 - (activeOverlay.overlayScale ?? 0.35) * (height / Math.max(1, width))) * 100}%`,
            borderRadius: 6,
            boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
            pointerEvents: "none" as const,
            ...(activeOverlay.blendMode
              ? { mixBlendMode: activeOverlay.blendMode as React.CSSProperties["mixBlendMode"] }
              : {}),
          };
          return overlayMedia.kind === "image" ? (
            <img src={overlayMedia.url} alt="" style={overlayStyle} />
          ) : (
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
              style={overlayStyle}
            />
          );
        })()}
        {activeText && activeText.length > 0 && (
          <>
            {activeText.filter((c) => c.textY === undefined).length > 0 && (
              <div className="preview-text-stack">
                {activeText.filter((c) => c.textY === undefined).map((c) => (
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
                  ...(c.textGlow ? { textShadow: `0 0 0.3em ${c.textGlow}, 0 0 0.65em ${c.textGlow}` } : {}),
                    }}
                  >
                    {c.text}
                  </div>
                ))}
              </div>
            )}
            {activeText.filter((c) => c.textY !== undefined).map((c) => (
              <div
                key={c.id}
                className="preview-text"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  textAlign: "center",
                  top: `${(c.textY ?? 0) * 100}%`,
                  transform: `translateY(-${(c.textY ?? 0) * 100}%)`,
                  fontSize: (c.fontSize ?? 64) / 16,
                  color: c.textColor ?? "#ffffff",
                  pointerEvents: "none",
                  ...(c.textBg
                    ? {
                        background: `${c.textBg}cc`,
                        padding: "0.1em 0.45em",
                        borderRadius: "0.35em",
                      }
                    : {}),
                  ...(c.textShadow ? { textShadow: "0.08em 0.08em 0.15em rgba(0,0,0,0.85)" } : {}),
                  ...(c.textGlow ? { textShadow: `0 0 0.3em ${c.textGlow}, 0 0 0.65em ${c.textGlow}` } : {}),
                }}
              >
                {c.text}
              </div>
            ))}
          </>
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
          className={showScopes ? "chip active" : "chip"}
          title="Scopes: histogram, waveform and vectorscope of the current frame"
          onClick={() => setShowScopes(!showScopes)}
        >
          Scopes
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
      {showScopes && (
        <div className="scopes-row">
          <div className="scope-box">
            <span>Histogram</span>
            <canvas ref={histRef} width={176} height={84} />
          </div>
          <div className="scope-box">
            <span>Waveform</span>
            <canvas ref={waveRef} width={176} height={84} />
          </div>
          <div className="scope-box">
            <span>Vectorscope</span>
            <canvas ref={vecRef} width={120} height={84} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Draw histogram / luma waveform / vectorscope of a video frame. */
export function drawScopes(v: HTMLVideoElement, hist: HTMLCanvasElement, wave: HTMLCanvasElement, vec: HTMLCanvasElement) {
  const W = 96, H = 54;
  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const octx = off.getContext("2d");
  if (!octx) return;
  octx.drawImage(v, 0, 0, W, H);
  const data = octx.getImageData(0, 0, W, H).data;

  // Histogram (per-channel, log-scaled so small peaks stay visible).
  const hctx = hist.getContext("2d");
  if (hctx) {
    const bins = [new Float32Array(64), new Float32Array(64), new Float32Array(64)];
    for (let i = 0; i < data.length; i += 4) {
      bins[0][data[i] >> 2]++;
      bins[1][data[i + 1] >> 2]++;
      bins[2][data[i + 2] >> 2]++;
    }
    hctx.fillStyle = "#0b0f14";
    hctx.fillRect(0, 0, hist.width, hist.height);
    const colors = ["rgba(239,68,68,0.75)", "rgba(34,197,94,0.75)", "rgba(59,130,246,0.75)"];
    bins.forEach((bin, ch) => {
      const max = Math.log1p(Math.max(...bin));
      hctx.fillStyle = colors[ch];
      for (let x = 0; x < 64; x++) {
        const hgt = (Math.log1p(bin[x]) / Math.max(1, max)) * hist.height;
        hctx.fillRect((x / 64) * hist.width, hist.height - hgt, hist.width / 64, hgt);
      }
    });
  }

  // Waveform: per-column luma min/max envelope, green phosphor style.
  const wctx = wave.getContext("2d");
  if (wctx) {
    wctx.fillStyle = "#0b0f14";
    wctx.fillRect(0, 0, wave.width, wave.height);
    wctx.fillStyle = "rgba(0,224,189,0.8)";
    for (let x = 0; x < W; x++) {
      let mn = 255, mx = 0;
      for (let y = 0; y < H; y++) {
        const i = (y * W + x) * 4;
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (luma < mn) mn = luma;
        if (luma > mx) mx = luma;
      }
      const px = (x / W) * wave.width;
      const yTop = wave.height - (mx / 255) * wave.height;
      const yBot = wave.height - (mn / 255) * wave.height;
      wctx.fillRect(px, yTop, Math.max(1, wave.width / W), Math.max(1, yBot - yTop));
    }
  }

  // Vectorscope: Cb/Cr scatter around the center.
  const vctx = vec.getContext("2d");
  if (vctx) {
    vctx.fillStyle = "#0b0f14";
    vctx.fillRect(0, 0, vec.width, vec.height);
    vctx.strokeStyle = "rgba(255,255,255,0.25)";
    vctx.beginPath();
    vctx.arc(vec.width / 2, vec.height / 2, vec.height / 2 - 2, 0, Math.PI * 2);
    vctx.stroke();
    vctx.fillStyle = "rgba(0,224,189,0.5)";
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const cb = (-0.14713 * r - 0.28886 * g + 0.436 * b) * 1.6;
      const cr = (0.615 * r - 0.51499 * g - 0.10001 * b) * 1.6;
      const x = vec.width / 2 + cb * (vec.height / 2 - 2) * 1.4;
      const y = vec.height / 2 - cr * (vec.height / 2 - 2) * 1.4;
      vctx.fillRect(x, y, 1.5, 1.5);
    }
  }
}

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 30);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}
