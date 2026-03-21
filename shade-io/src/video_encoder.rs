use anyhow::{Context, Result};
use std::path::Path;
use video_rs::{encode::Settings, Encoder, Time};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoCodec {
    #[default]
    H264,
    H265,
    Prores422,
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
            other => anyhow::bail!(
                "unknown codec '{}'; valid options: h264, h265, prores422, prores4444",
                other
            ),
        }
    }
}

pub struct VideoEncoder {
    inner: Encoder,
    width: u32,
    height: u32,
    fps: f64,
}

impl VideoEncoder {
    pub fn open(
        path: &Path,
        width: u32,
        height: u32,
        fps: f64,
        codec: VideoCodec,
    ) -> Result<Self> {
        let settings = build_settings(width, height, fps, codec);
        let location = video_rs::location::Location::File(path.to_path_buf());
        let inner = Encoder::new(location, settings).with_context(|| {
            format!("failed to open video for encoding: {}", path.display())
        })?;
        Ok(Self {
            inner,
            width,
            height,
            fps,
        })
    }

    pub fn push_frame(&mut self, rgba8: &[u8], frame_index: u64) -> Result<()> {
        assert_eq!(
            rgba8.len(),
            (self.width * self.height * 4) as usize,
            "rgba8 buffer size mismatch"
        );
        let frame = rgba8_to_rgb_ndarray(rgba8, self.width, self.height);
        let ts = Time::from_nth_of_a_second(frame_index as usize, self.fps as usize);
        self.inner
            .encode(&frame, ts)
            .with_context(|| format!("failed to encode frame {}", frame_index))?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<()> {
        self.inner
            .finish()
            .context("failed to finish video encoding")
    }
}

fn build_settings(width: u32, height: u32, _fps: f64, codec: VideoCodec) -> Settings {
    let (w, h) = (width as usize, height as usize);
    match codec {
        VideoCodec::H264 => Settings::preset_h264_yuv420p(w, h, false),
        VideoCodec::H265 => Settings::preset_h265_yuv420p(w, h, false),
        VideoCodec::Prores422 => Settings::for_prores(w, h),
        VideoCodec::Prores4444 => Settings::for_prores(w, h),
    }
}

fn rgba8_to_rgb_ndarray(rgba8: &[u8], width: u32, height: u32) -> ndarray::Array3<u8> {
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
