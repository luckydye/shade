# Generic Web App Fuzzing Protocol

This document defines process for building repeatable, feature-aware fuzzing system for any web application. It is split into three main stages:

1. feature extraction
2. feature documentation
3. story creation

The goal is not blind random clicking. The goal is to discover screens, map capabilities, model state transitions, and then generate high-value browser sessions that stress one or more features under realistic and adversarial conditions.

## Goals

- discover application features from source code or screenshots
- normalize findings into machine-readable inventory
- compose multi-step stories from that inventory
- attach assertions, risks, and mutation points to every story
- make output reproducible across projects and teams

## Core Principles

- Every extracted feature needs evidence.
- Every feature needs entry conditions and observable outcomes.
- Every story should have clear objective, not random action soup.
- Fuzzing should mutate realistic sessions, not skip app semantics.
- Unknowns should stay unknowns. Do not invent hidden logic without evidence.

## Pipeline

Implement pipeline in this order:

1. collect evidence
2. extract screens and features
3. normalize and merge duplicates
4. document features and screens
5. compose stories
6. attach fuzz mutations
7. execute in browser
8. collect telemetry
9. triage and cluster failures

## Stage 1: Feature Extraction

Feature extraction builds raw inventory from one or both of:

- source code
- screenshots or recordings

### 1.1 Inputs

Useful source inputs:

- route config
- page components
- modal, drawer, dialog, and wizard roots
- navigation definitions
- form components
- API client calls
- test ids
- localized strings
- analytics event names
- end-to-end tests

Useful visual inputs:

- screenshots
- screen recordings
- DOM snapshots
- OCR text
- accessibility tree
- interaction map from browser automation

### 1.2 What To Extract

Extract these entities:

- screens
- features
- interactions
- states
- dependencies

#### Screens

A screen is any distinct UI context:

- route
- modal
- drawer
- full-screen overlay
- tab panel with unique workflow
- empty state
- error state

#### Features

A feature is user-visible capability:

- sign in
- search
- upload
- export
- filter
- edit profile
- create record
- adjust image exposure
- manage billing

#### Interactions

Capture every meaningful user control:

- buttons
- inputs
- sliders
- toggles
- hotkeys
- drag and drop
- gestures
- file pickers

#### States

At minimum capture:

- loading
- empty
- populated
- valid
- invalid
- success
- error
- offline
- permission denied

#### Dependencies

Examples:

- feature requires auth
- feature requires selected item
- feature requires uploaded file
- feature requires another feature to run first

### 1.3 Source-Code Extraction Strategy

For code-based extraction, run these passes:

1. route discovery
2. component discovery
3. interaction discovery
4. state discovery
5. data-flow discovery

#### Route Discovery

Find:

- file-system routes
- router config
- lazy-loaded screens
- navigation links
- modal routes

Output:

- route path
- component name
- layout name
- auth requirement if visible

#### Component Discovery

Scan for components that imply feature boundaries:

- `*Page`
- `*Screen`
- `*Modal`
- `*Dialog`
- `*Drawer`
- `*Form`
- `*Table`
- `*Editor`
- `*Wizard`

Look for:

- submit handlers
- API calls
- state stores
- mutation hooks
- upload handlers

#### Interaction Discovery

Extract:

- visible labels
- aria labels
- test ids
- event handlers
- keyboard shortcuts
- drag/drop handlers

Each interaction should keep evidence:

- file path
- component name
- line or selector

#### State Discovery

Look for explicit conditional branches:

- `isLoading`
- `error`
- `empty`
- `disabled`
- permission checks
- feature flags
- form validation

#### Data-Flow Discovery

Map inputs to outputs:

- submit form -> API mutation -> toast -> list refresh
- upload file -> processing -> preview -> export

This becomes story graph later.

### 1.4 Screenshot Extraction Strategy

When code is unavailable, infer features from screenshots.

Use this order:

1. screen clustering
2. region detection
3. OCR and label extraction
4. interaction inference
5. state inference

#### Screen Clustering

Group screenshots by:

- shared navigation shell
- active tab
- modal presence
- content layout
- entity type

#### Region Detection

