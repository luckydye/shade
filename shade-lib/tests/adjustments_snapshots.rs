use shade_lib::{
    build_curve_lut_from_points, AdjustmentOp, ColorParams, CurveControlPoint, DenoiseParams,
    FloatImage, GlowParams, GrainParams, HslParams, LayerStack, Renderer, SharpenParams,
    VignetteParams,
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const SNAPSHOT_DIR: &str = "tests/snapshots";
const TARGET_WIDTH: u32 = 512;

struct SnapshotCase {
    name: &'static str,
    ops: Vec<AdjustmentOp>,
    compare_to_original: bool,
}

async fn renderer_or_skip() -> Option<Renderer> {
    match Renderer::new().await {
        Ok(renderer) => Some(renderer),
        Err(error) if error.to_string().contains("No suitable wgpu adapter found") => {
            eprintln!("SKIP: {error}");
            None
        }
        Err(error) => panic!("renderer init failed: {error}"),
    }
}

fn fixture_paths() -> Vec<PathBuf> {
    let fixtures_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut fixtures = Vec::new();
    for entry in fs::read_dir(&fixtures_dir).expect("fixtures directory must be readable") {
        let path = entry.expect("fixture entry must be readable").path();
        let ext = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("jpg") | Some("jpeg") | Some("png")) {
            fixtures.push(path);
        }
    }
    assert!(!fixtures.is_empty(), "no supported fixtures found");
    fixtures.sort();
    fixtures
}

fn adjustment_cases() -> Vec<SnapshotCase> {
    vec![
        SnapshotCase {
            name: "noop",
            ops: vec![],
            compare_to_original: true,
        },
        SnapshotCase {
            name: "expsoure",
            ops: vec![AdjustmentOp::Tone {
                exposure: 1.0,
                contrast: 0.0,
                blacks: 0.0,
                whites: 0.0,
                highlights: 0.0,
                shadows: 0.0,
                gamma: 1.0,
            }],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "expsoure_minus_1ev",
            ops: vec![AdjustmentOp::Tone {
                exposure: -1.0,
                contrast: 0.0,
                blacks: 0.0,
                whites: 0.0,
                highlights: 0.0,
                shadows: 0.0,
                gamma: 1.0,
            }],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "tone",
            ops: vec![AdjustmentOp::Tone {
                exposure: 0.18,
                contrast: 0.22,
                blacks: -0.06,
                whites: 0.08,
                highlights: -0.2,
                shadows: 0.15,
                gamma: 1.02,
            }],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "color",
            ops: vec![AdjustmentOp::Color(ColorParams {
                saturation: 0.2,
                vibrancy: 0.18,
                temperature: 0.08,
                tint: -0.06,
            })],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "vignette",
            ops: vec![AdjustmentOp::Vignette(VignetteParams {
                amount: 0.35,
                midpoint: 0.45,
                feather: 0.4,
                roundness: 0.8,
            })],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "sharpen",
            ops: vec![AdjustmentOp::Sharpen(SharpenParams {
                amount: 0.8,
                threshold: 0.05,
            })],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "grain",
            ops: vec![AdjustmentOp::Grain(GrainParams {
                amount: 0.2,
                size: 1.2,
                roughness: 0.5,
                seed: 7.0,
            })],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "glow",
            ops: vec![AdjustmentOp::Glow(GlowParams {
                amount: 0.35,
                _pad: [0.0; 3],
            })],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "hsl",
            ops: vec![AdjustmentOp::Hsl(HslParams {
                red_hue: 0.08,
                red_sat: -0.1,
                red_lum: 0.05,
                green_hue: -0.05,
                green_sat: 0.12,
                green_lum: -0.04,
                blue_hue: 0.06,
                blue_sat: 0.1,
                blue_lum: 0.08,
            })],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "curves",
            ops: vec![AdjustmentOp::Curves {
                lut_r: build_curve_lut_from_points(&[
                    CurveControlPoint { x: 0.0, y: 0.0 },
                    CurveControlPoint { x: 72.0, y: 0.2 },
                    CurveControlPoint { x: 188.0, y: 0.86 },
                    CurveControlPoint { x: 255.0, y: 1.0 },
                ]),
                lut_g: build_curve_lut_from_points(&[
                    CurveControlPoint { x: 0.0, y: 0.0 },
                    CurveControlPoint { x: 96.0, y: 0.28 },
                    CurveControlPoint { x: 176.0, y: 0.74 },
                    CurveControlPoint { x: 255.0, y: 1.0 },
                ]),
                lut_b: build_curve_lut_from_points(&[
                    CurveControlPoint { x: 0.0, y: 0.0 },
                    CurveControlPoint { x: 64.0, y: 0.1 },
                    CurveControlPoint { x: 200.0, y: 0.84 },
                    CurveControlPoint { x: 255.0, y: 1.0 },
                ]),
                lut_master: build_curve_lut_from_points(&[
                    CurveControlPoint { x: 0.0, y: 0.0 },
                    CurveControlPoint { x: 80.0, y: 0.18 },
                    CurveControlPoint { x: 200.0, y: 0.88 },
                    CurveControlPoint { x: 255.0, y: 1.0 },
                ]),
                per_channel: true,
                control_points: None,
            }],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "lscurve",
            ops: vec![AdjustmentOp::LsCurve {
                lut: build_curve_lut_from_points(&[
                    CurveControlPoint { x: 0.0, y: 0.0 },
                    CurveControlPoint { x: 64.0, y: 0.14 },
                    CurveControlPoint { x: 184.0, y: 0.82 },
                    CurveControlPoint { x: 255.0, y: 1.0 },
                ]),
                control_points: None,
            }],
            compare_to_original: false,
        },
        SnapshotCase {
            name: "denoise",
            ops: vec![AdjustmentOp::Denoise(DenoiseParams {
                luma_strength: 0.2,
                chroma_strength: 0.2,
                mode: 0,
                _pad: 0.0,
            })],
            compare_to_original: false,
        },
    ]
}

