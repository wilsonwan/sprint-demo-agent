# Spike: does Midscene.js simplify the sprint-demo pipeline?

Follow-up idea to #1. Timebox: one session. PoC in [`spikes/midscene/`](../spikes/midscene/).

## Short answer

**Yes for recording, no for the rest.** [Midscene.js](https://midscenejs.com) is a
vision-model browser-automation layer on top of Playwright. It can replace the
riskiest custom piece of #1, **stage 4 (the agent explores the app and writes a fixed,
repeatable recording script per segment)**, and simplifies the take in stage 6. It does
nothing for Jira, narration, voice-over, GPU switching, ffmpeg, durability or
multiplayer, so it doesn't change the Pi Durable go/no-go question.

Recommendation: adopt it as the recording layer, pinned, using the
**rehearse → cache → take** pattern below. Before committing, run one real rehearsal
against the real app with the model we'd actually use (see *Not verified*).

## The pattern that works

Each segment's steps are plain English, written by the LLM at the plan stage and
editable by people in `demo.plan`:

```json
{ "act": "Tick the checkbox next to \"Buy milk\"", "atMs": 7400 }
```

1. **Rehearse** (vision model, no video). `agent.aiAct(step)` plans each step, and
   Midscene writes a cache file: a YAML action flow per step plus an XPath per element.
   `aiAssert` checks the segment's end state (for example, the acceptance criterion
   shown on screen). That cache file *is* the fixed, repeatable recording script from
   #1, and nobody has to write Playwright code.
