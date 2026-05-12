use image::{ImageBuffer, RgbaImage};
use std::hint::black_box;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const WIDTH: u32 = 4200;
const HEIGHT: u32 = 2800;

fn main() -> anyhow::Result<()> {
    let path = fixture_path();
    if !path.exists() {
        write_fixture(&path)?;
    }

    let mut checksum = 0usize;
    report("startup", Duration::ZERO, checksum);

    let t = Instant::now();
    for max_dim in [1600, 1200, 900, 1200, 1800, 720, 1200, 1000] {
        let (pixels, width, height) = shade_io::load_image_preview(&path, max_dim)?;
        checksum ^= black_box(pixels.len() ^ width as usize ^ height as usize);
    }
    report("open_preview_repeated", t.elapsed(), checksum);

    let t = Instant::now();
    for _ in 0..6 {
        let thumbnail = shade_io::generate_desktop_thumbnail(
            path.to_str().expect("fixture path must be utf8"),
        )
        .map_err(anyhow::Error::msg)?;
        checksum ^= black_box(thumbnail.bytes.len());
    }
    report("desktop_thumbnail_queue_work", t.elapsed(), checksum);

    let t = Instant::now();
    for max_dim in [240, 320, 512, 240, 360, 320, 240, 512, 640, 320, 240, 512] {
        let (pixels, width, height) = shade_io::load_image_preview(&path, max_dim)?;
        checksum ^= black_box(pixels.len() ^ width as usize ^ height as usize);
    }
    report("grid_thumbnail_previews", t.elapsed(), checksum);

    Ok(())
}

fn fixture_path() -> PathBuf {
    std::env::temp_dir().join("shade-organic-preview-bench-4200x2800.jpg")
}

fn write_fixture(path: &PathBuf) -> anyhow::Result<()> {
    let mut pixels = Vec::with_capacity((WIDTH * HEIGHT * 4) as usize);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let wave = ((x.wrapping_mul(17) ^ y.wrapping_mul(29)) & 255) as u8;
            pixels.push(((x * 255 / WIDTH) as u8).saturating_add(wave / 12));
            pixels.push(((y * 255 / HEIGHT) as u8).saturating_add(wave / 16));
            pixels.push(
                255u8
                    .saturating_sub((x * 255 / WIDTH) as u8)
                    .saturating_add(wave / 20),
            );
            pixels.push(255);
        }
    }
    let image: RgbaImage = ImageBuffer::from_raw(WIDTH, HEIGHT, pixels)
        .expect("generated rgba buffer size must match dimensions");
    image.save_with_format(path, image::ImageFormat::Jpeg)?;
    Ok(())
}

fn report(phase: &str, elapsed: Duration, checksum: usize) {
    println!(
        "{{\"phase\":\"{}\",\"elapsed_ms\":{},\"rss_bytes\":{},\"checksum\":{}}}",
        phase,
        elapsed.as_millis(),
        current_rss_bytes(),
        checksum,
    );
}

#[cfg(target_os = "linux")]
fn current_rss_bytes() -> u64 {
    let statm =
        std::fs::read_to_string("/proc/self/statm").expect("read /proc/self/statm");
    let pages = statm
        .split_whitespace()
        .nth(1)
        .expect("statm rss field")
        .parse::<u64>()
        .expect("parse statm rss");
    pages * 4096
}

#[cfg(target_os = "macos")]
fn current_rss_bytes() -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("run ps for rss");
    let rss_kib = String::from_utf8(output.stdout)
        .expect("ps output utf8")
        .trim()
        .parse::<u64>()
        .expect("parse ps rss");
    rss_kib * 1024
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn current_rss_bytes() -> u64 {
    0
}
