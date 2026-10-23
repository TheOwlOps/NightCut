// NightCut desktop shell: thin Tauri commands over the Rust core crates.
// All real work lives in editor-core / media-engine / export-engine so it is
// testable without a GUI (see those crates' test suites).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::BTreeMap;
use std::path::PathBuf;

#[tauri::command]
fn probe_media(path: String) -> Result<media_engine::MediaInfo, String> {
    media_engine::probe(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn make_proxy(input: String, output: String) -> Result<String, String> {
    media_engine::make_proxy(std::path::Path::new(&input), std::path::Path::new(&output))
        .map(|p| p.display().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn waveform(path: String, buckets: usize) -> Result<Vec<f32>, String> {
    media_engine::waveform_peaks(std::path::Path::new(&path), buckets).map_err(|e| e.to_string())
}

/// Local text-to-speech (flite). Writes a WAV under the system temp dir
/// and returns its path so the frontend can add it as an audio clip.
#[tauri::command]
fn text_to_speech(text: String, voice: String) -> Result<String, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = std::env::temp_dir().join(format!("nightcut-tts-{stamp}.wav"));
    media_engine::synthesize_speech(&text, &voice, &out).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

/// Beat detection: { beats: number[], bpm } as JSON.
#[tauri::command]
fn detect_beats(path: String) -> Result<String, String> {
    let (beats, bpm) =
        media_engine::detect_beats(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "beats": beats, "bpm": bpm }).to_string())
}

fn find_onnx_files() -> Option<(PathBuf, PathBuf)> {
    let model_names = ["libonnxruntime.so", "onnxruntime.dll", "libonnxruntime.dylib"];
    let dirs = [
        std::env::var("NIGHTCUT_ONNX_DIR").ok().map(PathBuf::from),
        std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("tools").join("onnx"))),
    ];
    for dir in dirs.into_iter().flatten() {
        let model = dir.join("u2netp.onnx");
        if !model.exists() { continue; }
        for name in model_names {
            let dylib = dir.join(name);
            if dylib.exists() { return Some((dylib, model)); }
        }
    }
    None
}

/// AI background removal (local u2netp ONNX): writes a new MP4 next to
/// the source with the subject composited over black; returns its path.
#[tauri::command]
fn remove_background(path: String) -> Result<String, String> {
    let (dylib, model) = find_onnx_files().ok_or_else(|| {
        "ONNX sidecar not found: put libonnxruntime + u2netp.onnx in tools/onnx next to the app (or set NIGHTCUT_ONNX_DIR). See tools/onnx/README.md.".to_string()
    })?;
    let src = PathBuf::from(&path);
    let out = src.with_file_name(format!(
        "{}.nobg.mp4",
        src.file_stem().and_then(|s| s.to_str()).unwrap_or("clip")
    ));
    media_engine::remove_background(&src, &out, &model, &dylib).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

/// Motion tracking of the clip's center patch; returns TrackPoint[] JSON.
#[tauri::command]
fn track_motion(path: String, start: f64, duration: f64) -> Result<String, String> {
    let points = media_engine::track_motion(std::path::Path::new(&path), start, duration)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&points).map_err(|e| e.to_string())
}

/// Render a project. `project_json` is the editor-core JSON shape (the same
/// JSON the web UI downloads as project.nightcut.json).
#[tauri::command]
fn export_video(
    project_json: String,
    sources: BTreeMap<String, String>,
    output: String,
    max_height: Option<u32>,
    gif: Option<bool>,
) -> Result<String, String> {
    let project: editor_core::Project =
        serde_json::from_str(&project_json).map_err(|e| e.to_string())?;
    let sources: BTreeMap<String, PathBuf> =
        sources.into_iter().map(|(k, v)| (k, PathBuf::from(v))).collect();
    let settings = export_engine::ExportSettings {
        encoder: export_engine::Encoder::preferred_for_os(),
        max_height,
        gif: gif.unwrap_or(false),
        ..Default::default()
    };
    // Hardware encoders are best-effort: fall back to software on failure.
    let result = export_engine::render(&project, &sources, std::path::Path::new(&output), &settings);
    match result {
        Ok(p) => Ok(p.display().to_string()),
        Err(first_err) => {
            if settings.encoder == export_engine::Encoder::Software {
                return Err(first_err.to_string());
            }
            let software = export_engine::ExportSettings { max_height, gif: gif.unwrap_or(false), ..Default::default() };
            export_engine::render(&project, &sources, std::path::Path::new(&output), &software)
                .map(|p| p.display().to_string())
                .map_err(|e| e.to_string())
        }
    }
}

/// Native multi-file picker (desktop import keeps real file paths, which
/// probing, proxies and auto-captions need). Returns chosen paths.
#[tauri::command]
async fn pick_media_files() -> Vec<String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Media", &["mp4", "mov", "mkv", "webm", "mp3", "wav", "m4a", "aac", "ogg"])
            .pick_files()
    })
    .await
    .ok()
    .flatten();
    picked
        .map(|files| files.iter().map(|p| p.display().to_string()).collect())
        .unwrap_or_default()
}

fn find_whisper_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("NIGHTCUT_WHISPER_BIN") {
        let pb = PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let name = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
    let candidate = exe_dir.join("tools").join("whisper").join(name);
    if candidate.exists() { return Some(candidate); }
    // Fall back to PATH.
    let probe = std::process::Command::new(name).arg("--help").output();
    if matches!(probe, Ok(o) if o.status.success() || !o.stderr.is_empty()) {
        return Some(PathBuf::from(name));
    }
    None
}

fn find_whisper_model(model: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("NIGHTCUT_WHISPER_MODEL") {
        let pb = PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = exe_dir
        .join("tools")
        .join("whisper-models")
        .join(format!("ggml-{model}.bin"));
    if candidate.exists() { Some(candidate) } else { None }
}

/// Local auto-captions via whisper.cpp (no cloud): extract 16kHz WAV with
/// FFmpeg, transcribe with the whisper-cli sidecar, return cues.
#[tauri::command]
async fn auto_captions(path: String, model: String) -> Result<Vec<media_engine::CaptionCue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = find_whisper_bin().ok_or_else(|| {
            "whisper-cli not found — place the whisper.cpp binary in tools/whisper/ next to the \
             app or set NIGHTCUT_WHISPER_BIN (see tools/whisper/README.md)"
                .to_string()
        })?;
        let model_path = find_whisper_model(&model).ok_or_else(|| {
            format!(
                "whisper model ggml-{model}.bin not found — download it into tools/whisper-models/ \
                 next to the app or set NIGHTCUT_WHISPER_MODEL (see tools/whisper/README.md)"
            )
        })?;
        let dir = std::env::temp_dir().join("nightcut-captions");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let wav = dir.join(format!("{}.wav", media_engine::cache_key(std::path::Path::new(&path))));
        media_engine::extract_audio_wav(std::path::Path::new(&path), &wav).map_err(|e| e.to_string())?;
        media_engine::whisper_captions(&bin, &model_path, &wav).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            probe_media, make_proxy, waveform, export_video, pick_media_files, auto_captions,
            text_to_speech, detect_beats, track_motion, remove_background
        ])
        .run(tauri::generate_context!())
        .expect("error while running NightCut");
}
