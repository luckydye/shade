use std::path::Path;
use std::process::Command;

use exr::prelude::write_rgba_file;
use image::{GenericImageView, ImageBuffer, Rgba};
use tempfile::tempdir;

fn cli_bin() -> &'static str {
    env!("CARGO_BIN_EXE_shade-cli")
}

fn run_cli(args: &[&str]) -> std::process::Output {
    Command::new(cli_bin())
        .args(args)
        .output()
        .expect("failed to launch shade-cli")
}

fn skip_if_no_gpu(output: &std::process::Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("No suitable wgpu adapter found") {
        eprintln!("skipping CLI GPU test: {stderr}");
        return true;
    }
    false
}

fn write_png(path: &Path) {
    let image = ImageBuffer::from_fn(2, 1, |x, _| match x {
        0 => Rgba([32u8, 64, 96, 255]),
        1 => Rgba([192u8, 128, 64, 255]),
        _ => unreachable!(),
    });
    image.save(path).expect("failed to save png fixture");
}

fn write_hdr_exr(path: &Path) {
    write_rgba_file(path, 2, 1, |x, _| match x {
        0 => (2.0f32, 0.0f32, 0.0f32, 1.0f32),
        1 => (4.0f32, 0.0f32, 0.0f32, 1.0f32),
        _ => unreachable!(),
    })
    .expect("failed to save exr fixture");
}

#[test]
fn edit_command_writes_output_png() {
    let dir = tempdir().expect("failed to create temp dir");
    let input = dir.path().join("input.png");
    let output = dir.path().join("output.png");
    write_png(&input);

    let cli_output = run_cli(&[
        "edit",
        input.to_str().expect("input path utf-8"),
        "--output",
        output.to_str().expect("output path utf-8"),
        "--exposure",
        "0.5",
        "--contrast",
        "0.1",
    ]);
    if skip_if_no_gpu(&cli_output) {
        return;
    }
    assert!(
        cli_output.status.success(),
        "shade-cli failed: stdout={}\nstderr={}",
        String::from_utf8_lossy(&cli_output.stdout),
        String::from_utf8_lossy(&cli_output.stderr)
    );

    let image = image::open(&output).expect("failed to open cli output");
    assert_eq!(image.dimensions(), (2, 1));
}

#[test]
fn hdr_exr_edit_preserves_highlight_separation_before_output_quantization() {
    let dir = tempdir().expect("failed to create temp dir");
    let input = dir.path().join("input.exr");
    let output = dir.path().join("output.png");
    write_hdr_exr(&input);

    let cli_output = run_cli(&[
        "edit",
        input.to_str().expect("input path utf-8"),
        "--output",
        output.to_str().expect("output path utf-8"),
        "--exposure=-2",
    ]);
    if skip_if_no_gpu(&cli_output) {
        return;
    }
    assert!(
        cli_output.status.success(),
        "shade-cli failed: stdout={}\nstderr={}",
        String::from_utf8_lossy(&cli_output.stdout),
        String::from_utf8_lossy(&cli_output.stderr)
    );

    let image = image::open(&output)
        .expect("failed to open cli output")
        .to_rgba8();
    let left = image.get_pixel(0, 0).0[0];
    let right = image.get_pixel(1, 0).0[0];

    assert!(
        left < right,
        "expected hdr values to remain distinct, got left={left}, right={right}"
    );
    assert!(
        right > 200,
        "expected brighter hdr pixel to remain bright after exposure reduction, got {right}"
    );
}
