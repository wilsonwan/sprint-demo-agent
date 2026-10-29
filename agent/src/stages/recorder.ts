// The browser side of the pipeline, run as a child process so Midscene's environment-based
// model settings and Playwright stay out of the agent process.
//
//   snapshot  Open the app, write its accessibility tree (for planning). No model.
//   rehearse  Midscene plans each plain-English step with the vision model and writes the
//             cache: a plan and element XPath per step. No video.
//   verify    Replays the cache right after a rehearsal, as fast as it can, with no video and
//             the model stub: proves every step can be taken without the model.
//   take      Replays the cache with a fake cursor, each step at its narration cue, and
//             writes clip.mp4 sized to the slide. Model requests go to a stub that fails.
//
// Usage: tsx src/stages/recorder.ts <mode> <spec.json>
// Environment: DEMO_APP_URL (may hold a token), DEMO_STORAGE_STATE (a saved, signed-in browser
// session; the login itself never goes through the model), MIDSCENE_MODEL_* for rehearse.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { overlayScript } from './overlay.ts';

export type RecorderSpec = {
  id: string;
  readyText?: string;
  steps: { act: string; atMs?: number }[];
  targetDurationMs?: number;
  assert?: string;
  cacheDir: string;
  outDir: string;
};

const VIEWPORT = { width: 1280, height: 720 };
const [mode, specPath] = process.argv.slice(2);
if (!['snapshot', 'rehearse', 'verify', 'take'].includes(mode) || !specPath) {
  console.error('usage: recorder.ts <snapshot|rehearse|verify|take> <spec.json>');
  process.exit(2);
}
const spec: RecorderSpec = JSON.parse(readFileSync(specPath, 'utf8'));
const url = process.env.DEMO_APP_URL;
if (!url) throw new Error('DEMO_APP_URL is not set');
mkdirSync(spec.outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const replay = mode === 'take' || mode === 'verify';
const stub = replay ? await startModelStub() : undefined;
let currentStep = -1; // for error messages
let checking = false; // true while the end check (aiAssert) runs
if (stub) {
  Object.assign(process.env, {
    MIDSCENE_MODEL_BASE_URL: stub.baseUrl,
    MIDSCENE_MODEL_API_KEY: 'stub',
    MIDSCENE_MODEL_NAME: 'stub',
    MIDSCENE_MODEL_FAMILY: 'qwen3',
    MIDSCENE_MODEL_RETRY_COUNT: '0',
  });
}
process.env.MIDSCENE_RUN_DIR = join(spec.outDir, 'midscene_run');

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  // The environment's saved session (targets.ts logs in and keeps it valid).
  ...(process.env.DEMO_STORAGE_STATE && { storageState: process.env.DEMO_STORAGE_STATE }),
  ...(mode === 'take' && { recordVideo: { dir: spec.outDir, size: VIEWPORT } }),
});
if (mode === 'take') await context.addInitScript({ content: overlayScript });
const videoStart = Date.now();
const page = await context.newPage();
let failed = false;
try {
  await page.goto(url, { waitUntil: 'load' });
  if (process.env.DEMO_STORAGE_STATE) {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    if (await page.locator('input[type="password"]:visible').first().isVisible().catch(() => false)) {
      throw new Error('The saved session has expired (the app shows a login page). Retry, and the agent logs in again');
    }
  }
  if (spec.readyText) {
    // Visible text, an input's placeholder or a heading: whatever shows the app has loaded.
    const t = spec.readyText;
    await page.getByText(t).or(page.getByPlaceholder(t)).or(page.getByRole('heading', { name: t })).first()
      .waitFor({ timeout: 30_000 })
      .catch(() => { throw new Error(`The start page never showed "${t}" (as text, a placeholder or a heading) within 30 s`); });
  }
  if (mode === 'snapshot') {
    writeFileSync(join(spec.outDir, 'snapshot.txt'), (await page.locator('body').ariaSnapshot()).slice(0, 12_000));
    await page.screenshot({ path: join(spec.outDir, 'snapshot.png') });
  } else {
    await run(page, Date.now() - videoStart);
  }
} catch (error) {
  failed = true;
  await page.screenshot({ path: join(spec.outDir, `${mode}-failed.png`) }).catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  // One plain line for the agent and the people reading it (record.ts looks for "ERROR: ").
  const step = spec.steps[currentStep];
  const where = checking ? `The end check ("${spec.assert}")` : step ? `Step ${currentStep + 1} ("${step.act}")` : 'Opening the app';
  const raw = (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, '');
  const why = checking
    ? `failed: ${(/Assertion failed:?\s*([\s\S]*)/i.exec(raw)?.[1] ?? raw).split('\n')[0].trim().slice(0, 300)}`
    : stub?.calls.length
    ? "couldn't be replayed from the rehearsal: the page didn't match what was cached, so it would need the model"
    : /planning cycle limit/i.test(raw)
      ? "kept failing: the model couldn't do it on this page (the step may name something that isn't there)"
      : (raw.split('\n').find((l) => l.trim() && !/^\s+at /.test(l)) ?? raw).trim().slice(0, 300);
  console.error(`ERROR: ${where} ${why}`);
} finally {
  await context.close();
  await browser.close();
  await stub?.close();
}
if (stub?.calls.length && !failed) {
  console.error(`ERROR: The ${mode} needed the model ${stub.calls.length} time(s); the segment needs rehearsing again`);
  failed = true;
}
if (!failed && mode === 'take') {
  const webm = (await page.video()!.path())!;
  renameSync(webm, join(spec.outDir, 'raw.webm'));
}
process.exit(failed ? 1 : 0);

