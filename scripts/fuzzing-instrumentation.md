# Generic Fuzzing Instrumentation and Run Comparison

This document defines instrumentation needed to compare fuzzing runs at metric level across builds, branches, environments, and system types.

It must support:

- web applications
- APIs
- CLI tools
- background workers
- scheduled jobs
- mixed frontend and backend systems

The instrumentation layer must not require app code changes. Black-box runtime metrics are baseline. Source-aware and app-defined metrics are optional improvements.

## Goals

- collect stable machine-readable metrics during every run
- preserve enough context to compare runs fairly
- aggregate noisy points into useful summaries
- classify deltas as improvement, neutral change, or regression
- make every regression traceable back to story, feature, surface, step, and fixture

## Capability Tiers

### Tier 0: Artifact-Only

Compare based on:

- logs
- screenshots
- traces
- specs
- generated artifacts

### Tier 1: Black-Box Runtime

Compare based on:

- browser telemetry
- HTTP latency
- CLI duration
- process memory
- queue job timings
- error counts
- CDP profiler and trace output where browser runtime supports it

### Tier 2: Gray-Box Source-Visible

Add source-aware scoping:

- feature id
- surface id
- handler id
- command id
- job type

### Tier 3: White-Box Instrumented

Optional custom metrics:

- internal cache hits
- queue depth
- worker stage durations
- render pipeline timings

## Instrumentation Pipeline

Implement:

1. collect raw metrics
2. normalize metric dimensions
3. persist raw JSONL
4. aggregate per story, feature, surface, and step
5. compare against baseline
6. classify deltas
7. generate report

## What To Measure

Split metrics into four groups.

## 1. Reliability Metrics

Recommended:

- story completion rate
- step completion rate
- assertion pass rate
- error count
- timeout count
- retry count
- crash count
- failed request count
- failed command count
- failed job count

Examples:

- `fuzz.story.success`
- `fuzz.step.failure_count`
- `fuzz.runtime.error_count`

## 2. Performance Metrics

Recommended:

- story duration
- step duration
- feature duration
- request latency
- command duration
- job duration
- render latency
- queue latency
- long task count
- CPU profile hotspots
- self time or total time by script or function where profiler exposes it

Examples:

- `fuzz.story.duration`
- `fuzz.step.duration`
- `fuzz.surface.request.duration`
- `fuzz.surface.job.duration`
- `fuzz.runtime.profile.total_time`
- `fuzz.runtime.profile.top_function.self_time`

## 3. Resource Metrics

Recommended:

- browser process memory
- renderer process memory
- GPU process memory
- server process memory
- worker process memory
- peak memory
- memory after idle
- storage growth
- network bytes sent and received
- file descriptor count if available

Examples:

- `fuzz.runtime.gpu.physical_footprint`
- `fuzz.runtime.process.rss`
- `fuzz.runtime.network.received_bytes`

## 4. Domain or Feature Metrics

Recommended:

- upload throughput
- search latency
- export duration
- import row failure count
- preview render time
- cache hit rate
- queue retry count

## Metric Dimensions

Every metric point must carry enough dimensions for fair comparison.

Minimum dimensions:

- `run_id`
- `suite_id`
- `story_id`
- `feature_id`
- `surface_id`
- `step_id`
- `mutation_id`
- `fixture_id`
- `phase`
- `build_id`
- `commit_sha`
- `branch`
- `environment`
- `runtime`
- `runtime_version`
- `os`
- `device_profile`
- `cache_mode`

Useful optional dimensions:

- `api_environment`
- `experiment_flag`
- `user_role`
- `network_profile`
- `render_backend`
- `job_type`
- `command_name`

## Metric Model

Use machine-readable JSONL. OTel-style JSONL works well because:

- append-friendly
- stream-friendly
- easy to aggregate
- easy to export later

Use metric types:

- `gauge`
- `histogram`
- `sum`

Guidelines:

- `gauge` for memory or current resource values
- `histogram` for durations and latency
- `sum` for counts and totals

## Example OTel-Style JSONL

