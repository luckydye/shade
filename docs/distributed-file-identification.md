# Distributed File Identification

## 1. Overview

Shade needs to identify files uniquely across local disks, S3 buckets, HTTP
endpoints, and peers — using the smallest possible amount of data. The
fingerprint is a 256-bit content-derived value that:

- Works for both local and remote files without downloading the full payload.
- Has negligible collision probability over the target dataset (~100k files).
- Is deterministic and reproducible across peers, enabling deduplication and
  cache sharing.
- Is cheap to compute (≤ ~64 KB read per file in the typical case).
- **Is computed on demand**, never as a side effect of listing. Discovering a
  file (e.g. enumerating a bucket or scanning a directory) must not issue
  sample reads or ranged GETs. Fingerprints are computed at the moment a
  consumer needs one — most commonly when writing a derived artifact such
  as a thumbnail.

The thumbnail and job pipeline described in §8 is an **optional extension**
that builds on top of the file identifier. It is not required for file
identification itself.

---

## 2. Goals & Non-Goals

### Goals
- Stable, peer-reproducible 256-bit fingerprint per file.
- Constant-bounded I/O regardless of file size (sample-based hashing).
- Range-request friendly for remote sources (S3, HTTP).
- Persistent cache keyed by fingerprint, suitable for peer sync.

### Non-Goals
- Cryptographic proof of file integrity (a partial-sample fingerprint is
  probabilistic, not adversarial).
- Resemblance/perceptual hashing — fingerprints are content-exact, not
  perceptual.
- Replacing existing per-content-type identifiers (S3 ETag, EXIF UUIDs); the
  fingerprint can coexist with them.

---

## 3. Fingerprint Definition

### 3.1 Inputs
A fingerprint is computed from:

| Field        | Type     | Source                                   |
|--------------|----------|------------------------------------------|
| `size`       | `u64`    | Local: `metadata().len()`. Remote: `Content-Length` header / S3 `HeadObject`. |
| `samples[]`  | bytes    | Up to 4 deterministic byte ranges of the file. |

### 3.2 Sample selection
With `SAMPLE_SIZE = 16 KiB` and `size` known:

1. If `size <= 4 * SAMPLE_SIZE` (≤ 64 KiB): hash the **entire file**. No
   sampling, no offsets — `samples[]` is the full content.
2. Otherwise, take 4 chunks at offsets:
   - `0`
   - `floor(size / 3)`
   - `floor(2 * size / 3)`
   - `size - SAMPLE_SIZE`
   Each chunk is exactly `SAMPLE_SIZE` bytes. Overlap is permitted and not
   normalized (the algorithm is defined by offset, not coverage).

Offsets must be computed identically on every peer; integer math and
truncating division are normative.

### 3.3 Hash function
**BLAKE3, 256-bit output.** Chosen for:
- High throughput on commodity CPUs (multi-GB/s).
- 256-bit output gives ~2^128 birthday bound — collision probability
  for 100k files is ~10⁻³⁸.
- Wide language support (Rust crate `blake3` is the canonical implementation).

### 3.4 Hashing procedure
The hasher is fed in this order, with no separators:

```
hasher.update(size.to_le_bytes())             // 8 bytes, little-endian
hasher.update(SAMPLE_SIZE.to_le_bytes())      // 4 bytes, little-endian
hasher.update(num_samples.to_le_bytes())      // 4 bytes, little-endian
for offset, chunk in samples:
    hasher.update(offset.to_le_bytes())       // 8 bytes, little-endian
    hasher.update(chunk)                      // raw chunk bytes
fingerprint = hasher.finalize()               // 32 bytes
```

Including `SAMPLE_SIZE`, `num_samples`, and offsets in the digest makes the
fingerprint **parameter-bound**: changing the sampling scheme produces a
different fingerprint, preventing accidental cross-version collisions when
the algorithm evolves. For files ≤ 64 KiB, `num_samples = 1` and `offset = 0`.

### 3.5 Encoding
- In-memory / SQLite: 32-byte `BLOB` (preferred; smaller, faster index).
- Wire / JSON: lowercase 64-char hex string.

