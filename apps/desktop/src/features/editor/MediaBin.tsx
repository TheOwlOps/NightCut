import { useRef } from "react";
import { useEditor } from "../../store/editor";
import { newId } from "../../lib/project";

/** Left panel: imported media. Files stay local — object URLs only. */
export default function MediaBin() {
  const { media, addMedia, addToTimeline } = useEditor();
  const fileRef = useRef<HTMLInputElement>(null);

  const importFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file);
      const probe = document.createElement(file.type.startsWith("audio") ? "audio" : "video");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        addMedia({
          id: newId("media"),
          name: file.name,
          url,
          duration: probe.duration || 0,
          kind: file.type.startsWith("audio") ? "audio" : "video",
        });
      };
      probe.src = url;
    }
  };

  return (
    <aside className="mediabin">
      <div className="panel-title">Media</div>
      <button className="primary" onClick={() => fileRef.current?.click()}>
        + Import video / audio
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="video/*,audio/*"
        multiple
        hidden
        onChange={(e) => importFiles(e.target.files)}
      />
      <div className="media-list">
        {media.length === 0 && (
          <p className="hint">Import a clip to start. It is added to the timeline automatically.</p>
        )}
        {media.map((m) => (
          <div key={m.id} className="media-item">
            {m.kind === "video" ? (
              <video src={m.url} muted preload="metadata" />
            ) : (
              <div className="audio-thumb">♪</div>
            )}
            <div className="media-meta">
              <span className="media-name" title={m.name}>{m.name}</span>
              <span className="media-dur">{m.duration.toFixed(1)}s</span>
            </div>
            <button onClick={() => addToTimeline(m.id)} title="Add to timeline again">
              +
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
