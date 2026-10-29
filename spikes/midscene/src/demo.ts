// Builds a whole demo video: title card, "what this demo proves", a step slide per
// recorded segment, and a closing card, with voice-over.
//
//   plan    The text model (src/llm.ts) writes the card text and narration from
//           demos/<id>/brief.json into demos/<id>/plan.json, which people can edit.
//   voice   Each slide's narration through Kokoro. Its word timings give each recorded
//           step its cue.
//   take    Re-records each step slide's segment from the rehearsal cache, every action
//           starting on its spoken cue and the clip as long as the slide. No model.
//   render  Cards to PNG with Playwright, clips inset into step slides, slides joined
//           with crossfades -> out/demos/<id>/demo.mp4.
//
// Usage: tsx src/demo.ts <plan|voice|take|render|all> demos/<id>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { speak as kokoroSpeak, kokoroVoice, type Analysis } from './kokoro.ts';
import { chatJson } from './llm.ts';
import { INSET, SLIDE, slideHtml, type Card, type Slide } from './slides.ts';

type Brief = { product: string; audience: string; notes: string[]; segments: string[] };
type SegmentFile = { id: string; title: string; steps: { act: string }[]; assert?: string; [k: string]: unknown };
type Plan = {
  product: string;
  title: string;
  summary: string;
  tags: string[];
  stats: { value: string; label: string }[];
  titleNarration: string;
  proves: { subtitle: string; cards: Card[]; outcome: string; narration: string };
  steps: { segment: string; title: string; subtitle: string; narration: string[] }[];
  close: { message: string; delivered: string; next: string; value: string; narration: string };
};
type Voice = { text: string; voice: string; durationMs: number; analysis: Analysis; transcript: string };

const tts = { voice: kokoroVoice, speak: async (text: string) => kokoroSpeak(text) };

const LEAD_MS = 600; // silence before the narration starts on each slide
const TAIL_MS = 1000; // and after it ends
const ACTION_MS = 2500; // room after a step's cue for the action to finish
const XFADE_S = 0.5;
const MAX_NARRATION_CHARS = 280; // keeps each slide short enough to voice in one go

const [command, demoDir] = process.argv.slice(2);
if (!['plan', 'voice', 'take', 'render', 'all'].includes(command) || !demoDir) {
  console.error('usage: demo.ts <plan|voice|take|render|all> demos/<id>');
  process.exit(2);
}
const id = basename(resolve(demoDir));
const out = resolve('out', 'demos', id);
mkdirSync(join(out, 'voice'), { recursive: true });
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const planPath = join(demoDir, 'plan.json');

if (command === 'plan' || command === 'all') await plan();
const demo = readJson<Plan>(planPath);
const slides = slidesOf(demo);
if (command === 'voice' || command === 'all') await voice();
if (command === 'take' || command === 'all') take();
if (command === 'render' || command === 'all') await render();

// ---------------------------------------------------------------- plan

