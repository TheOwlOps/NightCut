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
    #[error("could not parse JSON output: {0}")]
    Json(#[from] serde_json::Error),
    #[error("onnx background removal failed: {0}")]
    Ort(String),
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

/// One auto-caption cue from speech recognition.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CaptionCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Extract a 16kHz mono WAV (what whisper.cpp expects) from a media file.
pub fn extract_audio_wav(source: &Path, out_wav: &Path) -> Result<PathBuf> {
    let status = Command::new("ffmpeg")
        .args(["-y", "-v", "error", "-i"])
        .arg(source)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(out_wav)
        .status()?;
    if !status.success() { return Err(MediaError::FfmpegFailed(status)); }
    Ok(out_wav.to_path_buf())
}

/// Parse an `HH:MM:SS,mmm` whisper timestamp into seconds.
pub fn parse_whisper_timestamp(ts: &str) -> Option<f64> {
    let parts: Vec<&str> = ts.trim().split(':').collect();
    if parts.len() != 3 { return None; }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].replace(',', ".").parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Parse the JSON produced by `whisper-cli -oj` into caption cues.
pub fn parse_whisper_json(json: &str) -> Result<Vec<CaptionCue>> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    let segments = value["transcription"].as_array().cloned().unwrap_or_default();
    let mut cues = Vec::new();
    for seg in segments {
        let (Some(from), Some(to)) = (
            seg["timestamps"]["from"].as_str(),
            seg["timestamps"]["to"].as_str(),
        ) else { continue };
        let text = seg["text"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() { continue; }
        if let (Some(start), Some(end)) =
            (parse_whisper_timestamp(from), parse_whisper_timestamp(to))
        {
            cues.push(CaptionCue { start, end, text });
        }
    }
    Ok(cues)
}

/// Transcribe `wav` with a whisper.cpp binary (`whisper-cli`) and model,
/// returning caption cues. Fully local — the open-source answer to
/// CapCut's cloud auto-captions.
pub fn whisper_captions(whisper_bin: &Path, model: &Path, wav: &Path) -> Result<Vec<CaptionCue>> {
    let out_base = wav.with_extension("whisper");
    let status = Command::new(whisper_bin)
        .args(["-m"])
        .arg(model)
        .args(["-f"])
        .arg(wav)
        .args(["-oj", "-of"])
        .arg(&out_base)
        .status()?;
    if !status.success() { return Err(MediaError::FfmpegFailed(status)); }
    let json_path = out_base.with_extension("json");
    let json = std::fs::read_to_string(&json_path)?;
    parse_whisper_json(&json)
}

/// Local text-to-speech via FFmpeg's flite (libflite) source — the local
/// substitute for CapCut's cloud TTS voices. Returns the WAV path.
pub fn synthesize_speech(text: &str, voice: &str, out_wav: &Path) -> Result<PathBuf> {
    // flite's text quoting: single quotes inside the filter arg are the
    // risk; strip them rather than fight FFmpeg escaping rules.
    let safe: String = text.chars().filter(|c| *c != '\'' && *c != '\\').collect();
    let source = format!("flite=text='{safe}':voice={voice}");
    let status = Command::new("ffmpeg")
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", &source])
        .arg(out_wav)
        .status()?;
    if !status.success() { return Err(MediaError::FfmpegFailed(status)); }
    Ok(out_wav.to_path_buf())
}

/// Beat/onset detection from spectral flux over the decoded waveform:
/// windowed energy increases above an adaptive threshold become beats.
/// Returns (beat times in seconds, estimated BPM).
pub fn detect_beats(path: &Path) -> Result<(Vec<f64>, f64)> {
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
    Ok(beat_track(&samples, 8000))
}

/// Pure onset-flux beat tracker (unit-testable without FFmpeg).
pub fn beat_track(samples: &[f32], sample_rate: u32) -> (Vec<f64>, f64) {
    let hop = 256usize; // 32ms at 8kHz
    let win = 1024usize;
    let mut energies: Vec<f64> = Vec::new();
    let mut i = 0usize;
    while i + win <= samples.len() {
        let e: f64 = samples[i..i + win].iter().map(|s| (*s as f64) * (*s as f64)).sum();
        energies.push(e);
        i += hop;
    }
    if energies.len() < 8 { return (Vec::new(), 0.0); }
    // Positive energy flux, adaptive threshold = local mean * 1.5.
    let mut beats: Vec<f64> = Vec::new();
    let mut last_beat = -1.0f64;
    for n in 1..energies.len() {
        let flux = energies[n] - energies[n - 1];
        if flux <= 0.0 { continue; }
        let lo = n.saturating_sub(16);
        let local_mean = energies[lo..n].iter().sum::<f64>() / (n - lo) as f64;
        let t = (n * hop) as f64 / sample_rate as f64;
        if energies[n] > local_mean * 1.6 + 1e-6 && t - last_beat >= 0.25 {
            beats.push(t);
            last_beat = t;
        }
    }
    // BPM from the median inter-beat interval.
    let bpm = if beats.len() >= 2 {
        let mut intervals: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).collect();
        intervals.sort_by(|a, b| a.total_cmp(b));
        let median = intervals[intervals.len() / 2];
        if median > 0.0 { 60.0 / median } else { 0.0 }
    } else {
        0.0
    };
    (beats, bpm)
}

