/// Snapshot tests for each adjustment type using test/fixtures/Desk.exr.
///
/// Each test applies an adjustment in two opposite directions and asserts that the
/// measurable effect is in the expected direction (e.g. higher exposure → brighter image).
/// This catches regressions without hardcoding exact pixel values, which vary across GPU
/// hardware.
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

struct Stats {
    mean_r: f64,
    mean_g: f64,
    mean_b: f64,
    variance: f64,
    corner_mean: f64,
    center_mean: f64,
}

fn compute_stats(path: &Path) -> Stats {
    let img = image::open(path).expect("failed to open image").to_rgba8();
    let (w, h) = img.dimensions();
    let n = (w * h) as f64;

    let mut sum_r = 0u64;
    let mut sum_g = 0u64;
    let mut sum_b = 0u64;
    let mut corner_sum = 0u64;
    let mut corner_count = 0u64;
    let mut center_sum = 0u64;
    let mut center_count = 0u64;

    // Corner = outermost 12.5% on each edge; center = inner 25% region.
    let border = (w.min(h) / 8) as i32;
    let cx = w as i32 / 2;
    let cy = h as i32 / 2;
    let center_r = w.min(h) as i32 / 4;

    for (x, y, pixel) in img.enumerate_pixels() {
        let r = pixel.0[0] as u64;
        let g = pixel.0[1] as u64;
        let b = pixel.0[2] as u64;
        let lum = (r + g + b) / 3;

        sum_r += r;
        sum_g += g;
        sum_b += b;

        let xi = x as i32;
        let yi = y as i32;

        if xi < border || xi >= w as i32 - border || yi < border || yi >= h as i32 - border {
            corner_sum += lum;
            corner_count += 1;
        }
        if (xi - cx).abs() < center_r && (yi - cy).abs() < center_r {
            center_sum += lum;
            center_count += 1;
        }
    }

    let mean_r = sum_r as f64 / n;
    let mean_g = sum_g as f64 / n;
    let mean_b = sum_b as f64 / n;
    let mean_lum = (mean_r + mean_g + mean_b) / 3.0;

    let variance = img
        .pixels()
        .map(|p| {
            let lum = (p.0[0] as f64 + p.0[1] as f64 + p.0[2] as f64) / 3.0;
            (lum - mean_lum).powi(2)
        })
        .sum::<f64>()
        / n;

    Stats {
        mean_r,
        mean_g,
        mean_b,
        variance,
        corner_mean: corner_sum as f64 / corner_count as f64,
        center_mean: center_sum as f64 / center_count as f64,
    }
}