### 3.6 Alternate scheme: S3 ETag fast path

For S3 sources, the object's `ETag` is already a content-derived value
(MD5 for single-part, multipart-aware hash for multipart uploads). When
present and trustworthy, we can derive a fingerprint from the ETag
without issuing any ranged GETs — the ETag has typically already been
delivered by the listing in §4.2.

**Derivation.** A 32-byte fingerprint is produced by:

```
hasher = blake3()
hasher.update(b"shade-s3-etag-v1\0")    // domain separator
hasher.update(size.to_le_bytes())       // 8 bytes, little-endian
hasher.update(etag_bytes)               // raw ETag string, no quotes
fingerprint = hasher.finalize()         // 32 bytes
```

Stored with `algo_version = 100` to distinguish it from the sample
scheme (`algo_version = 1`). Two peers seeing the same S3 object compute
the same fingerprint deterministically, so this scheme supports peer
dedup across S3 consumers.

**Eligibility — the ETag must be a content hash:**
- ✅ Standard PUT, no SSE-KMS, no SSE-C.
- ✅ Multipart upload (ETag `<hex>-<N>`). Note: two clients uploading
  the same bytes with different part sizes get different ETags, so
  cross-upload dedup is best-effort.
- ❌ SSE-KMS / SSE-C / SSE-C with custom key: ETag is **not** a content
  hash. Fall back to the sample scheme.
- ❌ Bucket has object-level encryption with rotated keys: same.

Eligibility is determined from `HeadObject` / `GetObject` response
headers (`x-amz-server-side-encryption`); when absent or `AES256`, the
ETag is a content hash.

**Trade-off — namespaces do not cross.** A file living on both local disk
and S3 produces two different fingerprints (sample-derived for local,
ETag-derived for S3). Peer dedup works *within* each namespace but not
*across*. This is acceptable: most files have a single canonical source.
Implementations that need cross-namespace dedup must compute the sample
scheme as well — at the cost of the ranged GETs the fast path was meant
to avoid.

---

## 4. I/O Strategy

### 4.1 Local files
- Open with read-only access, `seek` + bounded `read_exact` per offset.
- Do not `mmap` for sampling — explicit reads are simpler and avoid keeping
  large mappings alive on small reads.
- Honor a per-process semaphore (see §7) to cap concurrent file descriptors.

### 4.2 Remote files (HTTP / S3)
- Issue a single `HEAD` (HTTP) or `HeadObject` (S3) call up front to obtain
  `Content-Length` and (for S3) the `ETag` and encryption mode.
- **S3 fast path**: if the object qualifies under §3.6 (no SSE-KMS/SSE-C),
  derive the fingerprint from the ETag and skip ranged GETs entirely. The
  ETag is typically already in hand from `ListObjectsV2` (§4.2.1), making
  the fingerprint compute zero-I/O.
- Otherwise (HTTP without a content-hash ETag, S3 with SSE-KMS/SSE-C, or
  any source needing cross-namespace dedup), fall back to the sample
  scheme: for each sample, issue a `Range: bytes=offset-(offset+SAMPLE_SIZE-1)`
  GET. Sample requests for the same file should be issued in parallel;
  a typical fingerprint completes in **1 HEAD + 4 ranged GETs**.
- Retry policy: exponential backoff on 5xx and connection errors, max 3
  attempts per range. A single-range failure invalidates the fingerprint
  attempt.

#### Batch metadata for S3
S3 has no native batch-HEAD. For prefix or bucket scans, prefer
`ListObjectsV2` (up to 1000 keys per request, returning `Key`, `Size`,
`LastModified`, `ETag`, `StorageClass`) instead of per-object `HeadObject`
calls — listing populates the application catalog (locator + size + ETag)
without issuing any sample reads. Reserve parallel `HeadObject` (capped by
the §7 semaphore) for the on-demand path: when a consumer asks for a
fingerprint and the catalog row is missing or stale. For very large
buckets, **S3 Inventory** (async daily/weekly manifest) is the scalable
replacement for listing. **S3 Batch Operations** is *not* applicable here
— it dispatches actions, not metadata reads.

