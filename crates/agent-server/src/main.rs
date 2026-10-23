//! nightcut-mcp — an MCP server (JSON-RPC 2.0 over stdio) that lets AI
//! agents edit video with the NightCut engines: build a project, add /
//! trim / split clips, apply effects, add text and captions, run local
//! AI tools (auto captions, background removal, motion tracking, beat /
//! scene / silence detection) and render — no GUI required.
//!
//! The server holds one project in memory. Clips reference real file
//! paths, which double as their export sources. Project files use the
//! exact editor-core JSON the desktop app reads and writes, so an agent
//! and a human can hand the same project back and forth.

use editor_core::{Clip, Effect, Project, TrackKind};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

static COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_id(prefix: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{prefix}-{stamp:x}-{n}")
}

struct State {
    project: Mutex<Project>,
}

fn track_id_for(name: &str) -> &'static str {
    match name {
        "overlay" => "track-overlay",
        "audio" | "music" => "track-audio",
        "text" => "track-text",
        _ => "track-video",
    }
}

fn find_clip<'a>(p: &'a Project, clip_id: &str) -> Option<(&'a str, &'a Clip)> {
    for t in &p.tracks {
        if let Some(c) = t.clips.iter().find(|c| c.id == clip_id) {
            return Some((&t.id, c));
        }
    }
    None
}

fn clip_summary(c: &Clip) -> Value {
    json!({
        "id": c.id, "source": c.source, "inSec": c.in_sec, "outSec": c.out_sec,
        "timelineStart": c.timeline_start, "duration": c.duration(),
        "speed": c.speed, "volume": c.volume,
        "text": c.text, "effects": serde_json::to_value(&c.effects).unwrap_or(Value::Null),
    })
}

type ToolResult = Result<Value, String>;