async function run(page: Page, pageReady: number) {
  // Midscene reads its model settings from the environment, so import it after setting them.
  const { PlaywrightPageAgent } = await import('@midscene/web/playwright');
  if (mode === 'take') glideMouse(page);
  const agent = new PlaywrightPageAgent(page, {
    cache: { id: spec.id, strategy: mode === 'rehearse' ? 'write-only' : 'read-only', cacheDir: spec.cacheDir },
    keyboardTypeDelay: mode === 'take' ? 70 : undefined,
    generateReport: mode === 'rehearse',
    reportFileName: `${spec.id}-${mode}`,
  });
  if (mode === 'rehearse') replayableXpaths(agent.page);
  const timings: { act: string; cueMs: number; startMs: number; endMs: number }[] = [];
  const now = () => Date.now() - videoStart - pageReady;
  for (const [i, step] of spec.steps.entries()) {
    currentStep = i;
    // Replays look each cached element up once, without waiting: let the page finish first.
    if (mode !== 'rehearse') await settle(page);
    const cueMs = step.atMs ?? 0;
    if (mode === 'take') await sleep(cueMs - now());
    const startMs = now();
    await agent.aiAct(step.act);
    timings.push({ act: step.act, cueMs, startMs, endMs: now() });
    console.log(`step ${i + 1}: ${startMs}→${now()}ms  ${step.act}`);
  }
  // aiAssert is never cached, so it only runs in rehearsal.
  if (mode === 'rehearse' && spec.assert) {
    checking = true;
    await agent.aiAssert(spec.assert);
    checking = false;
  }
  if (mode === 'take') {
    const target = spec.targetDurationMs ?? now();
    await sleep(Math.max(0, target - now()));
    writeFileSync(join(spec.outDir, 'timings.json'), JSON.stringify({ pageReadyMs: pageReady, targetDurationMs: target, steps: timings }, null, 2));
  }
}

// Waits until the page has loaded, its network has gone quiet and it shows something: a click
// that navigates leaves a blank page for a moment, and a cached element can't be found on it.
async function settle(page: Page) {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 0, null, { timeout: 10_000 }).catch(() => {});
}

// Midscene caches the XPath under the click point and, on replay, takes the first element it
// matches. A text predicate can match a hidden twin (an invisible bold copy of a label), so the
// replay finds no rect and falls back to the model. While the element is on screen, shorten
// each cached XPath to the nearest ancestor that resolves to a visible rect.
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
        xpath = xpath.replace(/\/[^/[]+(\[[^\]]*\])*$/, '');
      }
      // Got all the way to <body> (e.g. a large scroll area): <body> can't be replayed, keep the original.
      if (xpath.split('/').length <= 3) xpath = original;
      xpaths.push(xpath);
    }
    return { ...feature, xpaths };
  };
}

// Midscene teleports the mouse; glide it instead so the fake cursor travels visibly.
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

// A stand-in for the model during a take. A request under /v1/ means the take was not fully
// served from the rehearsal cache. Other paths are ignored: some dev environments probe every
// new listening port with `GET /`.
async function startModelStub() {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/v1/')) return void res.writeHead(404).end();
    calls.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model-stub: a take must not call the model' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

