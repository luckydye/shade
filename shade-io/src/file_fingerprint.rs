//! Content-derived 256-bit file fingerprints
//! (see `docs/distributed-file-identification.md`, §3).
//!
//! Pure sync primitives: digest format, deterministic sample selection, the
//! [`SampleSource`] trait, and a local-filesystem [`LocalFile`] source.
//! Async network sources and the persistent cache live in sibling modules
//! and build on top of these.

use std::fmt;
use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Bytes read per sample for files larger than the whole-file threshold.
pub const SAMPLE_SIZE: u32 = 16 * 1024;

/// Files at or below this size are hashed in full (4 × `SAMPLE_SIZE`).
pub const WHOLE_FILE_THRESHOLD: u64 = 4 * SAMPLE_SIZE as u64;

/// `algo_version` for the sample-scheme fingerprint (§3.2 / §3.4).
pub const ALGO_V1_SAMPLES: u32 = 1;

/// `algo_version` for the S3 ETag fast-path scheme (§3.6).
pub const ALGO_V_S3_ETAG: u32 = 100;

const S3_ETAG_DOMAIN: &[u8] = b"shade-s3-etag-v1\0";
const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";

/// 256-bit content-derived fingerprint.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Fingerprint([u8; 32]);

impl Fingerprint {
    pub const LEN: usize = 32;

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        let mut out = String::with_capacity(64);
        for byte in self.0 {
            out.push(HEX_CHARS[(byte >> 4) as usize] as char);
            out.push(HEX_CHARS[(byte & 0x0f) as usize] as char);
        }
        out
    }

    pub fn from_hex(hex: &str) -> Result<Self, FingerprintError> {
        if hex.len() != 64 {
            return Err(FingerprintError::InvalidHex(format!(
                "expected 64 hex chars, got {}",
                hex.len()
            )));
        }
        let bytes = hex.as_bytes();
        let mut out = [0u8; 32];
        for i in 0..32 {
            let hi = decode_hex_nibble(bytes[i * 2])?;
            let lo = decode_hex_nibble(bytes[i * 2 + 1])?;
            out[i] = (hi << 4) | lo;
        }
        Ok(Self(out))
    }
}

impl fmt::Debug for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Fingerprint({})", self.to_hex())
    }
}

fn decode_hex_nibble(byte: u8) -> Result<u8, FingerprintError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(FingerprintError::InvalidHex(format!(
            "invalid hex character: {:?}",
            byte as char
        ))),
    }
}

#[derive(Debug)]
pub enum FingerprintError {
    Io(std::io::Error),
    TruncatedRead {
        offset: u64,
        requested: u32,
        got: u32,
    },
    InvalidHex(String),
}

impl fmt::Display for FingerprintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FingerprintError::Io(error) => write!(f, "fingerprint I/O error: {error}"),
            FingerprintError::TruncatedRead {
                offset,
                requested,
                got,
            } => write!(
                f,
                "truncated read at offset {offset}: requested {requested} bytes, got {got}"
            ),
            FingerprintError::InvalidHex(message) => {
                write!(f, "invalid fingerprint hex: {message}")
            }
        }
    }
}

impl std::error::Error for FingerprintError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            FingerprintError::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for FingerprintError {
    fn from(error: std::io::Error) -> Self {
        FingerprintError::Io(error)
    }
}

/// A byte-range source that can feed [`fingerprint_with_source`].
///
/// Implementations must return exactly `len` bytes starting at `offset`, or
/// surface [`FingerprintError::TruncatedRead`].
pub trait SampleSource {
    fn read_range(&mut self, offset: u64, len: u32) -> Result<Vec<u8>, FingerprintError>;
}

/// Deterministic sample offsets per §3.2.
///
/// - `size == 0`: empty.
/// - `0 < size <= 4 * SAMPLE_SIZE`: single offset at `0` (whole-file path).
/// - Otherwise: `[0, size/3, 2*size/3, size - SAMPLE_SIZE]`.
pub fn sample_offsets(size: u64) -> Vec<u64> {
    sample_plan(size).into_iter().map(|(offset, _)| offset).collect()
}

/// Deterministic `(offset, length)` plan per §3.2 / §3.4.
///
/// In the whole-file branch (size ≤ 64 KiB) the single chunk's length is the
/// file size. In the multi-sample branch each chunk is `SAMPLE_SIZE`.
pub fn sample_plan(size: u64) -> Vec<(u64, u32)> {
    if size == 0 {
        return Vec::new();
    }
    if size <= WHOLE_FILE_THRESHOLD {
        return vec![(0, size as u32)];
    }
    vec![
        (0, SAMPLE_SIZE),
        (size / 3, SAMPLE_SIZE),
        (2 * size / 3, SAMPLE_SIZE),
        (size - SAMPLE_SIZE as u64, SAMPLE_SIZE),
    ]
}

