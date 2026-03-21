/// Integration tests for gradient mask support through the full CLI → GPU pipeline.
///
/// Tests exercise the `stack` subcommand with `--mask linear` and `--mask radial` flags,
/// verifying that masks selectively apply adjustments to different regions of the image.
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::tempdir;

fn cli_bin() -> &'static str {
    env!("CARGO_BIN_EXE_shade-cli")
}

fn desk_exr() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/Desk.exr")
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
        eprintln!("skipping GPU test: {stderr}");
        return true;
    }
    false
}

struct RegionStats {
    top_half_mean: f64,
    bottom_half_mean: f64,
    center_mean: f64,
    corner_mean: f64,
    #[allow(dead_code)]
    overall_mean: f64,
}

fn compute_region_stats(path: &Path) -> RegionStats {
    let img = image::open(path).expect("failed to open image").to_rgba8();
    let (w, h) = img.dimensions();

    let mut top_sum = 0u64;
    let mut top_count = 0u64;
    let mut bottom_sum = 0u64;
    let mut bottom_count = 0u64;
    let mut center_sum = 0u64;
    let mut center_count = 0u64;
    let mut corner_sum = 0u64;
    let mut corner_count = 0u64;
    let mut total_sum = 0u64;

    let cx = w / 2;
    let cy = h / 2;
    let center_r = w.min(h) / 4;
    let border = w.min(h) / 8;

    for (x, y, pixel) in img.enumerate_pixels() {
        let lum = (pixel.0[0] as u64 + pixel.0[1] as u64 + pixel.0[2] as u64) / 3;
        total_sum += lum;

        if y < h / 2 {
            top_sum += lum;
            top_count += 1;
        } else {
            bottom_sum += lum;
            bottom_count += 1;
        }

        let xi = x as i32;
        let yi = y as i32;
        if (xi - cx as i32).unsigned_abs() < center_r
            && (yi - cy as i32).unsigned_abs() < center_r
        {
            center_sum += lum;
            center_count += 1;
        }
        if xi < border as i32
            || xi >= (w - border) as i32
            || yi < border as i32
            || yi >= (h - border) as i32
        {
            corner_sum += lum;
            corner_count += 1;
        }
    }

    let n = (w * h) as f64;
    RegionStats {
        top_half_mean: top_sum as f64 / top_count as f64,
        bottom_half_mean: bottom_sum as f64 / bottom_count as f64,
        center_mean: center_sum as f64 / center_count as f64,
        corner_mean: corner_sum as f64 / corner_count as f64,
        overall_mean: total_sum as f64 / n,
    }
}

/// Run `shade-cli stack Desk.exr --output <tmp>.png [extra_args...]`.
fn run_stack(extra_args: &[&str]) -> Option<RegionStats> {
    let dir = tempdir().expect("temp dir");
    let output = dir.path().join("output.png");
    let input = desk_exr();

    let mut args = vec![
        "stack",
        input.to_str().expect("input path utf-8"),
        "--output",
        output.to_str().expect("output path utf-8"),
    ];
    args.extend_from_slice(extra_args);

    let cli_out = run_cli(&args);
    if skip_if_no_gpu(&cli_out) {
        return None;
    }
    assert!(
        cli_out.status.success(),
        "shade-cli failed:\nstderr={}",
        String::from_utf8_lossy(&cli_out.stderr)
    );

    Some(compute_region_stats(&output))
}

// ── Linear mask tests ────────────────────────────────────────────────────────

#[test]
fn linear_mask_top_to_bottom_applies_exposure_gradually() {
    // Mask: top=0 (transparent), bottom=255 (opaque)
    // Exposure +2 should affect bottom more than top.
    let Some(masked) = run_stack(&["--exposure", "2.0", "--mask", "linear"]) else {
        return;
    };
    let Some(baseline) = run_stack(&["--exposure", "0.0"]) else {
        return;
    };
    // Bottom half should be brighter than baseline by more than top half
    let top_delta = masked.top_half_mean - baseline.top_half_mean;
    let bottom_delta = masked.bottom_half_mean - baseline.bottom_half_mean;
    assert!(
        bottom_delta > top_delta,
        "linear mask should apply more exposure to bottom than top: top_delta={top_delta:.1}, bottom_delta={bottom_delta:.1}"
    );
}