fn tool_call(state: &State, name: &str, args: &Value) -> ToolResult {
    let mut p = state.project.lock().unwrap();
    let get = |k: &str| args.get(k);
    let f64_of = |k: &str| args.get(k).and_then(|v| v.as_f64());
    let str_of = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    match name {
        "nightcut_project_new" => {
            *p = Project::default();
            if let Some(name) = str_of("name") { p.name = name.to_string(); }
            if let (Some(w), Some(h)) = (f64_of("width"), f64_of("height")) {
                p.canvas.width = w as u32;
                p.canvas.height = h as u32;
            }
            Ok(json!({ "ok": true, "canvas": { "width": p.canvas.width, "height": p.canvas.height, "fps": p.canvas.fps } }))
        }
        "nightcut_project_open" => {
            let path = str_of("path").ok_or("missing path")?;
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            *p = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "tracks": p.tracks.len() }))
        }
        "nightcut_project_save" => {
            let path = str_of("path").ok_or("missing path")?;
            let text = serde_json::to_string_pretty(&*p).map_err(|e| e.to_string())?;
            std::fs::write(&path, text).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "path": path }))
        }
        "nightcut_project_info" => {
            let tracks: Vec<Value> = p.tracks.iter().map(|t| {
                json!({
                    "id": t.id, "kind": format!("{:?}", t.kind).to_lowercase(),
                    "muted": t.muted, "hidden": t.hidden, "locked": t.locked,
                    "clips": t.clips.iter().map(clip_summary).collect::<Vec<_>>(),
                })
            }).collect();
            Ok(json!({
                "name": p.name,
                "canvas": { "width": p.canvas.width, "height": p.canvas.height, "fps": p.canvas.fps },
                "duration": p.duration(), "markers": p.markers, "tracks": tracks,
            }))
        }
        "nightcut_media_probe" => {
            let path = str_of("path").ok_or("missing path")?;
            let info = media_engine::probe(Path::new(&path)).map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(info).map_err(|e| e.to_string())?)
        }
        "nightcut_clip_add" => {
            let path = str_of("path").ok_or("missing path")?;
            let info = media_engine::probe(Path::new(&path)).map_err(|e| e.to_string())?;
            let track_name = str_of("track").unwrap_or_else(|| {
                if info.has_audio && info.duration_sec > 0.0 && path.rsplit('.').next().map(|e| ["mp3", "wav", "m4a", "aac", "ogg"].contains(&e.to_lowercase().as_str())).unwrap_or(false) {
                    "audio".to_string()
                } else { "video".to_string() }
            });
            let tid = track_id_for(&track_name);
            let in_sec = f64_of("inSec").unwrap_or(0.0);
            let out_sec = f64_of("outSec").unwrap_or(info.duration_sec);
            let at = f64_of("at").unwrap_or_else(|| {
                p.tracks.iter().find(|t| t.id == tid)
                    .map(|t| t.clips.iter().map(|c| c.timeline_end()).fold(0.0, f64::max))
                    .unwrap_or(0.0)
            });
            // Overlay tracks must exist even in projects from older files.
            if tid == "track-overlay" && p.tracks.iter().all(|t| t.id != tid) {
                let pos = p.tracks.iter().position(|t| t.kind == TrackKind::Audio).unwrap_or(p.tracks.len());
                p.tracks.insert(pos, editor_core::Track::new("track-overlay", TrackKind::Video));
            }
            let mut clip = Clip::new(next_id("clip"), path.clone(), in_sec, out_sec, at);
            if tid == "track-overlay" {
                clip.overlay_scale = Some(0.35);
                clip.overlay_x = Some(0.9);
                clip.overlay_y = Some(0.9);
            }
            let id = clip.id.clone();
            p.add_clip(tid, clip).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "clipId": id, "trackId": tid }))
        }
        "nightcut_clip_trim" => {
            let (tid, cid) = locate(&p, args)?;
            p.trim_clip(&tid, &cid, f64_of("inSec").ok_or("missing inSec")?, f64_of("outSec").ok_or("missing outSec")?)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "nightcut_clip_move" => {
            let (tid, cid) = locate(&p, args)?;
            p.move_clip(&tid, &cid, f64_of("start").ok_or("missing start")?).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "nightcut_clip_split" => {
            let (tid, cid) = locate(&p, args)?;
            let new_id = next_id("clip");
            p.split_clip(&tid, &cid, f64_of("at").ok_or("missing at")?, new_id.clone()).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "newClipId": new_id }))
        }
        "nightcut_clip_delete" => {
            let (tid, cid) = locate(&p, args)?;
            p.remove_clip(&tid, &cid).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "nightcut_clip_set" => {
            let (tid, cid) = locate(&p, args)?;
            let track = p.track_mut(&tid).map_err(|e| e.to_string())?;
            let clip = track.clips.iter_mut().find(|c| c.id == cid).ok_or("clip not found")?;
            if let Some(v) = f64_of("speed") { clip.speed = v; }
            if let Some(v) = f64_of("volume") { clip.volume = v; }
            if let Some(v) = f64_of("overlayScale") { clip.overlay_scale = Some(v); }
            if let Some(v) = f64_of("overlayX") { clip.overlay_x = Some(v); }
            if let Some(v) = f64_of("overlayY") { clip.overlay_y = Some(v); }
            if let Some(v) = f64_of("textY") { clip.text_y = Some(v.clamp(0.0, 1.0)); }
            if let Some(m) = str_of("blend") {
                clip.blend_mode = if m == "normal" { None } else { Some(m) };
            }
            Ok(json!({ "ok": true }))
        }
        "nightcut_effect_add" => {
            let (tid, cid) = locate(&p, args)?;
            let fx_val = get("effect").ok_or("missing effect")?.clone();
            let fx: Effect = serde_json::from_value(fx_val).map_err(|e| format!("bad effect JSON: {e}"))?;
            let track = p.track_mut(&tid).map_err(|e| e.to_string())?;
            let clip = track.clips.iter_mut().find(|c| c.id == cid).ok_or("clip not found")?;
            clip.effects.push(fx);
            Ok(json!({ "ok": true, "effects": clip.effects.len() }))
        }
        "nightcut_text_add" => {
            let text = str_of("text").ok_or("missing text")?;
            let at = f64_of("at").unwrap_or(0.0);
            let dur = f64_of("duration").unwrap_or(3.0);
            let mut clip = Clip::text_clip(next_id("clip"), text, at, dur);
            if let Some(fs) = f64_of("fontSize") { clip.font_size = Some(fs as u32); }
            if let Some(c) = str_of("color") { clip.text_color = Some(c); }
            if let Some(c) = str_of("bg") { clip.text_bg = Some(c); }
            if let Some(y) = f64_of("y") { clip.text_y = Some(y.clamp(0.0, 1.0)); }
            if let Some(g) = str_of("glow") { clip.text_glow = Some(g); }
            if args.get("shadow").and_then(|v| v.as_bool()).unwrap_or(false) { clip.text_shadow = true; }
            let id = clip.id.clone();
            p.add_clip("track-text", clip).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "clipId": id }))
        }
        "nightcut_captions_import_srt" => {
            let path = str_of("path").ok_or("missing path")?;
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let cues = media_engine::parse_srt(&text);
            let at = f64_of("at").unwrap_or(0.0);
            let mut ids = Vec::new();
            for cue in &cues {
                let mut clip = Clip::text_clip(next_id("clip"), cue.text.clone(), at + cue.start, (cue.end - cue.start).max(0.3));
                clip.font_size = Some(54);
                ids.push(clip.id.clone());
                p.add_clip("track-text", clip).map_err(|e| e.to_string())?;
            }
            Ok(json!({ "ok": true, "clips": ids.len() }))
        }
        "nightcut_captions_auto" => {
            let path = str_of("path").ok_or("missing path")?;
            let bin = PathBuf::from(str_of("whisperBin").ok_or("missing whisperBin")?);
            let model = PathBuf::from(str_of("model").ok_or("missing model")?);
            let wav = std::env::temp_dir().join(format!("{}.wav", next_id("nc-agent")));
            media_engine::extract_audio_wav(Path::new(&path), &wav).map_err(|e| e.to_string())?;
            let cues = media_engine::whisper_captions(&bin, &model, &wav).map_err(|e| e.to_string())?;
            let at = f64_of("at").unwrap_or(0.0);
            for cue in &cues {
                let mut clip = Clip::text_clip(next_id("clip"), cue.text.clone(), at + cue.start, (cue.end - cue.start).max(0.3));
                clip.font_size = Some(54);
                p.add_clip("track-text", clip).map_err(|e| e.to_string())?;
            }
            Ok(json!({ "ok": true, "captions": cues.len() }))
        }
        "nightcut_beats_detect" => {
            let path = str_of("path").ok_or("missing path")?;
            let (beats, bpm) = media_engine::detect_beats(Path::new(&path)).map_err(|e| e.to_string())?;
            p.markers = beats.clone();
            Ok(json!({ "ok": true, "beats": beats, "bpm": bpm }))
        }
        "nightcut_scenes_detect" => {
            let path = str_of("path").ok_or("missing path")?;
            let times = media_engine::detect_scenes(Path::new(&path), f64_of("threshold").unwrap_or(0.4))
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "scenes": times }))
        }
        "nightcut_silences_detect" => {
            let path = str_of("path").ok_or("missing path")?;
            let ranges = media_engine::detect_silences(
                Path::new(&path),
                f64_of("noiseDb").unwrap_or(-35.0),
                f64_of("minDuration").unwrap_or(0.5),
            ).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "silences": ranges }))
        }
        "nightcut_clip_split_scenes" => {
            let (tid, cid) = locate(&p, args)?;
            let clip = find_clip(&p, &cid).map(|(_, c)| c.clone()).ok_or("clip not found")?;
            let cuts = media_engine::detect_scenes(Path::new(&clip.source), f64_of("threshold").unwrap_or(0.4))
                .map_err(|e| e.to_string())?;
            let mut made = 0;
            let mut current_id = cid.clone();
            for cut in cuts {
                if cut > clip.in_sec + 0.05 && cut < clip.out_sec - 0.05 {
                    // Scene times are source-relative; the split point on
                    // the timeline accounts for the clip's speed.
                    let at_timeline = clip.timeline_start + (cut - clip.in_sec) / clip.speed.max(0.01);
                    let new_id = next_id("clip");
                    if p.split_clip(&tid, &current_id, at_timeline, new_id.clone()).is_ok() {
                        made += 1;
                    }
                }
            }
            let _ = &mut current_id;
            Ok(json!({ "ok": true, "splits": made }))
        }
        "nightcut_track_motion" => {
            let path = str_of("path").ok_or("missing path")?;
            let points = media_engine::track_motion(
                Path::new(&path),
                f64_of("start").unwrap_or(0.0),
                f64_of("duration").unwrap_or(2.0),
            ).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "points": serde_json::to_value(points).map_err(|e| e.to_string())? }))
        }
        "nightcut_bg_remove" => {
            let path = str_of("path").ok_or("missing path")?;
            let dir = str_of("onnxDir").ok_or("missing onnxDir")?;
            let dylib = ["libonnxruntime.so", "onnxruntime.dll", "libonnxruntime.dylib"]
                .iter().map(|n| PathBuf::from(&dir).join(n)).find(|p| p.exists())
                .ok_or("no onnxruntime library in onnxDir")?;
            let model = PathBuf::from(&dir).join("u2netp.onnx");
            let src = PathBuf::from(&path);
            let out = src.with_file_name(format!(
                "{}.nobg.mp4",
                src.file_stem().and_then(|s| s.to_str()).unwrap_or("clip")
            ));
            media_engine::remove_background(&src, &out, &model, &dylib).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "output": out.to_string_lossy() }))
        }
        "nightcut_export" => {
            let output = str_of("output").ok_or("missing output")?;
            let mut sources: BTreeMap<String, PathBuf> = BTreeMap::new();
            for t in &p.tracks {
                for c in &t.clips {
                    if !c.source.is_empty() && c.text.is_none() {
                        sources.insert(c.id.clone(), PathBuf::from(&c.source));
                    }
                }
            }
            let settings = export_engine::ExportSettings {
                max_height: f64_of("maxHeight").map(|v| v as u32),
                gif: args.get("gif").and_then(|v| v.as_bool()).unwrap_or(false),
                audio_only: args.get("audioOnly").and_then(|v| v.as_bool()).unwrap_or(false),
                ..Default::default()
            };
            let rendered = export_engine::render(&p, &sources, Path::new(&output), &settings)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true, "output": rendered.to_string_lossy() }))
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn locate(p: &Project, args: &Value) -> Result<(String, String), String> {
    let cid = args.get("clipId").and_then(|v| v.as_str()).ok_or("missing clipId")?.to_string();
    let (tid, _) = find_clip(p, &cid).ok_or("clip not found")?;
    Ok((tid.to_string(), cid))
}