For each screen, identify:

- top nav
- side nav
- toolbar
- content area
- list or grid
- detail panel
- inspector panel
- footer action area

#### OCR and Label Extraction

Extract:

- button labels
- field labels
- headings
- toast text
- error text
- empty state copy

#### Interaction Inference

Infer likely controls from:

- button shape
- input borders
- slider tracks
- pagination controls
- search bars
- file dropzones

Mark inferred controls with lower confidence than code-backed controls.

#### State Inference

Infer state from copy and layout:

- "No items"
- spinner
- disabled buttons
- validation text
- retry banners

### 1.5 Extraction Output

Raw extractor output should be machine-readable.

Minimum screen record:

```json
{
  "id": "screen.library",
  "name": "Library",
  "kind": "route",
  "route": "/library",
  "confidence": 0.95,
  "evidence": [
    "src/routes/library.tsx",
    "screenshots/library-01.png"
  ]
}
```

Minimum feature record:

```json
{
  "id": "feature.media.upload",
  "name": "Media Upload",
  "kind": "workflow",
  "screen_ids": ["screen.library", "screen.upload_modal"],
  "entry_points": [
    {
      "type": "button",
      "label": "Upload"
    }
  ],
  "confidence": 0.9,
  "evidence": [
    "src/components/UploadDialog.tsx"
  ]
}
```

## Stage 2: Feature Documentation

Feature documentation converts raw extraction into stable inventory that story composer can use.

Each feature should answer:

- how user enters it
- what it requires
- what inputs it accepts
- what state transitions it has
- what success and failure look like
- what systems it touches

### 2.1 Feature Record Schema

Recommended fields:

```json
{
  "id": "feature.media.upload",
  "name": "Media Upload",
  "kind": "workflow",
  "screens": ["screen.library", "screen.upload_modal"],
  "entry_points": [
    {
      "type": "button",
      "label": "Upload"
    },
    {
      "type": "dropzone",
      "label": "Drop files here"
    }
  ],
  "preconditions": [
    "user authenticated",
    "library selected"
  ],
  "inputs": [
    {
      "name": "file",
      "type": "file",
      "required": true
    }
  ],
  "actions": [
    "open upload dialog",
    "select file",
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
    "progress bar visible",
    "item appears in list",
    "error toast visible"
  ],
  "backend_touchpoints": [
    "POST /uploads",
    "GET /media"
  ],
  "risk_tags": [
    "async",
    "file-io",
    "large-payload"
  ],
  "confidence": 0.92,
  "evidence": [
    "src/components/UploadDialog.tsx",
    "screenshots/upload-modal-01.png"
  ]
}
```

### 2.2 Screen Record Schema

Recommended fields:

```json
{
  "id": "screen.library",
  "name": "Library",
  "kind": "route",
  "route": "/library",
  "regions": [
    "top_nav",
    "sidebar",
    "content_grid",
    "detail_panel"
  ],
  "features": [
    "feature.media.upload",
    "feature.media.search",
    "feature.media.filter"
  ],
  "states": [
    "empty",
    "populated",
    "loading",
    "error"
  ],
  "confidence": 0.95,
  "evidence": [
    "src/routes/library.tsx"
  ]
}
```

### 2.3 Required Documentation Rules

Every feature must include:

- `entry_points`
- `preconditions`
- `actions`
- `states`
- `observables`
- `risk_tags`
- `evidence`

Every screen must include:

- `features`
- `states`
- `evidence`

### 2.4 Confidence Rules

Use confidence scores to keep system honest:

- `0.9 - 1.0`: direct source evidence
- `0.7 - 0.89`: strong visual evidence
- `0.4 - 0.69`: partial inference
- `< 0.4`: weak guess, do not use for automatic story generation without review

### 2.5 Normalization Rules

Merge duplicates when:

- same route and same purpose
- same modal discovered from multiple files
- same feature with different labels but identical handler

Do not merge when:

- create vs edit
- upload vs import
- search vs filter
- preview vs edit

## Stage 3: Story Creation

Story creation converts feature inventory into browser sessions.