/// Scene-change detection (CapCut Split Scenes): runs FFmpeg's scene
/// scoring over thumbnails and returns cut times (seconds, excluding 0)
/// where the score passes `threshold` (0..1, 0.4 is a sane default).
pub fn detect_scenes(path: &Path, threshold: f64) -> Result<Vec<f64>> {
    let out = Command::new("ffmpeg")
        .args(["-v", "info", "-i"])
        .arg(path)
        .args(["-vf", &format!("select='gt(scene,{threshold:.2})',metadata=print:file=-"), "-f", "null", "-"])
        .output()?;
    let text = String::from_utf8_lossy(&out.stderr).to_string()
        + &String::from_utf8_lossy(&out.stdout);
    Ok(parse_scene_times(&text))
}

/// Parse an SRT subtitle document into caption cues.
pub fn parse_srt(text: &str) -> Vec<CaptionCue> {
    fn ts(s: &str) -> f64 {
        // 00:01:02,500 -> seconds
        let parts: Vec<&str> = s.trim().split([':', ',']).collect();
        if parts.len() == 4 {
            let h: f64 = parts[0].parse().unwrap_or(0.0);
            let m: f64 = parts[1].parse().unwrap_or(0.0);
            let sec: f64 = parts[2].parse().unwrap_or(0.0);
            let ms: f64 = parts[3].parse().unwrap_or(0.0);
            h * 3600.0 + m * 60.0 + sec + ms / 1000.0
        } else {
            0.0
        }
    }
    let mut cues = Vec::new();
    for block in text.replace("\r\n", "\n").split("\n\n") {
        let mut lines = block.lines().filter(|l| !l.trim().is_empty());
        let _ = lines.next(); // index line (may be the timing line itself)
        let timing = block.lines().find(|l| l.contains("-->"));
        let Some(timing) = timing else { continue };
        let mut it = timing.split("-->");
        let (Some(a), Some(b)) = (it.next(), it.next()) else { continue };
        let body: Vec<&str> = block.lines().skip_while(|l| !l.contains("-->")).skip(1).collect();
        if body.is_empty() { continue; }
        let _ = lines;
        cues.push(CaptionCue { start: ts(a), end: ts(b), text: body.join(" ") });
    }
    cues
}

/// Parse `pts_time:` values out of ffmpeg metadata=print output.
pub fn parse_scene_times(text: &str) -> Vec<f64> {
    let mut times: Vec<f64> = Vec::new();
    for line in text.lines() {
        if let Some(idx) = line.find("pts_time:") {
            let rest = &line[idx + "pts_time:".len()..];
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if let Ok(t) = num.parse::<f64>() {
                if t > 0.05 { times.push(t); }
            }
        }
    }
    times.sort_by(|a, b| a.total_cmp(b));
    times.dedup_by(|a, b| (*a - *b).abs() < 0.05);
    times
}