/// Fingerprint a file from a precomputed list of `(offset, chunk)` samples.
///
/// The digest format is fixed by §3.4 of the spec — changes here are a
/// wire-format break.
pub fn fingerprint_from_samples(size: u64, samples: &[(u64, &[u8])]) -> Fingerprint {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());
    hasher.update(&SAMPLE_SIZE.to_le_bytes());
    let num_samples = samples.len() as u32;
    hasher.update(&num_samples.to_le_bytes());
    for (offset, chunk) in samples {
        hasher.update(&offset.to_le_bytes());
        hasher.update(chunk);
    }
    Fingerprint(*hasher.finalize().as_bytes())
}

/// Sample-scheme fingerprint of a buffer already in memory.
///
/// Equivalent to feeding the buffer through a [`SampleSource`], but lets
/// callers that have the full bytes (e.g. just downloaded an S3 object,
/// just read a local file into a `Vec<u8>`) compute the spec-correct
/// fingerprint without re-reading from disk.
pub fn fingerprint_from_bytes(bytes: &[u8]) -> Fingerprint {
    let size = bytes.len() as u64;
    let plan = sample_plan(size);
    let samples: Vec<(u64, &[u8])> = plan
        .iter()
        .map(|(offset, len)| {
            let start = *offset as usize;
            let end = start + *len as usize;
            (*offset, &bytes[start..end])
        })
        .collect();
    fingerprint_from_samples(size, &samples)
}

/// S3 ETag fast-path fingerprint per §3.6. Surrounding quotes on the ETag
/// are stripped before hashing.
pub fn fingerprint_from_s3_etag(size: u64, etag: &str) -> Fingerprint {
    let trimmed = etag.trim().trim_matches('"');
    let mut hasher = blake3::Hasher::new();
    hasher.update(S3_ETAG_DOMAIN);
    hasher.update(&size.to_le_bytes());
    hasher.update(trimmed.as_bytes());
    Fingerprint(*hasher.finalize().as_bytes())
}

/// Drive a [`SampleSource`] through the §3.2 plan and produce a fingerprint.
pub fn fingerprint_with_source<S: SampleSource>(
    size: u64,
    src: &mut S,
) -> Result<Fingerprint, FingerprintError> {
    let plan = sample_plan(size);
    let mut chunks: Vec<(u64, Vec<u8>)> = Vec::with_capacity(plan.len());
    for (offset, len) in plan {
        let chunk = src.read_range(offset, len)?;
        if chunk.len() as u64 != u64::from(len) {
            return Err(FingerprintError::TruncatedRead {
                offset,
                requested: len,
                got: chunk.len().min(u32::MAX as usize) as u32,
            });
        }
        chunks.push((offset, chunk));
    }
    let refs: Vec<(u64, &[u8])> = chunks.iter().map(|(o, c)| (*o, c.as_slice())).collect();
    Ok(fingerprint_from_samples(size, &refs))
}

/// Local-file [`SampleSource`] (§4.1: explicit `seek + read_exact`).
pub struct LocalFile {
    file: File,
}

impl LocalFile {
    pub fn open(path: &Path) -> Result<Self, FingerprintError> {
        Ok(Self {
            file: File::open(path)?,
        })
    }
}

impl SampleSource for LocalFile {
    fn read_range(&mut self, offset: u64, len: u32) -> Result<Vec<u8>, FingerprintError> {
        self.file.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; len as usize];
        let mut filled = 0usize;
        while filled < buf.len() {
            let read = self.file.read(&mut buf[filled..])?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled != buf.len() {
            return Err(FingerprintError::TruncatedRead {
                offset,
                requested: len,
                got: filled as u32,
            });
        }
        Ok(buf)
    }
}

/// Result of fingerprinting a local file: digest plus the metadata needed to
/// populate a `file_fingerprints` cache row (§5).
pub struct LocalFingerprint {
    pub fingerprint: Fingerprint,
    pub size: u64,
    pub mtime_ms: Option<i64>,
}

/// Stat + sample + hash a local file.
pub fn fingerprint_local(path: &Path) -> Result<LocalFingerprint, FingerprintError> {
    let metadata = std::fs::metadata(path)?;
    let size = metadata.len();
    let mtime_ms = metadata_mtime_ms(&metadata);
    let mut source = LocalFile::open(path)?;
    let fingerprint = fingerprint_with_source(size, &mut source)?;
    Ok(LocalFingerprint {
        fingerprint,
        size,
        mtime_ms,
    })
}

