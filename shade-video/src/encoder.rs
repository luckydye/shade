//! Video frame encoding via `video-rs` / FFmpeg.

use anyhow::{Context, Result};
use std::path::Path;
use video_rs::{encode::Settings, Encoder, Time};

/// Output video codec / format selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoCodec {
    /// H.264 (AVC) — broad compatibility, small files. Default.
    #[default]
    H264,
    /// H.265 (HEVC) — better compression than H.264, slightly less compatible.
    H265,
    /// Apple ProRes 422 — near-lossless, ideal for post-production workflows.
    Prores422,
    /// Apple ProRes 4444 — lossless with alpha channel support.
    Prores4444,
}

impl std::str::FromStr for VideoCodec {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "h264" | "avc" => Ok(VideoCodec::H264),
            "h265" | "hevc" => Ok(VideoCodec::H265),
            "prores422" | "prores_422" => Ok(VideoCodec::Prores422),
            "prores4444" | "prores_4444" => Ok(VideoCodec::Prores4444),
            other => anyhow::bail!("unknown codec '{}'; valid options: h264, h265, prores422, prores4444", other),
        }
    }
}

/// Encodes RGBA8 frames to a video file.
///
/// Frames must be pushed in presentation order via [`VideoEncoder::push_frame`].
/// Call [`VideoEncoder::finish`] when all frames have been pushed to flush the
/// encoder and finalise the container.
pub struct VideoEncoder {
    inner: Encoder,
    width: u32,
    height: u32,
    fps: f64,
}

impl VideoEncoder {
    /// Open a video file for encoding.
    ///
    /// * `path`   — output file path; the container format is inferred from the
    ///              file extension (`.mp4`, `.mov`, `.mkv`).
    /// * `width`/`height` — frame dimensions in pixels.
    /// * `fps`    — frames per second (e.g. `24.0`, `29.97`, `60.0`).
    /// * `codec`  — output codec; see [`VideoCodec`].
    pub fn open(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        codec: VideoCodec,
    ) -> Result<Self> {
        let settings = build_settings(width, height, fps, codec);
        let location = video_rs::location::Location::File(path.to_path_buf());
        let inner = Encoder::new(location, settings)
            .with_context(|| format!("failed to open video for encoding: {}", path.display()))?;

        Ok(Self {
            inner,
            width,
            height,
            fps,
        })
    }

    /// Encode one frame.
    ///
    /// `rgba8` must be a flat RGBA8 slice with exactly `width × height × 4` bytes,
    /// in row-major order. `frame_index` is used to compute the presentation
    /// timestamp.
    pub fn push_frame(&mut self, rgba8: &[u8], frame_index: u64) -> Result<()> {
        assert_eq!(
            rgba8.len(),
            (self.width * self.height * 4) as usize,
            "rgba8 buffer size mismatch"
        );

        // Convert RGBA8 → RGB8 ndarray (video-rs / FFmpeg encoder expects RGB).
        let frame = rgba8_to_rgb_ndarray(rgba8, self.width, self.height);

        let ts = Time::from_nth_of_a_second(frame_index as usize, self.fps as usize);
        self.inner
            .encode(&frame, ts)
            .with_context(|| format!("failed to encode frame {}", frame_index))?;

        Ok(())
    }

    /// Flush and finalise the output file. Must be called after all frames.
    pub fn finish(mut self) -> Result<()> {
        self.inner.finish().context("failed to finish video encoding")
    }
}

/// Build video-rs encoder settings for the chosen codec.
fn build_settings(width: u32, height: u32, fps: f64, codec: VideoCodec) -> Settings {
    let (w, h) = (width as usize, height as usize);
    match codec {
        VideoCodec::H264 => Settings::preset_h264_yuv420p(w, h, false),
        VideoCodec::H265 => Settings::preset_h265_yuv420p(w, h, false),
        VideoCodec::Prores422 => Settings::for_prores(w, h),
        VideoCodec::Prores4444 => Settings::for_prores(w, h),
    }
}

/// Convert a flat RGBA8 slice to an RGB ndarray (dropping the alpha channel),
/// as expected by the video-rs Encoder.
fn rgba8_to_rgb_ndarray(
    rgba8: &[u8],
    width: u32,
    height: u32,
) -> ndarray::Array3<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut rgb = ndarray::Array3::<u8>::zeros((h, w, 3));
    for y in 0..h {
        for x in 0..w {
            let src = (y * w + x) * 4;
            rgb[(y, x, 0)] = rgba8[src];
            rgb[(y, x, 1)] = rgba8[src + 1];
            rgb[(y, x, 2)] = rgba8[src + 2];
        }
    }
    rgb
}