/// Silence detection (CapCut remove pauses / jump cuts): returns
/// (start, end) silent ranges via FFmpeg silencedetect.
pub fn detect_silences(path: &Path, noise_db: f64, min_duration: f64) -> Result<Vec<(f64, f64)>> {
    let out = Command::new("ffmpeg")
        .args(["-v", "info", "-i"])
        .arg(path)
        .args(["-af", &format!("silencedetect=noise={noise_db:.1}dB:d={min_duration:.2}"), "-f", "null", "-"])
        .output()?;
    let text = String::from_utf8_lossy(&out.stderr);
    Ok(parse_silences(&text))
}

/// Parse silencedetect start/end pairs from ffmpeg stderr.
pub fn parse_silences(text: &str) -> Vec<(f64, f64)> {
    let mut ranges = Vec::new();
    let mut pending: Option<f64> = None;
    for line in text.lines() {
        if let Some(idx) = line.find("silence_start:") {
            let num: String = line[idx + 15..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            pending = num.parse().ok();
        } else if let Some(idx) = line.find("silence_end:") {
            let num: String = line[idx + 13..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if let (Some(s), Ok(e)) = (pending, num.parse::<f64>()) {
                ranges.push((s, e));
                pending = None;
            }
        }
    }
    ranges
}

/// One tracked position: time (s, source-relative) and normalized frame
/// coordinates of the tracked patch center (0..1).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TrackPoint {
    pub t: f64,
    pub nx: f64,
    pub ny: f64,
}

/// Motion tracking by template matching: the center patch of the first
/// frame (at `start_sec`) is followed through the clip with normalized
/// cross-correlation over downscaled grayscale frames. Deterministic and
/// dependency-free — good enough for follow-cam keyframes.
pub fn track_motion(
    source: &Path,
    start_sec: f64,
    duration_sec: f64,
) -> Result<Vec<TrackPoint>> {
    const W: usize = 160;
    const H: usize = 90;
    let fps = 5u32;
    let frame_bytes = W * H;
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-ss", &format!("{start_sec:.3}"), "-i"])
        .arg(source)
        .args([
            "-t", &format!("{duration_sec:.3}"),
            "-vf", &format!("fps={fps},scale={W}:{H},format=gray"),
            "-f", "rawvideo", "-",
        ])
        .output()?;
    if !out.status.success() { return Err(MediaError::FfmpegFailed(out.status)); }
    let frames: Vec<&[u8]> = out.stdout.chunks_exact(frame_bytes).collect();
    if frames.len() < 2 { return Ok(Vec::new()); }

    // Template: the highest-variance 24x24 patch of frame 0 — the most
    // "interesting" region (usually the subject), not a flat background.
    let (pw, ph) = (24usize, 24usize);
    let (mut cx0, mut cy0) = (W / 2, H / 2);
    {
        let mut best_var = -1.0f64;
        let mut y = ph / 2;
        while y + ph / 2 < H {
            let mut x = pw / 2;
            while x + pw / 2 < W {
                let mut sum = 0.0f64;
                let mut sq = 0.0f64;
                for py in 0..ph {
                    for px in 0..pw {
                        let v = frames[0][(y - ph / 2 + py) * W + (x - pw / 2 + px)] as f64;
                        sum += v;
                        sq += v * v;
                    }
                }
                let n = (pw * ph) as f64;
                let var = sq / n - (sum / n).powi(2);
                if var > best_var {
                    best_var = var;
                    cx0 = x;
                    cy0 = y;
                }
                x += 8;
            }
            y += 8;
        }
    }
    let template: Vec<u8> = (0..ph)
        .flat_map(|y| frames[0][(cy0 - ph / 2 + y) * W + (cx0 - pw / 2)..(cy0 - ph / 2 + y) * W + (cx0 + pw / 2)].to_vec())
        .collect();
    let tmean = template.iter().map(|p| *p as f64).sum::<f64>() / template.len() as f64;
    let tvar: f64 = template.iter().map(|p| (*p as f64 - tmean).powi(2)).sum();

    let mut points = Vec::new();
    let (mut cx, mut cy) = (cx0 as i32, cy0 as i32);
    for (fi, frame) in frames.iter().enumerate() {
        // Search a window around the last position.
        let (mut best, mut bx, mut by) = (f64::MIN, cx, cy);
        let r = 20i32;
        for dy in -r..=r {
            for dx in -r..=r {
                let (x, y) = (cx + dx, cy + dy);
                if x < (pw / 2) as i32 || y < (ph / 2) as i32
                    || x + (pw / 2) as i32 >= W as i32 || y + (ph / 2) as i32 >= H as i32
                {
                    continue;
                }
                let mut num = 0.0f64;
                let mut dsum = 0.0f64;
                let mut dsq = 0.0f64;
                for py in 0..ph {
                    for px in 0..pw {
                        let v = frame[(y as usize - ph / 2 + py) * W + (x as usize - pw / 2 + px)] as f64;
                        dsum += v;
                        dsq += v * v;
                        num += (template[py * pw + px] as f64 - tmean) * v;
                    }
                }
                // num already sums (template - tmean) * v, and since the
                // template deviations sum to zero this is the covariance.
                let n = (pw * ph) as f64;
                let dvar = dsq - dsum * dsum / n;
                let score = if tvar > 0.0 && dvar > 0.0 {
                    num / (tvar.sqrt() * dvar.sqrt())
                } else {
                    0.0
                };
                if score > best {
                    best = score;
                    bx = x;
                    by = y;
                }
            }
        }
        cx = bx;
        cy = by;
        points.push(TrackPoint {
            t: fi as f64 / fps as f64,
            nx: cx as f64 / W as f64,
            ny: cy as f64 / H as f64,
        });
    }
    Ok(points)
}

/// AI background removal (CapCut "Remove BG"), fully local: u2netp ONNX
/// segmentation per frame -> alpha mask -> the subject composited over
/// black in a new MP4 (the export engine composites clips over the
/// canvas the same way). The ONNX Runtime shared library and the model
/// are sidecar files (see tools/onnx/README.md), loaded dynamically —
/// nothing is bundled.
pub fn remove_background(
    source: &Path,
    output: &Path,
    model: &Path,
    ort_dylib: &Path,
) -> Result<PathBuf> {
    use std::io::{Read, Write};
    use std::process::Stdio;

    static ORT_ENV: std::sync::OnceLock<std::result::Result<ort::environment::Environment, String>> =
        std::sync::OnceLock::new();
    let env = ORT_ENV
        .get_or_init(|| {
            ort::init_from(ort_dylib)
                .map_err(|e| e.to_string())
                .and_then(|b| b.build().map_err(|e| e.to_string()))
        })
        .as_ref()
        .map_err(|e| MediaError::Ort(format!("could not load ONNX Runtime from {}: {e}", ort_dylib.display())))?;
    let info = probe(source)?;
    let (w, h) = (info.width as usize, info.height as usize);
    let fps = info.fps.clamp(1.0, 15.0);
    let mut session = ort::session::Session::builder(env)
        .map_err(|e| MediaError::Ort(e.to_string()))?
        .commit_from_file(model)
        .map_err(|e| MediaError::Ort(e.to_string()))?;
    let input_name = session.inputs()[0].name().to_string();

    // Encoder: Rust composites each frame over black with the mask
    // (frame * alpha) and pipes RGB to a plain MP4 encoder. Deliberately
    // no alpha-in-WebM: ffmpeg/VP9 alpha round-trips are fragile, while
    // our export engine composites clips over the (black) canvas anyway.
    let mut encoder = Command::new("ffmpeg")
        .args(["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", &format!("{w}x{h}"), "-r", &format!("{fps:.2}"), "-i", "-", "-i"])
        .arg(source)
        .args([
            "-map", "0:v", "-map", "1:a?",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
            "-c:a", "aac", "-shortest",
        ])
        .arg(output)
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut enc_stdin = encoder.stdin.take().expect("encoder stdin");

    // Decoder: RGB frames at the same rate.
    let mut decoder = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(source)
        .args(["-vf", "fps=15,format=rgb24", "-f", "rawvideo", "-"])
        .stdout(Stdio::piped())
        .spawn()?;
    let mut dec_stdout = decoder.stdout.take().expect("decoder stdout");

    const S: usize = 320;
    let frame_len = w * h * 3;
    let mut frame = vec![0u8; frame_len];
    let mut frames_done = 0usize;
    loop {
        let mut filled = 0usize;
        while filled < frame_len {
            match dec_stdout.read(&mut frame[filled..]) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => return Err(MediaError::Spawn(e)),
            }
        }
        if filled < frame_len { break; }

        // Downscale (nearest) to 320x320 + ImageNet normalization (the
        // normalization rembg uses for u2net-family models).
        let mut input = vec![0f32; 3 * S * S];
        for y in 0..S {
            for x in 0..S {
                let sx = (x * w / S).min(w - 1);
                let sy = (y * h / S).min(h - 1);
                let base = (sy * w + sx) * 3;
                let means = [0.485f32, 0.456, 0.406];
                let stds = [0.229f32, 0.224, 0.225];
                for c in 0..3 {
                    input[c * S * S + y * S + x] =
                        ((frame[base + c] as f32 / 255.0) - means[c]) / stds[c];
                }
            }
        }
        let tensor = ort::value::Tensor::from_array(([1usize, 3, S, S], input))
            .map_err(|e| MediaError::Ort(e.to_string()))?;
        let outputs = session
            .run(ort::inputs![input_name.as_str() => tensor])
            .map_err(|e| MediaError::Ort(e.to_string()))?;
        let (_, mask_data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| MediaError::Ort(e.to_string()))?;
        // Min-max normalize the saliency map (rembg does the same).
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for v in mask_data.iter() {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
        let range = (hi - lo).max(1e-6);
        if std::env::var("NIGHTCUT_BG_DEBUG").is_ok() && frames_done == 0 {
            let c = mask_data[(S / 2) * S + S / 2];
            let corner = mask_data[2 * S + 2];
            eprintln!("mask lo={lo} hi={hi} center={c} corner={corner}");
        }
        // Upscale mask (nearest) and composite the frame over black.
        let mut rgb = vec![0u8; frame_len];
        for y in 0..h {
            for x in 0..w {
                let mx = (x * S / w.max(1)).min(S - 1);
                let my = (y * S / h.max(1)).min(S - 1);
                let a = ((mask_data[my * S + mx] - lo) / range).clamp(0.0, 1.0);
                let base = (y * w + x) * 3;
                for c in 0..3 {
                    rgb[base + c] = (frame[base + c] as f32 * a) as u8;
                }
            }
        }
        enc_stdin.write_all(&rgb)?;
        frames_done += 1;
    }
    drop(enc_stdin);
    let enc_out = encoder.wait_with_output()?;
    let _ = decoder.wait();
    if !enc_out.status.success() || frames_done == 0 {
        return Err(MediaError::Ort(format!(
            "encoder failed after {frames_done} frames: {}",
            String::from_utf8_lossy(&enc_out.stderr).chars().take(200).collect::<String>()
        )));
    }
    Ok(output.to_path_buf())
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

    #[test]
    #[ignore = "needs ffmpeg flite + a generated video"]
    fn live_tts_and_tracking() {
        let dir = std::env::temp_dir();
        // TTS produces a real WAV.
        let wav = dir.join("nc-tts-test.wav");
        synthesize_speech("hello night cut", "slt", &wav).expect("tts");
        let peaks = waveform_peaks(&wav, 50).expect("waveform tts");
        assert!(peaks.iter().any(|p| *p > 0.1), "tts wav should contain speech");

        // Tracking: white square moving right across a black 320x180 frame.
        let vid = dir.join("nc-track-test.mp4");
        let status = Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                   "color=c=black:s=320x180:r=10:d=2",
                   "-vf", "geq=lum='if(between(X\\,20+120*T\\,50+120*T)*between(Y\\,75\\,105)\\,255\\,0)':cb=128:cr=128",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&vid).status().unwrap();
        assert!(status.success());
        let points = track_motion(&vid, 0.0, 2.0).expect("track");
        assert!(points.len() >= 8, "points: {}", points.len());
        let first = points.first().unwrap().nx;
        let last = points.last().unwrap().nx;
        assert!(last > first + 0.2, "square should move right: {first} -> {last}");
    }

    #[test]
    #[ignore = "needs ONNX sidecar files (NIGHTCUT_ORT_DIR) and ffmpeg"]
    fn live_background_removal() {
        let ort_dir = std::env::var("NIGHTCUT_ORT_DIR").expect("NIGHTCUT_ORT_DIR");
        let dir = PathBuf::from(&ort_dir);
        let dylib = dir.join("libonnxruntime.so");
        let model = dir.join("u2netp.onnx");
        // Scene: bright subject blob centered on a dark background.
        let src = std::env::temp_dir().join("nc-bg-src.mp4");
        let status = Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                   "color=c=0x101030:s=320x240:r=10:d=1",
                   "-vf", "geq=lum='if(lt(hypot(X-160\\,Y-120)\\,55)\\,230\\,16)':cb=90:cr=160",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&src).status().unwrap();
        assert!(status.success());
        let out = std::env::temp_dir().join("nc-bg-out.mp4");
        remove_background(&src, &out, &model, &dylib).expect("remove bg");
        // Decode one frame: subject stays bright, background goes black.
        let raw = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(&out)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
            .output().unwrap();
        assert!(raw.status.success());
        let px = |x: usize, y: usize| raw.stdout[y * 320 + x];
        let (center, corner) = (px(160, 120), px(4, 4));
        assert!(center > 150, "subject should stay bright, got {center}");
        assert!(corner < 60, "background should be removed to black, got {corner}");
    }

    #[test]
    fn scene_and_silence_parsers() {
        let scene_log = "frame:1 pts:100 pts_time:2.5\nframe:2 pts:200 pts_time:5.0\n";
        assert_eq!(parse_scene_times(scene_log), vec![2.5, 5.0]);
        let sil_log = "[silencedetect] silence_start: 1.25\n[silencedetect] silence_end: 3.5 | silence_duration: 2.25\n";
        assert_eq!(parse_silences(sil_log), vec![(1.25, 3.5)]);
    }

    #[test]
    fn beat_track_finds_periodic_onsets() {
        // 2 seconds of 8kHz audio: short loud bursts every 0.5s (120 BPM).
        let sr = 8000usize;
        let mut samples = vec![0.0f32; sr * 2];
        for burst in 0..4 {
            let start = burst * sr / 2;
            for i in 0..400 {
                samples[start + i] = 0.9;
            }
        }
        let (beats, bpm) = beat_track(&samples, sr as u32);
        assert!(beats.len() >= 3, "beats: {beats:?}");
        assert!((bpm - 120.0).abs() < 30.0, "bpm: {bpm}");
    }

    #[test]
    fn whisper_timestamps_and_json_parse() {
        assert_eq!(parse_whisper_timestamp("00:01:02,500"), Some(62.5));
        assert_eq!(parse_whisper_timestamp("01:00:00.000"), Some(3600.0));
        let json = r#"{"transcription":[
            {"timestamps":{"from":"00:00:00,000","to":"00:00:02,760"},
             "offsets":{"from":0,"to":2760},"text":" Ask not what your country"},
            {"timestamps":{"from":"00:00:02,760","to":"00:00:05,000"},
             "offsets":{"from":2760,"to":5000},"text":"  "}
        ]}"#;
        let cues = parse_whisper_json(json).unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Ask not what your country");
        assert_eq!(cues[0].end, 2.76);
    }

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