A story should represent real user objective that touches one or more features in sequence.

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
  "id": "story.upload_then_edit_then_export",
  "name": "Upload then edit then export",
  "features": [
    "feature.media.upload",
    "feature.media.edit",
    "feature.media.export"
  ],
  "preconditions": [
    "user authenticated"
  ],
  "steps": [
    {
      "feature": "feature.media.upload",
      "action": "upload valid image"
    },
    {
      "feature": "feature.media.edit",
      "action": "adjust exposure and contrast"
    },
    {
      "feature": "feature.media.export",
      "action": "export as jpeg"
    }
  ],
  "assertions": [
    "uploaded item visible",
    "preview updates after edit",
    "download starts"
  ],
  "mutation_points": [
    "replace valid image with huge file",
    "interrupt network during upload",
    "drag slider aggressively during render"
  ],
  "risk_tags": [
    "async",
    "media",
    "memory",
    "download"
  ]
}
```

### 3.3 Story Types

Generate these story classes:

- happy path
- boundary path
- invalid input
- interruption
- cross-feature
- long-session accumulation
- permission mismatch
- recovery flow

### 3.4 Story Composition Rules

Compose features together when they:

- live on same screen
- operate on same entity
- form input/output chain
- share state or cache
- share backend touchpoints

Good examples:

- sign in -> create draft -> publish
- upload file -> edit metadata -> search -> delete
- filter list -> open detail -> edit -> return to list
- create item -> duplicate item -> export item

Weak examples:

- sign in -> random settings toggle -> unrelated help page

### 3.5 Mutation Rules

Attach mutations at feature boundaries.

Common mutation categories:

- invalid input
- max length input
- rapid repeated clicks
- drag abuse
- upload huge file
- network latency
- offline mode
- navigation interruption
- permission mismatch
- stale session

For each story step, define:

- normal input
- boundary input
- invalid input
- interruption case

## Execution Model

Once stories exist, fuzz runner should execute them in browser with telemetry.

### 4.1 Execution Signals

Collect:

- console errors
- uncaught exceptions
- failed network requests
- DOM assertion failures
- visual diffs if needed
- performance timing
- process memory if platform allows

### 4.2 Required Browser Observations

At minimum record:

- route transitions
- modal open and close
- success toasts
- error banners
- disabled or stuck controls
- loading indicators that never resolve

### 4.3 Failure Clustering

Cluster by:

- story id
- feature id
- mutation type
- error signature
- network endpoint
- telemetry spike

## Suggested Project Layout

Use any layout you want, but this structure scales well:

```text
protocol/
  feature.schema.json
  screen.schema.json
  story.schema.json
  risk-tags.json

extractors/
  source/
  screenshot/

inventory/
  screens.json
  features.json
  stories.json

benchmarks/
  telemetry/
  sessions/
```

## Minimal Implementation Plan

If starting from zero, build in this order:

1. define feature schema
2. define screen schema
3. define story schema
4. implement source-code extractor
5. implement screenshot extractor
6. implement dedupe and normalization pass
7. implement story composer
8. implement browser executor
9. add telemetry and clustering

## Heuristics For Good Coverage

Prioritize features with high bug yield:

- auth
- uploads
- editors
- drag/drop
- search and filters
- imports/exports
- async jobs
- settings
- billing
- collaborative flows

Prioritize stories with:

- multiple state transitions
- persistence
- large payloads
- background processing
- rendering pressure
- navigation during async work

## Review Checklist

Before running fuzzing on project, confirm:

- screens have evidence
- features have observables
- features have risk tags
- low-confidence features are reviewed
- stories have assertions
- stories have mutation points
- stateful stories have cleanup

## Practical Notes

- Start with source-code extraction if code is available.
- Use screenshots to fill gaps in state discovery and layout understanding.
- Keep raw extraction separate from normalized inventory.
- Keep story generator deterministic by default.
- Add randomness only at mutation layer.

## Deliverables

A good implementation should produce:

- `screens.json`
- `features.json`
- `stories.json`
- browser session traces
- telemetry logs
- clustered failure reports

That is enough to move from “exploratory clicking” to reproducible, feature-aware fuzzing system.