fn metadata_mtime_ms(metadata: &Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(duration) => i64::try_from(duration.as_millis()).unwrap_or(i64::MAX),
        Err(error) => -i64::try_from(error.duration().as_millis()).unwrap_or(i64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempFile {
        path: PathBuf,
    }

    impl TempFile {
        fn create(contents: &[u8]) -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "shade-fp-test-{}-{}.bin",
                std::process::id(),
                n
            ));
            let mut file = File::create(&path).expect("create temp file");
            file.write_all(contents).expect("write temp file");
            file.sync_all().ok();
            Self { path }
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn deterministic_bytes(seed: u64, len: usize) -> Vec<u8> {
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            out.extend_from_slice(&state.to_le_bytes());
        }
        out.truncate(len);
        out
    }

    #[test]
    fn empty_file_is_deterministic_and_uses_no_samples() {
        let fp1 = fingerprint_from_samples(0, &[]);
        let fp2 = fingerprint_from_samples(0, &[]);
        assert_eq!(fp1, fp2);
        assert!(sample_plan(0).is_empty());
        assert!(sample_offsets(0).is_empty());
    }

    #[test]
    fn whole_file_path_for_one_byte_and_64kib() {
        for &size in &[1u64, 1024, WHOLE_FILE_THRESHOLD] {
            let plan = sample_plan(size);
            assert_eq!(plan.len(), 1, "size {size} must use whole-file path");
            assert_eq!(plan[0].0, 0);
            assert_eq!(u64::from(plan[0].1), size);
        }
    }

    #[test]
    fn samples_format_matches_spec() {
        let bytes = b"hello world!";
        let size = bytes.len() as u64;

        let mut expected = blake3::Hasher::new();
        expected.update(&size.to_le_bytes());
        expected.update(&SAMPLE_SIZE.to_le_bytes());
        expected.update(&1u32.to_le_bytes());
        expected.update(&0u64.to_le_bytes());
        expected.update(bytes);
        let expected_fp = Fingerprint(*expected.finalize().as_bytes());

        let actual = fingerprint_from_samples(size, &[(0, bytes)]);
        assert_eq!(actual, expected_fp);
    }

    #[test]
    fn empty_format_matches_spec() {
        let mut expected = blake3::Hasher::new();
        expected.update(&0u64.to_le_bytes());
        expected.update(&SAMPLE_SIZE.to_le_bytes());
        expected.update(&0u32.to_le_bytes());
        let expected_fp = Fingerprint(*expected.finalize().as_bytes());

        assert_eq!(fingerprint_from_samples(0, &[]), expected_fp);
    }

    #[test]
    fn size_is_part_of_the_digest() {
        let bytes = b"\x00\x01\x02\x03";
        let fp_a = fingerprint_from_samples(4, &[(0, bytes)]);
        let fp_b = fingerprint_from_samples(99, &[(0, bytes)]);
        assert_ne!(fp_a, fp_b);
    }

    #[test]
    fn sample_size_parameter_binds_into_digest() {
        // Reproduce the §3.4 byte-stream by hand with two different declared
        // SAMPLE_SIZE values; digests must differ.
        let bytes = b"abc";
        let size = 3u64;

        let mut a = blake3::Hasher::new();
        a.update(&size.to_le_bytes());
        a.update(&SAMPLE_SIZE.to_le_bytes());
        a.update(&1u32.to_le_bytes());
        a.update(&0u64.to_le_bytes());
        a.update(bytes);

        let mut b = blake3::Hasher::new();
        b.update(&size.to_le_bytes());
        b.update(&(SAMPLE_SIZE * 2).to_le_bytes());
        b.update(&1u32.to_le_bytes());
        b.update(&0u64.to_le_bytes());
        b.update(bytes);

        assert_ne!(a.finalize().as_bytes(), b.finalize().as_bytes());
    }

    #[test]
    fn four_sample_offsets_for_large_files() {
        let size: u64 = 10_000_000;
        let offsets = sample_offsets(size);
        assert_eq!(
            offsets,
            vec![0, size / 3, 2 * size / 3, size - SAMPLE_SIZE as u64]
        );
    }

    #[test]
    fn local_file_matches_in_memory_for_large_input() {
        // 200 KiB > whole-file threshold ⇒ 4-sample path.
        let bytes = deterministic_bytes(0xC0FF_EE, 200 * 1024);
        let temp = TempFile::create(&bytes);

        let local = fingerprint_local(&temp.path).expect("local fingerprint");
        assert_eq!(local.size, bytes.len() as u64);
        assert!(local.mtime_ms.is_some());

        let plan = sample_plan(local.size);
        let samples: Vec<(u64, &[u8])> = plan
            .iter()
            .map(|(offset, len)| {
                let start = *offset as usize;
                let end = start + *len as usize;
                (*offset, &bytes[start..end])
            })
            .collect();
        let in_memory = fingerprint_from_samples(local.size, &samples);
        assert_eq!(local.fingerprint, in_memory);
    }

    #[test]
    fn local_file_matches_in_memory_for_small_input() {
        // 1 KiB ≤ whole-file threshold ⇒ single-chunk whole-file path.
        let bytes = deterministic_bytes(0xBEEF, 1024);
        let temp = TempFile::create(&bytes);

        let local = fingerprint_local(&temp.path).expect("local fingerprint");
        let in_memory = fingerprint_from_samples(local.size, &[(0, &bytes)]);
        assert_eq!(local.fingerprint, in_memory);
    }

    #[test]
    fn local_file_for_empty_file_uses_no_samples() {
        let temp = TempFile::create(&[]);
        let local = fingerprint_local(&temp.path).expect("local fingerprint");
        assert_eq!(local.size, 0);
        assert_eq!(local.fingerprint, fingerprint_from_samples(0, &[]));
    }

    struct ShortSource;
    impl SampleSource for ShortSource {
        fn read_range(&mut self, _offset: u64, len: u32) -> Result<Vec<u8>, FingerprintError> {
            Ok(vec![0u8; len.saturating_sub(1) as usize])
        }
    }

    #[test]
    fn truncated_source_returns_truncated_read_error() {
        let mut src = ShortSource;
        let result = fingerprint_with_source(WHOLE_FILE_THRESHOLD * 2, &mut src);
        assert!(matches!(result, Err(FingerprintError::TruncatedRead { .. })));
    }

    #[test]
    fn fingerprint_from_bytes_matches_local_fingerprint() {
        let bytes = deterministic_bytes(0xFEED, 200 * 1024);
        let temp = TempFile::create(&bytes);
        let local = fingerprint_local(&temp.path).expect("local fingerprint");
        assert_eq!(fingerprint_from_bytes(&bytes), local.fingerprint);

        // Also hold for the whole-file branch.
        let small = deterministic_bytes(0xCAFE, 1024);
        let small_temp = TempFile::create(&small);
        let small_local = fingerprint_local(&small_temp.path).expect("small fingerprint");
        assert_eq!(fingerprint_from_bytes(&small), small_local.fingerprint);

        // And for empty input.
        assert_eq!(fingerprint_from_bytes(&[]), fingerprint_from_samples(0, &[]));
    }

    #[test]
    fn s3_etag_format_matches_spec() {
        let size: u64 = 1234;
        let etag = "d41d8cd98f00b204e9800998ecf8427e";

        let mut expected = blake3::Hasher::new();
        expected.update(b"shade-s3-etag-v1\0");
        expected.update(&size.to_le_bytes());
        expected.update(etag.as_bytes());
        let expected_fp = Fingerprint(*expected.finalize().as_bytes());

        assert_eq!(fingerprint_from_s3_etag(size, etag), expected_fp);
    }

    #[test]
    fn s3_etag_strips_surrounding_quotes() {
        let size: u64 = 1234;
        let bare = fingerprint_from_s3_etag(size, "abcdef");
        let quoted = fingerprint_from_s3_etag(size, "\"abcdef\"");
        assert_eq!(bare, quoted);
    }

    #[test]
    fn fingerprint_hex_round_trip() {
        let fp = fingerprint_from_samples(42, &[(0, b"abc")]);
        let hex = fp.to_hex();
        assert_eq!(hex.len(), 64);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        let decoded = Fingerprint::from_hex(&hex).expect("decode");
        assert_eq!(decoded, fp);
    }

    #[test]
    fn fingerprint_blob_round_trip() {
        let fp = fingerprint_from_samples(42, &[(0, b"abc")]);
        let bytes: [u8; 32] = *fp.as_bytes();
        let restored = Fingerprint::from_bytes(bytes);
        assert_eq!(restored, fp);
    }

    #[test]
    fn from_hex_rejects_invalid_input() {
        assert!(Fingerprint::from_hex("xyz").is_err());
        assert!(Fingerprint::from_hex(&"g".repeat(64)).is_err());
    }
}
