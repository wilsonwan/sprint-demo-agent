import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Kokoro (Apache-2.0, 82M, on the CPU) reads the narration itself. Its duration predictor
// gives exact word timings, so no aligner is needed. tts/ is its own uv project.
export type Token = { text: string; spoken: boolean; start: number; end: number };
export type Analysis = { duration: number; aligned: boolean; lines: { start: number; end: number; text: string; tokens: Token[] }[] };
export type Take = { wav: Buffer; analysis: Analysis; transcript: string };

const VOICE = process.env.DEMO_KOKORO_VOICE ?? 'af_heart';
const TTS_DIR = new URL('../tts/', import.meta.url).pathname;

export function speak(text: string): Take {
  const wav = join(tmpdir(), `kokoro-${process.pid}-${Date.now()}.wav`);
  const json = execFileSync('uv', ['run', '--quiet', '--project', TTS_DIR, 'python', '-I', join(TTS_DIR, 'speak.py'), wav, VOICE], {
    input: text,
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });
  const analysis: Analysis = JSON.parse(json.toString());
  return { wav: readFileSync(wav), analysis, transcript: text };
}

export const kokoroVoice = `kokoro/${VOICE}`;
