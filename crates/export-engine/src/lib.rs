//! NightCut export engine: turns a non-destructive `Project` into one
//! FFmpeg invocation.
//!
//! Phase 0 scope (single sequential video track + text overlays):
//! - each video clip is trimmed, speed-adjusted, scaled/padded to canvas
//! - clips are concatenated in timeline order
//! - text clips become `drawtext` overlays enabled during their window
//! - audio comes from the video clips; a separate music track is mixed in
//!   when present (first audio-track clip, volume-scaled, looped/trimmed)
//! Anything richer (multi-layer compositing) belongs to the wgpu compositor
//! in a later phase — this module is the real render path until then.

use editor_core::{Effect, Project, TrackKind};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("project has no video clips to export")]
    NoVideoClips,
    #[error("clip {0} has no resolved source path")]
    UnresolvedSource(String),
    #[error("ffmpeg failed to start: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("ffmpeg exited with status {0}")]
    FfmpegFailed(std::process::ExitStatus),
}

pub type Result<T> = std::result::Result<T, ExportError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    /// libx264 — always available.
    Software,
    /// NVIDIA NVENC.
    Nvenc,
    /// Intel QuickSync.
    QuickSync,
    /// Apple VideoToolbox (macOS).
    VideoToolbox,
}

impl Encoder {
    pub fn ffmpeg_codec(&self) -> &'static str {
        match self {
            Encoder::Software => "libx264",
            Encoder::Nvenc => "h264_nvenc",
            Encoder::QuickSync => "h264_qsv",
            Encoder::VideoToolbox => "h264_videotoolbox",
        }
    }
    /// Best encoder to try first on this OS, before falling back to software.
    pub fn preferred_for_os() -> Self {
        if cfg!(target_os = "macos") { Encoder::VideoToolbox }
        else { Encoder::Software }
    }
}

#[derive(Debug, Clone)]
pub struct ExportSettings {
    pub encoder: Encoder,
    pub crf: u8,
    /// Optional drawtext font file; FFmpeg needs a real font path for text.
    pub font_file: Option<PathBuf>,
    /// Output height cap (e.g. 720 for a 720p export); width scales to
    /// keep the canvas aspect. None = canvas size.
    pub max_height: Option<u32>,
    /// Render an animated GIF instead of an MP4 (video only, 15 fps).
    pub gif: bool,
    /// Render audio only (CapCut's audio export): codec follows the
    /// output extension (.mp3/.wav/.m4a, default AAC in .m4a).
    pub audio_only: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self { encoder: Encoder::Software, crf: 20, font_file: None, max_height: None, gif: false, audio_only: false }
    }
}

/// Translate one effect into FFmpeg *video* filters for a clip.
/// `clip_duration` is the clip's played duration (after trim/speed).
pub fn effect_video_filters(effect: &Effect, clip_duration: f64) -> Vec<String> {
    match *effect {
        Effect::Adjust { brightness, contrast, saturation } => vec![format!(
            "eq=brightness={brightness:.3}:contrast={contrast:.3}:saturation={saturation:.3}"
        )],
        Effect::Grayscale => vec!["hue=s=0".to_string()],
        Effect::Sepia { intensity } => {
            let i = intensity.clamp(0.0, 1.0);
            let sepia = [
                [0.393, 0.769, 0.189],
                [0.349, 0.686, 0.168],
                [0.272, 0.534, 0.131],
            ];
            let mut vals: Vec<String> = Vec::new();
            for (row_idx, row) in sepia.iter().enumerate() {
                for (col_idx, target) in row.iter().enumerate() {
                    let identity = if row_idx == col_idx { 1.0 } else { 0.0 };
                    vals.push(format!("{:.3}", identity + (target - identity) * i));
                }
                vals.push("0".to_string()); // alpha contribution per row
            }
            vals.extend(["0".to_string(), "0".to_string(), "0".to_string(), "1".to_string()]);
            vec![format!("colorchannelmixer={}", vals.join(":"))]
        }
        Effect::Blur { sigma } => vec![format!("gblur=sigma={:.2}", sigma.clamp(0.0, 50.0))],
        Effect::Sharpen { amount } => {
            vec![format!("unsharp=5:5:{:.2}:5:5:0", amount.clamp(0.0, 2.0))]
        }
        Effect::Vignette { strength } => {
            let angle = (1.35 - strength.clamp(0.0, 1.0)).clamp(0.35, 1.35);
            vec![format!("vignette=angle={angle:.3}")]
        }
        Effect::Temperature { kelvin } => vec![format!(
            "colortemperature=temperature={:.0}:mix=1",
            kelvin.clamp(1000.0, 11000.0)
        )],
        Effect::Mirror => vec!["hflip".to_string()],
        Effect::Invert => vec!["negate".to_string()],
        Effect::FadeIn { duration } => {
            vec![format!("fade=t=in:st=0.000:d={:.3}", duration.max(0.0))]
        }
        Effect::FadeOut { duration } => {
            let st = (clip_duration - duration).max(0.0);
            vec![format!("fade=t=out:st={st:.3}:d={:.3}", duration.max(0.0))]
        }
        Effect::Reverse => vec!["reverse".to_string()],
        Effect::ChromaKey { ref color, similarity, blend } => vec![format!(
            "chromakey=color=0x{}:similarity={:.3}:blend={:.3}",
            color.trim_start_matches('#'),
            similarity.clamp(0.0, 1.0),
            blend.clamp(0.0, 1.0)
        )],
        Effect::Denoise { .. } => Vec::new(), // audio-only effect
        Effect::Mask { .. } => Vec::new(),    // rendered via the alpha matte
        Effect::Stabilize { .. } => Vec::new(), // needs the detect-pass transforms (render())
        Effect::PitchShift { .. } => Vec::new(), // audio-only effect
        Effect::Loudnorm { .. } => Vec::new(),  // audio-only effect
        Effect::Lut { ref path } => vec![format!("lut3d=file='{}'", path.replace('\'', "\\'"))],
        Effect::Deflicker { size } => vec![format!("deflicker=size={}:mode=pm", size.clamp(2, 30))],
        Effect::Hsl { ref shifts } => {
            vec![format!("lut3d=file='{}'", hsl_cube_path(shifts).display())]
        }
        Effect::VideoDenoise { strength } => {
            let s = strength.clamp(0.0, 1.0);
            vec![format!("hqdn3d={:.1}:{:.1}:{:.1}:{:.1}", 2.0 + s * 8.0, 2.0 + s * 8.0, 3.0 + s * 10.0, 3.0 + s * 10.0)]
        }
        Effect::Curves { ref master, ref red, ref green, ref blue } => {
            let mut parts = Vec::new();
            if !master.is_empty() { parts.push(format!("master='{master}'")); }
            if !red.is_empty() { parts.push(format!("red='{red}'")); }
            if !green.is_empty() { parts.push(format!("green='{green}'")); }
            if !blue.is_empty() { parts.push(format!("blue='{blue}'")); }
            if parts.is_empty() { Vec::new() } else { vec![format!("curves={}", parts.join(":"))] }
        }
        Effect::ColorWheels { shadows, midtones, highlights } => {
            let f = |v: &[f64; 3]| {
                format!(
                    "{:.2}:{:.2}:{:.2}",
                    v[0].clamp(-1.0, 1.0), v[1].clamp(-1.0, 1.0), v[2].clamp(-1.0, 1.0)
                )
            };
            let (s, m, h) = (f(&shadows), f(&midtones), f(&highlights));
            let sp: Vec<&str> = s.split(':').collect();
            let mp: Vec<&str> = m.split(':').collect();
            let hp: Vec<&str> = h.split(':').collect();
            vec![format!(
                "colorbalance=rs={}:gs={}:bs={}:rm={}:gm={}:bm={}:rh={}:gh={}:bh={}",
                sp[0], sp[1], sp[2], mp[0], mp[1], mp[2], hp[0], hp[1], hp[2]
            )]
        }
    }
}

/// The clip's shape mask, if it has a Mask effect.
pub fn clip_mask(clip: &editor_core::Clip) -> Option<(String, f64, f64, bool)> {
    clip.effects.iter().find_map(|fx| match fx {
        Effect::Mask { shape, size, feather, invert } => {
            Some((shape.clone(), *size, *feather, *invert))
        }
        _ => None,
    })
}

/// Whether the clip asks for stabilization.
pub fn clip_stabilize_smoothing(clip: &editor_core::Clip) -> Option<u32> {
    clip.effects.iter().find_map(|fx| match fx {
        Effect::Stabilize { smoothing } => Some(*smoothing),
        _ => None,
    })
}

/// Per-pixel matte value (0..1) expression over geq's X, Y, W, H, T,
/// combining keyframed opacity (over T) and the shape mask (over X, Y).
/// `None` means fully opaque everywhere. Rendered as a gray stream and
/// alphamerged onto the clip — one matte handles both, exactly.
pub fn matte_value_expr(clip: &editor_core::Clip, w: u32, h: u32) -> Option<String> {
    let opacity = keyframe_opacity_expr(clip);
    let mask = clip_mask(clip).map(|(shape, size, feather, invert)| {
        let size = size.clamp(0.05, 1.0);
        let feather_px = (feather.clamp(0.0, 1.0) * (w.min(h) as f64) * 0.5).max(1.0);
        // Signed distance outside the shape (positive = outside).
        // Linear mask: a gradient band sweeping along X; `size` places
        // the band center, feather its width.
        let sd = if shape == "linear" {
            format!("X-{:.1}", (w as f64) * size)
        } else if shape == "circle" {
            format!("hypot(X-W/2,H/2-Y)-{:.1}", (w.min(h) as f64) * size / 2.0)
        } else {
            format!(
                "max(abs(X-W/2)-{:.1},abs(Y-H/2)-{:.1})",
                (w as f64) * size / 2.0,
                (h as f64) * size / 2.0
            )
        };
        let v = format!("min(1,max(0,0.5-({sd})/{feather_px:.1}))");
        if invert { format!("(1-({v}))") } else { v }
    });
    match (opacity, mask) {
        (None, None) => None,
        (Some(op), None) => Some(op),
        (None, Some(m)) => Some(m),
        (Some(op), Some(m)) => Some(format!("({op})*({m})")),
    }
}

/// Split a speed factor into `atempo` filters (each step must be 0.5..2.0;
/// this FFmpeg build accepts that range per instance).
pub fn atempo_chain(speed: f64) -> Vec<String> {
    let mut out = Vec::new();
    let mut s = speed.max(0.01);
    while s > 2.0 { out.push("atempo=2.000".to_string()); s /= 2.0; }
    while s < 0.5 { out.push("atempo=0.500".to_string()); s /= 0.5; }
    out.push(format!("atempo={s:.3}"));
    out
}

