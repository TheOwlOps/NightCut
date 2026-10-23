import { useEffect, useRef, useState } from "react";
import { useEditor } from "../../store/editor";
import { newId } from "../../lib/project";

/** Screen recorder (desktop): ffmpeg captures the display via the
 * platform backend; the finished MP4 imports straight into the bin. */
function ScreenRecorder({ onRecorded }: { onRecorded: (path: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState("");
  const outRef = useRef<string>("");

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const toggle = async () => {
    try {
      if (!recording) {
        const dir = await tauriInvoke<string>("nightcut_cache_dir");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        outRef.current = `${dir}/screen-${stamp}.mp4`;
        await tauriInvoke("start_screen_record", { output: outRef.current });
        setElapsed(0);
        setRecording(true);
        setNote("Recording the screen — NightCut is capturing this display.");
      } else {
        const out = await tauriInvoke<string>("stop_screen_record", { output: outRef.current });
        setRecording(false);
        setNote("Recording saved and added to the media bin.");
        onRecorded(out);
      }
    } catch (err) {
      setRecording(false);
      setNote(`Screen recording failed: ${String(err)}`);
    }
  };

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <div className="field">
      <button className={recording ? "danger" : ""} onClick={() => void toggle()}>
        {recording ? `⏹ Stop recording (${mm}:${ss})` : "⏺ Record screen"}
      </button>
      {note && <p className="status">{note}</p>}
    </div>
  );
}

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = () =>
  typeof window !== "undefined" && (window.__TAURI_INTERNALS__ !== undefined || window.__TAURI__ !== undefined);

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/** Capture a poster frame from a video element as a small data URL. */
function captureThumb(video: HTMLVideoElement, onDone: (dataUrl: string) => void) {
  const seekTo = Math.min(0.6, (video.duration || 1) / 2);
  const handler = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 54;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, 96, 54);
        onDone(canvas.toDataURL("image/jpeg", 0.6));
      }
    } catch {
      /* poster capture is best-effort */
    }
    video.removeEventListener("seeked", handler);
  };
  video.addEventListener("seeked", handler);
  try {
    video.currentTime = seekTo;
  } catch {
    /* ignore */
  }
}

/** Left panel: imported media. Desktop imports keep real file paths
 * (native picker) so probing/proxies/auto-captions work; the browser
 * build uses object URLs only. */
export default function MediaBin() {
  const { media, addMedia, addToTimeline, setMediaThumb, addOverlayClip } = useEditor();
  const fileRef = useRef<HTMLInputElement>(null);

  const importBlobs = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file);
      if (file.type.startsWith("image")) {
        // Still image: becomes an overlay (logo / Elements art), 5s default.
        const id = newId("media");
        addMedia({ id, name: file.name, url, duration: 5, kind: "image" });
        setMediaThumb(id, url);
        continue;
      }
      const kind = file.type.startsWith("audio") ? "audio" : "video";
      const probe = document.createElement(kind === "audio" ? "audio" : "video");
      probe.preload = "auto";
      probe.muted = true;
      const id = newId("media");
      probe.onloadedmetadata = () => {
        addMedia({ id, name: file.name, url, duration: probe.duration || 0, kind });
        if (kind === "video") {
          captureThumb(probe as HTMLVideoElement, (thumb) => setMediaThumb(id, thumb));
        }
      };
      probe.src = url;
    }
  };

  const importNative = async () => {
    const paths = await tauriInvoke<string[]>("pick_media_files");
    for (const path of paths) {
      await importOnePath(path);
    }
  };

  const importOnePath = async (path: string) => {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const name = path.split(/[\\/]/).pop() ?? path;
    const kind = /\.(mp3|wav|m4a|aac|ogg)$/i.test(name)
      ? "audio"
      : /\.(png|jpe?g|webp|bmp)$/i.test(name)
        ? "image"
        : "video";
    const id = newId("media");
    const url = convertFileSrc(path);
    if (kind === "image") {
      // Still image: 5s overlay by default; the file itself is the thumb.
      addMedia({ id, name, url, duration: 5, kind, path });
      setMediaThumb(id, url);
      return;
    }
    let duration = 0;
    try {
      const info = await tauriInvoke<{ duration: number }>("probe_media", { path });
      duration = info.duration || 0;
    } catch {
      /* probing is best-effort; duration refines on export */
    }
    addMedia({ id, name, url, duration, kind, path });
    if (kind === "video") {
      // Generate a low-res proxy in the background for smooth scrubbing
      // (CapCut's proxy mode); preview can toggle to it.
      const proxyOut = `${path.replace(/(\.[^.]+)?$/, ".proxy.mp4")}`;
      void tauriInvoke<string>("make_proxy", { input: path, output: proxyOut })
        .then((out) => useEditor.getState().setMediaProxy(id, out, convertFileSrc(out)))
        .catch(() => { /* proxy is an optimization, never a blocker */ });
      const probe = document.createElement("video");
      probe.preload = "auto";
      probe.muted = true;
      probe.onloadedmetadata = () => captureThumb(probe, (thumb) => setMediaThumb(id, thumb));
      probe.src = url;
    }
  };

  const onImport = () => {
    if (isTauri()) void importNative();
    else fileRef.current?.click();
  };

  return (
    <div className="dock-panel">
      <div className="panel-title">Media</div>
      <button className="primary" onClick={onImport}>
        + Import video / audio / image
      </button>
      {isTauri() && <ScreenRecorder onRecorded={(p) => void importOnePath(p)} />}
      <input
        ref={fileRef}
        type="file"
        accept="video/*,audio/*,image/*"
        multiple
        hidden
        onChange={(e) => importBlobs(e.target.files)}
      />
      {media.length === 0 && (
        <p className="hint">Import a clip to start. It is added to the timeline automatically.</p>
      )}
      <div className="lib-grid">
        {media.map((m) => (
          <button
            key={m.id}
            className="lib-card"
            onClick={() => (m.kind === "image" ? addOverlayClip(m.id) : addToTimeline(m.id))}
            title={m.kind === "image" ? `${m.name} — click to add as overlay` : m.name}
          >
            <span className="lib-tile">
              {m.thumb ? (
                <img src={m.thumb} alt="" />
              ) : m.kind === "video" ? (
                <video src={m.url} muted preload="metadata" />
              ) : (
                "♪"
              )}
              <span className="lib-dur">{m.duration.toFixed(1)}s</span>
              <span className="lib-add">+</span>
            </span>
            <span className="lib-name">{m.name}</span>
          </button>
        ))}
      </div>
      {media.some((m) => m.kind === "video" || m.kind === "image") && (
        <div className="field">
          <span>Picture in picture</span>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {media.filter((m) => m.kind === "video" || m.kind === "image").map((m) => (
              <button key={m.id} className="chip" title={`Add ${m.name} as an overlay at the playhead`}
                onClick={() => addOverlayClip(m.id)}>
                📺 {m.name.length > 14 ? `${m.name.slice(0, 14)}…` : m.name}
              </button>
            ))}
          </div>
          <p className="hint">Overlay clips land on the PiP track — position and size in the Inspector.</p>
        </div>
      )}
    </div>
  );
}
