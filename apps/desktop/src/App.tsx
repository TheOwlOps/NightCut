import { useEffect, useRef, useState } from "react";
import LeftPanel from "./features/editor/LeftPanel";
import Preview from "./features/editor/Preview";
import Timeline from "./features/editor/Timeline";
import Inspector from "./features/editor/Inspector";
import ExportPanel from "./features/export/ExportPanel";
import { useEditor } from "./store/editor";
import { Project } from "./lib/project";

export default function App() {
  const { undo, redo, loadProject, project, setProjectName } = useEditor();
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
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useEditor.getState().splitSelected();
      } else if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setExportOpen(true);
      } else if (e.key === "m" || e.key === "M") {
        if ((e.target as HTMLElement).tagName === "BODY") {
          const s = useEditor.getState();
          s.setMarkers([...(s.project.markers ?? []), Math.round(s.playhead * 100) / 100].sort((a, b) => a - b));
        }
      } else if (e.key === "Home") {
        useEditor.getState().setPlayhead(0);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if ((e.target as HTMLElement).tagName === "BODY") {
          const s = useEditor.getState();
          const step = (e.shiftKey ? 1 : 1 / 30) * (e.key === "ArrowRight" ? 1 : -1);
          s.setPlayhead(Math.max(0, s.playhead + step));
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
        <input
          className="project-name"
          value={project.name ?? ""}
          placeholder="Untitled project"
          onChange={(e) => setProjectName(e.target.value)}
          title="Project name — used as the export file name"
          aria-label="Project name"
        />
        <span className="spacer" />
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
        <LeftPanel />
        <Preview />
        <Inspector />
      </main>

      <Timeline />
      <ExportPanel open={exportOpen} onClose={() => setExportOpen(false)} />
    </div>
  );
}