2. **Take** (no model). Replay with `cache: { strategy: 'read-only' }`, Playwright
   `recordVideo`, the fake-cursor overlay, and each step started at its narration cue
   (`atMs` from the aligner's word timings, otherwise an even split). ffmpeg trims the
   page load and pads or trims to exactly the voice-over length.

A take must never call the model: a model call adds seconds of frozen video and makes
the clip non-deterministic. The PoC enforces this by pointing Midscene at a local stub
server that fails and counts every request. A cache miss fails the take loudly, and the
fix is to rehearse again.

## What the PoC showed (verified here)

| Check | Result |
|---|---|
| Cached take, zero model calls | ✅ all 3 plan and 3 locate entries hit; stub saw 0 requests |
| Output | ✅ `clip.mp4`, H.264 1280×720 30 fps, **12.000 s** for a 12 s target |
| Fake cursor, click ripple, element highlight | ✅ visible in frames; the cursor glides (wraps `page.mouse.move`) instead of jumping |
| Step edited after rehearsal (prompt text changed) | ✅ take fails with the model-stub error, no bad clip |
| Narration too short for the actions | ✅ logs `step N started Xms after its cue` and records `cueMs`/`startMs` in `timings.json` |

## Where it simplifies #1

- **Stage 4 mostly disappears.** No Copilot tool-calling loop to explore the app,
  no generated Playwright code to review or debug. Steps stay human-readable in
  `demo.plan`, so the transcript editor and the step editor are the same kind of edit.
- **Self-healing on UI changes.** When the app changes, re-rehearse the segment
  (model re-plans) instead of regenerating and fixing code. Cache is keyed by the
  exact step text, so editing a step invalidates exactly that step.
- **Free review artefact.** Each run writes an HTML report (screenshot per action,
  replay). It's a good thing to show at the stage 4/6 approval gates.
- **Existing tests (open question in #1).** Midscene attaches to any Playwright
  `Page` (and has a `PlaywrightAiFixture`), so "replay an existing test with recording
  on" can mix the existing selectors with `aiAct` steps in the same page.
- **Optional:** `aiQuery` can read values off the screen to check the narration
  against what's actually shown.

## What it doesn't do

- **Video.** Midscene has no screen recording. We still need Playwright `recordVideo`,
  the overlay (about 50 lines, `src/overlay.ts`) and ffmpeg.
- **Asserts and queries are never cached.** `aiAssert`, `aiQuery` and `aiBoolean`
  always call the model, so they belong in the rehearsal, not the take.
- **Everything else in #1:** ingest, plan, narration, TTS and scoring, GPU lease,
  combine, publish, durability, multiplayer.

## Costs and risks

- **It needs a vision model that can locate elements.** Midscene speaks the
  OpenAI-compatible API (`MIDSCENE_MODEL_BASE_URL`/`_API_KEY`/`_NAME`/`_FAMILY`, with
  separate planning, locate and insight models optional). Two candidates:
  - *Copilot.* Midscene's docs say GPT-5.4 or later can do visual localization;
    earlier GPT-5 models can only plan. Custom auth headers go through
    `MIDSCENE_MODEL_INIT_CONFIG_JSON` (`defaultHeaders`). Screenshots of the app go to
    the model. (The agent later settled on this; see `agent/`.)
  - *A local Qwen3-VL on a GPU machine* (Midscene family `qwen3-vl`). Keeps
    screenshots local, but needs GPU time; only rehearsals use it, so they can be
    batched. VRAM fit is unmeasured.
- **Fixed per-action overhead.** Even fully cached, each primitive action took about
  1 s of Midscene settle time on top of the action itself. Three steps (two typed
  entries, one click) needed about 8 s, so the narration has to leave about 1.5–3 s
  per step. This is stable, so it's plannable: the plan stage can estimate it, and
  overruns are detected.
- **XPath cache is positional** (`/html/body/main/ul/li[1]/input`). Lists whose order
  depends on data can hit the wrong element, so seed test data deterministically
  before the take. `aiTap(prompt, { xpath })` can pin a known-stable selector.
- **Release churn.** Releases come almost daily (1.15.4 → 1.17.3 in two weeks). Pin it
  like `pi-durable`. The PoC pins `1.15.4`.

## Gotchas hit during the PoC

- `@midscene/web/playwright` imports `@playwright/test` even if you only use
  `playwright`, so add it as a dependency.
- Under `tsx`/esbuild, functions passed to `context.addInitScript(fn)` get `__name(...)`
  helpers and throw `__name is not defined` in the page. Pass `{ content: string }`.
- Midscene reads model config from the environment, so set or override it before
  importing `@midscene/web`.
- The Playwright adapter logs a warning that `waitForNetworkIdle` is skipped. Wait for
  app-specific readiness in the step itself (for example, `aiWaitFor`, which also runs
  in rehearsal only).

## Real rehearsal: Whaleshark web UI with GLM 5.3 Flash (2026-10-29)

Segment `segments/whaleshark-settings.json`: open Settings, then Appearance, Skills
and MCP servers, on the Whaleshark web host (hub mode, no connections). Model:
`glm-5.3-flash` through an OpenAI-compatible endpoint.

| Check | Result |
|---|---|
| Rehearsal | ✅ 4/4 steps, one plan each, `aiAssert` passed; 13 model calls |
| Time per step (rehearsal) | ~8–20 s (2–3 model calls per step); one cold first call took 50 s |
| Cache shape | ✅ same as the hand-written one: a `plan` + `locate` entry per step |
| Take | ✅ 0 model calls, every step on its cue, `clip.mp4` 16.000 s 1280×720 30 fps |
| Time per step (take) | ~1.0–1.9 s per click, cached |

Three things had to change before the take replayed cleanly:

- **GLM answers bboxes in pixels.** The `glm-v` family's prompt asks for 0–1000
  normalized coordinates, but GLM 5.3 Flash mostly answers in pixels, so clicks
  land in the wrong place and the step loops until the 20-cycle replanning limit.
  Use family `qwen2.5-vl`, whose prompt asks for pixel `[x1,y1,x2,y2]`.
- **A passing rehearsal can write a cache that doesn't replay.** Midscene caches
  the XPath under the click point with a text predicate
  (`span[1]/span[normalize-space()="Appearance"]`). Whaleshark's nav stacks an
  invisible bold copy of each label under the visible one, so on replay the XPath
  finds the hidden copy first, gets no rect and falls back to the model. Rehearse
  now checks each cached XPath while the element is on screen and shortens it to
  the nearest ancestor that resolves to a visible rect (`replayableXpaths` in
  `record-segment.ts`). A rehearsal should be followed by a take (or a dry replay)
  before it counts as done.
- **The model stub counted a port probe.** This dev environment probes every new
  listening port with `GET /`. The stub now counts only requests under `/v1/`.

Still open: the Skills and MCP servers pages show only loading placeholders on a
hub with no connections, so a real demo needs a seeded machine behind the web
host. Copilot and local Qwen weren't compared.

## Not verified (sandbox limits)

- **demo.playwright.dev is blocked here,** so the PoC uses a local TodoMVC-style
  fixture (`fixtures/todomvc.html`).

## How it maps onto Pi Durable (if we go ahead)

- Split the `record` child task into `rehearse` (holds the GPU lease if the vision
  model is local) and `take` (no lease). The take's input hash includes the cache
  file, so editing a step re-rehearses and re-takes only that segment.
- `demo.plan` holds per-step `act` text and `atMs` cues from the aligner. The
  rehearsal report is linked from the segment for the approval gate.

## Suggested follow-up tickets

1. Compare the vision model: GLM 5.3 Flash (done, see above) vs. Copilot (done, see `agent/`) vs. local Qwen3-VL (quality, time per step, VRAM).
2. Estimate per-step duration at plan time so narration and actions fit before voice-over.
3. Deterministic test-data seeding per segment (protects the positional XPath cache).
4. Wire `rehearse` and `take` into the `demo.pipeline` child tasks with input hashing.