/// Piecewise-linear FFmpeg expression over `var` for sorted (at, value)
/// points, e.g. `if(lt(t,1.000),0.500+...,1.000)`.
pub fn piecewise_expr(points: &[(f64, f64)], var: &str) -> String {
    if points.is_empty() { return "0".to_string(); }
    if points.len() == 1 { return format!("{:.4}", points[0].1); }
    let (t0, v0) = points[0];
    let (t1, v1) = points[1];
    let seg = if (t1 - t0).abs() < f64::EPSILON {
        format!("{v1:.4}")
    } else {
        format!("{v0:.4}+({v1:.4}-{v0:.4})*({var}-{t0:.3})/{:.3}", t1 - t0)
    };
    if points.len() == 2 {
        format!("if(lt({var},{t1:.3}),{seg},{v1:.4})")
    } else {
        format!("if(lt({var},{t1:.3}),{seg},{})", piecewise_expr(&points[1..], var))
    }
}

/// Keyframe transform filters for a clip: zoompan (scale/position) and
/// rotate, driven by piecewise expressions over frame count / seconds.
pub fn keyframe_filters(clip: &editor_core::Clip, w: u32, h: u32, fps: u32) -> Vec<String> {
    if clip.keyframes.is_empty() { return Vec::new(); }
    let mut kfs = clip.keyframes.clone();
    kfs.sort_by(|a, b| a.at.total_cmp(&b.at));
    let mut out = Vec::new();

    let scale_varies = kfs.iter().any(|k| (k.scale - kfs[0].scale).abs() > 0.001)
        || (kfs[0].scale - 1.0).abs() > 0.001;
    let pos_varies = kfs.iter().any(|k| k.pos_x.abs() > 0.001 || k.pos_y.abs() > 0.001);
    if scale_varies || pos_varies {
        let z_points: Vec<(f64, f64)> = kfs.iter().map(|k| (k.at * fps as f64, k.scale.max(1.0))).collect();
        let x_points: Vec<(f64, f64)> = kfs.iter().map(|k| (k.at * fps as f64, k.pos_x)).collect();
        let y_points: Vec<(f64, f64)> = kfs.iter().map(|k| (k.at * fps as f64, k.pos_y)).collect();
        out.push(format!(
            "zoompan=z='{}':x='(iw-iw/zoom)/2+({})*(iw/zoom)':y='(ih-ih/zoom)/2+({})*(ih/zoom)':d=1:s={w}x{h}:fps={fps}",
            piecewise_expr(&z_points, "on"),
            piecewise_expr(&x_points, "on"),
            piecewise_expr(&y_points, "on"),
        ));
    }
    let rot_varies = kfs.iter().any(|k| k.rotation.abs() > 0.01);
    if rot_varies {
        let r_points: Vec<(f64, f64)> = kfs
            .iter()
            .map(|k| (k.at, k.rotation * std::f64::consts::PI / 180.0))
            .collect();
        out.push(format!(
            "rotate=a='{}':ow=iw:oh=ih:c=black",
            piecewise_expr(&r_points, "t")
        ));
    }
    out
}

/// Piecewise opacity (0..1) expression over geq's `T` (seconds), when any
/// keyframe sets opacity below 1. None means fully opaque.
pub fn keyframe_opacity_expr(clip: &editor_core::Clip) -> Option<String> {
    if clip.keyframes.is_empty() { return None; }
    if clip.keyframes.iter().all(|k| k.opacity >= 0.999) { return None; }
    let mut kfs = clip.keyframes.clone();
    kfs.sort_by(|a, b| a.at.total_cmp(&b.at));
    let points: Vec<(f64, f64)> = kfs.iter().map(|k| (k.at, k.opacity.clamp(0.0, 1.0))).collect();
    Some(piecewise_expr(&points, "T"))
}

/// Translate one effect into FFmpeg *audio* filters (fades + reverse apply).
pub fn effect_audio_filters(effect: &Effect, clip_duration: f64) -> Vec<String> {
    match *effect {
        Effect::FadeIn { duration } => {
            vec![format!("afade=t=in:st=0.000:d={:.3}", duration.max(0.0))]
        }
        Effect::FadeOut { duration } => {
            let st = (clip_duration - duration).max(0.0);
            vec![format!("afade=t=out:st={st:.3}:d={:.3}", duration.max(0.0))]
        }
        Effect::Reverse => vec!["areverse".to_string()],
        Effect::Denoise { strength } => {
            vec![format!("afftdn=nr={:.1}", 1.0 + strength.clamp(0.0, 1.0) * 40.0)]
        }
        Effect::PitchShift { semitones } => {
            let ratio = 2f64.powf(semitones.clamp(-12.0, 12.0) / 12.0);
            vec![format!("rubberband=pitch={ratio:.4}")]
        }
        Effect::Loudnorm { target_lufs } => {
            vec![format!("loudnorm=I={:.1}:TP=-1.5:LRA=11", target_lufs.clamp(-24.0, -5.0))]
        }
        _ => Vec::new(),
    }
}

/// Escape a string for use inside an FFmpeg drawtext `text='...'`.
/// Hue-range centers (degrees) for the 8 HSL ranges, in the order the
/// editor stores them: red, orange, yellow, green, cyan, blue,
/// purple, magenta.
pub const HSL_RANGE_CENTERS: [f64; 8] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 330.0];

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-9 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    ((h + 360.0) % 360.0, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    let h = ((h % 360.0) + 360.0) % 360.0;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match h {
        v if v < 60.0 => (c, x, 0.0),
        v if v < 120.0 => (x, c, 0.0),
        v if v < 180.0 => (0.0, c, x),
        v if v < 240.0 => (0.0, x, c),
        v if v < 300.0 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    (r + m, g + m, b + m)
}

/// Apply the 8-range HSL shifts (sliders -100..100) to one RGB pixel.
pub fn apply_hsl(r: f64, g: f64, b: f64, shifts: &[[f64; 3]]) -> (f64, f64, f64) {
    if shifts.len() < 8 || shifts.iter().all(|s| s.iter().all(|v| *v == 0.0)) {
        return (r, g, b);
    }
    let (h, s, l) = rgb_to_hsl(r, g, b);
    // Triangular weights whose falloff on each side reaches zero at
    // the neighboring range's center, so a range's slider applies at
    // full strength at its own center hue (no dilution).
    let mut weights = [0.0f64; 8];
    let mut total = 0.0;
    for (k, center) in HSL_RANGE_CENTERS.iter().enumerate() {
        let prev = HSL_RANGE_CENTERS[(k + 7) % 8];
        let next = HSL_RANGE_CENTERS[(k + 1) % 8];
        let left_span = (center - prev + 360.0) % 360.0;
        let right_span = (next - center + 360.0) % 360.0;
        // Signed circular distance from center to h, in (-180, 180].
        let mut d = (h - center + 540.0) % 360.0 - 180.0;
        if d == -180.0 { d = 180.0; }
        let w = if d < 0.0 {
            (1.0 + d / left_span).clamp(0.0, 1.0)
        } else {
            (1.0 - d / right_span).clamp(0.0, 1.0)
        };
        weights[k] = w;
        total += w;
    }
    if total <= 0.0 {
        return (r, g, b);
    }
    let (mut dh, mut ds, mut dl) = (0.0, 0.0, 0.0);
    for k in 0..8 {
        let w = weights[k] / total;
        dh += w * shifts[k][0];
        ds += w * shifts[k][1];
        dl += w * shifts[k][2];
    }
    // Hue shifts fade out for near-gray pixels (their hue is unstable);
    // saturation/lightness apply at full weight.
    let nh = h + dh * 1.8 * s.max(0.15);
    let ns = (s * (1.0 + ds / 100.0)).clamp(0.0, 1.0);
    let nl = (l + dl / 200.0).clamp(0.0, 1.0);
    hsl_to_rgb(nh, ns, nl)
}

/// Generate (or reuse from the temp cache) a 32^3 .cube LUT realizing
/// the HSL shifts, and return its path for lut3d.
pub fn hsl_cube_path(shifts: &[[f64; 3]]) -> PathBuf {
    let mut hash: u64 = 0xcbf29ce484222325;
    for row in shifts {
        for v in row {
            for byte in v.to_bits().to_le_bytes() {
                hash ^= byte as u64;
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
    }
    // v2: triangular range weights. The version tag keeps stale cubes
    // from an older weighting scheme out of the cache.
    let path = std::env::temp_dir().join(format!("nightcut-hsl-v2-{hash:016x}.cube"));
    if path.exists() {
        return path;
    }
    const N: usize = 32;
    let mut out = String::with_capacity(1 << 20);
    out.push_str("TITLE \"nightcut-hsl\"\nLUT_3D_SIZE 32\n");
    let denom = (N - 1) as f64;
    for bi in 0..N {
        for gi in 0..N {
            for ri in 0..N {
                let (r, g, b) = apply_hsl(ri as f64 / denom, gi as f64 / denom, bi as f64 / denom, shifts);
                out.push_str(&format!(
                    "{:.6} {:.6} {:.6}\n",
                    r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0)
                ));
            }
        }
    }
    let _ = std::fs::write(&path, out);
    path
}

/// The clip's blend mode if it names a real ffmpeg blend mode other
/// than normal compositing.
pub fn blend_mode_of(clip: &editor_core::Clip) -> Option<&'static str> {
    match clip.blend_mode.as_deref() {
        Some("screen") => Some("screen"),
        Some("multiply") => Some("multiply"),
        Some("overlay") => Some("overlay"),
        Some("softlight") => Some("softlight"),
        Some("hardlight") => Some("hardlight"),
        Some("darken") => Some("darken"),
        Some("lighten") => Some("lighten"),
        Some("difference") => Some("difference"),
        Some("addition") => Some("addition"),
        _ => None,
    }
}

/// Still-image sources that must be looped when used as overlay inputs.
pub fn is_still_image(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "bmp")
    )
}

pub fn escape_drawtext(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace(':', "\\:")
        .replace('%', "\\%")
}

/// Build the full FFmpeg argument list for a project.
///
/// `sources` maps clip ids to absolute source paths (the UI resolves the
/// project-relative `source` field before calling).
pub fn build_ffmpeg_args(
    project: &Project,
    sources: &BTreeMap<String, PathBuf>,
    output: &Path,
    settings: &ExportSettings,
) -> Result<Vec<String>> {
    build_ffmpeg_args_stabilized(project, sources, output, settings, &BTreeMap::new())
}

/// Like `build_ffmpeg_args`, plus vidstab transform files (clip id ->
/// .trf path) produced by the detect pass in `render()`. Clips whose id
/// is present get a `vidstabtransform` filter; a Stabilize effect
/// without a transforms entry renders unstabilized.
pub fn build_ffmpeg_args_stabilized(
    project: &Project,
    sources: &BTreeMap<String, PathBuf>,
    output: &Path,
    settings: &ExportSettings,
    stabilize_transforms: &BTreeMap<String, PathBuf>,
) -> Result<Vec<String>> {
    build_ffmpeg_args_full(project, sources, output, settings, stabilize_transforms, &BTreeMap::new())
}

