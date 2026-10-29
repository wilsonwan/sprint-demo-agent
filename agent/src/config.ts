import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Everything the agent keeps (SQLite, demo work files, browser sessions) lives under the data dir.
export const ROOT = resolve(new URL('..', import.meta.url).pathname);
export const DATA = resolve(process.env.DEMO_DATA ?? join(ROOT, 'data'));
export const DB_PATH = join(DATA, 'agent.sqlite');
export const CREDENTIALS_OVERLAY = join(DATA, 'credentials.json');
export const demoDir = (id: string) => join(DATA, 'demos', id);
mkdirSync(join(DATA, 'demos'), { recursive: true });

// The models the agent uses, through the host's Pi logins (GitHub Copilot by default; any pi-ai
// provider): one for the plan, narration and chat, one that sees screenshots for Midscene
// rehearsals, which must speak the OpenAI API (Midscene's client). Through Copilot, gpt-6-luna
// hangs on some rehearsal requests; gpt-5.6-luna doesn't.
export const MODEL = {
  provider: process.env.DEMO_PROVIDER ?? 'github-copilot',
  id: process.env.DEMO_MODEL ?? 'gpt-6-luna',
  visionProvider: process.env.DEMO_VISION_PROVIDER ?? process.env.DEMO_PROVIDER ?? 'github-copilot',
  visionId: process.env.DEMO_VISION_MODEL ?? 'gpt-5.6-luna',
};

// Pi's logins on this host, read-only. The first that exists is used.
export const PI_AUTH_PATHS = [
  process.env.PI_AUTH_PATH,
  join(homedir(), '.pi/agent/auth.json'),
].filter((p): p is string => !!p);

// Never record against these hosts (production).
export const BLOCKED_HOSTS = (process.env.DEMO_BLOCKED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);

export const KOKORO_VOICE = process.env.DEMO_KOKORO_VOICE ?? 'af_heart';
export const JIRA = {
  baseUrl: process.env.JIRA_BASE_URL,
  email: process.env.JIRA_EMAIL, // Jira Cloud: email + API token; Server/DC: token alone (PAT)
  token: process.env.JIRA_API_TOKEN,
};
