// The agent's HTTP API (see agent/src/web/server.ts) and the shapes it returns.

export type Step = { act: string; narration: string };
export type Segment = { id: string; title: string; subtitle: string; tickets: string[]; steps: Step[]; assert?: string };
export type Plan = {
  product: string;
  title: string;
  summary: string;
  titleNarration: string;
  proves: { subtitle: string; cards: { title: string; text: string }[]; outcome: string; narration: string };
  segments: Segment[];
  close: { message: string; delivered: string; next: string; value: string; narration: string };
};
export type SegmentState = { status: 'pending' | 'rehearsing' | 'rehearsed' | 'failed'; error?: string };
export type Demo = {
  id: string;
  title: string;
  stage: string;
  message: string;
  error: string | null;
  problems: string[];
  input: { target: string; appUrl: string; tickets: string[] };
  tickets: { key: string; summary: string }[];
  plan: Plan | null;
  review: { gate: 'plan' | 'final' | null };
  segments: Record<string, SegmentState>;
  video: { file: string; seconds: number; at: number } | null;
  activity: { at: number; who: string; text: string }[];
  steps?: Partial<Record<string, StepStatus>>;
};
export type StepStatus = 'pending' | 'active' | 'waiting' | 'done' | 'failed';
export type Tunnel = { status: 'off' | 'starting' | 'on' | 'error'; url: string | null; shareUrl: string | null; allowedEmails: string[]; error: string | null; startedBy: string | null };
export type Thread = { id: number; title: string; demoId: string | null; createdAt: number; createdBy: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export const api = {
  threads: () => call<Thread[]>('GET', '/api/threads'),
  newThread: (by: string) => call<{ id: number }>('POST', '/api/threads', { by }),
  send: (thread: number, by: string, text: string) => call('POST', `/api/threads/${thread}/messages`, { by, text }),
  stop: (thread: number) => call('POST', `/api/threads/${thread}/stop`),
  tunnel: () => call<Tunnel>('GET', '/api/tunnel'),
  startTunnel: (by: string, allowedEmails: string) => call<Tunnel>('POST', '/api/tunnel', { by, allowedEmails }),
  stopTunnel: () => call<Tunnel>('DELETE', '/api/tunnel'),
  deleteThread: (thread: number) => call('DELETE', `/api/threads/${thread}`),
  savePlan: (demo: string, by: string, plan: Plan) => call('PUT', `/api/demos/${demo}/plan`, { by, plan }),
  decide: (demo: string, by: string, decision: 'approve' | 'rebuild' | 'revise', feedback = '') =>
    call('POST', `/api/demos/${demo}/decision`, { by, decision, feedback }),
};
