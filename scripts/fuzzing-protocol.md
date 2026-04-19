# Generic System Fuzzing Protocol

This document defines process for building repeatable, feature-aware fuzzing system for any software project.

It must work for:

- web applications
- mobile applications
- desktop applications
- REST or RPC services
- CLI tools
- queue workers
- scheduled jobs
- mixed frontend and backend systems

The protocol must not require application code changes. Source visibility and custom instrumentation improve quality, but baseline protocol works in black-box mode.

The process is split into three core stages:

1. feature extraction
2. feature documentation
3. story creation

## Goals

- discover system capabilities from available evidence
- normalize findings into machine-readable inventory
- compose multi-step stories from that inventory
- attach assertions, risks, and mutation points to every story
- make execution reproducible across projects and environments

## Capability Tiers

Protocol should support these tiers.

### Tier 0: Artifact-Only

Inputs only:

- screenshots
- recordings
- OpenAPI specs
- protobuf schemas
- CLI help text
- logs
- docs

### Tier 1: Black-Box Runtime

No source code changes. Interact with:

- browser UI
- HTTP endpoints
- RPC methods
- CLI commands
- queues and jobs
- sockets and streams

### Tier 2: Gray-Box Source-Visible

Read source code, config, and tests, but do not require app changes.

### Tier 3: White-Box Instrumented

Optional custom hooks, metrics, events, and traces.

The protocol must remain valid at Tier 0 through Tier 2. Tier 3 is enhancement only.

## Core Abstractions

Use these abstractions across all system types.

### Surface

A surface is any externally observable interface or execution context.

Examples:

- web route
- modal
- tab
- API endpoint
- CLI command
- RPC method
- queue consumer
- cron job
- websocket channel

### Feature

A feature is system capability exposed through one or more surfaces.

Examples:

- authenticate user
- upload asset
- search records
- export report
- reindex data
- process payment webhook
- render image preview

### Story

A story is ordered scenario using one or more features in one session or execution chain.

Examples:

- sign in -> search -> export
- upload file -> process job -> poll status -> download result
- create entity -> update entity -> delete entity

### State

A state is observable condition of system or surface.

Examples:

- loading
- ready
- empty
- populated
- success
- error
- offline
- permission denied
- queued
- processing
- completed
- failed

## Pipeline

Implement pipeline in this order:

1. collect evidence
2. extract surfaces and features
3. normalize and merge duplicates
4. document features and surfaces
5. compose stories
6. attach fuzz mutations
7. execute against target system
8. collect telemetry
9. triage and cluster failures

## Stage 1: Feature Extraction

Feature extraction builds raw inventory from one or more evidence sources.

### 1.1 Inputs

Possible inputs:

- source code
- config files
- tests
- screenshots
- recordings
- DOM snapshots
- accessibility trees
- OpenAPI specs
- GraphQL schema
- protobuf definitions
- CLI help output
- logs
- existing metrics

### 1.2 What To Extract

Extract these entities:

- surfaces
- features
- interaction points
- states
- dependencies

### 1.3 Surface Extraction

Examples by system type:

- web app:
  - routes
  - modals
  - drawers
  - tabs
- API:
  - endpoints
  - resources
  - auth flows
- CLI:
  - commands
  - subcommands
  - flags
  - stdin modes
- worker:
  - job types
  - queue topics
  - retry paths
  - dead-letter paths

### 1.4 Feature Extraction

A feature should map to real capability, not implementation detail.

Good feature examples:

- sign in
- create report
- upload file
- import CSV
- generate preview
- export archive
- process webhook
- reindex search

Bad feature examples:

- `useThingStore`
- `ButtonGroup`
- `fetchRecordsInternal`

### 1.5 Interaction Point Extraction

For GUI systems:

- buttons
- inputs
- sliders
- toggles
- drag-drop zones
- hotkeys

For non-GUI systems:

- HTTP methods and payload shapes
- CLI flags and arguments
- RPC request types
- queue message schemas
- cron triggers

### 1.6 State Extraction

Extract state branches from evidence:

- loading
- empty
- invalid input
- success
- retry
- timeout
- permission denied
- queue pending
- worker processing
- worker failed

### 1.7 Dependency Extraction

Examples:

- feature requires auth
- endpoint requires existing entity
- command requires config file
- job requires uploaded asset
- export requires completed processing

### 1.8 Extraction Strategy By Tier

#### Tier 0

Infer from:

- screenshots
- docs
- schemas
- help output

#### Tier 1

Probe runtime via:

- browser automation
- HTTP exploration
- CLI invocation
- RPC calls
- queue and worker observation

#### Tier 2

Add:

- route discovery
- handler discovery
- command registry discovery
- component and page scanning
- API client and server handler mapping

#### Tier 3

Add:

- app-declared feature boundaries
- custom telemetry
- internal state transitions

## Stage 2: Feature Documentation

Convert raw extraction into stable inventory for story composer.

Every feature should answer:

- how it is entered
- what it requires
- what inputs it accepts
- what state transitions it has
- what success and failure look like
- what other features or surfaces it touches

### 2.1 Surface Record

