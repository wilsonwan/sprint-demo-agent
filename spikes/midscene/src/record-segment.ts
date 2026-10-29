// Records one demo segment with Midscene driving Playwright.
//
//   rehearse  Real vision model, no video. Midscene plans each natural-language
//             step and writes the plan + element XPaths to cache/<id>.cache.yaml.
//   take      No model (requests go to a stub that fails and counts them). Replays
//             the cached plan with a fake cursor, paced to the narration length,
//             and writes out/<id>/clip.mp4 + timings.json.
//
// Usage: tsx src/record-segment.ts <rehearse|take> segments/<id>.json
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { startModelStub } from './model-stub.ts';
import { overlayScript } from './overlay.ts';

type Step = { act: string; narrationCue?: string; atMs?: number };
type Segment = {
  id: string;
  title: string;
  url: string;
  /** Text to wait for after load, for apps that render after the load event. */
  readyText?: string;
  targetDurationMs: number;
  steps: Step[];
  assert?: string;
};

const VIEWPORT = { width: 1280, height: 720 };
const LEAD_IN_MS = 800;
const TAIL_MS = 1200;

const [mode, segmentPath] = process.argv.slice(2);
if ((mode !== 'rehearse' && mode !== 'take') || !segmentPath) {
  console.error('usage: record-segment.ts <rehearse|take> <segment.json>');
  process.exit(2);
}
const segment: Segment = JSON.parse(readFileSync(segmentPath, 'utf8'));
// `${VAR}` in the URL comes from the environment, so tokens stay out of the segment file.
const rawUrl = segment.url.replace(/\$\{(\w+)\}/g, (_, name) => {
  const value = process.env[name];
  if (!value) throw new Error(`segment url needs $${name}`);
  return value;
});
const url = /^https?:/.test(rawUrl) ? rawUrl : pathToFileURL(resolve(rawUrl)).href;
const outDir = resolve('out', segment.id);
mkdirSync(outDir, { recursive: true });

const stub = mode === 'take' && !process.env.TAKE_ALLOW_MODEL ? await startModelStub() : undefined;
if (stub) {
  process.env.MIDSCENE_MODEL_BASE_URL = stub.baseUrl;
  process.env.MIDSCENE_MODEL_API_KEY = 'stub';
  process.env.MIDSCENE_MODEL_NAME ??= 'stub';
  process.env.MIDSCENE_MODEL_FAMILY ??= 'qwen3';
  process.env.MIDSCENE_MODEL_RETRY_COUNT = '0';
}
// Midscene reads model config from the environment, so import it afterwards.
const { PlaywrightPageAgent } = await import('@midscene/web/playwright');

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  ...(mode === 'take' && { recordVideo: { dir: outDir, size: VIEWPORT } }),
});
if (mode === 'take') await context.addInitScript({ content: overlayScript });

const videoStart = Date.now();
const page = await context.newPage();
if (mode === 'take') glideMouse(page);
await page.goto(url, { waitUntil: 'load' });
if (segment.readyText) await page.getByText(segment.readyText).first().waitFor();
const pageReady = Date.now() - videoStart;

const agent = new PlaywrightPageAgent(page, {
  cache: {
    id: segment.id,
    strategy: mode === 'rehearse' ? 'write-only' : 'read-only',
    cacheDir: resolve('cache'),
  },
  keyboardTypeDelay: mode === 'take' ? 70 : undefined,
  reportFileName: `${segment.id}-${mode}`,
});
if (mode === 'rehearse') replayableXpaths(agent.page);