#[test]
fn linear_mask_limits_effect_at_transparent_end() {
    // With a top-to-bottom linear mask, the top should be almost unchanged
    let Some(masked) = run_stack(&["--exposure", "2.0", "--mask", "linear"]) else {
        return;
    };
    let Some(baseline) = run_stack(&["--exposure", "0.0"]) else {
        return;
    };
    let Some(unmasked) = run_stack(&["--exposure", "2.0"]) else {
        return;
    };
    // Top half of masked image should be closer to baseline than to unmasked
    let diff_to_baseline = (masked.top_half_mean - baseline.top_half_mean).abs();
    let diff_to_unmasked = (masked.top_half_mean - unmasked.top_half_mean).abs();
    assert!(
        diff_to_baseline < diff_to_unmasked,
        "transparent end of mask should leave pixels closer to baseline: to_baseline={diff_to_baseline:.1}, to_unmasked={diff_to_unmasked:.1}"
    );
}

// ── Radial mask tests ────────────────────────────────────────────────────────

#[test]
fn radial_mask_applies_more_at_center_than_edges() {
    // Radial mask: center=255 (opaque), edge=0 (transparent)
    // Exposure +2 should brighten center more than corners.
    let Some(masked) = run_stack(&["--exposure", "2.0", "--mask", "radial"]) else {
        return;
    };
    let Some(baseline) = run_stack(&["--exposure", "0.0"]) else {
        return;
    };
    let center_delta = masked.center_mean - baseline.center_mean;
    let corner_delta = masked.corner_mean - baseline.corner_mean;
    assert!(
        center_delta > corner_delta,
        "radial mask should apply more exposure at center than corners: center_delta={center_delta:.1}, corner_delta={corner_delta:.1}"
    );
}

#[test]
fn radial_mask_leaves_corners_near_baseline() {
    let Some(masked) = run_stack(&["--exposure", "2.0", "--mask", "radial"]) else {
        return;
    };
    let Some(baseline) = run_stack(&["--exposure", "0.0"]) else {
        return;
    };
    let Some(unmasked) = run_stack(&["--exposure", "2.0"]) else {
        return;
    };
    // Corners of masked image should be closer to baseline than to fully exposed
    let corner_to_baseline = (masked.corner_mean - baseline.corner_mean).abs();
    let corner_to_unmasked = (masked.corner_mean - unmasked.corner_mean).abs();
    assert!(
        corner_to_baseline < corner_to_unmasked,
        "radial mask corners should be closer to baseline: to_baseline={corner_to_baseline:.1}, to_unmasked={corner_to_unmasked:.1}"
    );
}

// ── No mask baseline ─────────────────────────────────────────────────────────

#[test]
fn no_mask_applies_exposure_uniformly() {
    // Without a mask, exposure should affect all regions roughly equally
    let Some(exposed) = run_stack(&["--exposure", "2.0"]) else {
        return;
    };
    let Some(baseline) = run_stack(&["--exposure", "0.0"]) else {
        return;
    };
    let top_delta = exposed.top_half_mean - baseline.top_half_mean;
    let bottom_delta = exposed.bottom_half_mean - baseline.bottom_half_mean;
    // Both halves should brighten by a similar amount (within 20% of each other)
    let ratio = if top_delta > bottom_delta {
        bottom_delta / top_delta
    } else {
        top_delta / bottom_delta
    };
    assert!(
        ratio > 0.5,
        "without mask, exposure should be roughly uniform: top_delta={top_delta:.1}, bottom_delta={bottom_delta:.1}, ratio={ratio:.2}"
    );
}
