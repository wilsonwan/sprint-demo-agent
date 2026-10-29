import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { KOKORO_VOICE, ROOT } from '../config.ts';

const run = promisify(execFile);
const TTS = join(ROOT, 'tts');

export type Token = { text: string; spoken: boolean; start: number; end: number };
export type Voice = { text: string; voice: string; durationMs: number; tokens: Token[] };

// Kokoro on the CPU (tts/ is its own uv project). Its duration predictor gives exact word
// timings. Cached by text and voice: a slide is re-voiced only when its narration changes.
export async function speak(text: string, path: string, signal?: AbortSignal): Promise<Voice> {
  const voice = `kokoro/${KOKORO_VOICE}`;
  if (existsSync(`${path}.json`)) {
    const done: Voice = JSON.parse(readFileSync(`${path}.json`, 'utf8'));
    if (done.text === text && done.voice === voice) return done;
  }
  const child = run('uv', ['run', '--quiet', '--project', TTS, 'python', '-I', join(TTS, 'speak.py'), `${path}.wav`, KOKORO_VOICE], {
    signal,
    maxBuffer: 16 * 1024 * 1024,
  });
  child.child.stdin!.end(text);
  const { stdout } = await child;
  const analysis = JSON.parse(stdout.trim().split('\n').at(-1)!); // the JSON is the last line
  const v: Voice = { text, voice, durationMs: Math.round(analysis.duration * 1000), tokens: analysis.lines.flatMap((l: { tokens: Token[] }) => l.tokens) };
  writeFileSync(`${path}.json`, JSON.stringify(v, null, 2)); // written last: the voice is done once this exists
  return v;
}

// When each cue sentence starts in the narration, in ms from the start of the audio.
export function cueStartsMs(cues: string[], voice: Voice) {
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = voice.tokens.filter((t) => t.spoken && norm(t.text));
  let cursor = 0;
  return cues.map((cue) => {
    const words = cue.split(/\s+/).map(norm).filter(Boolean);
    let at = tokens.findIndex((t, k) => k >= cursor && norm(t.text) === words[0] && (!words[1] || norm(tokens[k + 1]?.text ?? '') === words[1]));
    if (at < 0) at = Math.min(cursor, tokens.length - 1); // not found: place it by word count
    cursor = at + words.length;
    return Math.round(tokens[at].start * 1000);
  });
}