```json
{
  "resourceMetrics": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "fuzz-runner" } },
          { "key": "run_id", "value": { "stringValue": "run-2026-04-19-001" } },
          { "key": "commit_sha", "value": { "stringValue": "abc123" } },
          { "key": "runtime", "value": { "stringValue": "chrome" } }
        ]
      },
      "scopeMetrics": [
        {
          "scope": {
            "name": "fuzz.instrumentation",
            "version": "1.0.0"
          },
          "metrics": [
            {
              "name": "fuzz.runtime.gpu.physical_footprint",
              "unit": "By",
              "gauge": {
                "dataPoints": [
                  {
                    "attributes": [
                      { "key": "story_id", "value": { "stringValue": "story.upload_process_export" } },
                      { "key": "surface_id", "value": { "stringValue": "surface.ui.editor" } },
                      { "key": "step_id", "value": { "stringValue": "step.adjust_exposure" } },
                      { "key": "fixture_id", "value": { "stringValue": "raw-large-01" } },
                      { "key": "phase", "value": { "stringValue": "during_drag" } }
                    ],
                    "timeUnixNano": "1776632909310240000",
                    "startTimeUnixNano": "1776632900628307968",
                    "asInt": "10737418240"
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

## Required Run Context

Persist one metadata file per run.

It should include:

- run id
- timestamp
- git commit
- branch
- runtime and version
- OS version
- machine or device class
- cache mode
- feature flags
- fixture set
- suite config

## Baseline Strategy

Never compare against one run only.

Use:

- rolling baseline for branch
- stable baseline for release
- golden baseline for pinned lab machine if possible

Recommended sample counts:

- `10` minimum for low-noise flows
- `20+` for memory or performance-sensitive flows

Store baselines:

- per story
- per step
- per fixture
- per runtime profile

## Noise Control Rules

- pin runtime version
- pin fixtures
- pin network profile
- separate cold and warm cache suites
- warm up once before measured runs when needed
- compare only same story plus same mutation plus same fixture
- keep machine class stable

## Comparison Model

Comparison should produce:

1. raw metrics
2. aggregates
3. comparison report

### Raw Metrics

Store exact emitted points plus run metadata.

### Aggregates

Compute:

- `count`
- `min`
- `max`
- `mean`
- `p50`
- `p95`
- `p99`
- `stddev`
- `failure_rate`

Aggregate scopes:

- run-wide
- story-wide
- feature-wide
- surface-wide
- step-wide
- story plus fixture
- step plus mutation

### Comparison Report

Compare candidate aggregates against baseline aggregates.

Example:

```json
{
  "metric": "fuzz.runtime.gpu.physical_footprint",
  "scope": {
    "story_id": "story.upload_process_export",
    "surface_id": "surface.ui.editor",
    "step_id": "step.adjust_exposure",
    "fixture_id": "raw-large-01"
  },
  "baseline": {
    "p50": 2147483648,
    "p95": 4294967296,
    "max": 5368709120,
    "n": 20
  },
  "candidate": {
    "p50": 7516192768,
    "p95": 10737418240,
    "max": 12884901888,
    "n": 20
  },
  "delta": {
    "p50_abs": 5368709120,
    "p50_pct": 250.0,
    "p95_abs": 6442450944,
    "p95_pct": 150.0
  },
  "status": "regression",
  "threshold_rule": "p95 > baseline_p95 * 1.5 and abs_delta > 268435456"
}
```

## Threshold Rules

Use rule per metric class.

### Latency

- regression if `candidate_p95 > baseline_p95 * 1.3`
- and absolute delta exceeds fixed floor

### Memory

- regression if `candidate_peak > baseline_peak * 1.5`
- and absolute delta exceeds fixed floor

### Reliability

- regression if success rate drops past tolerance
- regression if new error signature appears

### Count Metrics

- regression if errors, retries, or failures rise beyond stable variance

## Event Records

Emit event-style records too.

Examples:

- story started
- story completed
- step started
- step completed
- assertion failed
- retry triggered
- timeout triggered
- crash detected

These help correlate metric spikes to exact actions.

## CDP Profiler and Trace Metrics

For browser-based targets, Chrome DevTools Protocol profiling can add useful comparison signals that basic timing and memory metrics miss.

Useful sources:

- `agent-browser profiler start <path>`
- `agent-browser profiler stop`
- `agent-browser trace start <path>`
- `agent-browser trace stop`

These are helpful for:

- CPU-bound regressions
- hot function attribution
- long task bursts
- unexpected script work during idle
- render pipeline cost spikes

Recommended derived metrics:

- total sampled profile time
- top functions by self time
- top functions by total time
- total time under specific script URL
- long task count from trace
- total long task time from trace

Example metric names:

- `fuzz.runtime.profile.total_time`
- `fuzz.runtime.profile.top_function.self_time`
- `fuzz.runtime.trace.long_task.count`
- `fuzz.runtime.trace.long_task.total_time`

Profiler output should be stored as raw artifacts first and normalized metrics second.

Recommended artifact set:

- raw `.cpuprofile`
- raw trace file
- derived summary JSON
- derived JSONL metrics

Example derived record:

```json
{
  "metric": "fuzz.runtime.profile.top_function.self_time",
  "unit": "ms",
  "value": 1842,
  "story_id": "story.upload_process_export",
  "surface_id": "surface.ui.editor",
  "step_id": "step.adjust_exposure",
  "phase": "during_drag",
  "runtime": "chrome",
  "function_name": "renderPreview",
  "script_url": "http://localhost:4173/assets/editor.js"
}
```

Use profiler-derived metrics when:

- memory spike exists but root cause unclear
- latency regressed without obvious network delta
- CPU saturation is suspected
- same story passes functionally but feels slower

Do not use profiler metrics alone for pass or fail. Use them as explanatory and comparative signals alongside reliability, latency, and memory metrics.

## App-Specific Instrumentation

Optional only.

Useful custom events:

- `feature:start`
- `feature:end`
- `render:start`
- `render:end`
- `job:start`
- `job:end`
- `cache:hit`
- `cache:miss`

Possible transports:

- `window.__fuzzMetrics.push(...)`
- structured console logs
- custom events
- direct OTel exporter

## Suggested Output Layout

```text
artifacts/
  runs/<run-id>/
    run-metadata.json
    telemetry.jsonl
    aggregates.json
    comparison.json
    profiles/
    screenshots/
    traces/
    logs/