fn load_fixture(path: &Path) -> FloatImage {
    shade_io::load_image_f32(path).unwrap_or_else(|error| {
        panic!("failed to load fixture {}: {error}", path.display());
    })
}

async fn render_case(
    renderer: &Renderer,
    image: &FloatImage,
    texture_id: u64,
    ops: Vec<AdjustmentOp>,
    keep_native_size: bool,
) -> (Vec<u8>, u32, u32) {
    let (target_width, target_height) = if keep_native_size {
        (image.width, image.height)
    } else {
        let target_height = ((TARGET_WIDTH as f32 / image.width as f32) * image.height as f32)
            .round()
            .max(1.0) as u32;
        (TARGET_WIDTH, target_height)
    };
    let mut stack = LayerStack::new();
    stack.add_image_layer(texture_id, image.width, image.height);
    if !ops.is_empty() {
        stack.add_adjustment_layer(ops);
    }

    let mut sources = HashMap::new();
    sources.insert(texture_id, image.clone());

    let bytes = renderer
        .render_stack_preview(
            &stack,
            &sources,
            image.width,
            image.height,
            target_width,
            target_height,
            None,
        )
        .await
        .expect("preview render failed");
    (bytes, target_width, target_height)
}

fn texture_id_for_fixture(path: &Path) -> u64 {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .expect("fixture filename must be valid utf-8");
    let mut hash: u64 = 1469598103934665603;
    for byte in name.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    hash
}

fn read_rgba(path: &Path) -> (Vec<u8>, u32, u32) {
    let image = image::open(path)
        .unwrap_or_else(|error| panic!("failed to read snapshot {}: {error}", path.display()));
    let rgba = image.to_rgba8();
    (rgba.into_raw(), image.width(), image.height())
}

fn load_fixture_rgba(path: &Path) -> (Vec<u8>, u32, u32) {
    read_rgba(path)
}

fn write_png(path: &Path, pixels: &[u8], width: u32, height: u32) {
    let parent = path.parent().expect("snapshot path must have parent");
    fs::create_dir_all(parent).expect("snapshot directory must be creatable");
    let image = image::RgbaImage::from_raw(width, height, pixels.to_vec())
        .expect("pixel buffer size must match dimensions");
    image.save(path).expect("failed to write snapshot png");
}

fn assert_image_match(
    actual: &[u8],
    expected: &[u8],
    width: u32,
    height: u32,
    snapshot_path: &Path,
) {
    assert_eq!(actual.len(), expected.len(), "snapshot byte length mismatch");
    let mut max_diff = 0u8;
    let mut changed = 0usize;
    for (left, right) in actual.iter().zip(expected.iter()) {
        let diff = left.abs_diff(*right);
        if diff > 0 {
            changed += 1;
        }
        if diff > max_diff {
            max_diff = diff;
        }
    }
    let changed_ratio = changed as f32 / actual.len() as f32;
    assert!(
        max_diff <= 2 && changed_ratio <= 0.005,
        "snapshot mismatch: {} ({}x{}), max_diff={}, changed_ratio={:.6}; run with UPDATE_SNAPSHOTS=1 to accept",
        snapshot_path.display(),
        width,
        height,
        max_diff,
        changed_ratio
    );
}

#[tokio::test]
async fn adjustments_match_snapshots() {
    let Some(renderer) = renderer_or_skip().await else {
        return;
    };

    let update_snapshots =
        std::env::var("UPDATE_SNAPSHOTS").is_ok_and(|value| value == "1" || value == "true");
    let snapshots_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(SNAPSHOT_DIR);

    for fixture_path in fixture_paths() {
        let fixture_stem = fixture_path
            .file_stem()
            .and_then(|value| value.to_str())
            .expect("fixture filename must be valid utf-8");
        let image = load_fixture(&fixture_path);
        let texture_id = texture_id_for_fixture(&fixture_path);

        for case in adjustment_cases() {
            let (actual, width, height) = render_case(
                &renderer,
                &image,
                texture_id,
                case.ops,
                case.compare_to_original,
            )
            .await;
            let snapshot_path = snapshots_dir.join(format!("{fixture_stem}__{}.png", case.name));

            if case.compare_to_original {
                let (original, original_width, original_height) = load_fixture_rgba(&fixture_path);
                assert_eq!(
                    (original_width, original_height),
                    (width, height),
                    "noop render dimensions must match original fixture dimensions"
                );
                assert_image_match(&actual, &original, width, height, &fixture_path);
            }

            if update_snapshots || !snapshot_path.exists() {
                write_png(&snapshot_path, &actual, width, height);
                continue;
            }

            let (expected, expected_width, expected_height) = read_rgba(&snapshot_path);
            assert_eq!(
                (expected_width, expected_height),
                (width, height),
                "snapshot dimensions mismatch for {}",
                snapshot_path.display()
            );
            assert_image_match(&actual, &expected, width, height, &snapshot_path);
        }
    }
}