```json
{
  "id": "surface.api.upload",
  "name": "Upload Endpoint",
  "kind": "http_endpoint",
  "locator": {
    "method": "POST",
    "path": "/uploads"
  },
  "states": ["ready", "validation_error", "server_error"],
  "features": ["feature.asset.upload"],
  "confidence": 0.96,
  "evidence": ["openapi.yaml#/paths/~1uploads/post"]
}
```

### 2.2 Feature Record

```json
{
  "id": "feature.asset.upload",
  "name": "Asset Upload",
  "kind": "workflow",
  "surfaces": ["surface.ui.upload_modal", "surface.api.upload"],
  "entry_points": [
    { "type": "button", "label": "Upload" },
    { "type": "http", "method": "POST", "path": "/uploads" }
  ],
  "preconditions": [
    "user authenticated"
  ],
  "inputs": [
    { "name": "file", "type": "file", "required": true }
  ],
  "actions": [
    "open upload surface",
    "provide file",
    "confirm upload"
  ],
  "states": [
    "idle",
    "uploading",
    "success",
    "error_network",
    "error_validation"
  ],
  "observables": [
    "progress visible",
    "uploaded asset appears",
    "error response or toast visible"
  ],
  "risk_tags": [
    "async",
    "large-payload",
    "storage"
  ],
  "confidence": 0.92,
  "evidence": [
    "src/components/UploadDialog.tsx",
    "openapi.yaml#/paths/~1uploads/post"
  ]
}
```

### 2.3 Required Documentation Fields

Every feature must include:

- `surfaces`
- `entry_points`
- `preconditions`
- `actions`
- `states`
- `observables`
- `risk_tags`
- `evidence`

Every surface must include:

- `kind`
- `locator`
- `states`
- `features`
- `evidence`

### 2.4 Confidence Rules

- `0.9 - 1.0`: direct source or runtime evidence
- `0.7 - 0.89`: strong inferred evidence
- `0.4 - 0.69`: partial inference
- `< 0.4`: weak guess, do not auto-compose without review

## Stage 3: Story Creation

Stories are ordered scenarios that exercise one or more features through one or more surfaces.

### 3.1 Story Requirements

Every story needs:

- objective
- preconditions
- ordered steps
- assertions
- mutation points
- cleanup if stateful

### 3.2 Story Schema

```json
{
  "id": "story.upload_then_process_then_export",
  "name": "Upload then process then export",
  "features": [
    "feature.asset.upload",
    "feature.asset.process",
    "feature.asset.export"
  ],
  "preconditions": [
    "user authenticated"
  ],
  "steps": [
    {
      "feature": "feature.asset.upload",
      "surface": "surface.ui.upload_modal",
      "action": "upload valid file"
    },
    {
      "feature": "feature.asset.process",
      "surface": "surface.worker.process_asset",
      "action": "wait for processing to complete"
    },
    {
      "feature": "feature.asset.export",
      "surface": "surface.api.export",
      "action": "download result"
    }
  ],
  "assertions": [
    "asset exists",
    "processing completes",
    "download returns expected artifact"
  ],
  "mutation_points": [
    "replace valid file with oversized file",
    "interrupt network during upload",
    "poll status aggressively during processing"
  ],
  "risk_tags": [
    "async",
    "storage",
    "memory",
    "download"
  ]
}
```

### 3.3 Story Types

Generate:

- happy path
- boundary path
- invalid input
- interruption
- cross-feature
- long-session accumulation
- permission mismatch
- recovery flow

### 3.4 Story Composition Rules

Compose features when they:

- share same entity type
- share same state chain
- share same surface
- form input/output chain
- touch same backend objects or resources

Examples:

- sign in -> create draft -> publish
- upload file -> process job -> export result
- create record -> search record -> delete record
- import CSV -> validate rows -> retry failed rows

## Fuzz Mutation Layer

Mutations should stress realistic boundaries.

Mutation classes:

- invalid input
- max length input
- repeated action spam
- drag abuse
- upload huge payload
- network interruption
- offline mode
- timeout injection
- stale session
- duplicate request
- race between surfaces

## Execution Model

The executor depends on available surface type.

Examples:

- browser automation for GUI surfaces
- HTTP client for API surfaces
- command runner for CLI surfaces
- worker harness for queue surfaces
- scheduler harness for cron surfaces

Protocol does not require browser-only execution.

## Suggested Project Layout

```text
protocol/
  surface.schema.json
  feature.schema.json
  story.schema.json
  risk-tags.json

extractors/
  artifacts/
  runtime/
  source/

inventory/
  surfaces.json
  features.json
  stories.json

benchmarks/
  telemetry/
  sessions/
```

## Minimal Implementation Plan

1. define `surface`, `feature`, and `story` schemas
2. implement Tier 0 and Tier 1 extractors
3. add Tier 2 source-aware extractor
4. implement dedupe and normalization
5. implement story composer
6. implement executor adapters by surface kind
7. add telemetry and comparison

## Deliverables

Good implementation should produce:

- `surfaces.json`
- `features.json`
- `stories.json`
- execution traces
- telemetry logs
- clustered failure reports

That is enough to move from blind fuzzing to reproducible, feature-aware fuzzing for any software system.
