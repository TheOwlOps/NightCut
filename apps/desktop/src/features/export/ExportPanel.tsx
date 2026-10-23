import { useMemo, useState } from "react";
import { useEditor } from "../../store/editor";
import { buildFfmpegCommand, toRustJson } from "../../lib/project";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * Export dialog. Desktop (Tauri): calls the Rust export-engine natively.
 * Browser: shows the exact FFmpeg command + downloads the project JSON —
 * nothing is faked, the encode only happens where FFmpeg can really run.
 */
export default function ExportPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const [output, setOutput] = useState("nightcut-export.mp4");
  const [maxHeight, setMaxHeight] = useState<number>(0); // 0 = original
  const [gif, setGif] = useState(false);
  const [status, setStatus] = useState<string>("");
  const command = useMemo(() => buildFfmpegCommand(project, output), [project, output]);

  if (!open) return null;

  const downloadProject = () => {
    const blob = new Blob([toRustJson(project)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "project.nightcut.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const runNativeExport = async () => {
    setStatus("Rendering…");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // In the desktop build, clips reference real file paths and the Rust
      // export-engine resolves and renders them with the FFmpeg sidecar.
      const sources: Record<string, string> = {};
      for (const t of project.tracks)
        for (const c of t.clips) if (c.source) sources[c.id] = c.source;
      await invoke("export_video", {
        projectJson: toRustJson(project),
        sources,
        output: gif ? output.replace(/\.mp4$/i, ".gif") : output,
        maxHeight: maxHeight > 0 ? maxHeight : null,
        gif,
      });
      setStatus(`Done: ${output}`);
    } catch (err) {
      setStatus(`Export failed: ${String(err)}`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export</h2>
        <label className="field">
          <span>Output file</span>
          <input value={output} onChange={(e) => setOutput(e.target.value)} />
        </label>
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            <span>Resolution</span>
            <select value={maxHeight} onChange={(e) => setMaxHeight(Number(e.target.value))}>
              <option value={0}>Original</option>
              <option value={1080}>1080p</option>
              <option value={720}>720p</option>
              <option value={480}>480p</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Format</span>
            <select value={gif ? "gif" : "mp4"} onChange={(e) => setGif(e.target.value === "gif")}>
              <option value="mp4">MP4 (video + audio)</option>
              <option value="gif">GIF (15 fps, silent)</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>FFmpeg command (generated from this timeline)</span>
          <textarea readOnly rows={5} value={command} />
        </label>
        <div className="row">
          <button onClick={() => void navigator.clipboard.writeText(command)}>Copy command</button>
          <button onClick={downloadProject}>Download project JSON</button>
          {isTauri() && (
            <button className="primary" onClick={() => void runNativeExport()}>
              Render MP4
            </button>
          )}
        </div>
        {!isTauri() && (
          <p className="hint">
            You are in the browser build: rendering runs in the desktop app (Tauri) via the Rust
            export engine, or anywhere with this FFmpeg command.
          </p>
        )}
        {status && <p className="status">{status}</p>}
        <button className="close" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