async function plan() {
  const brief = readJson<Brief>(join(demoDir, 'brief.json'));
  const segments = brief.segments.map((path) => ({ path, ...readJson<SegmentFile>(path) }));
  const system = `You write sprint demo videos: a title card, a "what this demo proves" slide, one slide per recorded
segment, and a closing card, with a voice-over read by a text-to-speech narrator. Reply with JSON only.

Rules:
- Only claim what the recorded steps and the notes show. Never describe content the notes say is not on screen.
- Card text is final copy for the audience: no instructions, placeholders or notes about the video itself.
- Narration is spoken English for a sprint review audience: plain, warm, no jargon, no markdown, no brackets.
- Every narration string is at most ${MAX_NARRATION_CHARS} characters.
- For each segment, "narration" has exactly one sentence per recorded step, in order. Each sentence is said while
  that step happens on screen, so it must describe that step and be long enough to cover it (8 to 16 words).`;
  const user = `Product: ${brief.product}
Audience: ${brief.audience}
Notes:
${brief.notes.map((n) => `- ${n}`).join('\n')}

Recorded segments:
${segments.map((s) => `- segment "${s.path}": ${s.title}\n${s.steps.map((st, i) => `  step ${i + 1}: ${st.act}`).join('\n')}${s.assert ? `\n  ends with: ${s.assert}` : ''}`).join('\n')}

Return JSON with this shape:
{
  "product": string,
  "title": string (the feature, 2-5 words),
  "summary": string (one line, what the demo shows),
  "tags": [string, string] (short chips, e.g. "3-minute demo"),
  "stats": [{"value": string, "label": string}] (0-2 counts of what the demo covers, e.g. {"value":"4","label":"Pages"}),
  "titleNarration": string,
  "proves": {"subtitle": string, "cards": [{"title": string, "text": string}] (2-4, the journey in order), "outcome": string (one line, starts "Demo outcome:"), "narration": string},
  "steps": [{"segment": string (the segment path, verbatim), "title": string (starts "Step N: "), "subtitle": string, "narration": [string, one per recorded step]}],
  "close": {"message": string (one sentence to leave with the audience), "delivered": string, "next": string, "value": string, "narration": string}
}`;
  const result = await chatJson<Plan>(system, user);
  const problems = lint(result, segments);
  writeFileSync(planPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`plan written: ${planPath}`);
  if (problems.length) {
    console.error(`plan needs fixing before voice:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
}

// Things a person would catch in review: planning notes left on a card (the reference
// demo has one), narration that won't fit a TTS chunk, steps without a sentence each.
function lint(p: Plan, segments: { path: string; steps: unknown[] }[]) {
  const problems: string[] = [];
  const leaked = /\b(todo|tbd|placeholder|lorem|continuous video|this slide|on this slide|voice-?over|narrat)/i;
  const cardText = [p.title, p.summary, ...p.tags, p.proves.subtitle, p.proves.outcome,
    ...p.proves.cards.flatMap((c) => [c.title, c.text]), ...p.steps.flatMap((s) => [s.title, s.subtitle]),
    p.close.message, p.close.delivered, p.close.next, p.close.value];
  for (const text of cardText) if (leaked.test(text)) problems.push(`card text reads like a note: "${text}"`);
  if (/what this demo proves/i.test(p.proves.subtitle)) problems.push('proves.subtitle repeats the slide heading');
  const narration = [p.titleNarration, p.proves.narration, ...p.steps.map((s) => s.narration.join(' ')), p.close.narration];
  for (const text of narration) {
    if (text.length > MAX_NARRATION_CHARS) problems.push(`narration over ${MAX_NARRATION_CHARS} chars (${text.length}): "${text.slice(0, 60)}…"`);
    if (/[[\]<>*_#]/.test(text)) problems.push(`narration has markup the voice would misread: "${text.slice(0, 60)}…"`);
  }
  for (const s of segments) {
    const step = p.steps.find((st) => st.segment === s.path);
    if (!step) problems.push(`no step slide for segment ${s.path}`);
    else if (step.narration.length !== s.steps.length)
      problems.push(`${s.path}: ${s.steps.length} steps but ${step.narration.length} narration sentences`);
  }
  return problems;
}

// ---------------------------------------------------------------- voice

function slidesOf(p: Plan): { slide: Slide; narration: string; segment?: string; cues?: string[] }[] {
  return [
    { slide: { kind: 'title', title: p.title, summary: p.summary, tags: p.tags, stats: p.stats }, narration: p.titleNarration },
    { slide: { kind: 'proves', subtitle: p.proves.subtitle, cards: p.proves.cards, outcome: p.proves.outcome }, narration: p.proves.narration },
    ...p.steps.map((s) => ({
      slide: { kind: 'step' as const, title: s.title, subtitle: s.subtitle },
      narration: s.narration.join(' '),
      segment: s.segment,
      cues: s.narration,
    })),
    { slide: { kind: 'close', message: p.close.message, delivered: p.close.delivered, next: p.close.next, value: p.close.value }, narration: p.close.narration },
  ];
}

function voicePath(i: number) {
  return join(out, 'voice', String(i + 1).padStart(2, '0'));
}

async function voice() {
  for (const [i, s] of slides.entries()) {
    const path = voicePath(i);
    if (existsSync(`${path}.json`)) {
      const done = readJson<Voice>(`${path}.json`);
      if (done.text === s.narration && done.voice === tts.voice) continue;
    }
    const started = Date.now();
    const take = await tts.speak(s.narration);
    writeFileSync(`${path}.wav`, take.wav);
    const v: Voice = { text: s.narration, voice: tts.voice, durationMs: Math.round(take.analysis.duration * 1000), analysis: take.analysis, transcript: take.transcript };
    writeFileSync(`${path}.json`, JSON.stringify(v, null, 2)); // written last: the voice is done once this exists
    console.log(`slide ${i + 1} (${s.slide.kind}): ${(v.durationMs / 1000).toFixed(1)}s audio in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    console.log(`  said: ${take.transcript}`);
  }
}

// When each cue sentence starts in the narration audio, from the aligner's word timings.
function cueStartsMs(cues: string[], analysis: Analysis) {
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = analysis.lines.flatMap((l) => l.tokens).filter((t) => t.spoken && norm(t.text));
  let cursor = 0;
  return cues.map((cue, i) => {
    const words = cue.split(/\s+/).map(norm).filter(Boolean);
    // Find the cue's first two words at or after the cursor; the aligner keeps the text's word split.
    let at = tokens.findIndex((t, k) => k >= cursor && norm(t.text) === words[0] && (!words[1] || norm(tokens[k + 1]?.text ?? '') === words[1]));
    if (at < 0) {
      console.warn(`cue ${i + 1} not found in the aligned words, placing it by word count: "${cue}"`);
      at = Math.min(cursor, tokens.length - 1);
    }
    cursor = at + words.length;
    return Math.round(tokens[at].start * 1000);
  });
}

function slideDurationMs(i: number) {
  const v = readJson<Voice>(`${voicePath(i)}.json`);
  let ms = LEAD_MS + v.durationMs + TAIL_MS;
  const s = slides[i];
  if (s.cues) ms = Math.max(ms, LEAD_MS + cueStartsMs(s.cues, v.analysis).at(-1)! + ACTION_MS);
  return ms;
}

// ---------------------------------------------------------------- take

function take() {
  for (const [i, s] of slides.entries()) {
    if (!s.segment || !s.cues) continue;
    const segment = readJson<SegmentFile & { targetDurationMs: number; steps: { act: string; atMs?: number; narrationCue?: string }[] }>(s.segment);
    const starts = cueStartsMs(s.cues, readJson<Voice>(`${voicePath(i)}.json`).analysis);
    // The step text stays as rehearsed (the cache is keyed by it); only the timing comes from the voice.
    const timed = {
      ...segment,
      targetDurationMs: slideDurationMs(i),
      steps: segment.steps.map((step, k) => ({ ...step, narrationCue: s.cues![k], atMs: LEAD_MS + starts[k] })),
    };
    const path = join(out, `${segment.id}.timed.json`);
    writeFileSync(path, JSON.stringify(timed, null, 2));
    console.log(`slide ${i + 1}: taking ${segment.id}, cues at ${timed.steps.map((st) => st.atMs).join(', ')} ms`);
    execFileSync('npx', ['tsx', 'src/record-segment.ts', 'take', path], { stdio: 'inherit' });
  }
}

// ---------------------------------------------------------------- render

async function render() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: SLIDE });
  const footer = `${demo.product}  |  ${demo.title}`;
  for (const [i, s] of slides.entries()) {
    await page.setContent(slideHtml(s.slide, footer, i + 1), { waitUntil: 'load' });
    await page.screenshot({ path: join(out, `slide-${i + 1}.png`) });
  }
  await browser.close();

  const durations = slides.map((_, i) => slideDurationMs(i) / 1000);
  for (const [i, s] of slides.entries()) {
    const seconds = durations[i].toFixed(3);
    const audio = ['-i', `${voicePath(i)}.wav`];
    const audioFilter = `[a:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${LEAD_MS}:all=1,apad,atrim=0:${seconds}[a]`;
    const inputs = ['-loop', '1', '-framerate', '30', '-t', seconds, '-i', join(out, `slide-${i + 1}.png`)];
    let video = `[0:v]format=yuv420p[v]`;
    if (s.segment) {
      const segmentId = readJson<SegmentFile>(s.segment).id;
      inputs.push('-i', resolve('out', segmentId, 'clip.mp4'));
      video = `[1:v]scale=${INSET.width}:${INSET.height}[c];[0:v][c]overlay=${INSET.x}:${INSET.y}:eof_action=repeat,format=yuv420p[v]`;
    }
    const audioIndex = s.segment ? 2 : 1;
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', ...inputs, ...audio,
      '-filter_complex', `${video};${audioFilter.replace('[a:a]', `[${audioIndex}:a]`)}`,
      '-map', '[v]', '-map', '[a]', '-t', seconds, '-r', '30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
      join(out, `slide-${i + 1}.mp4`),
    ]);
  }

  // Crossfade the slides together; the fades overlap only the silence around each narration.
  const parts = slides.map((_, i) => ['-i', join(out, `slide-${i + 1}.mp4`)]).flat();
  const filters: string[] = [];
  let v = '[0:v]';
  let a = '[0:a]';
  let offset = 0;
  for (let i = 1; i < slides.length; i++) {
    offset += durations[i - 1] - XFADE_S;
    filters.push(`${v}[${i}:v]xfade=transition=fade:duration=${XFADE_S}:offset=${offset.toFixed(3)}[v${i}]`);
    filters.push(`${a}[${i}:a]acrossfade=d=${XFADE_S}[a${i}]`);
    v = `[v${i}]`;
    a = `[a${i}]`;
  }
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', ...parts, '-filter_complex', filters.join(';'), '-map', v, '-map', a,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k',
    join(out, 'demo.mp4'),
  ]);
  const total = durations.reduce((x, y) => x + y, 0) - XFADE_S * (slides.length - 1);
  console.log(`demo written: ${join('out', 'demos', id, 'demo.mp4')} (${total.toFixed(1)}s)`);
}
