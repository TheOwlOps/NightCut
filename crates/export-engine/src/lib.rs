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
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self { encoder: Encoder::Software, crf: 20, font_file: None }
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
    let dur = clip.duration();
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
        _ => Vec::new(),
    }
}

/// Escape a string for use inside an FFmpeg drawtext `text='...'`.
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
        .map(|t| t.clips.iter().filter(|c| !c.source.is_empty()).collect())
        .unwrap_or_default();
    for clip in &music {
        let path = sources.get(&clip.id)
            .ok_or_else(|| ExportError::UnresolvedSource(clip.id.clone()))?;
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
        let needs_alpha = has_chroma
            || clip.keyframes.iter().any(|k| k.opacity < 0.999);
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
        } else {
            let mut vchain = vec![
                format!("trim=start={:.3}:end={:.3}", clip.in_sec, clip.out_sec),
                format!("setpts=(PTS-STARTPTS)/{:.3}", clip.speed.max(0.01)),
            ];
            vchain.extend(scale_pad.iter().cloned());
            filters.push(format!("[{i}:v]{}[vb{i}]", vchain.join(",")));
            let mut achain = vec![
                format!("atrim=start={:.3}:end={:.3}", clip.in_sec, clip.out_sec),
                "asetpts=PTS-STARTPTS".to_string(),
                format!("atempo={:.3}", clip.speed.clamp(0.5, 2.0)),
                "aresample=48000".to_string(),
                format!("volume={:.2}", clip.volume.clamp(0.0, 2.0)),
            ];
            filters.push(format!("[{i}:a]{}[ab{i}]", achain.join(",")));
        }

        // ---- step 2: keyframes + video effects
        let mut vlabel = format!("vb{i}");
        for (step, filter) in keyframe_filters(clip, w, h, fps).into_iter().enumerate() {
            let next = format!("vk{i}_{step}");
            filters.push(format!("[{vlabel}]{filter}[{next}]"));
            vlabel = next;
        }
        let vfx: Vec<String> = clip.effects.iter().flat_map(|fx| effect_video_filters(fx, dur)).collect();
        if !vfx.is_empty() {
            let next = format!("ve{i}");
            filters.push(format!("[{vlabel}]{}[{next}]", vfx.join(",")));
            vlabel = next;
        }
        if needs_alpha {
            // Composite over a black canvas of the same duration so the
            // alpha (chroma key / keyframed opacity) becomes visible.
            if has_chroma {
                // Chroma alpha already exists; a keyframed opacity on top is
                // approximated by its minimum value as a constant alpha scale.
                if let Some(min_op) = clip.keyframes.iter()
                    .map(|k| k.opacity)
                    .fold(None::<f64>, |m, o| Some(m.map_or(o, |x: f64| x.min(o))))
                    .filter(|o| *o < 0.999)
                {
                    let next = format!("va{i}");
                    filters.push(format!("[{vlabel}]colorchannelmixer=aa={min_op:.3}[{next}]"));
                    vlabel = next;
                }
            } else if let Some(op) = keyframe_opacity_expr(clip) {
                // Build an alpha matte: a gray stream whose brightness is
                // the opacity curve over time (geq on gray is well-defined),
                // then alphamerge it onto the clip.
                filters.push(format!(
                    "color=c=black:s={w}x{h}:r={fps}:d={dur:.3},format=gray,geq=lum='255*({op})'[vam{i}]"
                ));
                let next = format!("va{i}");
                filters.push(format!("[{vlabel}][vam{i}]alphamerge[{next}]"));
                vlabel = next;
            }
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

    // Text overlays on top of the merged video.
    let mut current = vcat;
    if let Some(font) = &settings.font_file {
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
                filters.push(format!(
                    "[{current}]drawtext=fontfile='{}':text='{}':fontsize={}:fontcolor={}:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-220:enable='between(t,{:.3},{:.3})'[{next}]",
                    font.display(),
                    escape_drawtext(text),
                    clip.font_size.unwrap_or(64),
                    color,
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

    args.push("-filter_complex".into());
    args.push(filters.join(";"));
    args.push("-map".into());
    args.push(format!("[{current}]"));
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
    args.push(output.display().to_string());
    Ok(args)
}

/// Render a project to `output` with FFmpeg.
pub fn render(
    project: &Project,
    sources: &BTreeMap<String, PathBuf>,
    output: &Path,
    settings: &ExportSettings,
) -> Result<PathBuf> {
    let args = build_ffmpeg_args(project, sources, output, settings)?;
    let status = Command::new("ffmpeg").args(&args).status()?;
    if !status.success() { return Err(ExportError::FfmpegFailed(status)); }
    Ok(output.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use editor_core::Clip;

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
