import { useState } from "react";
import { useEditor } from "../../store/editor";
import { EFFECT_LABELS, Effect, SPEED_CURVE_PRESETS, clipDuration } from "../../lib/project";

const EFFECT_TYPES = Object.keys(EFFECT_LABELS) as Effect["type"][];

/** Right panel: properties of the selected clip + canvas presets. */
export default function Inspector() {
  const {
    project, selected, updateSelectedText, setCanvas, addEffect, removeEffect, updateEffect,
    setSelectedSpeed, setSelectedVolume, setSelectedTransitionDuration, removeSelectedTransition,
    setSelectedTextStyle, setSpeedCurve, addKeyframeAtPlayhead, updateKeyframe, removeKeyframe,
  } = useEditor();
  const [newFx, setNewFx] = useState<Effect["type"]>("adjust");
  const clip = selected
    ? project.tracks.find((t) => t.id === selected.trackId)?.clips.find((c) => c.id === selected.clipId)
    : undefined;

  return (
    <aside className="inspector">
      <div className="panel-title">Inspector</div>
      <div className="field">
        <span>Canvas</span>
        <div className="row">
          {(["9:16", "16:9", "1:1"] as const).map((p) => (
            <button
              key={p}
              className={
                `${project.canvas.width}:${project.canvas.height}` ===
                (p === "9:16" ? "1080:1920" : p === "16:9" ? "1920:1080" : "1080:1080")
                  ? "chip active"
                  : "chip"
              }
              onClick={() => setCanvas(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {clip ? (
        <>
          <div className="field">
            <span>Clip</span>
            <strong className="clip-title">{clip.text ?? clip.source}</strong>
          </div>
          <div className="kv">
            <span>Start</span>
            <b>{clip.timelineStart.toFixed(2)}s</b>
            <span>Duration</span>
            <b>{clipDuration(clip).toFixed(2)}s</b>
            <span>In / Out</span>
            <b>
              {clip.inSec.toFixed(2)}s → {clip.outSec.toFixed(2)}s
            </b>
            <span>Speed</span>
            <b>{clip.speed}×</b>
          </div>
          {clip.text === undefined && (
            <>
              <div className="field">
                <span>Speed</span>
                <Slider label="Speed" value={clip.speed} min={0.25} max={4} step={0.05}
                  onChange={setSelectedSpeed} />
                <div className="row">
                  {[0.5, 1, 1.5, 2].map((v) => (
                    <button key={v} className="chip" onClick={() => setSelectedSpeed(v)}>{v}×</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span>Speed curve</span>
                <div className="row">
                  {SPEED_CURVE_PRESETS.map((preset) => (
                    <button key={preset.name} className="chip" title={preset.name}
                      onClick={() => setSpeedCurve(preset.points)}>
                      {preset.name.split(" ")[0]} {preset.name.includes("slow") ? "🐢" : preset.name.includes("fast") ? "🐇" : preset.name.includes("down") ? "↘" : "↗"}
                    </button>
                  ))}
                </div>
                {clip.speedCurve ? (
                  <div className="row">
                    <span className="hint">Curve active: {clip.speedCurve.map((p) => `${Math.round(p.at * 100)}%→${p.speed}×`).join(" · ")}</span>
                    <button onClick={() => setSpeedCurve(null)}>Clear</button>
                  </div>
                ) : (
                  <p className="hint">Constant speed right now — or pick a CapCut-style curve preset.</p>
                )}
              </div>
              <div className="field">
                <span>Audio</span>
                <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.05}
                  onChange={setSelectedVolume} />
              </div>
              <div className="field">
                <span>Keyframes ◆</span>
                <button onClick={addKeyframeAtPlayhead}>◆ Add keyframe at playhead</button>
                {(clip.keyframes ?? []).map((kf, i) => (
                  <div key={i} className="effect-item">
                    <div className="row">
                      <strong>◆ {kf.at.toFixed(2)}s</strong>
                      <span className="spacer" />
                      <button onClick={() => removeKeyframe(i)}>✕</button>
                    </div>
                    <Slider label="Scale" value={kf.scale} min={1} max={3} step={0.05}
                      onChange={(v) => updateKeyframe(i, { scale: v })} />
                    <Slider label="Rotate" value={kf.rotation} min={-180} max={180} step={1}
                      onChange={(v) => updateKeyframe(i, { rotation: v })} />
                    <Slider label="Opacity" value={kf.opacity} min={0} max={1} step={0.05}
                      onChange={(v) => updateKeyframe(i, { opacity: v })} />
                  </div>
                ))}
                <p className="hint">Animate scale/rotation/opacity between keyframes — rendered at export, previewed live.</p>
              </div>
              <div className="field">
                <span>Transition in</span>
                {clip.transitionIn ? (
                  <>
                    <div className="row">
                      <strong>{clip.transitionIn.kind}</strong>
                      <span className="spacer" />
                      <button onClick={removeSelectedTransition}>✕</button>
                    </div>
                    <Slider label="Seconds" value={clip.transitionIn.duration} min={0.1} max={3} step={0.1}
                      onChange={setSelectedTransitionDuration} />
                  </>
                ) : (
                  <p className="hint">None — add one from the Transitions tab on the left.</p>
                )}
              </div>
            </>
          )}
          {clip.text !== undefined && (
            <div className="field">
              <span>Text</span>
              <textarea
                value={clip.text}
                rows={3}
                onChange={(e) => updateSelectedText(e.target.value)}
              />
              <Slider label="Size" value={clip.fontSize ?? 64} min={24} max={200} step={2}
                onChange={(v) => setSelectedTextStyle({ fontSize: v })} />
              <div className="row">
                {["#ffffff", "#ffe14d", "#22d3ee", "#ff5252", "#7CFC00", "#000000"].map((c) => (
                  <button
                    key={c}
                    className="swatch"
                    style={{ background: c }}
                    title={c}
                    onClick={() => setSelectedTextStyle({ textColor: c })}
                  />
                ))}
                <input
                  type="color"
                  className="color-input"
                  value={clip.textColor ?? "#ffffff"}
                  onChange={(e) => setSelectedTextStyle({ textColor: e.target.value })}
                />
              </div>
            </div>
          )}
          {clip.text === undefined && (
            <div className="field">
              <span>Effects</span>
              {(clip.effects ?? []).map((fx, i) => (
                <div key={i} className="effect-item">
                  <div className="row">
                    <strong>{EFFECT_LABELS[fx.type]}</strong>
                    <span className="spacer" />
                    <button onClick={() => removeEffect(i)} title="Remove effect">✕</button>
                  </div>
                  <EffectControls effect={fx} onChange={(next) => updateEffect(i, next)} />
                </div>
              ))}
              <div className="row">
                <select value={newFx} onChange={(e) => setNewFx(e.target.value as Effect["type"])}>
                  {EFFECT_TYPES.map((t) => (
                    <option key={t} value={t}>{EFFECT_LABELS[t]}</option>
                  ))}
                </select>
                <button onClick={() => addEffect(newFx)}>+ Add</button>
              </div>
              <p className="hint">
                Preview approximates effects live; export renders them exactly with FFmpeg.
              </p>
            </div>
          )}
          <p className="hint">Drag a clip to move it, drag its edges to trim, Split cuts at the playhead.</p>
        </>
      ) : (
        <p className="hint">Select a clip on the timeline to edit its properties.</p>
      )}
    </aside>
  );
}

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <b>{value.toFixed(step < 0.1 ? 2 : 0)}</b>
    </label>
  );
}

function EffectControls({ effect, onChange }: { effect: Effect; onChange: (e: Effect) => void }) {
  switch (effect.type) {
    case "adjust":
      return (
        <>
          <Slider label="Brightness" value={effect.brightness} min={-1} max={1} step={0.01}
            onChange={(v) => onChange({ ...effect, brightness: v })} />
          <Slider label="Contrast" value={effect.contrast} min={0} max={3} step={0.01}
            onChange={(v) => onChange({ ...effect, contrast: v })} />
          <Slider label="Saturation" value={effect.saturation} min={0} max={3} step={0.01}
            onChange={(v) => onChange({ ...effect, saturation: v })} />
        </>
      );
    case "sepia":
      return <Slider label="Intensity" value={effect.intensity} min={0} max={1} step={0.01}
        onChange={(v) => onChange({ ...effect, intensity: v })} />;
    case "blur":
      return <Slider label="Sigma" value={effect.sigma} min={0} max={50} step={0.5}
        onChange={(v) => onChange({ ...effect, sigma: v })} />;
    case "sharpen":
      return <Slider label="Amount" value={effect.amount} min={0} max={2} step={0.05}
        onChange={(v) => onChange({ ...effect, amount: v })} />;
    case "vignette":
      return <Slider label="Strength" value={effect.strength} min={0} max={1} step={0.01}
        onChange={(v) => onChange({ ...effect, strength: v })} />;
    case "temperature":
      return <Slider label="Kelvin" value={effect.kelvin} min={1000} max={11000} step={100}
        onChange={(v) => onChange({ ...effect, kelvin: v })} />;
    case "fade_in":
    case "fade_out":
      return <Slider label="Seconds" value={effect.duration} min={0} max={5} step={0.1}
        onChange={(v) => onChange({ ...effect, duration: v })} />;
    case "chroma_key":
      return (
        <>
          <label className="slider-row">
            <span>Key color</span>
            <input type="color" value={effect.color}
              onChange={(e) => onChange({ ...effect, color: e.target.value })} />
            <b>{effect.color}</b>
          </label>
          <Slider label="Similarity" value={effect.similarity} min={0} max={1} step={0.01}
            onChange={(v) => onChange({ ...effect, similarity: v })} />
          <Slider label="Blend" value={effect.blend} min={0} max={1} step={0.01}
            onChange={(v) => onChange({ ...effect, blend: v })} />
          <p className="hint">Keyed area becomes transparent over black at export.</p>
        </>
      );
    case "denoise":
      return <Slider label="Strength" value={effect.strength} min={0} max={1} step={0.05}
        onChange={(v) => onChange({ ...effect, strength: v })} />;
    default:
      return null; // grayscale / mirror / invert are on-off effects
  }
}
