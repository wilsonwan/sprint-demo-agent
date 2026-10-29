import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from '../config.ts';
import type { RecorderSpec } from './recorder.ts';

const run = promisify(execFile);

export type RecorderEnv = { appUrl: string; sessionFile?: string | null; model?: Record<string, string> };

// Runs the recorder child process. Resolves with its output; rejects with its stderr tail.
export async function recorder(mode: 'snapshot' | 'rehearse' | 'verify' | 'take', spec: RecorderSpec, env: RecorderEnv, signal?: AbortSignal) {
  mkdirSync(spec.outDir, { recursive: true });
  const specPath = join(spec.outDir, `${mode}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  try {
    const { stdout } = await run('npx', ['tsx', join(ROOT, 'src/stages/recorder.ts'), mode, specPath], {
      cwd: ROOT,
      signal,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ...env.model,
        DEMO_APP_URL: env.appUrl,
        ...(env.sessionFile && { DEMO_STORAGE_STATE: env.sessionFile }),
      },
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    const clean = stderr.replace(/\x1b\[[0-9;]*m/g, '');
    // The recorder's own one-line explanation, when it gave one.
    const plain = clean.split('\n').filter((l) => l.startsWith('ERROR: ')).at(-1);
    if (plain) throw new Error(plain.slice(7));
    const lines = clean.split('\n').filter((l) => l.trim() && !/DEP0205|trace-deprecation|npm notice|waitForNetworkIdle|^\s+at /.test(l));
    throw new Error(lines.slice(-3).join('\n') || `recorder ${mode} failed`);
  }
}

// Steps whose plan is already in the rehearsal cache (Midscene keys the cache by step text).
export function cachedSteps(cacheFile: string): Set<string> {
  if (!existsSync(cacheFile)) return new Set();
  const prompts = [...readFileSync(cacheFile, 'utf8').matchAll(/^\s+- type: plan\n\s+prompt: (.*)$/gm)].map((m) => unquote(m[1]));
  return new Set(prompts);
}
const unquote = (s: string) => (/^'.*'$/.test(s) ? s.slice(1, -1).replaceAll("''", "'") : /^".*"$/.test(s) ? JSON.parse(s) : s);

// Trims the page load off the take and pads (frozen last frame) or trims it to the slide's length.
export async function finishClip(outDir: string, targetMs: number) {
  const { pageReadyMs } = JSON.parse(readFileSync(join(outDir, 'timings.json'), 'utf8'));
  await run('ffmpeg', [
    '-y', '-loglevel', 'error', '-ss', (pageReadyMs / 1000).toFixed(3), '-i', join(outDir, 'raw.webm'),
    '-vf', `tpad=stop_mode=clone:stop_duration=${targetMs / 1000},fps=30`, '-t', (targetMs / 1000).toFixed(3),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(outDir, 'clip.mp4'),
  ]);
}