const timings: { act: string; cueMs: number; startMs: number; endMs: number }[] = [];
const now = () => Date.now() - videoStart - pageReady;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  // Each step starts at its narration cue (atMs, from the aligner's word
  // timings) or, failing that, at an even split of the narration length.
  const slot = (segment.targetDurationMs - LEAD_IN_MS - TAIL_MS) / segment.steps.length;
  for (const [i, step] of segment.steps.entries()) {
    const cueMs = Math.round(step.atMs ?? LEAD_IN_MS + i * slot);
    if (mode === 'take') await sleep(cueMs - now());
    const startMs = now();
    if (mode === 'take' && startMs - cueMs > 250) {
      console.warn(`step ${i + 1} started ${startMs - cueMs}ms after its cue; the previous step overran`);
    }
    await agent.aiAct(step.act);
    timings.push({ act: step.act, cueMs, startMs, endMs: now() });
    console.log(`step ${i + 1}: ${startMs}→${now()}ms  ${step.act}`);
  }
  // aiAssert is never cached, so it only runs where a model is available.
  if (segment.assert && !stub) await agent.aiAssert(segment.assert);
} catch (error) {
  await page.screenshot({ path: join(outDir, `${mode}-failed.png`) }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
  await stub?.close();
}

if (mode === 'rehearse') {
  writeFileSync(join(outDir, 'rehearse-timings.json'), JSON.stringify({ steps: timings }, null, 2));
  console.log(`cache written: ${join('cache', `${segment.id}.cache.yaml`)}`);
} else {
  if (stub?.calls.length) {
    console.error(`take made ${stub.calls.length} model call(s); re-run rehearse: ${stub.calls.join(", ")}`);
    process.exit(1);
  }
  const webm = (await page.video()!.path())!;
  renameSync(webm, join(outDir, 'raw.webm'));
  // Drop the page-load frames, then pad (freeze last frame) or trim to exactly
  // the narration length so the clip lines up with the voice-over.
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', (pageReady / 1000).toFixed(3), '-i', join(outDir, 'raw.webm'),
    '-vf', `tpad=stop_mode=clone:stop_duration=${segment.targetDurationMs / 1000},fps=30`,
    '-t', (segment.targetDurationMs / 1000).toFixed(3),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    join(outDir, 'clip.mp4'),
  ]);
  writeFileSync(
    join(outDir, 'timings.json'),
    JSON.stringify({ targetDurationMs: segment.targetDurationMs, modelCalls: 0, steps: timings }, null, 2),
  );
  console.log(`clip written: ${join('out', segment.id, 'clip.mp4')}`);
}

// Midscene caches the XPath of the element under the click point, and on replay takes the
// first element that XPath matches, with no wait. A text predicate can match a hidden twin
// (Whaleshark's nav stacks an invisible bold copy of each label under the visible one), so
// the replay finds no rect and falls back to the model. While the element is still on screen,
// shorten each cached XPath to the nearest ancestor that replay resolves to a visible rect.
type XpathPage = {
  cacheFeatureForPoint(center: [number, number], options?: unknown): Promise<{ xpaths?: string[] }>;
  getElementInfoByXpath(xpath: string): Promise<{ rect?: { isVisible?: boolean } } | null>;
};
function replayableXpaths(page: unknown) {
  const p = page as XpathPage;
  const cacheFeatureForPoint = p.cacheFeatureForPoint.bind(p);
  p.cacheFeatureForPoint = async (center, options) => {
    const feature = await cacheFeatureForPoint(center, options);
    const xpaths: string[] = [];
    for (let xpath of feature.xpaths ?? []) {
      const original = xpath;
      while (xpath.split('/').length > 3 && !(await p.getElementInfoByXpath(xpath))?.rect?.isVisible) {
        xpath = xpath.replace(/\/[^/\[]+(\[[^\]]*\])*$/, '');
      }
      if (xpath !== original) console.log(`cache xpath shortened to a visible element:\n  ${original}\n  ${xpath}`);
      xpaths.push(xpath);
    }
    return { ...feature, xpaths };
  };
}

// Midscene teleports the mouse; glide it there instead so the fake cursor
// travels visibly, and pause briefly so the click lands where viewers look.
function glideMouse(page: Page) {
  const move = page.mouse.move.bind(page.mouse);
  let last = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  page.mouse.move = async (x, y, options) => {
    const distance = Math.hypot(x - last.x, y - last.y);
    last = { x, y };
    await move(x, y, { steps: options?.steps ?? Math.max(1, Math.round(distance / 12)) });
    if (distance > 4) await sleep(250);
  };
}