### 4.3 Edge cases
- **Zero-length files**: `size = 0`, `num_samples = 0`, hasher fed only the
  size + parameter prelude. All zero-length files produce one canonical
  fingerprint.
- **Truncated reads**: if a local read returns fewer bytes than `SAMPLE_SIZE`
  (file shrunk between metadata and read), abort and re-stat. Do not pad.
- **Length mismatch on remote**: if a ranged response returns fewer bytes
  than requested, abort and refetch metadata.
- **Symlinks**: follow by default; the fingerprint reflects target content,
  not link path.

---

## 5. Persistent Cache (index)

A local SQLite/libSQL database stores fingerprints and their bindings to
concrete locations.

```sql
CREATE TABLE file_fingerprints (
    fingerprint   BLOB    NOT NULL,         -- 32 bytes BLAKE3
    size          INTEGER NOT NULL,
    locator       TEXT    NOT NULL,         -- path or URL
    locator_kind  TEXT    NOT NULL,         -- 'local' | 's3' | 'http' | 'peer'
    mtime_ms      INTEGER,                  -- local files only; NULL otherwise
    etag          TEXT,                     -- remote: cached HTTP/S3 ETag
    computed_at   INTEGER NOT NULL,         -- epoch ms
    algo_version  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (fingerprint, locator)
);

CREATE INDEX idx_file_fp_locator ON file_fingerprints(locator);
CREATE INDEX idx_file_fp_size    ON file_fingerprints(size);
```

Notes:
- A single fingerprint may appear under multiple locators (the same content
  living in two places, or replicated across peers) — hence the composite
  primary key.