/// Full builder: `overlay_dims` carries probed source dimensions
/// (clip id -> (width, height)) for overlay clips with a blend mode —
/// the blend path crops the base to the overlay's exact rect, which
/// needs the scaled height. Without dims it assumes the canvas aspect.
#[allow(clippy::too_many_arguments)]
pub fn build_ffmpeg_args_full(
    project: &Project,
    sources: &BTreeMap<String, PathBuf>,
    output: &Path,
    settings: &ExportSettings,
    stabilize_transforms: &BTreeMap<String, PathBuf>,
    overlay_dims: &BTreeMap<String, (u32, u32)>,
) -> Result<Vec<String>> {
    let video_track = project.tracks.iter().find(|t| t.kind == TrackKind::Video);
    let mut video_clips: Vec<_> = video_track
        .map(|t| t.clips.iter().filter(|c| !c.source.is_empty()).collect())
        .unwrap_or_default();
    if video_clips.is_empty() { return Err(ExportError::NoVideoClips); }
    video_clips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));

    let mut args: Vec<String> = vec!["-y".into(), "-v".into(), "error".into()];
    for clip in &video_clips {
        let path = sources.get(&clip.id)
            .ok_or_else(|| ExportError::UnresolvedSource(clip.id.clone()))?;
        args.push("-i".into());
        args.push(path.display().to_string());
    }
    // Music/audio-track clips become extra inputs after the video inputs.
    let audio_track = project.tracks.iter().find(|t| t.kind == TrackKind::Audio);
    let music: Vec<_> = audio_track
        .filter(|t| !t.muted)
        .map(|t| t.clips.iter().filter(|c| !c.source.is_empty()).collect())
        .unwrap_or_default();
    for clip in &music {
        let path = sources.get(&clip.id)
            .ok_or_else(|| ExportError::UnresolvedSource(clip.id.clone()))?;
        args.push("-i".into());
        args.push(path.display().to_string());
    }
    // Overlay (PiP) clips: every video track after the first. Their
    // inputs follow the music inputs.
    let overlay_tracks: Vec<_> = project.tracks.iter()
        .filter(|t| t.kind == TrackKind::Video)
        .skip(1)
        .filter(|t| !t.hidden)
        .collect();
    let mut overlay_clips: Vec<&editor_core::Clip> = overlay_tracks.iter()
        .flat_map(|t| t.clips.iter().filter(|c| !c.source.is_empty()))
        .collect();
    overlay_clips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
    let overlay_input_start = video_clips.len() + music.len();
    for clip in &overlay_clips {
        let path = sources.get(&clip.id)
            .ok_or_else(|| ExportError::UnresolvedSource(clip.id.clone()))?;
        // Still images (logo watermarks, Elements art) loop into a video
        // stream so the overlay chain's trim/setpts work unchanged.
        if is_still_image(path) {
            args.push("-loop".into());
            args.push("1".into());
        }
        args.push("-i".into());
        args.push(path.display().to_string());
    }

    let (w, h, fps) = (project.canvas.width, project.canvas.height, project.canvas.fps);
    let mut filters: Vec<String> = Vec::new();

    // Per-clip construction, in three steps:
    //   1. base stream [vb{i}]/[ab{i}] — trim/speed (or speed-curve
    //      segments, or a freeze frame) normalized to the canvas
    //   2. keyframe transform + video effects -> [v{i}]
    //      (chroma key / keyframed opacity composite over black via alpha)
    //   3. audio effects -> [a{i}]
    for (i, clip) in video_clips.iter().enumerate() {
        let dur = clip.duration();
        let has_chroma = clip.effects.iter().any(|fx| matches!(fx, Effect::ChromaKey { .. }));
        // Only the chroma path needs an RGBA base (its alpha is produced by
        // the chromakey filter later). Keyframed opacity works on YUV via
        // alphamerge below.
        let base_format = if has_chroma { "format=rgba" } else { "format=yuv420p" };
        let scale_pad = [
            format!("scale={w}:{h}:force_original_aspect_ratio=decrease"),
            format!("pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"),
            format!("fps={fps}"),
            "setsar=1".to_string(),
            base_format.to_string(),
        ];

        // ---- step 1: base streams
        if let Some(freeze_dur) = clip.freeze_duration {
            let mut vchain = vec![
                format!("trim=start={:.3}:end={:.3}", clip.in_sec, clip.in_sec + 0.1),
                "setpts=PTS-STARTPTS".to_string(),
            ];
            vchain.extend(scale_pad.iter().cloned());
            vchain.push(format!("tpad=stop_mode=clone:stop_duration={freeze_dur:.3}"));
            vchain.push(format!("trim=duration={freeze_dur:.3}"));
            vchain.push("setpts=PTS-STARTPTS".to_string());
            filters.push(format!("[{i}:v]{}[vb{i}]", vchain.join(",")));
            filters.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={freeze_dur:.3}[ab{i}]"));
        } else if let Some(curve) = &clip.speed_curve.as_ref().filter(|c| !c.is_empty()) {
            let mut points: Vec<editor_core::SpeedPoint> = curve.iter().cloned().collect();
            points.sort_by(|a, b| a.at.total_cmp(&b.at));
            let source_len = (clip.out_sec - clip.in_sec).max(0.0);
            let segs: Vec<(f64, f64, f64)> = points
                .iter()
                .enumerate()
                .map(|(j, p)| {
                    let start = p.at.clamp(0.0, 1.0);
                    let end = points.get(j + 1).map(|n| n.at.clamp(0.0, 1.0)).unwrap_or(1.0);
                    (start, end, p.speed.max(0.01))
                })
                .filter(|(s, e, _)| e > s)
                .collect();
            for (j, (start, end, speed)) in segs.iter().enumerate() {
                let s_in = clip.in_sec + source_len * start;
                let s_out = clip.in_sec + source_len * end;
                let mut vchain = vec![
                    format!("trim=start={s_in:.3}:end={s_out:.3}"),
                    format!("setpts=(PTS-STARTPTS)/{speed:.3}"),
                ];
                vchain.extend(scale_pad.iter().cloned());
                filters.push(format!("[{i}:v]{}[vb{i}s{j}]", vchain.join(",")));
                let mut achain = vec![
                    format!("atrim=start={s_in:.3}:end={s_out:.3}"),
                    "asetpts=PTS-STARTPTS".to_string(),
                ];
                achain.extend(atempo_chain(*speed));
                achain.push("aresample=48000".to_string());
                achain.push(format!("volume={:.2}", clip.volume.clamp(0.0, 2.0)));
                filters.push(format!("[{i}:a]{}[ab{i}s{j}]", achain.join(",")));
            }
            let vinputs: String = (0..segs.len()).map(|j| format!("[vb{i}s{j}]")).collect();
            let ainputs: String = (0..segs.len()).map(|j| format!("[ab{i}s{j}]")).collect();
            filters.push(format!("{vinputs}concat=n={}:v=1:a=0[vb{i}]", segs.len()));
            filters.push(format!("{ainputs}concat=n={}:v=0:a=1[ab{i}]", segs.len()));
        } else if project.canvas_fill == "blur" {
            // Canvas blur fill: an enlarged, cropped, heavily blurred copy
            // fills the frame behind the fitted clip.
            let base = format!(
                "trim=start={:.3}:end={:.3},setpts=(PTS-STARTPTS)/{:.3}",
                clip.in_sec, clip.out_sec, clip.speed.max(0.01)
            );
            filters.push(format!("[{i}:v]{base},split=2[vb{i}bg][vb{i}fg]"));
            filters.push(format!(
                "[vb{i}bg]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=30,setsar=1[vb{i}bgb]"
            ));
            filters.push(format!(
                "[vb{i}fg]scale={w}:{h}:force_original_aspect_ratio=decrease,setsar=1[vb{i}fgb]"
            ));
            filters.push(format!("[vb{i}bgb][vb{i}fgb]overlay=(W-w)/2:(H-h)/2[vb{i}]"));
            let achain = vec![
                format!("atrim=start={:.3}:end={:.3}", clip.in_sec, clip.out_sec),
                "asetpts=PTS-STARTPTS".to_string(),
                format!("atempo={:.3}", clip.speed.clamp(0.5, 2.0)),
                "aresample=48000".to_string(),
                format!("volume={:.2}", clip.volume.clamp(0.0, 2.0)),
            ];
            filters.push(format!("[{i}:a]{}[ab{i}]", achain.join(",")));
        } else {
            let mut vchain = vec![
                format!("trim=start={:.3}:end={:.3}", clip.in_sec, clip.out_sec),
                format!("setpts=(PTS-STARTPTS)/{:.3}", clip.speed.max(0.01)),
            ];
            vchain.extend(scale_pad.iter().cloned());
            filters.push(format!("[{i}:v]{}[vb{i}]", vchain.join(",")));
            let achain = vec![
                format!("atrim=start={:.3}:end={:.3}", clip.in_sec, clip.out_sec),
                "asetpts=PTS-STARTPTS".to_string(),
                format!("atempo={:.3}", clip.speed.clamp(0.5, 2.0)),
                "aresample=48000".to_string(),
                format!("volume={:.2}", clip.volume.clamp(0.0, 2.0)),
            ];
            filters.push(format!("[{i}:a]{}[ab{i}]", achain.join(",")));
        }

        // Smooth slow motion: motion-interpolate the base stream when a
        // constant-speed clip plays under 1x and asked for it.
        if clip.smooth_slowmo && clip.speed < 1.0 && clip.speed_curve.is_none()
            && clip.freeze_duration.is_none()
        {
            filters.push(format!("[vb{i}]minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir[vmi{i}]"));
        }
        let base_label = if clip.smooth_slowmo && clip.speed < 1.0 && clip.speed_curve.is_none()
            && clip.freeze_duration.is_none()
        {
            format!("vmi{i}")
        } else {
            format!("vb{i}")
        };

        // ---- step 2: stabilization, keyframes, matte, video effects
        let matte = matte_value_expr(clip, w, h);
        let needs_alpha = has_chroma || matte.is_some();
        let mut vlabel = base_label;
        // Stabilization first (it warps the raw frames; later transforms
        // then operate on stable footage, as in CapCut).
        if let (Some(smoothing), Some(trf)) = (
            clip_stabilize_smoothing(clip),
            stabilize_transforms.get(&clip.id),
        ) {
            let next = format!("vst{i}");
            filters.push(format!(
                "[{vlabel}]vidstabtransform=input='{}':smoothing={smoothing}:optalgo=gauss,unsharp=5:5:0.8:3:3:0.4[{next}]",
                trf.display()
            ));
            vlabel = next;
        }
        for (step, filter) in keyframe_filters(clip, w, h, fps).into_iter().enumerate() {
            let next = format!("vk{i}_{step}");
            filters.push(format!("[{vlabel}]{filter}[{next}]"));
            vlabel = next;
        }
        // The matte is a gray stream whose brightness is the combined
        // opacity-curve × shape-mask value per pixel per frame.
        if let Some(matte_expr) = &matte {
            filters.push(format!(
                "color=c=black:s={w}x{h}:r={fps}:d={dur:.3},format=gray,geq=lum='255*({matte_expr})'[vam{i}]"
            ));
        }
        if matte.is_some() && !has_chroma {
            let next = format!("va{i}");
            filters.push(format!("[{vlabel}][vam{i}]alphamerge[{next}]"));
            vlabel = next;
        }
        let vfx: Vec<String> = clip.effects.iter().flat_map(|fx| effect_video_filters(fx, dur)).collect();
        if !vfx.is_empty() {
            let next = format!("ve{i}");
            filters.push(format!("[{vlabel}]{}[{next}]", vfx.join(",")));
            vlabel = next;
        }
        if matte.is_some() && has_chroma {
            // Chroma produced its own alpha in the effects step; merge the
            // matte on top (alphamerge multiplies the existing alpha).
            let next = format!("va{i}");
            filters.push(format!("[{vlabel}][vam{i}]alphamerge[{next}]"));
            vlabel = next;
        }
        if needs_alpha {
            // Composite over a black canvas of the same duration so the
            // alpha (chroma key / matte) becomes visible.
            filters.push(format!("color=c=black:s={w}x{h}:r={fps}:d={dur:.3}[vbg{i}]"));
            filters.push(format!("[vbg{i}][{vlabel}]overlay=0:0,format=yuv420p[v{i}]"));
        } else {
            filters.push(format!("[{vlabel}]format=yuv420p[v{i}]"));
        }

        // ---- step 3: audio effects
        let afx: Vec<String> = clip.effects.iter().flat_map(|fx| effect_audio_filters(fx, dur)).collect();
        if afx.is_empty() {
            filters.push(format!("[ab{i}]anull[a{i}]"));
        } else {
            filters.push(format!("[ab{i}]{}[a{i}]", afx.join(",")));
        }
    }
    // Merge clips in timeline order: a clip with `transition_in` is blended
    // into the running result with xfade/acrossfade; otherwise it is
    // concatenated. This replaces a single concat=n chain.
    let mut vcur = "v0".to_string();
    let mut acur = "a0".to_string();
    let mut acc_duration = video_clips[0].duration();
    for (i, clip) in video_clips.iter().enumerate().skip(1) {
        let dur = clip.duration();
        let transition = clip.transition_in.as_ref().filter(|t| {
            t.duration > 0.0 && t.duration < acc_duration && t.duration < dur
        });
        if let Some(t) = transition {
            let offset = acc_duration - t.duration;
            filters.push(format!(
                "[{vcur}][v{i}]xfade=transition={}:duration={:.3}:offset={:.3}[vx{i}]",
                t.kind, t.duration, offset
            ));
            filters.push(format!("[{acur}][a{i}]acrossfade=d={:.3}[ax{i}]", t.duration));
            vcur = format!("vx{i}");
            acur = format!("ax{i}");
            acc_duration += dur - t.duration;
        } else {
            filters.push(format!(
                "[{vcur}][{acur}][v{i}][a{i}]concat=n=2:v=1:a=1[vc{i}][ac{i}]"
            ));
            vcur = format!("vc{i}");
            acur = format!("ac{i}");
            acc_duration += dur;
        }
    }
    let vcat = vcur;
    let acat = acur;

    // PiP overlays: composite each overlay clip over the merged base at
    // its timeline window, scaled to its canvas fraction and positioned
    // by its center fractions (defaults: 0.35 wide, bottom-right).
    let mut current = vcat;
    for (k, clip) in overlay_clips.iter().enumerate() {
        let idx = overlay_input_start + k;
        let dur = clip.duration();
        let scale_f = clip.overlay_scale.unwrap_or(0.35).clamp(0.05, 1.0);
        let cx = clip.overlay_x.unwrap_or(0.8).clamp(0.0, 1.0);
        let cy = clip.overlay_y.unwrap_or(0.8).clamp(0.0, 1.0);
        let pw = ((w as f64 * scale_f).round() as u32).max(2);
        let blend = blend_mode_of(clip);
        // Scaled height: from the probed source aspect when blending
        // (the blend path needs the exact rect), else -2 (keep aspect).
        let ph = overlay_dims.get(&clip.id).map(|(sw, sh)| {
            (((pw as f64 * *sh as f64 / *sw as f64) / 2.0).round() as u32 * 2).max(2)
        });
        let vfx: Vec<String> = clip.effects.iter()
            .flat_map(|fx| effect_video_filters(fx, dur))
            .collect();
        let mut chain = vec![
            format!("trim=start={:.3}:end={:.3}", clip.in_sec, clip.out_sec),
            format!("setpts=(PTS-STARTPTS)/{:.3}", clip.speed.max(0.01)),
            match (blend, ph) {
                (Some(_), Some(ph)) => format!("scale={pw}:{ph}"),
                _ => format!("scale={pw}:-2"),
            },
            format!("fps={fps}"),
            "setsar=1".to_string(),
            "format=yuva420p".to_string(),
        ];
        chain.extend(vfx);
        // Chroma/mask alpha survives in yuva; the matte path is skipped
        // for overlays in v1 (keyframe opacity not applied either).
        chain.push(format!("setpts=PTS+{:.3}/TB", clip.timeline_start));
        filters.push(format!("[{idx}:v]{}[ov{k}]", chain.join(",")));
        let next = format!("vov{k}");
        if let (Some(mode), Some(ph)) = (blend, ph) {
            // Blend path: crop the base to the overlay's exact rect,
            // blend the two, and lay the result back with the plain
            // overlay filter inside the clip's window. (The overlay's
            // own alpha is flattened on this path.)
            let px = (((w - pw) as f64 * cx).round() as u32).min(w - pw);
            let py = (((h - ph) as f64 * cy).round() as u32).min(h - ph);
            // Blend in planar RGB (gbrp): YUV planes garble hues, and
            // packed rgb24 is misread by the blend filter entirely.
            filters.push(format!("[ov{k}]format=gbrp[ovf{k}]"));
            filters.push(format!("[{current}]split=2[baseM{k}][baseC{k}]"));
            filters.push(format!("[baseC{k}]crop={pw}:{ph}:{px}:{py},format=gbrp[crop{k}]"));
            filters.push(format!("[crop{k}][ovf{k}]blend=all_mode={mode},format=yuv420p[bl{k}]"));
            filters.push(format!(
                "[baseM{k}][bl{k}]overlay={px}:{py}:enable='between(t,{:.3},{:.3})'[{next}]",
                clip.timeline_start,
                clip.timeline_end(),
            ));
        } else {
            filters.push(format!(
                "[{current}][ov{k}]overlay=x='(W-w)*{cx:.3}':y='(H-h)*{cy:.3}':enable='between(t,{:.3},{:.3})'[{next}]",
                clip.timeline_start,
                clip.timeline_end(),
            ));
        }
        current = next;
    }

    // Text overlays on top of the merged video. When the caller did not
    // provide a font, discover a system font so captions actually render
    // (desktop, agent and CLI exports alike).
    let mut current = current;
    let discovered_font;
    let font = match &settings.font_file {
        Some(f) => Some(f),
        None => {
            discovered_font = default_system_font();
            discovered_font.as_ref()
        }
    };
    if let Some(font) = &font {
        let text_track = project.tracks.iter().find(|t| t.kind == TrackKind::Text);
        if let Some(track) = text_track {
            for (j, clip) in track.clips.iter().enumerate() {
                let Some(text) = &clip.text else { continue };
                let next = format!("vtxt{j}");
                let color = clip
                    .text_color
                    .as_deref()
                    .map(|hex| format!("0x{}", hex.trim_start_matches('#')))
                    .unwrap_or_else(|| "white".to_string());
                // Caption pill (drawtext box) + drop shadow, CapCut-style.
                let mut extra = String::new();
                if let Some(bg) = &clip.text_bg {
                    extra.push_str(&format!(
                        ":box=1:boxcolor=0x{}@0.65:boxborderw={}",
                        bg.trim_start_matches('#'),
                        clip.font_size.unwrap_or(64) / 3,
                    ));
                }
                if clip.text_shadow {
                    extra.push_str(":shadowcolor=black@0.6:shadowx=3:shadowy=3");
                }
                // Glow: a thick translucent outline in the glow color
                // replaces the black border (drawtext has no blur, so
                // the halo is an outline approximation — see docs).
                let (borderw, bordercolor) = match &clip.text_glow {
                    Some(glow) => (
                        (clip.font_size.unwrap_or(64) / 6).max(2),
                        format!("0x{}@0.55", glow.trim_start_matches('#')),
                    ),
                    None => (3, "black".to_string()),
                };
                // Per-clip vertical position: (h-text_h)*f puts the top
                // edge at fraction f of the free space (0=top, 1=bottom);
                // unset keeps the legacy caption spot.
                let y_expr = match clip.text_y {
                    Some(f) => format!("(h-text_h)*{:.3}", f.clamp(0.0, 1.0)),
                    None => "h-220".to_string(),
                };
                filters.push(format!(
                    "[{current}]drawtext=fontfile='{}':text='{}':fontsize={}:fontcolor={}:borderw={}:bordercolor={}{}:x=(w-text_w)/2:y={}:enable='between(t,{:.3},{:.3})'[{next}]",
                    font.display(),
                    escape_drawtext(text),
                    clip.font_size.unwrap_or(64),
                    color,
                    borderw,
                    bordercolor,
                    extra,
                    y_expr,
                    clip.timeline_start,
                    clip.timeline_end(),
                ));
                current = next;
            }
        }
    }

    // Audio out: clip audio, optionally mixed with the first music clip.
    let audio_label = if let Some(music_clip) = music.first() {
        let music_idx = video_clips.len(); // first extra input index
        filters.push(format!(
            "[{music_idx}:a]aresample=48000,volume={:.2}[music]",
            music_clip.volume
        ));
        filters.push(format!("[{acat}][music]amix=inputs=2:duration=first:dropout_transition=0[aout]"));
        "aout"
    } else {
        acat.as_str()
    };

    // GIF has no audio track: terminate the audio chain in a sink so the
    // filtergraph has no dangling outputs.
    if settings.gif {
        filters.push(format!("[{audio_label}]anullsink"));
    }

    // Optional output transform: GIF (15fps) and/or a height cap.
    let mut video_out = current.clone();
    if settings.gif || settings.max_height.is_some() {
        let mut tail: Vec<String> = Vec::new();
        if settings.gif { tail.push("fps=15".to_string()); }
        if let Some(mh) = settings.max_height {
            if mh < h { tail.push(format!("scale=-2:{mh}")); }
        }
        if !tail.is_empty() {
            filters.push(format!("[{current}]{}[vfinal]", tail.join(",")));
            video_out = "vfinal".to_string();
        }
    }

    // Audio-only export: terminate the video chain in a sink so the
    // filtergraph has no dangling outputs.
    if settings.audio_only {
        filters.push(format!("[{video_out}]nullsink"));
    }

    args.push("-filter_complex".into());
    args.push(filters.join(";"));
    if settings.audio_only {
        args.push("-map".into());
        args.push(format!("[{audio_label}]"));
        let out_name = output.to_string_lossy().to_lowercase();
        let codec = if out_name.ends_with(".mp3") {
            "libmp3lame"
        } else if out_name.ends_with(".wav") {
            "pcm_s16le"
        } else {
            "aac"
        };
        args.push("-c:a".into());
        args.push(codec.into());
        args.push(output.display().to_string());
        return Ok(args);
    }
    args.push("-map".into());
    args.push(format!("[{video_out}]"));
    if settings.gif {
        args.push("-loop".into());
        args.push("0".into());
    } else {
        args.push("-map".into());
        args.push(format!("[{audio_label}]"));
        args.push("-c:v".into());
        args.push(settings.encoder.ffmpeg_codec().into());
        if settings.encoder == Encoder::Software {
            args.push("-crf".into());
            args.push(settings.crf.to_string());
            args.push("-preset".into());
            args.push("medium".into());
        }
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("160k".into());
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    args.push(output.display().to_string());
    Ok(args)
}

