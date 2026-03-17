//! Video decode/encode support for the shade render pipeline.
//!
//! This crate wraps `video-rs` (which uses system FFmpeg) to provide
//! frame-by-frame access to video files and encoding of processed frames
//! back to a video container.
//!
//! # Enabling
//!
//! The `ffmpeg` feature must be enabled and system FFmpeg libraries
//! (libavcodec, libavformat, libavutil, libswscale) must be installed:
//!
//! ```toml
//! shade-video = { path = "../shade-video", features = ["ffmpeg"] }
//! ```
//!
//! # Typical usage
//!
//! ```no_run
//! use shade_video::{VideoDecoder, VideoEncoder, VideoCodec};
//! use std::path::Path;
//!
//! shade_video::init();
//!
//! let mut decoder = VideoDecoder::open(Path::new("input.mp4")).unwrap();
//! let (w, h) = decoder.dimensions();
//! let fps = decoder.fps();
//!
//! let mut encoder = VideoEncoder::open(
//!     Path::new("output.mp4"), w, h, fps, VideoCodec::H264
//! ).unwrap();
//!
//! for frame_result in &mut decoder {
//!     let frame = frame_result.unwrap();
//!     // ... process frame.data (RGBA32F) through shade-gpu renderer ...
//!     let rgba8: Vec<u8> = vec![0u8; (w * h * 4) as usize]; // placeholder
//!     encoder.push_frame(&rgba8, frame.index).unwrap();
//! }
//! encoder.finish().unwrap();
//! ```

#[cfg(feature = "ffmpeg")]
pub mod decoder;
#[cfg(feature = "ffmpeg")]
pub mod encoder;

#[cfg(feature = "ffmpeg")]
pub use decoder::{FrameInfo, VideoDecoder};
#[cfg(feature = "ffmpeg")]
pub use encoder::{VideoCodec, VideoEncoder};

/// Initialize the underlying FFmpeg library. Must be called once before any
/// `VideoDecoder` or `VideoEncoder` is created. Subsequent calls are no-ops.
///
/// Only available when the `ffmpeg` feature is enabled.
#[cfg(feature = "ffmpeg")]
pub fn init() {
    video_rs::init().expect("failed to initialise FFmpeg via video-rs");
}

/// Stub when the `ffmpeg` feature is not enabled.
#[cfg(not(feature = "ffmpeg"))]
pub fn init() {
    panic!(
        "shade-video was compiled without the `ffmpeg` feature. \
         Install system FFmpeg and rebuild with --features ffmpeg."
    );
}
