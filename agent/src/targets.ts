import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { DATA, ROOT } from './config.ts';

// The environments a demo can record against, from targets.json on the agent host (see
// targets.example.json). Each names its app URL and, optionally, how to log in. The agent keeps
// a saved browser session per environment in data/sessions/ and logs in again, headless, when
// it has expired. Credentials are read from the env file at login time and never stored here.
export type Target = {
  id: string;
  label: string;
  appUrl: string;
  readyText?: string;
  session?: {
    loginUrl: string; // opens the login form and returns to the app once signed in
    checkUrl: string; // answers 200 with {"token": ...} while the session is valid
    envFile: string; // where the username and password are (e.g. the app's playwright/.env)
    usernameVar: string;
    passwordVar: string;
    usernameSelector: string;
    passwordSelector: string;
    submitSelector: string;
  };
};

const TARGETS_PATH = process.env.DEMO_TARGETS ?? join(ROOT, 'targets.json');

export function listTargets(): Target[] {
  return existsSync(TARGETS_PATH) ? JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) : [];
}
export function getTarget(id: string): Target {
  const target = listTargets().find((t) => t.id === id);
  if (!target) throw new Error(`no environment "${id}" in ${TARGETS_PATH}`);
  return target;
}

const sessionPath = (id: string) => join(DATA, 'sessions', `${id}.json`);

// A saved session that works, logging in first if there's none or it has expired.
export async function ensureSession(target: Target): Promise<string | null> {
  const s = target.session;
  if (!s) return null;
  const file = sessionPath(target.id);
  const browser = await chromium.launch();
  try {
    if (existsSync(file)) {
      const context = await browser.newContext({ storageState: file });
      if (await signedIn(context, s.checkUrl)) return file;
      await context.close();
    }
    const env = readEnvFile(s.envFile);
    const username = env[s.usernameVar];
    const password = env[s.passwordVar];
    if (!username || !password) throw new Error(`${s.envFile} has no ${s.usernameVar}/${s.passwordVar} for logging in to ${target.label}`);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(s.loginUrl, { waitUntil: 'load' });
    await page.locator(s.usernameSelector).fill(username, { timeout: 15_000 });
    await page.locator(s.passwordSelector).fill(password);
    await page.locator(s.submitSelector).click();
    const deadline = Date.now() + 60_000;
    while (!(await signedIn(context, s.checkUrl))) {
      if (Date.now() > deadline) throw new Error(`logging in to ${target.label} didn't give a valid session within a minute`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    mkdirSync(join(DATA, 'sessions'), { recursive: true });
    await context.storageState({ path: file });
    chmodSync(file, 0o600); // session cookies: owner only
    return file;
  } finally {
    await browser.close();
  }
}

async function signedIn(context: import('playwright').BrowserContext, checkUrl: string) {
  try {
    const response = await context.request.get(checkUrl);
    if (!response.ok()) return false;
    const body = await response.json();
    return typeof body.token === 'string' && body.token.length > 20;
  } catch {
    return false;
  }
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`no env file at ${path}`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