/// Best-effort system font for drawtext when the caller set none:
/// NIGHTCUT_FONT wins, then common platform paths, then `fc-match`.
pub fn default_system_font() -> Option<PathBuf> {
    if let Ok(f) = std::env::var("NIGHTCUT_FONT") {
        let p = PathBuf::from(f);
        if p.exists() { return Some(p); }
    }
    let candidates: &[&str] = &[
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial Bold.ttf",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() { return Some(p); }
    }
    let out = Command::new("fc-match").args(["-f", "%{file}", "sans:bold"]).output().ok()?;
    let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string());
    if p.exists() { Some(p) } else { None }
}

/// Run the vidstab *detect* pass for every clip that asks for
/// stabilization (constant-speed, non-freeze clips only — the transform
/// must see the same frames the main graph will). Transform files are
/// cached under the system temp dir, keyed by source + trim window.
/// Returns clip id -> transforms file for the clips that got one.
pub fn run_stabilize_detect_passes(
    project: &Project,
    sources: &BTreeMap<String, PathBuf>,
) -> BTreeMap<String, PathBuf> {
    let mut out = BTreeMap::new();
    let Some(track) = project.tracks.iter().find(|t| t.kind == editor_core::TrackKind::Video) else {
        return out;
    };
    let dir = std::env::temp_dir().join("nightcut-stabilize");
    if std::fs::create_dir_all(&dir).is_err() { return out; }
    for clip in &track.clips {
        if clip_stabilize_smoothing(clip).is_none()
            || clip.speed_curve.is_some()
            || clip.freeze_duration.is_some()
            || clip.source.is_empty()
        {
            continue;
        }
        let Some(path) = sources.get(&clip.id) else { continue };
        let key = format!(
            "{}-{}-{}",
            media_engine::cache_key(path),
            (clip.in_sec * 1000.0) as i64,
            (clip.out_sec * 1000.0) as i64
        );
        let trf = dir.join(format!("{key}.trf"));
        if !trf.exists() {
            // Detect on the same normalized stream the main graph builds:
            // trim -> speed -> scale/pad to canvas.
            let vf = format!(
                "trim=start={:.3}:end={:.3},setpts=(PTS-STARTPTS)/{:.3},scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,fps={},vidstabdetect=shakiness=5:accuracy=15:result='{}'",
                clip.in_sec, clip.out_sec, clip.speed.max(0.01),
                project.canvas.width, project.canvas.height,
                project.canvas.width, project.canvas.height,
                project.canvas.fps, trf.display()
            );
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-i"])
                .arg(path)
                .args(["-vf", &vf, "-f", "null", "-"])
                .status();
            if !matches!(status, Ok(s) if s.success()) { continue; }
        }
        if trf.exists() {
            out.insert(clip.id.clone(), trf);
        }
    }
    out
}

