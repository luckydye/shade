//! Video frame decoding via `video-rs` / FFmpeg.

use anyhow::{Context, Result};
use std::path::Path;
use video_rs::Decoder;

/// Decoded video frame with RGBA32F pixel data and metadata.
pub struct FrameInfo {
    /// Zero-based frame index within the stream.
    pub index: u64,
    /// Presentation timestamp in seconds.
    pub timestamp: f64,
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Raw pixels in RGBA32F (linear, row-major). Length = width × height × 4.
    pub data: Vec<f32>,
}

/// Iterates over decoded frames of a video file.
///
/// Each call to [`Iterator::next`] decodes and converts the next frame to
/// RGBA32F. The caller is responsible for applying colour-space conversions
/// (e.g. sRGB→linear) before feeding the data into the GPU pipeline.
pub struct VideoDecoder {
    inner: Decoder,
    frame_count: Option<u64>,
    fps: f64,
    width: u32,
    height: u32,
    current_index: u64,
}

impl VideoDecoder {
    /// Open a video file for decoding.
    pub fn open(path: &Path) -> Result<Self> {
        let location = video_rs::location::Location::File(path.to_path_buf());
        let inner = Decoder::new(location)
            .with_context(|| format!("failed to open video for decoding: {}", path.display()))?;

        let size = inner.size();
        let (width, height) = (size.0 as u32, size.1 as u32);

        let fps = inner.frame_rate();

        // Best-effort frame count; unavailable for some container/codec combos.
        let frame_count = inner.duration().ok().map(|(duration, time_base)| {
            let seconds = duration as f64 * time_base;
            (seconds * fps).round() as u64
        });

        Ok(Self {
            inner,
            frame_count,
            fps,
            width,
            height,
            current_index: 0,
        })
    }

    /// Approximate total frame count derived from container duration and fps.
    /// Returns `None` when the container does not provide a reliable duration.
    pub fn frame_count(&self) -> Option<u64> {
        self.frame_count
    }

    /// Frames per second of the video stream.
    pub fn fps(&self) -> f64 {
        self.fps
    }

    /// (width, height) in pixels.
    pub fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

impl Iterator for VideoDecoder {
    type Item = Result<FrameInfo>;

    fn next(&mut self) -> Option<Self::Item> {
        match self.inner.decode() {
            Ok((timestamp, frame)) => {
                let index = self.current_index;
                self.current_index += 1;

                let ts_secs = timestamp
                    .map(|(pts, tb)| pts as f64 * tb)
                    .unwrap_or(index as f64 / self.fps.max(1.0));

                // video-rs delivers frames as ndarray::Array3<u8> in RGB or RGBA.
                // Convert to RGBA32F in the range [0, 1].
                let data = rgb_u8_frame_to_rgba_f32(&frame);

                Some(Ok(FrameInfo {
                    index,
                    timestamp: ts_secs,
                    width: self.width,
                    height: self.height,
                    data,
                }))
            }
            // End of stream — video-rs returns a specific error variant.
            Err(video_rs::Error::ReadExhausted) => None,
            Err(e) => Some(Err(e.into())),
        }
    }
}

/// Convert an RGB/RGBA u8 ndarray frame (from video-rs) to a flat RGBA32F Vec.
///
/// video-rs decodes into `ndarray::Array3<u8>` with shape [H, W, C] where
/// C is 3 (RGB) or 4 (RGBA). We normalise to [0, 1] and add an alpha=1
/// channel when the source is RGB.
fn rgb_u8_frame_to_rgba_f32(frame: &ndarray::Array3<u8>) -> Vec<f32> {
    let shape = frame.shape();
    let (h, w, channels) = (shape[0], shape[1], shape[2]);
    let mut out = Vec::with_capacity(w * h * 4);

    for row in frame.outer_iter() {
        for pixel in row.exact_chunks([channels]) {
            let r = pixel[0] as f32 / 255.0;
            let g = pixel[1] as f32 / 255.0;
            let b = pixel[2] as f32 / 255.0;
            let a = if channels == 4 {
                pixel[3] as f32 / 255.0
            } else {
                1.0
            };
            out.push(r);
            out.push(g);
            out.push(b);
            out.push(a);
        }
    }

    out
}
