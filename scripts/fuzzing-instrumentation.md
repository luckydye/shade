# Fuzzing Instrumentation and Run Comparison

This document defines instrumentation needed to compare fuzzing test runs at metric level across builds, branches, environments, and time.

The goal is not only to find crashes. The goal is to detect regressions in:

- reliability
- performance
- memory
- rendering
- feature-specific behavior

## Goals

- collect stable machine-readable metrics during every run
- preserve enough context to compare runs fairly
- aggregate noisy raw points into useful summaries
- classify deltas as improvement, neutral change, or regression
- make every regression traceable back to story, feature, step, and fixture

## Core Principles

- Raw metrics first. Derived summaries second.
- Every metric needs dimensions.
- Compare like with like only.
- Use baselines from multiple runs, not single run.
- Separate cold and warm cache runs.
- Keep measurement source explicit.

## Instrumentation Pipeline

Implement this pipeline:

1. collect raw metrics
2. normalize metric dimensions
3. persist raw JSONL
4. aggregate per story, feature, and step
5. compare against baseline
6. classify deltas
7. generate report

## What To Measure

Split metrics into four groups.

## 1. Reliability Metrics

Track whether system still works.

Recommended metrics:

- story completion rate
- step completion rate
- assertion pass rate
- console error count
- uncaught exception count
- failed network request count
- timeout count
- retry count
- crash count
- page reload count

Examples:

- `fuzz.story.success`
- `fuzz.step.failure_count`
- `fuzz.browser.console_error_count`
- `fuzz.browser.request_failure_count`

## 2. Performance Metrics

Track whether system got slower.

Recommended metrics:

- story duration
- step duration
- feature duration
- request latency
- time to first usable UI
- time to interactive
- render latency
- long task count
- dropped frame count
- layout shift if relevant

Examples:

- `fuzz.story.duration`
- `fuzz.step.duration`
- `fuzz.feature.duration`
- `fuzz.browser.long_task_count`

## 3. Resource Metrics

Track memory and related resource growth.

Recommended metrics:

- browser process memory
- renderer process memory
- GPU process memory
- peak memory
- memory after idle
- storage growth
- network bytes sent
- network bytes received
- object URL count if app exposes it
- WebGL or WebGPU resource counts if app exposes them

Examples:

- `fuzz.browser.gpu.physical_footprint`
- `fuzz.browser.renderer.rss`
- `fuzz.browser.storage.bytes`
- `fuzz.browser.network.received_bytes`

## 4. Feature-Specific Metrics

Track behavior that only makes sense for app domain.

Examples:

- upload throughput
- search latency
- filter apply latency
- export duration
- preview render time
- cache hit rate
- autosave interval
- sync roundtrip latency
- image decode latency

Examples:

- `fuzz.feature.upload.duration`
- `fuzz.feature.preview.render_duration`
- `fuzz.feature.export.duration`

## Metric Dimensions

Every metric point must carry enough dimensions to make comparisons fair.

Minimum dimensions:

- `run_id`
- `suite_id`
- `story_id`
- `feature_id`
- `step_id`
- `mutation_id`
- `fixture_id`
- `phase`
- `build_id`
- `commit_sha`
- `branch`
- `environment`
- `browser`
- `browser_version`
- `os`
- `device_profile`
- `cache_mode`

Useful optional dimensions:

- `api_environment`
- `experiment_flag`
- `user_role`
- `network_profile`
- `render_backend`
- `screen_id`

Without dimensions, comparisons become invalid fast.

## Metric Model

Use machine-readable JSONL. OTel-style JSONL works well because:

- easy to append
- easy to stream
- easy to aggregate
- maps well to external systems later

Each line should represent one observation batch.

Recommended metric types:

- gauge
- histogram
- sum

Use:

- `gauge` for memory and current resource values
- `histogram` for durations and latency distributions
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
          { "key": "browser", "value": { "stringValue": "chrome" } }
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
              "name": "fuzz.browser.gpu.physical_footprint",
              "unit": "By",
              "gauge": {
                "dataPoints": [
                  {
                    "attributes": [
                      { "key": "story_id", "value": { "stringValue": "story.upload_edit_export" } },
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

Persist one run metadata file per run.

It should include:

- run id
- timestamp
- git commit
- branch
- browser version
- OS version
- machine or device class
- viewport
- cache mode
- feature flags
- fixture set
- suite config

This metadata lets you reject bad comparisons later.

## Baseline Strategy

Never compare against one single run.

Use:

- rolling baseline for same branch
- stable baseline for release branch
- golden baseline from pinned machine if available

Recommended sample counts:

- `10` runs minimum for cheap low-noise stories
- `20+` runs for noisy performance or memory stories

Store:

- per-story baseline
- per-step baseline
- per-fixture baseline

## Noise Control Rules

To reduce fake regressions:

- pin browser version
- pin viewport and device profile
- pin fixtures
- pin network conditions
- separate cold-cache and warm-cache suites
- warm up app before measured runs if needed
- discard first run when cache hydration dominates
- compare only same story plus same mutation plus same fixture

## Comparison Model

Comparison should produce three artifact layers:

1. raw metrics
2. aggregates
3. comparison report

### 1. Raw Metrics

Store exact emitted points.

Examples:

- `telemetry.jsonl`
- `run-metadata.json`

### 2. Aggregates

Aggregate by metric name and scope.

Useful aggregate fields:

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
- step-wide
- story plus fixture
- step plus mutation

### 3. Comparison Report

Compare candidate aggregates against baseline aggregates.

Recommended report record:

```json
{
  "metric": "fuzz.browser.gpu.physical_footprint",
  "scope": {
    "story_id": "story.upload_edit_export",
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

## Comparison Rules

Use rule per metric class. One threshold does not fit all metrics.

### Latency Rules

Typical rule:

- regression if `candidate_p95 > baseline_p95 * 1.3`
- and absolute delta > `100ms`

### Memory Rules

Typical rule:

- regression if `candidate_peak > baseline_peak * 1.5`
- and absolute delta > `256MiB`

### Failure Rules

Typical rule:

- regression if failure rate increases beyond tolerance
- regression if new error signature appears
- regression if story success rate drops below threshold

### Count Rules

Typical rule:

- regression if console errors or failed requests increase beyond stable baseline variance

## Event Classification

Every story run should emit event-style records too, not only metrics.

Examples:

- story started
- story completed
- step started
- step completed
- assertion failed
- retry triggered
- timeout triggered
- crash detected

These events help correlate metric spikes to user actions.

## App-Specific Instrumentation

Generic browser metrics are not enough for deep comparisons. Add app hooks when possible.

Good app-specific events:

- `feature:start`
- `feature:end`
- `render:start`
- `render:end`
- `job:start`
- `job:end`
- `cache:hit`
- `cache:miss`
- `worker:start`
- `worker:end`

Possible transport options:

- `window.__fuzzMetrics.push(...)`
- `console.info` with structured prefix
- custom DOM events
- direct OTel exporter

## Execution Signals To Capture

During browser execution, collect:

- console logs
- uncaught exceptions
- page errors
- request failures
- response codes
- screenshots
- traces
- performance entries
- process memory probes

For desktop and browser-process comparison, also collect:

- `ps` output where useful
- `vmmap -summary` on macOS
- browser task-manager-equivalent if accessible

## Suggested Output Files Per Run

Store run artifacts like this:

```text
artifacts/
  runs/<run-id>/
    run-metadata.json
    telemetry.jsonl
    aggregates.json
    comparison.json
    screenshots/
    traces/
    logs/
```

## Aggregation Steps

Implement aggregator in this order:

1. read JSONL
2. flatten OTel metric points
3. group by:
   - metric name
   - story id
   - step id
   - fixture id
   - mutation id
4. compute summary statistics
5. write `aggregates.json`

Flattened record should look like:

```json
{
  "metric": "fuzz.browser.gpu.physical_footprint",
  "unit": "By",
  "value": 10737418240,
  "story_id": "story.upload_edit_export",
  "step_id": "step.adjust_exposure",
  "fixture_id": "raw-large-01",
  "phase": "during_drag",
  "run_id": "run-2026-04-19-001",
  "browser": "chrome"
}
```

## Comparison Steps

Implement comparator in this order:

1. load candidate aggregates
2. load baseline aggregates
3. match records by metric plus scope
4. compute absolute and percent deltas
5. evaluate threshold rules
6. emit report

Reject comparison if:

- browser version mismatches and run is version-sensitive
- fixture set mismatches
- story ids mismatch
- cache mode mismatch
- environment mismatches in incompatible way

## Reporting Requirements

Every report should answer:

- what regressed
- by how much
- under which story and step
- with which fixture and mutation
- whether regression is new or recurring
- where raw evidence lives

Recommended report sections:

- top regressions by severity
- new error signatures
- memory regressions
- latency regressions
- failed stories
- links to raw artifacts

## Suggested Severity Model

Use clear severity levels:

- `critical`
  - crash
  - data corruption
  - memory explosion
  - total story failure
- `high`
  - large performance regression
  - consistent feature failure
- `medium`
  - noisy but repeated regression
  - partial workflow failure
- `low`
  - minor slowdown
  - non-blocking console noise

## Implementation Plan

If starting from zero, build in this order:

1. define metric naming rules
2. define required dimensions
3. emit JSONL metrics from runner
4. add run metadata file
5. implement JSONL flattener
6. implement aggregator
7. implement baseline store
8. implement comparator
9. implement report renderer

## Practical Rules

- Keep metric names stable once published.
- Do not change units silently.
- Use bytes for memory.
- Use milliseconds or nanoseconds consistently.
- Record measurement source for non-browser metrics.
- Treat warm and cold runs as separate suites.
- Prefer repeated small deterministic runs over one giant noisy run.

## Deliverables

A solid instrumentation layer should produce:

- raw JSONL metrics
- run metadata
- aggregated summaries
- comparison report
- artifact links for screenshots, traces, and logs

That is enough to make fuzzing runs comparable over time instead of isolated one-off sessions.