/// Render a project to `output` with FFmpeg. Runs the stabilization
/// detect pass first when any clip requests it.
pub fn render(
    project: &Project,
    sources: &BTreeMap<String, PathBuf>,
    output: &Path,
    settings: &ExportSettings,
) -> Result<PathBuf> {
    let transforms = run_stabilize_detect_passes(project, sources);
    // Probe dimensions for overlay clips with a blend mode (the blend
    // path needs the overlay's exact scaled height).
    let mut overlay_dims: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    for track in project.tracks.iter().filter(|t| t.kind == TrackKind::Video).skip(1) {
        for clip in &track.clips {
            if blend_mode_of(clip).is_some() {
                if let Some(path) = sources.get(&clip.id) {
                    if let Ok(info) = media_engine::probe(path) {
                        if info.width > 0 && info.height > 0 {
                            overlay_dims.insert(clip.id.clone(), (info.width, info.height));
                        }
                    }
                }
            }
        }
    }
    let args = build_ffmpeg_args_full(project, sources, output, settings, &transforms, &overlay_dims)?;
    let status = Command::new("ffmpeg").args(&args).status()?;
    if !status.success() { return Err(ExportError::FfmpegFailed(status)); }
    Ok(output.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::Clip;

    #[test]
    fn hsl_shifts_rotate_reds_and_leave_grays() {
        let zero = vec![[0.0; 3]; 8];
        let (r, g, b) = apply_hsl(1.0, 0.0, 0.0, &zero);
        assert!((r - 1.0).abs() < 0.01 && g < 0.01 && b < 0.01, "identity: {r},{g},{b}");
        // Red range hue +50 (slider) = +90 degrees: red -> yellow-green.
        let mut shifts = vec![[0.0; 3]; 8];
        shifts[0] = [50.0, 0.0, 0.0];
        let (r, g, b) = apply_hsl(1.0, 0.0, 0.0, &shifts);
        assert!(g > 0.9 && r > 0.4 && r < 0.65 && b < 0.2, "rotated red (+90deg = chartreuse): {r},{g},{b}");
        // Gray is untouched by a red-range saturation cut.
        let mut shifts2 = vec![[0.0; 3]; 8];
        shifts2[0] = [0.0, -100.0, 0.0];
        let (r, g, b) = apply_hsl(0.5, 0.5, 0.5, &shifts2);
        assert!((r - 0.5).abs() < 0.02 && (g - 0.5).abs() < 0.02, "gray stays: {r},{g},{b}");
        // Blue is untouched by a red-range saturation cut.
        let (r, g, b) = apply_hsl(0.0, 0.0, 1.0, &shifts2);
        assert!(b > 0.95 && r < 0.05, "blue stays: {r},{g},{b}");
    }

    #[test]
    fn hsl_and_deflicker_map_to_filters() {
        let mut shifts = vec![[0.0; 3]; 8];
        shifts[3] = [20.0, -30.0, 10.0];
        let f = effect_video_filters(&Effect::Hsl { shifts }, 3.0);
        assert!(f[0].starts_with("lut3d=file='"), "{f:?}");
        assert!(f[0].contains("nightcut-hsl-"), "{f:?}");
        let d = effect_video_filters(&Effect::Deflicker { size: 7 }, 3.0);
        assert_eq!(d, vec!["deflicker=size=7:mode=pm".to_string()]);
    }

    fn two_clip_project() -> (Project, BTreeMap<String, PathBuf>) {
        let mut p = Project::default();
        p.add_clip("track-video", Clip::new("c1", "a.mp4", 0.0, 4.0, 0.0)).unwrap();
        p.add_clip("track-video", Clip::new("c2", "b.mp4", 1.0, 6.0, 4.0)).unwrap();
        p.add_clip("track-text", Clip::text_clip("t1", "Hello: world", 0.5, 2.0)).unwrap();
        let sources = BTreeMap::from([
            ("c1".to_string(), PathBuf::from("/media/a.mp4")),
            ("c2".to_string(), PathBuf::from("/media/b.mp4")),
        ]);
        (p, sources)
    }

    #[test]
    fn builds_concat_graph_for_two_clips() {
        let (p, sources) = two_clip_project();
        let args = build_ffmpeg_args(&p, &sources, Path::new("out.mp4"), &ExportSettings::default()).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("concat=n=2"));
        assert!(joined.contains("trim=start=1.000:end=6.000"));
        assert!(joined.contains("scale=1080:1920"));
        assert!(joined.contains("libx264"));
        assert!(args.last().unwrap() == "out.mp4");
    }

    #[test]
    fn text_overlay_needs_font_and_is_escaped() {
        let (p, sources) = two_clip_project();
        let settings = ExportSettings {
            font_file: Some(PathBuf::from("/fonts/DejaVuSans-Bold.ttf")),
            ..Default::default()
        };
        let args = build_ffmpeg_args(&p, &sources, Path::new("out.mp4"), &settings).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("drawtext"));
        assert!(joined.contains("Hello\\: world"));
        assert!(joined.contains("between(t,0.500,2.500)"));
    }

    #[test]
    fn empty_project_errors() {
        let p = Project::default();
        let sources = BTreeMap::new();
        assert!(build_ffmpeg_args(&p, &sources, Path::new("o.mp4"), &ExportSettings::default()).is_err());
    }

    #[test]
    fn unresolved_source_errors() {
        let (p, _) = two_clip_project();
        let empty = BTreeMap::new();
        assert!(matches!(
            build_ffmpeg_args(&p, &empty, Path::new("o.mp4"), &ExportSettings::default()),
            Err(ExportError::UnresolvedSource(_))
        ));
    }

    #[test]
    fn effects_become_ffmpeg_filters() {
        let mut p = Project::default();
        let mut c = Clip::new("c1", "a.mp4", 0.0, 4.0, 0.0);
        c.effects = vec![
            editor_core::Effect::Adjust { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
            editor_core::Effect::Grayscale,
            editor_core::Effect::Blur { sigma: 5.0 },
            editor_core::Effect::Mirror,
            editor_core::Effect::FadeIn { duration: 0.5 },
            editor_core::Effect::FadeOut { duration: 1.0 },
        ];
        p.add_clip("track-video", c).unwrap();
        let sources = BTreeMap::from([("c1".to_string(), PathBuf::from("/media/a.mp4"))]);
        let args = build_ffmpeg_args(&p, &sources, Path::new("o.mp4"), &ExportSettings::default()).unwrap();
        let j = args.join(" ");
        assert!(j.contains("eq=brightness=0.100:contrast=1.200:saturation=0.800"), "{j}");
        assert!(j.contains("hue=s=0"));
        assert!(j.contains("gblur=sigma=5.00"));
        assert!(j.contains("hflip"));
        assert!(j.contains("fade=t=in:st=0.000:d=0.500"));
        assert!(j.contains("fade=t=out:st=3.000:d=1.000"));
        assert!(j.contains("afade=t=out:st=3.000:d=1.000"));
    }

    #[test]
    fn transition_becomes_xfade_with_correct_offset() {
        let mut p = Project::default();
        p.add_clip("track-video", Clip::new("c1", "a.mp4", 0.0, 4.0, 0.0)).unwrap();
        let mut c2 = Clip::new("c2", "b.mp4", 0.0, 4.0, 4.0);
        c2.transition_in = Some(editor_core::Transition { kind: "fade".into(), duration: 0.5 });
        c2.volume = 0.4;
        p.add_clip("track-video", c2).unwrap();
        let sources = BTreeMap::from([
            ("c1".to_string(), PathBuf::from("/media/a.mp4")),
            ("c2".to_string(), PathBuf::from("/media/b.mp4")),
        ]);
        let args = build_ffmpeg_args(&p, &sources, Path::new("o.mp4"), &ExportSettings::default()).unwrap();
        let j = args.join(" ");
        // offset = first clip duration (4s) - transition (0.5s)
        assert!(j.contains("xfade=transition=fade:duration=0.500:offset=3.500"), "{j}");
        assert!(j.contains("acrossfade=d=0.500"), "{j}");
        assert!(j.contains("volume=0.40"), "{j}");
        assert!(!j.contains("concat=n=2"), "transition should replace concat: {j}");
    }

    #[test]
    fn speed_curve_expands_to_segments() {
        let mut p = Project::default();
        let mut c = Clip::new("c1", "a.mp4", 0.0, 10.0, 0.0);
        c.speed_curve = Some(vec![
            editor_core::SpeedPoint { at: 0.0, speed: 1.0 },
            editor_core::SpeedPoint { at: 0.5, speed: 2.0 },
        ]);
        p.add_clip("track-video", c).unwrap();
        let sources = BTreeMap::from([("c1".to_string(), PathBuf::from("/media/a.mp4"))]);
        let args = build_ffmpeg_args(&p, &sources, Path::new("o.mp4"), &ExportSettings::default()).unwrap();
        let j = args.join(" ");
        assert!(j.contains("trim=start=5.000:end=10.000"), "{j}");
        assert!(j.contains("concat=n=2"), "{j}");
        assert_eq!(p.duration(), 7.5);
    }

    #[test]
    fn freeze_clip_uses_tpad_and_silent_audio() {
        let mut p = Project::default();
        let mut c = Clip::new("c1", "a.mp4", 3.0, 3.0, 0.0);
        c.freeze_duration = Some(2.0);
        p.add_clip("track-video", c).unwrap();
        let sources = BTreeMap::from([("c1".to_string(), PathBuf::from("/media/a.mp4"))]);
        let args = build_ffmpeg_args(&p, &sources, Path::new("o.mp4"), &ExportSettings::default()).unwrap();
        let j = args.join(" ");
        assert!(j.contains("tpad=stop_mode=clone:stop_duration=2.000"), "{j}");
        assert!(j.contains("anullsrc"), "{j}");
    }

    #[test]
    fn keyframes_become_zoompan_rotate_and_alpha() {
        let mut p = Project::default();
        let mut c = Clip::new("c1", "a.mp4", 0.0, 4.0, 0.0);
        c.keyframes = vec![
            editor_core::Keyframe { at: 0.0, scale: 1.0, rotation: 0.0, opacity: 1.0, ..Default::default() },
            editor_core::Keyframe { at: 4.0, scale: 2.0, rotation: 90.0, opacity: 0.5, ..Default::default() },
        ];
        p.add_clip("track-video", c).unwrap();
        let sources = BTreeMap::from([("c1".to_string(), PathBuf::from("/media/a.mp4"))]);
        let args = build_ffmpeg_args(&p, &sources, Path::new("o.mp4"), &ExportSettings::default()).unwrap();
        let j = args.join(" ");
        assert!(j.contains("zoompan=z='"), "{j}");
        assert!(j.contains("rotate=a='"), "{j}");
        assert!(j.contains("alphamerge"), "{j}");
        assert!(j.contains("overlay=0:0"), "{j}");
    }

    #[test]
    fn mask_and_stabilize_graph_bits() {
        let mut p = Project::default();
        let mut c = Clip::new("c1", "a.mp4", 0.0, 4.0, 0.0);
        c.effects = vec![
            editor_core::Effect::Mask { shape: "circle".into(), size: 0.6, feather: 0.2, invert: false },
            editor_core::Effect::Stabilize { smoothing: 12 },
        ];
        p.add_clip("track-video", c).unwrap();
        let sources = BTreeMap::from([("c1".to_string(), PathBuf::from("/media/a.mp4"))]);
        let transforms = BTreeMap::from([("c1".to_string(), PathBuf::from("/tmp/x.trf"))]);
        let args = build_ffmpeg_args_stabilized(&p, &sources, Path::new("o.mp4"), &ExportSettings::default(), &transforms).unwrap();
        let j = args.join(" ");
        assert!(j.contains("vidstabtransform=input='/tmp/x.trf':smoothing=12"), "{j}");
        assert!(j.contains("geq=lum='255*(min(1,max(0,0.5-(hypot"), "{j}");
        assert!(j.contains("alphamerge"), "{j}");
        // Without a transforms entry the same project renders unstabilized.
        let args2 = build_ffmpeg_args(&p, &sources, Path::new("o.mp4"), &ExportSettings::default()).unwrap();
        assert!(!args2.join(" ").contains("vidstabtransform"));
    }

    #[test]
    fn chroma_and_denoise_filters() {
        let v = effect_video_filters(
            &editor_core::Effect::ChromaKey { color: "#00ff00".into(), similarity: 0.3, blend: 0.1 },
            4.0,
        );
        assert_eq!(v, vec!["chromakey=color=0x00ff00:similarity=0.300:blend=0.100"]);
        let a = effect_audio_filters(&editor_core::Effect::Denoise { strength: 0.5 }, 4.0);
        assert_eq!(a, vec!["afftdn=nr=21.0"]);
        assert_eq!(atempo_chain(4.0), vec!["atempo=2.000", "atempo=2.000"]);
    }

    #[test]
    fn reverse_effect_filters() {
        assert_eq!(effect_video_filters(&editor_core::Effect::Reverse, 3.0), vec!["reverse"]);
        assert_eq!(effect_audio_filters(&editor_core::Effect::Reverse, 3.0), vec!["areverse"]);
    }

    #[test]
    fn sepia_interpolates_matrix() {
        let full = effect_video_filters(&editor_core::Effect::Sepia { intensity: 1.0 }, 4.0);
        assert!(full[0].contains("colorchannelmixer=0.393:0.769:0.189:0"), "{}", full[0]);
        let none = effect_video_filters(&editor_core::Effect::Sepia { intensity: 0.0 }, 4.0);
        assert!(none[0].contains("colorchannelmixer=1.000:0.000:0.000:0"), "{}", none[0]);
    }

    /// Live render of Wave 6 export features: LUT, linear mask, pitch
    /// shift, smooth slow-mo (minterpolate) and GIF output.
    #[test]
    #[ignore]
    fn renders_wave6_features() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mp4");
        if !src.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
                       "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                       "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                .arg(&src).status().unwrap();
            assert!(status.success());
        }
        let lut = dir.join("identity.cube");
        std::fs::write(&lut, "TITLE \"id\"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n").unwrap();
        let sources: BTreeMap<String, PathBuf> =
            [("c1".to_string(), src.clone()), ("m1".to_string(), src.clone())].into_iter().collect();
        let make = |fx: Vec<Effect>, slowmo: bool| {
            let mut p = Project::default();
            p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
            let mut clip = Clip::new("c1", "src.mp4", 0.0, 1.0, 0.0);
            clip.effects = fx;
            clip.smooth_slowmo = slowmo;
            if slowmo { clip.speed = 0.5; }
            p.tracks[0].clips = vec![clip];
            let mut music = Clip::new("m1", "src.mp4", 0.0, 1.0, 0.0);
            music.effects = vec![Effect::PitchShift { semitones: 7.0 }];
            p.tracks[1].clips = vec![music];
            p
        };
        let p = make(vec![
            Effect::Lut { path: lut.to_string_lossy().to_string() },
            Effect::Mask { shape: "linear".into(), size: 0.5, feather: 0.3, invert: false },
        ], false);
        render(&p, &sources, &dir.join("wave6-lut.mp4"), &ExportSettings::default())
            .expect("lut+linear mask render");

        let p = make(vec![], true);
        let slow = dir.join("wave6-slowmo.mp4");
        render(&p, &sources, &slow, &ExportSettings::default()).expect("slowmo render");
        let out = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(&slow).output().unwrap();
        let dur: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0.0);
        assert!(dur > 1.7, "0.5x of 1s should be ~2s, got {dur}");

        let p = make(vec![], false);
        let gif_path = dir.join("wave6.gif");
        render(&p, &sources, &gif_path, &ExportSettings { gif: true, ..Default::default() })
            .expect("gif render");
        let head = std::fs::read(&gif_path).unwrap();
        assert_eq!(&head[0..3], b"GIF", "output should be a real GIF");
    }

    /// Live render with a PiP overlay track: red base, green overlay in
    /// the bottom-right quarter window.
    #[test]
    #[ignore]
    fn renders_pip_overlay() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |name: &str, color: &str| {
            let p = dir.join(name);
            if !p.exists() {
                let status = Command::new("ffmpeg")
                    .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                           &format!("color=c={color}:duration=2:size=320x240:rate=30"),
                           "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                           "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                    .arg(&p).status().unwrap();
                assert!(status.success());
            }
            p
        };
        let base = mk("base-red.mp4", "red");
        let over = mk("over-lime.mp4", "lime");
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        p.tracks[0].clips = vec![Clip::new("c1", "base-red.mp4", 0.0, 2.0, 0.0)];
        let mut oc = Clip::new("ov1", "over-lime.mp4", 0.0, 2.0, 0.0);
        oc.overlay_scale = Some(0.5);
        oc.overlay_x = Some(1.0);
        oc.overlay_y = Some(1.0);
        p.tracks.insert(1, {
            let mut t = editor_core::Track::new("track-overlay", TrackKind::Video);
            t.clips = vec![oc];
            t
        });
        let sources: BTreeMap<String, PathBuf> =
            [("c1".to_string(), base), ("ov1".to_string(), over)].into_iter().collect();
        let out = dir.join("pip.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).expect("pip render");
        // Frame at t=1: center should be red-ish, bottom-right green-ish.
        let raw = Command::new("ffmpeg")
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&out)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output().unwrap();
        assert!(raw.status.success());
        let px = |x: usize, y: usize| {
            let i = (y * 320 + x) * 3;
            (raw.stdout[i], raw.stdout[i + 1], raw.stdout[i + 2])
        };
        let (r1, g1, _) = px(40, 40);
        assert!(r1 > 120 && g1 < 110, "base area should be red, got r={r1} g={g1}");
        let (r2, g2, _) = px(280, 200);
        assert!(g2 > 90 && r2 < 130, "pip area should be green, got r={r2} g={g2}");
    }

    #[test]
    fn image_overlay_input_is_looped() {
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        p.tracks[0].clips = vec![Clip::new("c1", "base.mp4", 0.0, 2.0, 0.0)];
        let mut oc = Clip::new("ov1", "logo.png", 0.0, 2.0, 0.0);
        oc.overlay_scale = Some(0.3);
        p.tracks.insert(1, {
            let mut t = editor_core::Track::new("track-overlay", TrackKind::Video);
            t.clips = vec![oc];
            t
        });
        let sources: BTreeMap<String, PathBuf> = [
            ("c1".to_string(), PathBuf::from("/media/base.mp4")),
            ("ov1".to_string(), PathBuf::from("/media/logo.png")),
        ].into_iter().collect();
        let args = build_ffmpeg_args(&p, &sources, Path::new("/tmp/out.mp4"), &ExportSettings::default()).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("-loop 1 -i /media/logo.png"), "{joined}");
        assert!(!joined.contains("-loop 1 -i /media/base.mp4"), "{joined}");
    }

    /// Live render: a still PNG (logo) watermarked over a red base.
    #[test]
    #[ignore]
    fn renders_image_overlay() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let base = dir.join("base-red.mp4");
        if !base.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:duration=2:size=320x240:rate=30",
                       "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                       "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                .arg(&base).status().unwrap();
            assert!(status.success());
        }
        let logo = dir.join("logo-white.png");
        if !logo.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=white:size=80x80", "-frames:v", "1"])
                .arg(&logo).status().unwrap();
            assert!(status.success());
        }
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        p.tracks[0].clips = vec![Clip::new("c1", "base-red.mp4", 0.0, 2.0, 0.0)];
        let mut oc = Clip::new("ov1", "logo-white.png", 0.0, 2.0, 0.0);
        oc.overlay_scale = Some(0.25);
        oc.overlay_x = Some(1.0);
        oc.overlay_y = Some(1.0);
        p.tracks.insert(1, {
            let mut t = editor_core::Track::new("track-overlay", TrackKind::Video);
            t.clips = vec![oc];
            t
        });
        let sources: BTreeMap<String, PathBuf> =
            [("c1".to_string(), base), ("ov1".to_string(), logo)].into_iter().collect();
        let out = dir.join("image-overlay.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).expect("image overlay render");
        let raw = Command::new("ffmpeg")
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&out)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output().unwrap();
        assert!(raw.status.success());
        let px = |x: usize, y: usize| {
            let i = (y * 320 + x) * 3;
            (raw.stdout[i], raw.stdout[i + 1], raw.stdout[i + 2])
        };
        let (r1, g1, _) = px(40, 40);
        assert!(r1 > 120 && g1 < 110, "base area should be red, got r={r1} g={g1}");
        let (r2, g2, b2) = px(290, 215);
        assert!(r2 > 180 && g2 > 180 && b2 > 180, "logo area should be white, got {r2},{g2},{b2}");
    }

    #[test]
    fn blend_mode_uses_crop_blend_path() {
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        p.tracks[0].clips = vec![Clip::new("c1", "base.mp4", 0.0, 2.0, 0.0)];
        let mut oc = Clip::new("ov1", "over.mp4", 0.0, 2.0, 0.0);
        oc.overlay_scale = Some(0.5);
        oc.overlay_x = Some(1.0);
        oc.overlay_y = Some(1.0);
        oc.blend_mode = Some("screen".to_string());
        p.tracks.insert(1, {
            let mut t = editor_core::Track::new("track-overlay", TrackKind::Video);
            t.clips = vec![oc];
            t
        });
        let sources: BTreeMap<String, PathBuf> = [
            ("c1".to_string(), PathBuf::from("/media/base.mp4")),
            ("ov1".to_string(), PathBuf::from("/media/over.mp4")),
        ].into_iter().collect();
        let dims: BTreeMap<String, (u32, u32)> =
            [("ov1".to_string(), (320u32, 240u32))].into_iter().collect();
        let args = build_ffmpeg_args_full(&p, &sources, Path::new("/tmp/o.mp4"),
            &ExportSettings::default(), &BTreeMap::new(), &dims).unwrap();
        let j = args.join(" ");
        // pw=160, ph=120, bottom-right => px=160, py=120.
        assert!(j.contains("crop=160:120:160:120"), "{j}");
        assert!(j.contains("blend=all_mode=screen"), "{j}");
        // Unknown modes fall back to plain compositing.
        let mut p2 = p.clone();
        p2.tracks[1].clips[0].blend_mode = Some("bogus".to_string());
        let args2 = build_ffmpeg_args_full(&p2, &sources, Path::new("/tmp/o.mp4"),
            &ExportSettings::default(), &BTreeMap::new(), &dims).unwrap();
        assert!(!args2.join(" ").contains("blend=all_mode"), "{}", args2.join(" "));
    }

    #[test]
    fn text_y_changes_drawtext_position() {
        let (mut p, sources) = two_clip_project();
        let args = build_ffmpeg_args(&p, &sources, Path::new("/tmp/o.mp4"), &ExportSettings::default()).unwrap();
        assert!(args.join(" ").contains("y=h-220"), "{}", args.join(" "));
        p.tracks.iter_mut().find(|t| t.kind == TrackKind::Text).unwrap().clips[0].text_y = Some(0.0);
        let args = build_ffmpeg_args(&p, &sources, Path::new("/tmp/o.mp4"), &ExportSettings::default()).unwrap();
        assert!(args.join(" ").contains("y=(h-text_h)*0.000"), "{}", args.join(" "));
    }

    /// Live render: green overlay in screen mode over a red base makes
    /// yellow in the rect, red outside it.
    #[test]
    #[ignore]
    fn renders_blend_mode_screen() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let mk = |name: &str, color: &str| {
            let p = dir.join(name);
            if !p.exists() {
                let status = Command::new("ffmpeg")
                    .args(["-y", "-v", "error", "-f", "lavfi", "-i",
                           &format!("color=c={color}:duration=2:size=320x240:rate=30"),
                           "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                           "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                    .arg(&p).status().unwrap();
                assert!(status.success());
            }
            p
        };
        let base = mk("base-red.mp4", "red");
        let over = mk("over-lime.mp4", "lime");
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        p.tracks[0].clips = vec![Clip::new("c1", "base-red.mp4", 0.0, 2.0, 0.0)];
        let mut oc = Clip::new("ov1", "over-lime.mp4", 0.0, 2.0, 0.0);
        oc.overlay_scale = Some(0.5);
        oc.overlay_x = Some(1.0);
        oc.overlay_y = Some(1.0);
        oc.blend_mode = Some("screen".to_string());
        p.tracks.insert(1, {
            let mut t = editor_core::Track::new("track-overlay", TrackKind::Video);
            t.clips = vec![oc];
            t
        });
        let sources: BTreeMap<String, PathBuf> =
            [("c1".to_string(), base), ("ov1".to_string(), over)].into_iter().collect();
        let out = dir.join("blend-screen.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).expect("blend render");
        let raw = Command::new("ffmpeg")
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&out)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output().unwrap();
        assert!(raw.status.success());
        let px = |x: usize, y: usize| {
            let i = (y * 320 + x) * 3;
            (raw.stdout[i], raw.stdout[i + 1], raw.stdout[i + 2])
        };
        let (r1, g1, _) = px(40, 40);
        assert!(r1 > 120 && g1 < 110, "outside rect should stay red, got r={r1} g={g1}");
        let (r2, g2, b2) = px(280, 200);
        assert!(r2 > 180 && g2 > 180 && b2 < 120, "screen(red,green) should be yellow, got {r2},{g2},{b2}");
    }

    /// Live render: HSL range shift recolors the frame; text glow
    /// leaves a colored halo.
    #[test]
    #[ignore]
    fn renders_hsl_shift_and_text_glow() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let base_path = dir.join("base-red.mp4");
        if !base_path.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=30",
                       "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                       "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
                .arg(&base_path).status().unwrap();
            assert!(status.success());
        }
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        let mut c1 = Clip::new("c1", "base-red.mp4", 0.0, 2.0, 0.0);
        let mut shifts = vec![[0.0; 3]; 8];
        shifts[0] = [50.0, 0.0, 0.0]; // reds +90 degrees -> chartreuse
        c1.effects.push(Effect::Hsl { shifts });
        p.tracks[0].clips = vec![c1];
        let mut t = Clip::text_clip("t1", "HI", 0.0, 2.0);
        t.font_size = Some(90);
        t.text_y = Some(0.5);
        t.text_glow = Some("#00ffff".to_string());
        let ti = p.tracks.iter().position(|t| t.kind == TrackKind::Text).unwrap();
        p.tracks[ti].clips = vec![t];
        let sources = BTreeMap::from([("c1".to_string(), base_path)]);
        let out = dir.join("hsl-glow.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).expect("render");
        let raw0 = Command::new("ffmpeg")
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&out)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output().unwrap();
        assert!(raw0.status.success());
        let pi = (20 * 320 + 20) * 3;
        let (r2, g2, b2) = (raw0.stdout[pi], raw0.stdout[pi + 1], raw0.stdout[pi + 2]);
        assert!(g2 > 170 && r2 > 60 && r2 < 210 && b2 < 90,
            "HSL-rotated red should be chartreuse, got {r2},{g2},{b2}");
        let raw = Command::new("ffmpeg")
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&out)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output().unwrap();
        assert!(raw.status.success());
        let mut cyan = 0usize;
        for px in raw.stdout.chunks_exact(3) {
            if px[2] > 150 && px[1] > 150 && px[0] < 110 { cyan += 1; }
        }
        assert!(cyan > 40, "expected a cyan glow halo, found {cyan} cyan px");
    }

    /// Live render: two text clips at different heights no longer stack.
    #[test]
    #[ignore]
    fn renders_text_at_different_heights() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let base = dir.join("base-red.mp4");
        if !base.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:duration=2:size=320x240:rate=30",
                       "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                       "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                .arg(&base).status().unwrap();
            assert!(status.success());
        }
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        p.tracks[0].clips = vec![Clip::new("c1", "base-red.mp4", 0.0, 2.0, 0.0)];
        let mut t1 = Clip::text_clip("t1", "TOP", 0.0, 2.0);
        t1.text_y = Some(0.0);
        let mut t2 = Clip::text_clip("t2", "BOTTOM", 0.0, 2.0);
        t2.text_y = Some(1.0);
        p.tracks.iter_mut().find(|t| t.kind == TrackKind::Text).unwrap().clips = vec![t1, t2];
        let sources: BTreeMap<String, PathBuf> = [("c1".to_string(), base)].into_iter().collect();
        let out = dir.join("text-heights.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).expect("text heights render");
        let raw = Command::new("ffmpeg")
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&out)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output().unwrap();
        assert!(raw.status.success());
        // Count near-white pixels in the top and bottom thirds.
        let count_white = |y0: usize, y1: usize| {
            let mut n = 0;
            for y in y0..y1 {
                for x in 0..320 {
                    let i = (y * 320 + x) * 3;
                    if raw.stdout[i] > 200 && raw.stdout[i + 1] > 200 && raw.stdout[i + 2] > 200 { n += 1; }
                }
            }
            n
        };
        let top = count_white(0, 80);
        let mid = count_white(95, 145);
        let bot = count_white(160, 240);
        assert!(top > 100, "TOP text should render in the top third, white px={top}");
        assert!(bot > 100, "BOTTOM text should render in the bottom third, white px={bot}");
        assert!(mid < top && mid < bot, "middle should be emptier than both, mid={mid} top={top} bot={bot}");
    }

    #[test]
    fn encoder_names() {
        assert_eq!(Encoder::Nvenc.ffmpeg_codec(), "h264_nvenc");
        assert_eq!(Encoder::VideoToolbox.ffmpeg_codec(), "h264_videotoolbox");
    }

    /// Live end-to-end render WITH effects applied — ignored by default.
    #[test]
    #[ignore]
    fn renders_a_real_mp4_with_effects() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mp4");
        if !src.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
                       "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                       "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                .arg(&src).status().unwrap();
            assert!(status.success());
        }
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        let mut c = Clip::new("c1", "src.mp4", 0.0, 2.0, 0.0);
        c.effects = vec![
            editor_core::Effect::Adjust { brightness: 0.05, contrast: 1.1, saturation: 0.9 },
            editor_core::Effect::Sepia { intensity: 0.5 },
            editor_core::Effect::Vignette { strength: 0.5 },
            editor_core::Effect::Temperature { kelvin: 5200.0 },
            editor_core::Effect::FadeIn { duration: 0.3 },
            editor_core::Effect::FadeOut { duration: 0.3 },
        ];
        p.add_clip("track-video", c).unwrap();
        let sources = BTreeMap::from([("c1".to_string(), src)]);
        let out = dir.join("out-effects.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).unwrap();
        assert!(out.metadata().unwrap().len() > 10_000);
    }

    /// Live end-to-end render of Wave 3 features in one project:
    /// speed curve + freeze frame + keyframed zoom/opacity + chroma key.
    #[test]
    #[ignore]
    fn renders_wave3_features() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mp4");
        if !src.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
                       "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                       "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                .arg(&src).status().unwrap();
            assert!(status.success());
        }
        let green = dir.join("green.mp4");
        if !green.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=green:size=320x240:duration=2:rate=30",
                       "-f", "lavfi", "-i", "sine=frequency=220:duration=2",
                       "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                .arg(&green).status().unwrap();
            assert!(status.success());
        }
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        let mut c1 = Clip::new("c1", "src.mp4", 0.0, 2.0, 0.0);
        c1.speed_curve = Some(vec![
            editor_core::SpeedPoint { at: 0.0, speed: 0.5 },
            editor_core::SpeedPoint { at: 0.5, speed: 2.0 },
        ]);
        p.add_clip("track-video", c1).unwrap();
        let mut c2 = Clip::new("c2", "src.mp4", 1.0, 1.0, 3.0);
        c2.freeze_duration = Some(1.0);
        p.add_clip("track-video", c2).unwrap();
        let mut c3 = Clip::new("c3", "src.mp4", 0.0, 2.0, 4.0);
        c3.keyframes = vec![
            editor_core::Keyframe { at: 0.0, scale: 1.0, opacity: 1.0, ..Default::default() },
            editor_core::Keyframe { at: 2.0, scale: 1.8, opacity: 0.6, ..Default::default() },
        ];
        p.add_clip("track-video", c3).unwrap();
        let mut c4 = Clip::new("c4", "green.mp4", 0.0, 1.0, 6.0);
        c4.effects = vec![editor_core::Effect::ChromaKey {
            color: "#00ff00".into(), similarity: 0.4, blend: 0.1,
        }];
        p.add_clip("track-video", c4).unwrap();
        let sources = BTreeMap::from([
            ("c1".to_string(), src.clone()),
            ("c2".to_string(), src.clone()),
            ("c3".to_string(), src),
            ("c4".to_string(), green),
        ]);
        let out = dir.join("out-wave3.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).unwrap();
        assert!(out.metadata().unwrap().len() > 10_000);
    }

    /// Live end-to-end: mask matte render + real two-pass stabilization of
    /// a synthetically shaky clip (moving crop window).
    #[test]
    #[ignore]
    fn renders_mask_and_stabilized() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let shaky = dir.join("shaky.mp4");
        if !shaky.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi",
                       "-i", "testsrc=duration=2:size=400x300:rate=30",
                       "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
                       "-vf", "crop=320:240:x='40+25*sin(2*PI*t/0.7)':y='30+18*cos(2*PI*t/0.9)'",
                       "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                .arg(&shaky).status().unwrap();
            assert!(status.success());
        }
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        let mut c1 = Clip::new("c1", "shaky.mp4", 0.0, 2.0, 0.0);
        c1.effects = vec![
            editor_core::Effect::Mask { shape: "circle".into(), size: 0.7, feather: 0.25, invert: false },
            editor_core::Effect::Stabilize { smoothing: 10 },
        ];
        p.add_clip("track-video", c1).unwrap();
        let sources = BTreeMap::from([("c1".to_string(), shaky)]);
        let out = dir.join("out-mask-stab.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).unwrap();
        assert!(out.metadata().unwrap().len() > 10_000);
        // The detect pass must have produced a transforms file.
        let transforms = run_stabilize_detect_passes(&p, &sources);
        assert!(transforms.contains_key("c1"));
    }

    /// Live end-to-end render of two clips joined by an xfade transition.
    #[test]
    #[ignore]
    fn renders_two_clips_with_transition() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mp4");
        if !src.exists() {
            let status = Command::new("ffmpeg")
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
                       "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                       "-c:v", "libx264", "-c:a", "aac", "-shortest"])
                .arg(&src).status().unwrap();
            assert!(status.success());
        }
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        p.add_clip("track-video", Clip::new("c1", "src.mp4", 0.0, 2.0, 0.0)).unwrap();
        let mut c2 = Clip::new("c2", "src.mp4", 0.0, 2.0, 2.0);
        c2.transition_in = Some(editor_core::Transition { kind: "dissolve".into(), duration: 0.5 });
        p.add_clip("track-video", c2).unwrap();
        let sources = BTreeMap::from([
            ("c1".to_string(), src.clone()),
            ("c2".to_string(), src),
        ]);
        let out = dir.join("out-transition.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).unwrap();
        assert!(out.metadata().unwrap().len() > 10_000);
    }

    /// LIVE: canvas blur fill + audio-only MP3 + grade/loudnorm chain.
    #[test]
    #[ignore]
    fn live_wave8_render_paths() {
        use std::collections::BTreeMap as Map;
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        // Own source file: the shared src.mp4 is regenerated by sibling
        // tests running in parallel.
        let src = dir.join("src-wave8.mp4");
        let ok = Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                   "-c:v", "libx264", "-c:a", "aac", "-shortest"])
            .arg(&src).status().unwrap().success();
        assert!(ok);
        let mut clip = editor_core::Clip::new("c1", "src", 0.0, 2.0, 0.0);
        clip.effects = vec![
            editor_core::Effect::Loudnorm { target_lufs: -14.0 },
            editor_core::Effect::Curves {
                master: "0/0 0.5/0.6 1/1".into(), red: String::new(),
                green: String::new(), blue: String::new(),
            },
            editor_core::Effect::ColorWheels {
                shadows: [0.1, 0.0, -0.1], midtones: [0.0; 3], highlights: [-0.05, 0.0, 0.05],
            },
            editor_core::Effect::VideoDenoise { strength: 0.5 },
        ];
        let mut project = editor_core::Project::default();
        project.canvas.width = 240;
        project.canvas.height = 320;
        project.canvas_fill = "blur".into();
        project.tracks[0].clips = vec![clip];
        let mut sources = Map::new();
        sources.insert("c1".to_string(), src.clone());
        let out = dir.join("out-blur.mp4");
        render(&project, &sources, &out, &ExportSettings::default()).unwrap();
        assert!(out.metadata().unwrap().len() > 20_000, "blur render too small");

        let mp3 = dir.join("out-audio.mp3");
        let settings = ExportSettings { audio_only: true, ..Default::default() };
        render(&project, &sources, &mp3, &settings).unwrap();
        let bytes = std::fs::read(&mp3).unwrap();
        assert!(bytes.len() > 5_000, "mp3 too small");
        assert!(&bytes[0..3] == b"ID3" || (bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0), "not an mp3 stream");
    }

    /// Live end-to-end render with a generated test clip — ignored by
    /// default, run with: cargo test -p export-engine -- --ignored
    #[test]
    #[ignore]
    fn renders_a_real_mp4() {
        let dir = std::env::temp_dir().join("nightcut-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mp4");
        let status = Command::new("ffmpeg")
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=30",
                   "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                   "-c:v", "libx264", "-c:a", "aac", "-shortest"])
            .arg(&src).status().unwrap();
        assert!(status.success());
        let mut p = Project::default();
        p.canvas = editor_core::Canvas { width: 320, height: 240, fps: 30 };
        p.add_clip("track-video", Clip::new("c1", "src.mp4", 0.0, 2.0, 0.0)).unwrap();
        let sources = BTreeMap::from([("c1".to_string(), src)]);
        let out = dir.join("out.mp4");
        render(&p, &sources, &out, &ExportSettings::default()).unwrap();
        assert!(out.metadata().unwrap().len() > 10_000);
    }
}