fn tools_list() -> Value {
    let t = |name: &str, desc: &str, props: Value, required: &[&str]| {
        json!({
            "name": name, "description": desc,
            "inputSchema": { "type": "object", "properties": props, "required": required },
        })
    };
    let s = |d: &str| json!({ "type": "string", "description": d });
    let n = |d: &str| json!({ "type": "number", "description": d });
    let b = |d: &str| json!({ "type": "boolean", "description": d });
    json!([
        t("nightcut_project_new", "Start a fresh project (optionally with a name and canvas width/height).", json!({ "name": s("project name"), "width": n("canvas width"), "height": n("canvas height") }), &[]),
        t("nightcut_project_open", "Load a project JSON file (editor-core format, same as the desktop app).", json!({ "path": s("project file path") }), &["path"]),
        t("nightcut_project_save", "Save the current project as JSON.", json!({ "path": s("destination path") }), &["path"]),
        t("nightcut_project_info", "Describe the current project: canvas, duration, markers, tracks and clips.", json!({}), &[]),
        t("nightcut_media_probe", "Probe a media file (duration, dimensions, fps, codecs).", json!({ "path": s("media path") }), &["path"]),
        t("nightcut_clip_add", "Add a media file as a clip. track: video (default), overlay (PiP), audio, text. Defaults to appending at the track's end.", json!({ "path": s("media path"), "track": s("video|overlay|audio"), "at": n("timeline start seconds"), "inSec": n("trim in"), "outSec": n("trim out") }), &["path"]),
        t("nightcut_clip_trim", "Trim a clip by id.", json!({ "clipId": s("clip id"), "inSec": n("in"), "outSec": n("out") }), &["clipId", "inSec", "outSec"]),
        t("nightcut_clip_move", "Move a clip to a new timeline start.", json!({ "clipId": s("clip id"), "start": n("seconds") }), &["clipId", "start"]),
        t("nightcut_clip_split", "Split a clip at a timeline time.", json!({ "clipId": s("clip id"), "at": n("timeline seconds") }), &["clipId", "at"]),
        t("nightcut_clip_delete", "Delete a clip by id.", json!({ "clipId": s("clip id") }), &["clipId"]),
        t("nightcut_clip_set", "Set clip speed / volume / PiP placement / text height / blend mode.", json!({ "clipId": s("clip id"), "speed": n("0.25-4"), "volume": n("0-2"), "overlayScale": n("0-1"), "overlayX": n("0-1"), "overlayY": n("0-1"), "textY": n("text vertical position 0-1"), "blend": s("blend mode: normal|screen|multiply|overlay|softlight|hardlight|darken|lighten|difference|addition") }), &["clipId"]),
        t("nightcut_effect_add", "Add an effect to a clip. effect is the editor-core Effect JSON, e.g. {\"type\":\"sepia\",\"intensity\":0.7}, {\"type\":\"adjust\",\"brightness\":0.05,\"contrast\":1.1,\"saturation\":1.1}, {\"type\":\"loudnorm\",\"target_lufs\":-14}, {\"type\":\"pitch_shift\",\"semitones\":4}, {\"type\":\"lut\",\"path\":\"/x.cube\"}, {\"type\":\"curves\",\"master\":\"0/0 0.5/0.6 1/1\",\"red\":\"\",\"green\":\"\",\"blue\":\"\"}.", json!({ "clipId": s("clip id"), "effect": { "type": "object" } }), &["clipId", "effect"]),
        t("nightcut_text_add", "Add a text clip at a timeline time.", json!({ "text": s("text"), "at": n("start"), "duration": n("seconds"), "fontSize": n("px"), "color": s("#rrggbb"), "bg": s("caption pill #rrggbb"), "shadow": b("drop shadow"), "y": n("vertical position 0=top, 0.5=center, 1=bottom"), "glow": s("glow halo #rrggbb") }), &["text"]),
        t("nightcut_captions_import_srt", "Import an .srt file as caption text clips.", json!({ "path": s("srt path"), "at": n("offset seconds") }), &["path"]),
        t("nightcut_captions_auto", "Auto-captions with a local whisper.cpp (binary + ggml model paths), added as text clips.", json!({ "path": s("media path"), "whisperBin": s("whisper-cli path"), "model": s("ggml model path"), "at": n("offset") }), &["path", "whisperBin", "model"]),
        t("nightcut_beats_detect", "Detect beats in an audio file and store them as project markers.", json!({ "path": s("audio path") }), &["path"]),
        t("nightcut_scenes_detect", "Detect scene-change times in a video.", json!({ "path": s("video path"), "threshold": n("0..1, default 0.4") }), &["path"]),
        t("nightcut_silences_detect", "Detect silent ranges in a media file.", json!({ "path": s("media path"), "noiseDb": n("default -35"), "minDuration": n("default 0.5") }), &["path"]),
        t("nightcut_clip_split_scenes", "Split a clip at every detected scene change inside it.", json!({ "clipId": s("clip id"), "threshold": n("0..1") }), &["clipId"]),
        t("nightcut_track_motion", "Track the most salient subject in a video segment; returns normalized positions over time.", json!({ "path": s("video path"), "start": n("seconds"), "duration": n("seconds") }), &["path"]),
        t("nightcut_bg_remove", "AI background removal (u2netp ONNX). onnxDir holds libonnxruntime + u2netp.onnx. Writes <name>.nobg.mp4.", json!({ "path": s("video path"), "onnxDir": s("tools/onnx folder") }), &["path", "onnxDir"]),
        t("nightcut_export", "Render the project. Options: maxHeight (e.g. 720), gif (bool), audioOnly (bool; codec by output extension).", json!({ "output": s("output path"), "maxHeight": n("px cap"), "gif": b("GIF output"), "audioOnly": b("audio only") }), &["output"]),
    ])
}

fn main() {
    let state = State { project: Mutex::new(Project::default()) };
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0", "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "nightcut-mcp", "version": env!("CARGO_PKG_VERSION") },
                },
            }),
            "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools_list() } }),
            "tools/call" => {
                let params = req.get("params").cloned().unwrap_or(Value::Null);
                let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                match tool_call(&state, name, &args) {
                    Ok(v) => json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": { "content": [{ "type": "text", "text": v.to_string() }] },
                    }),
                    Err(e) => json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": { "content": [{ "type": "text", "text": e }], "isError": true },
                    }),
                }
            }
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            _ => {
                if id.is_null() { continue; } // notification
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })
            }
        };
        let _ = writeln!(out, "{response}");
        let _ = out.flush();
    }
}