```

## Aggregation Steps

1. read JSONL
2. flatten OTel metric points
3. group by metric plus scope
4. compute summary statistics
5. write aggregates

Flattened record example:

```json
{
  "metric": "fuzz.runtime.gpu.physical_footprint",
  "unit": "By",
  "value": 10737418240,
  "story_id": "story.upload_process_export",
  "surface_id": "surface.ui.editor",
  "step_id": "step.adjust_exposure",
  "fixture_id": "raw-large-01",
  "phase": "during_drag",
  "run_id": "run-2026-04-19-001",
  "runtime": "chrome"
}
```

## Comparison Steps

1. load candidate aggregates
2. load baseline aggregates
3. match by metric plus scope
4. compute absolute and percent deltas
5. evaluate threshold rules
6. emit report

Reject comparison if incompatible:

- runtime version mismatch for sensitive suites
- fixture mismatch
- cache mode mismatch
- environment mismatch

## Reporting Requirements

Every report should answer:

- what regressed
- by how much
- under which story, surface, and step
- with which fixture and mutation
- whether regression is new or recurring
- where raw evidence lives

Recommended sections:

- top regressions by severity
- new error signatures
- memory regressions
- latency regressions
- CPU hotspot regressions
- failed stories
- links to artifacts

## Implementation Plan

1. define metric naming rules
2. define required dimensions
3. emit JSONL metrics from runner
4. add run metadata file
5. implement JSONL flattener
6. implement aggregator
7. implement baseline store
8. implement comparator
9. implement report renderer

## Deliverables

A solid instrumentation layer should produce:

- raw JSONL metrics
- run metadata
- aggregated summaries
- comparison report
- links to traces, screenshots, logs, and raw samples

That is enough to make fuzzing runs comparable across time and across system types, not only one-off debugging sessions.
