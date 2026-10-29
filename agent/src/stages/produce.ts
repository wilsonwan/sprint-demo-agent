import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { Plan } from '../doc.ts';
import { finishClip, recorder, type RecorderEnv } from './record.ts';
import { INSET, SLIDE, slideHtml, type Slide } from './slides.ts';
import { cueStartsMs, speak, type Voice } from './voice.ts';

const run = promisify(execFile);
const LEAD_MS = 600; // silence before the narration on each slide
const TAIL_MS = 1000; // and after it
const ACTION_MS = 2500; // room after the last cue for its action to finish
const XFADE_S = 0.5;

type SlidePart = { slide: Slide; narration: string; segmentId?: string; cues?: string[] };

export function slidesOf(plan: Plan): SlidePart[] {
  return [
    { slide: { kind: 'title', title: plan.title, summary: plan.summary, tags: plan.tags, stats: plan.stats }, narration: plan.titleNarration },
    { slide: { kind: 'proves', subtitle: plan.proves.subtitle, cards: plan.proves.cards, outcome: plan.proves.outcome }, narration: plan.proves.narration },
    ...plan.segments.map((s) => ({
      slide: { kind: 'step' as const, title: s.title, subtitle: s.subtitle },
      narration: s.steps.map((st) => st.narration).join(' '),
      segmentId: s.id,
      cues: s.steps.map((st) => st.narration),
    })),
    { slide: { kind: 'close', ...plan.close }, narration: plan.close.narration },
  ];
}

const voicePath = (dir: string, i: number) => join(dir, 'voice', String(i + 1).padStart(2, '0'));

export async function voiceAll(dir: string, plan: Plan, signal?: AbortSignal) {
  mkdirSync(join(dir, 'voice'), { recursive: true });
  const voices: Voice[] = [];
  for (const [i, part] of slidesOf(plan).entries()) voices.push(await speak(part.narration, voicePath(dir, i), signal));
  return voices;
}

function readVoice(dir: string, i: number): Voice {
  return JSON.parse(readFileSync(`${voicePath(dir, i)}.json`, 'utf8'));
}

function slideMs(dir: string, part: SlidePart, i: number) {
  const voice = readVoice(dir, i);
  let ms = LEAD_MS + voice.durationMs + TAIL_MS;
  if (part.cues) ms = Math.max(ms, LEAD_MS + cueStartsMs(part.cues, voice).at(-1)! + ACTION_MS);
  return ms;
}

// One take per segment, every action on its spoken cue. Skipped when nothing it depends on
// changed (steps, cues, length, the rehearsal cache).
export async function takeAll(dir: string, plan: Plan, env: RecorderEnv, readyText: string, signal?: AbortSignal) {
  for (const [i, part] of slidesOf(plan).entries()) {
    if (!part.segmentId || !part.cues) continue;
    const segment = plan.segments.find((s) => s.id === part.segmentId)!;
    const starts = cueStartsMs(part.cues, readVoice(dir, i));
    const outDir = join(dir, 'segments', segment.id);
    const cacheDir = join(dir, 'cache');
    const spec = {
      id: segment.id,
      readyText,
      steps: segment.steps.map((st, k) => ({ act: st.act, atMs: LEAD_MS + starts[k] })),
      targetDurationMs: slideMs(dir, part, i),
      cacheDir,
      outDir,
    };
    const cacheFile = join(cacheDir, `${segment.id}.cache.yaml`);
    const hash = createHash('sha256').update(JSON.stringify(spec)).update(existsSync(cacheFile) ? readFileSync(cacheFile) : '').digest('hex');
    const hashFile = join(outDir, 'take.hash');
    if (existsSync(join(outDir, 'clip.mp4')) && existsSync(hashFile) && readFileSync(hashFile, 'utf8') === hash) continue;
    await recorder('take', spec, env, signal);
    await finishClip(outDir, spec.targetDurationMs);
    writeFileSync(hashFile, hash);
  }
}

// Cards to PNG, clips inset into step slides, slides joined with crossfades -> demo.mp4.
export async function render(dir: string, plan: Plan, signal?: AbortSignal) {
  const parts = slidesOf(plan);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: SLIDE });
  const footer = `${plan.product}  |  ${plan.title}`;
  for (const [i, part] of parts.entries()) {
    await page.setContent(slideHtml(part.slide, footer, i + 1), { waitUntil: 'load' });
    await page.screenshot({ path: join(dir, `slide-${i + 1}.png`) });
  }
  await browser.close();

  const durations = parts.map((part, i) => slideMs(dir, part, i) / 1000);
  for (const [i, part] of parts.entries()) {
    const seconds = durations[i].toFixed(3);
    const inputs = ['-loop', '1', '-framerate', '30', '-t', seconds, '-i', join(dir, `slide-${i + 1}.png`)];
    let video = '[0:v]format=yuv420p[v]';
    if (part.segmentId) {
      inputs.push('-i', join(dir, 'segments', part.segmentId, 'clip.mp4'));
      video = `[1:v]scale=${INSET.width}:${INSET.height}[c];[0:v][c]overlay=${INSET.x}:${INSET.y}:eof_action=repeat,format=yuv420p[v]`;
    }
    inputs.push('-i', `${voicePath(dir, i)}.wav`);
    const audio = `[${part.segmentId ? 2 : 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${LEAD_MS}:all=1,apad,atrim=0:${seconds}[a]`;
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${video};${audio}`, '-map', '[v]', '-map', '[a]',
      '-t', seconds, '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', join(dir, `slide-${i + 1}.mp4`)], { signal });
  }
  const filters: string[] = [];
  let v = '[0:v]';
  let a = '[0:a]';
  let offset = 0;
  for (let i = 1; i < parts.length; i++) {
    offset += durations[i - 1] - XFADE_S;
    filters.push(`${v}[${i}:v]xfade=transition=fade:duration=${XFADE_S}:offset=${offset.toFixed(3)}[v${i}]`, `${a}[${i}:a]acrossfade=d=${XFADE_S}[a${i}]`);
    v = `[v${i}]`;
    a = `[a${i}]`;
  }
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...parts.flatMap((_, i) => ['-i', join(dir, `slide-${i + 1}.mp4`)]),
    '-filter_complex', filters.join(';'), '-map', v, '-map', a, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '192k', join(dir, 'demo.mp4')], { signal });
  return durations.reduce((x, y) => x + y, 0) - XFADE_S * (parts.length - 1);
}
