//! NightCut media engine: everything that touches real media files.
//!
//! Design rules (see docs/BLUEPRINT.md):
//! - Probe with ffprobe, never decode on the UI thread.
//! - On import, generate a lightweight proxy + thumbnails + waveform peaks
//!   and cache them on disk; editing/scrubbing only touches the cache.
//! - FFmpeg is an external sidecar binary (downloaded on first run), so the
//!   app installer stays small.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("ffprobe/ffmpeg failed to start: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("ffprobe returned no video stream")]
    NoVideoStream,
    #[error("could not parse ffprobe output: {0}")]
    Parse(String),
    #[error("ffmpeg exited with status {0}")]
    FfmpegFailed(std::process::ExitStatus),
}

pub type Result<T> = std::result::Result<T, MediaError>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MediaInfo {
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: String,
    pub has_audio: bool,
}

/// Parse ffprobe's `-of json` output. Pure function — unit-testable without
/// a real media file.
pub fn parse_probe_json(json: &str) -> Result<MediaInfo> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| MediaError::Parse(e.to_string()))?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter()
        .find(|s| s["codec_type"] == "video")
        .ok_or(MediaError::NoVideoStream)?;
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let fps = video["avg_frame_rate"].as_str()
        .and_then(|r| {
            let (n, d) = r.split_once('/')?;
            let n: f64 = n.parse().ok()?;
            let d: f64 = d.parse().ok()?;
            if d == 0.0 { None } else { Some(n / d) }
        })
        .unwrap_or(0.0);
    let duration_sec = v["format"]["duration"].as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| video["duration"].as_str().and_then(|d| d.parse::<f64>().ok()))
        .unwrap_or(0.0);
    Ok(MediaInfo {
        duration_sec,
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        fps,
        video_codec: video["codec_name"].as_str().unwrap_or("").to_string(),
        has_audio,
    })
}

/// Probe a media file with ffprobe (must be on PATH or provided by the
/// sidecar in tools/ffmpeg/bin).
pub fn probe(path: &Path) -> Result<MediaInfo> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_streams", "-show_format", "-of", "json"])
        .arg(path)
        .output()?;
    parse_probe_json(&String::from_utf8_lossy(&out.stdout))
}

/// Arguments to build a preview proxy: max 720px tall, fast-start, cheap
/// codec settings. The proxy is what the timeline actually plays/scrubs.
pub fn proxy_args(input: &Path, output: &Path) -> Vec<String> {
    vec![
        "-y".into(), "-v".into(), "error".into(),
        "-i".into(), input.display().to_string(),
        "-vf".into(), "scale=-2:min(720\\,ih)".into(),
        "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
        "-crf".into(), "28".into(),
        "-c:a".into(), "aac".into(), "-b:a".into(), "96k".into(),
        "-movflags".into(), "+faststart".into(),
        output.display().to_string(),
    ]
}

pub fn make_proxy(input: &Path, output: &Path) -> Result<PathBuf> {
    let status = Command::new("ffmpeg").args(proxy_args(input, output)).status()?;
    if !status.success() { return Err(MediaError::FfmpegFailed(status)); }
    Ok(output.to_path_buf())
}

/// Arguments to extract one thumbnail per second into a contact-sheet dir
/// (`frame_%04d.jpg`). The timeline renders these instead of decoding.
pub fn thumbnail_args(input: &Path, out_pattern: &Path, fps: u32) -> Vec<String> {
    vec![
        "-y".into(), "-v".into(), "error".into(),
        "-i".into(), input.display().to_string(),
        "-vf".into(), format!("fps={fps},scale=160:-2"),
        out_pattern.display().to_string(),
    ]
}

/// Reduce raw mono f32 samples to per-bucket peak values for waveform
/// rendering. Pure function: the UI draws peaks, it never sees samples.
pub fn compute_peaks(samples: &[f32], buckets: usize) -> Vec<f32> {
    if buckets == 0 || samples.is_empty() { return vec![0.0; buckets]; }
    let per = (samples.len() as f64 / buckets as f64).ceil() as usize;
    (0..buckets).map(|b| {
        let start = b * per;
        if start >= samples.len() { return 0.0; }
        let end = ((b + 1) * per).min(samples.len());
        samples[start..end].iter().fold(0.0f32, |m, s| m.max(s.abs()))
    }).collect()
}

/// Extract waveform peaks by decoding audio to mono 8kHz f32 via FFmpeg.
pub fn waveform_peaks(path: &Path, buckets: usize) -> Result<Vec<f32>> {
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-ac", "1", "-ar", "8000", "-f", "f32le", "-"])
        .output()?;
    if !out.status.success() { return Err(MediaError::FfmpegFailed(out.status)); }
    let samples: Vec<f32> = out.stdout
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Ok(compute_peaks(&samples, buckets))
}

/// Deterministic cache file name for a source file, based on its path and
/// modification time, e.g. `a1b2c3d4.proxy.mp4`.
pub fn cache_key(path: &Path) -> String {
    let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a
    let s = path.display().to_string();
    for b in s.bytes() { hash ^= b as u64; hash = hash.wrapping_mul(0x100000001b3); }
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(mtime) = meta.modified() {
            if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                hash ^= dur.as_secs();
            }
        }
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROBE_JSON: &str = r#"{
        "streams": [
            {"codec_type":"video","codec_name":"h264","width":3840,"height":2160,
             "avg_frame_rate":"30000/1001","duration":"12.5"},
            {"codec_type":"audio","codec_name":"aac"}
        ],
        "format": {"duration": "12.512"}
    }"#;

    #[test]
    fn parses_probe_json() {
        let info = parse_probe_json(PROBE_JSON).unwrap();
        assert_eq!(info.width, 3840);
        assert_eq!(info.height, 2160);
        assert!((info.fps - 29.97).abs() < 0.01);
        assert!((info.duration_sec - 12.512).abs() < 0.001);
        assert!(info.has_audio);
        assert_eq!(info.video_codec, "h264");
    }

    #[test]
    fn probe_without_video_errors() {
        assert!(parse_probe_json(r#"{"streams":[],"format":{}}"#).is_err());
    }

    #[test]
    fn proxy_args_target_720p() {
        let args = proxy_args(Path::new("in.mp4"), Path::new("out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("min(720"));
        assert!(joined.contains("libx264"));
        assert!(args.last().unwrap() == "out.mp4");
    }

    #[test]
    fn peaks_are_bucket_maxima() {
        let samples = vec![0.1, -0.9, 0.3, 0.2, -0.4, 0.05];
        let peaks = compute_peaks(&samples, 3);
        assert_eq!(peaks, vec![0.9, 0.3, 0.4]);
    }

    #[test]
    fn peaks_handle_empty() {
        assert_eq!(compute_peaks(&[], 4), vec![0.0; 4]);
    }

    #[test]
    fn cache_key_is_stable() {
        let a = cache_key(Path::new("/tmp/nonexistent-a.mp4"));
        let b = cache_key(Path::new("/tmp/nonexistent-a.mp4"));
        assert_eq!(a, b);
        assert_ne!(a, cache_key(Path::new("/tmp/nonexistent-b.mp4")));
    }
}
