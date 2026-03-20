use anyhow::{Context, Result};
use std::path::Path;
use video_rs::Decoder;

pub struct FrameInfo {
    pub index: u64,
    pub timestamp: f64,
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}

pub struct VideoDecoder {
    inner: Decoder,
    frame_count: Option<u64>,
    fps: f64,
    width: u32,
    height: u32,
    current_index: u64,
}

impl VideoDecoder {
    pub fn open(path: &Path) -> Result<Self> {
        let location = video_rs::location::Location::File(path.to_path_buf());
        let inner = Decoder::new(location)
            .with_context(|| format!("failed to open video for decoding: {}", path.display()))?;
        let size = inner.size();
        let (width, height) = (size.0 as u32, size.1 as u32);
        let fps = inner.frame_rate();
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

    pub fn frame_count(&self) -> Option<u64> {
        self.frame_count
    }

    pub fn fps(&self) -> f64 {
        self.fps
    }

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
                Some(Ok(FrameInfo {
                    index,
                    timestamp: ts_secs,
                    width: self.width,
                    height: self.height,
                    data: rgb_u8_frame_to_rgba_f32(&frame),
                }))
            }
            Err(video_rs::Error::ReadExhausted) => None,
            Err(error) => Some(Err(error.into())),
        }
    }
}

fn rgb_u8_frame_to_rgba_f32(frame: &ndarray::Array3<u8>) -> Vec<f32> {
    let shape = frame.shape();
    let (h, w, channels) = (shape[0], shape[1], shape[2]);
    let mut out = Vec::with_capacity(w * h * 4);
    for row in frame.outer_iter() {
        for pixel in row.exact_chunks([channels]) {
            let a = if channels == 4 {
                pixel[3] as f32 / 255.0
            } else {
                1.0
            };
            out.push(pixel[0] as f32 / 255.0);
            out.push(pixel[1] as f32 / 255.0);
            out.push(pixel[2] as f32 / 255.0);
            out.push(a);
        }
    }
    out
}
