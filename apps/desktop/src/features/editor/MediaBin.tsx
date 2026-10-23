import { useRef } from "react";
import { useEditor } from "../../store/editor";
import { newId } from "../../lib/project";

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
  const { media, addMedia, addToTimeline, setMediaThumb } = useEditor();
  const fileRef = useRef<HTMLInputElement>(null);

  const importBlobs = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file);
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
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      const kind = /\.(mp3|wav|m4a|aac|ogg)$/i.test(name) ? "audio" : "video";
      const id = newId("media");
      let duration = 0;
      try {
        const info = await tauriInvoke<{ duration: number }>("probe_media", { path });
        duration = info.duration || 0;
      } catch {
        /* probing is best-effort; duration refines on export */
      }
      const url = convertFileSrc(path);
      addMedia({ id, name, url, duration, kind, path });
      if (kind === "video") {
        // Generate a low-res proxy in the background for smooth scrubbing
        // (CapCut's proxy mode); preview can toggle to it.
        const proxyOut = `${path.replace(/(\.[^.]+)?$/, ".proxy.mp4")}`;
        void tauriInvoke<string>("make_proxy", { input: path, output: proxyOut })
          .then((out) => useEditor.getState().setMediaProxy(id, out, convertFileSrc(out)))
          .catch(() => { /* proxy is an optimization, never a blocker */ });
      }
      if (kind === "video") {
        const probe = document.createElement("video");
        probe.preload = "auto";
        probe.muted = true;
        probe.onloadedmetadata = () => captureThumb(probe, (thumb) => setMediaThumb(id, thumb));
        probe.src = url;
      }
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
        + Import video / audio
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="video/*,audio/*"
        multiple
        hidden
        onChange={(e) => importBlobs(e.target.files)}
      />
      {media.length === 0 && (
        <p className="hint">Import a clip to start. It is added to the timeline automatically.</p>
      )}
      <div className="lib-grid">
        {media.map((m) => (
          <button key={m.id} className="lib-card" onClick={() => addToTimeline(m.id)} title={m.name}>
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
    </div>
  );
}