- `algo_version` lets us evolve the sampling scheme without re-hashing
  everything in lock-step. Migration is **lazy**: when a caller requests
  a fingerprint and the latest `algo_version` doesn't match the cached
  row, the workflow in §6 recomputes and inserts a new row. Old rows are
  left in place — they remain valid for any consumer still on the old
  version (e.g., a peer that hasn't upgraded). Garbage collection of
  superseded versions is a separate background concern, not a blocker
  for migration.
- For local entries, `mtime_ms` is used to skip rehashing when the file is
  unchanged. For remote entries, `etag` plays the same role.

---

## 6. Lookup & Compute Workflow

Fingerprints are **lazy**. Nothing in this section runs as part of file
discovery / listing — the workflow is entered only when a caller (e.g.
the thumbnail pipeline of §8) explicitly requests `fingerprint_of(locator)`.

### 6.1 Triggers
Compute is triggered by, and only by:
- Writing a thumbnail (§8) for a file that has no cached fingerprint.
- Inserting a file into a peer-shared index where the fingerprint is the
  identity.
- Explicit user action ("verify", "find duplicates", "share library").

Listing, indexing, and metadata sync are **not** triggers.

### 6.2 Procedure
```
fingerprint_of(locator) →
  1. Resolve locator_kind from scheme (local path, s3://, https://, peer://).
  2. Stat / HEAD to obtain size + (mtime | etag) — usually already cached
     in the catalog from listing; only refetch if missing or stale.
  3. Cache lookup keyed by (locator, size, mtime|etag, algo_version).
     - Hit → return cached fingerprint.
  4. Cache miss:
     a. Compute sample offsets per §3.2.
     b. Read samples (local) or issue ranged GETs (remote) per §4.
     c. Feed hasher per §3.4, finalize.
     d. Insert/replace row in file_fingerprints.
     e. Return fingerprint.
```

Concurrent calls for the same locator must coalesce to a single in-flight
compute (single-flight pattern), so a viewport that requests 50 thumbnails
of the same file does not issue 50 fingerprint computes.

### 6.3 Invalidation
- **Local**: `mtime_ms` change ⇒ recompute.
- **Remote**: `ETag` change (or absent + 24h TTL on `computed_at`) ⇒
  recompute.
- **Manual**: `delete_by_prefix(locator)` for explicit invalidation.

### 6.4 Peer sync
Peers exchange a subset of `file_fingerprints` rows. The exchange is
content-addressed:

- **Discovery**: peer A asks peer B "do you have fingerprint X?" — a single
  32-byte lookup, regardless of original file size.
- **Replication**: peers may sync the entire SQLite table (or a libSQL
  replica). Conflicts on `(fingerprint, locator)` are last-writer-wins by
  `computed_at`; the row body is otherwise stable.
- **Trust**: receiving a fingerprint from a peer does **not** prove that
  peer holds the file. Possession requires a follow-up fetch + local
  verification (re-sampling, or a full content hash if the use case
  demands it).

---

## 7. Concurrency & Backpressure

Fingerprinting 100k files concurrently must not exhaust file descriptors,
network sockets, or memory.

| Stage          | Bound (default)        | Mechanism                |
|----------------|------------------------|--------------------------|
| Local read     | `min(64, ulimit/2)`    | Tokio `Semaphore`        |
| HTTP / S3 GET  | 100                    | Tokio `Semaphore`        |
| HEAD / metadata| 200                    | Tokio `Semaphore`        |

All limits are configurable. Tasks are bounded by `mpsc::channel`s between
discovery → metadata → sample-fetch → hash stages so the slowest stage
applies backpressure to the producer.

---

## 8. Optional Extension: Thumbnail Pipeline

This section describes a thumbnail generation and sharing system layered on
top of file identification. It is **not required** for §1–7 to function.
Implementations may ship file identification independently.

### 8.1 Thumbnail key
A thumbnail is keyed by source content + edit state + transform parameters:

```
thumbnail_key = blake3(
    file_fingerprint      ||  -- 32 bytes (§3)
    edit_snapshot_hash    ||  -- 32 bytes (see below)
    width  (u32 LE)       ||
    height (u32 LE)       ||
    resize_mode bytes     ||  -- 'crop' | 'scale' | 'fit'
    format bytes              -- 'jpeg' | 'webp' | …
)
```

The 32-byte result is the primary key. Identical inputs produce identical
keys on every peer, enabling distributed caching with no coordination.

#### `edit_snapshot_hash`
A 32-byte BLAKE3 of a **canonical, stable serialization** of the edit
snapshot (the operations stack / parameters that define the rendered
result). Requirements:

- **Stable**: identical edits must serialize byte-identical across peers
  and across versions (sorted keys, fixed numeric encoding, no
  whitespace, no timestamps).
- **Content-addressed**: derived from the edit *content*, not the
  application-assigned `snapshot_id`. Two peers that arrive at the same
  edit state independently must produce the same hash.
- **Unedited marker**: when the image has no edits, `edit_snapshot_hash`
  is **32 zero bytes**. This gives unedited thumbnails a stable,
  peer-shareable key without special-casing the schema.

The application's `snapshot_id` (string) remains the user-facing handle
and may be denormalized into the thumbnails row for UI/debug, but it is
**not** part of the key.

### 8.2 Thumbnail storage

```sql
CREATE TABLE thumbnails (
    key                 BLOB    PRIMARY KEY,    -- 32 bytes
    fingerprint         BLOB    NOT NULL,       -- source file fingerprint
    edit_snapshot_hash  BLOB    NOT NULL,       -- 32 bytes; zeros = unedited
    edit_snapshot_id    TEXT,                   -- denormalized UI handle (optional)
    width               INTEGER NOT NULL,
    height              INTEGER NOT NULL,
    resize_mode         TEXT    NOT NULL,
    format              TEXT    NOT NULL,
    data                BLOB    NOT NULL,       -- thumbnail bytes
    created_at          INTEGER NOT NULL,
    last_accessed       INTEGER
);

CREATE INDEX idx_thumb_fingerprint     ON thumbnails(fingerprint);
CREATE INDEX idx_thumb_fp_snapshot     ON thumbnails(fingerprint, edit_snapshot_hash);
```

Thumbnail bytes are always stored inline in the `data` BLOB. There is no
sidecar-file path — the SQLite/libSQL database is the single source of
truth for thumbnail storage. This keeps replication, deletion, and peer
sync atomic with the row.


### 8.2.1 Locator-keyed lookup (no-compute path)

A UI rendering a listing must be able to display a previously generated
thumbnail given only the source locator — without any source I/O and
without computing a fingerprint. This is served by joining through
`file_fingerprints` (which carries the locator → fingerprint binding from
the last time the file was hashed):

```sql
SELECT t.data
FROM file_fingerprints f
JOIN thumbnails t ON t.fingerprint = f.fingerprint
WHERE f.locator            = ?1
  AND t.edit_snapshot_hash = ?2   -- 32 zero bytes for unedited
  AND t.width              = ?3
  AND t.height             = ?4
  AND t.resize_mode        = ?5
  AND t.format             = ?6
LIMIT 1;
```

The caller resolves the active snapshot of the image (or the unedited
marker) to `edit_snapshot_hash` before querying — that resolution is a
local lookup into the snapshot store, not a fingerprint compute.

Both joined tables are indexed on the join/filter columns
(`idx_file_fp_locator`, `idx_thumb_fp_snapshot`), so the lookup is two
indexed reads with no source touch.

**Freshness.** The binding in `file_fingerprints` may be stale if the file
changed since it was last hashed. The cheap freshness check uses metadata
the catalog already has from listing (§4.2):

- Local: compare current `mtime_ms` against the stored value.
- Remote: compare current `ETag` against the stored value.

If they match, the cached thumbnail is served. If they differ — or if no
row exists — the request falls through to the §8.3 pipeline, which is the
only place fingerprints are computed.

### 8.3 Pipeline stages

The fingerprint is computed *inside* this pipeline — at the point we are
about to do meaningful work for the file — not earlier. For local sources
the fingerprint compute can ride on the same file handle as the decode
read; for remote sources the sample GETs are issued just before fetching
the source bytes (and may overlap with them).

```
[Request]
   │
   ▼
[Local thumbnail cache by locator]──hit──▶ return
   │ miss
   ▼
[Compute fingerprint on demand (§6)]   ◀── only here, not at listing time
   │
   ▼
[Lookup thumbnail by key (fingerprint+params)]──hit──▶ return
   │ miss
   ▼
[Peer lookup by key]──hit──▶ fetch + insert ──▶ return
   │ miss
   ▼
[Fetch source bytes] ── (decode-time downscale where possible)
   │
   ▼
[Decode + resize]   ── CPU pool (rayon, num_cpus workers)
   │
   ▼
[Encode]            ── format-dependent (JPEG/WebP)
   │
   ▼
[Insert thumbnail row + announce] ──▶ return
```

Channels between stages are bounded; default capacities:
- fetch → decode: 200
- decode → encode: 16
- encode → store: 8

Semaphores (independent of §7):
- Network fetches for thumbnails: 100
- CPU decode / resize: `num_cpus()`
- Encode: `num_cpus() / 2`

### 8.4 Prioritization
Three-level priority queue, popped in strict order:
1. **HIGH** — viewport-visible.
2. **MEDIUM** — prefetch (scroll-ahead window).
3. **LOW** — background indexing.

Tasks are cancellable; deprioritization (e.g., scrolling away) cancels
in-flight LOW/MEDIUM work but leaves HIGH alone.

### 8.5 Peer race (optional)
For known-shareable libraries, a thumbnail request may race a peer fetch
against local generation:
- Start peer fetch immediately.
- Start local generation after a short delay (default 100 ms).
- First completion wins; the loser is cancelled.

This stays disabled by default — it amplifies network load and is only a
win on slow CPUs with fast peer links.

### 8.6 Adaptive sampling for huge sources
For sources where reading the full file is wasteful (RAW, multi-hundred-MB
JPEG):
- Decode-time downscale: pass the target size to the decoder so it skips
  full-resolution reconstruction (libjpeg `scale_num/scale_denom`, libraw
  half-size mode, etc.).
- This is purely a performance optimization; the resulting thumbnail bytes
  must still be reproducible (same `thumbnail_key` produces equivalent
  output across peers — modulo encoder version, which should be folded
  into `format` if it diverges materially).