/// Run `shade-cli edit Desk.exr --output <tmp>.png [extra_args...]`.
/// Returns None if no GPU is available.
fn run_edit(extra_args: &[&str]) -> Option<Stats> {
    let dir = tempdir().expect("temp dir");
    let output = dir.path().join("output.png");
    let input = desk_exr();

    let mut args = vec![
        "edit",
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

    Some(compute_stats(&output))
}

// ── Tone: exposure ────────────────────────────────────────────────────────────

#[test]
fn exposure_positive_brightens_image() {
    let Some(high) = run_edit(&["--exposure", "2.0"]) else {
        return;
    };
    let Some(low) = run_edit(&["--exposure", "-2.0"]) else {
        return;
    };
    let mean_high = (high.mean_r + high.mean_g + high.mean_b) / 3.0;
    let mean_low = (low.mean_r + low.mean_g + low.mean_b) / 3.0;
    assert!(
        mean_high > mean_low,
        "exposure +2 should be brighter than -2: {mean_high:.1} vs {mean_low:.1}"
    );
}

// ── Tone: contrast ────────────────────────────────────────────────────────────

#[test]
fn contrast_positive_raises_variance() {
    let Some(high) = run_edit(&["--contrast", "1.0"]) else {
        return;
    };
    let Some(low) = run_edit(&["--contrast", "-1.0"]) else {
        return;
    };
    assert!(
        high.variance > low.variance,
        "contrast +1 should have higher variance than -1: {:.1} vs {:.1}",
        high.variance,
        low.variance
    );
}

// ── Tone: blacks ──────────────────────────────────────────────────────────────

#[test]
fn blacks_positive_lifts_mean_luminance() {
    let Some(lifted) = run_edit(&["--blacks", "1.0"]) else {
        return;
    };
    let Some(baseline) = run_edit(&["--blacks", "0.0"]) else {
        return;
    };
    let mean_lifted = (lifted.mean_r + lifted.mean_g + lifted.mean_b) / 3.0;
    let mean_base = (baseline.mean_r + baseline.mean_g + baseline.mean_b) / 3.0;
    assert!(
        mean_lifted > mean_base,
        "blacks +1 should lift mean luminance above 0: {mean_lifted:.1} vs {mean_base:.1}"
    );
}

// ── Tone: highlights ──────────────────────────────────────────────────────────

#[test]
fn highlights_negative_dims_image() {
    let Some(compressed) = run_edit(&["--highlights", "-1.0"]) else {
        return;
    };
    let Some(expanded) = run_edit(&["--highlights", "1.0"]) else {
        return;
    };
    let mean_compressed = (compressed.mean_r + compressed.mean_g + compressed.mean_b) / 3.0;
    let mean_expanded = (expanded.mean_r + expanded.mean_g + expanded.mean_b) / 3.0;
    assert!(
        mean_compressed < mean_expanded,
        "highlights -1 should dim relative to +1: {mean_compressed:.1} vs {mean_expanded:.1}"
    );
}

// ── Tone: shadows ─────────────────────────────────────────────────────────────

#[test]
fn shadows_positive_lifts_luminance() {
    let Some(lifted) = run_edit(&["--shadows", "1.0"]) else {
        return;
    };
    let Some(lowered) = run_edit(&["--shadows", "-1.0"]) else {
        return;
    };
    let mean_lifted = (lifted.mean_r + lifted.mean_g + lifted.mean_b) / 3.0;
    let mean_lowered = (lowered.mean_r + lowered.mean_g + lowered.mean_b) / 3.0;
    assert!(
        mean_lifted > mean_lowered,
        "shadows +1 should be brighter than -1: {mean_lifted:.1} vs {mean_lowered:.1}"
    );
}

// ── Color: saturation ─────────────────────────────────────────────────────────

#[test]
fn saturation_zero_produces_greyscale() {
    let Some(s) = run_edit(&["--saturation", "0.0"]) else {
        return;
    };
    // All channels carry the same luminance value → means must match.
    let diff_rg = (s.mean_r - s.mean_g).abs();
    let diff_gb = (s.mean_g - s.mean_b).abs();
    assert!(
        diff_rg < 2.0,
        "saturation=0 should equalise R and G channel means: diff={diff_rg:.2}"
    );
    assert!(
        diff_gb < 2.0,
        "saturation=0 should equalise G and B channel means: diff={diff_gb:.2}"
    );
}

// ── Color: temperature ────────────────────────────────────────────────────────

#[test]
fn temperature_warm_shifts_red_over_blue() {
    let Some(warm) = run_edit(&["--temperature", "1.0"]) else {
        return;
    };
    assert!(
        warm.mean_r > warm.mean_b,
        "temperature +1 (warm) should make mean_r > mean_b: {:.1} vs {:.1}",
        warm.mean_r,
        warm.mean_b
    );
}

#[test]
fn temperature_cool_shifts_blue_over_red() {
    let Some(cool) = run_edit(&["--temperature", "-1.0"]) else {
        return;
    };
    assert!(
        cool.mean_b > cool.mean_r,
        "temperature -1 (cool) should make mean_b > mean_r: {:.1} vs {:.1}",
        cool.mean_b,
        cool.mean_r
    );
}

// ── Color: tint ───────────────────────────────────────────────────────────────

#[test]
fn tint_magenta_raises_rb_above_green() {
    let Some(magenta) = run_edit(&["--tint", "1.0"]) else {
        return;
    };
    let Some(green) = run_edit(&["--tint", "-1.0"]) else {
        return;
    };
    // Magenta tint lifts R+B relative to G; green tint does the opposite.
    let rb_magenta = (magenta.mean_r + magenta.mean_b) / 2.0;
    let rb_green = (green.mean_r + green.mean_b) / 2.0;
    assert!(
        rb_magenta > rb_green,
        "tint +1 (magenta) should raise (R+B)/2 above tint -1 (green): {rb_magenta:.1} vs {rb_green:.1}"
    );
    assert!(
        magenta.mean_g < green.mean_g,
        "tint +1 (magenta) should lower G below tint -1 (green): {:.1} vs {:.1}",
        magenta.mean_g,
        green.mean_g
    );
}

// ── Vignette ──────────────────────────────────────────────────────────────────

#[test]
fn vignette_darkens_corners_relative_to_center() {
    let Some(s) = run_edit(&["--vignette", "1.0"]) else {
        return;
    };
    assert!(
        s.corner_mean < s.center_mean,
        "vignette=1 should darken corners relative to center: corner={:.1}, center={:.1}",
        s.corner_mean,
        s.center_mean
    );
}

// ── Sharpen ───────────────────────────────────────────────────────────────────

#[test]
fn sharpen_increases_variance() {
    let Some(sharp) = run_edit(&["--sharpen", "2.0"]) else {
        return;
    };
    let Some(none) = run_edit(&[]) else {
        return;
    };
    assert!(
        sharp.variance > none.variance,
        "sharpen=2 should raise pixel variance above unsharpened: {:.1} vs {:.1}",
        sharp.variance,
        none.variance
    );
}

// ── Grain ─────────────────────────────────────────────────────────────────────

#[test]
fn grain_increases_variance() {
    let Some(grainy) = run_edit(&["--grain", "0.5"]) else {
        return;
    };
    let Some(none) = run_edit(&[]) else {
        return;
    };
    assert!(
        grainy.variance > none.variance,
        "grain=0.5 should raise pixel variance above clean render: {:.1} vs {:.1}",
        grainy.variance,
        none.variance
    );
}
