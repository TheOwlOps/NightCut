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

/// Render a project. `project_json` is the editor-core JSON shape (the same
/// JSON the web UI downloads as project.nightcut.json).
#[tauri::command]
fn export_video(
    project_json: String,
    sources: BTreeMap<String, String>,
    output: String,
) -> Result<String, String> {
    let project: editor_core::Project =
        serde_json::from_str(&project_json).map_err(|e| e.to_string())?;
    let sources: BTreeMap<String, PathBuf> =
        sources.into_iter().map(|(k, v)| (k, PathBuf::from(v))).collect();
    let settings = export_engine::ExportSettings {
        encoder: export_engine::Encoder::preferred_for_os(),
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
            let software = export_engine::ExportSettings::default();
            export_engine::render(&project, &sources, std::path::Path::new(&output), &software)
                .map(|p| p.display().to_string())
                .map_err(|e| e.to_string())
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe_media, make_proxy, waveform, export_video])
        .run(tauri::generate_context!())
        .expect("error while running NightCut");
}
