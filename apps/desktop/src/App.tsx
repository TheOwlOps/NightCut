import { useEffect, useRef, useState } from "react";
import MediaBin from "./features/editor/MediaBin";
import Preview from "./features/editor/Preview";
import Timeline from "./features/editor/Timeline";
import Inspector from "./features/editor/Inspector";
import ExportPanel from "./features/export/ExportPanel";
import { useEditor } from "./store/editor";
import { Project } from "./lib/project";

export default function App() {
  const { undo, redo, loadProject, past, future } = useEditor();
  const [exportOpen, setExportOpen] = useState(false);
  const openRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); redo(); }
      else if (e.key === "Delete" || e.key === "Backspace") {
        if ((e.target as HTMLElement).tagName !== "TEXTAREA" && (e.target as HTMLElement).tagName !== "INPUT") {
          useEditor.getState().deleteSelected();
        }
      } else if (e.key === " ") {
        if ((e.target as HTMLElement).tagName === "BODY") {
          e.preventDefault();
          const s = useEditor.getState();
          s.setPlaying(!s.playing);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const openProject = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      try {
        const raw = JSON.parse(text) as Project;
        loadProject(raw);
      } catch {
        alert("That file is not a NightCut project JSON.");
      }
    });
  };

  return (
    <div className="app">
      <header className="topbar">
        <img src="/logo.svg" alt="" className="topbar-logo" />
        <strong>NightCut</strong>
        <span className="topbar-sub">open-source video editor</span>
        <span className="spacer" />
        <button onClick={undo} disabled={past.length === 0} title="Undo (Ctrl+Z)">↩ Undo</button>
        <button onClick={redo} disabled={future.length === 0} title="Redo (Ctrl+Y)">↪ Redo</button>
        <button onClick={() => openRef.current?.click()}>Open project</button>
        <input
          ref={openRef}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => openProject(e.target.files?.[0])}
        />
        <button className="primary" onClick={() => setExportOpen(true)}>Export</button>
      </header>

      <main className="workspace">
        <MediaBin />
        <Preview />
        <Inspector />
      </main>

      <Timeline />
      <ExportPanel open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}
