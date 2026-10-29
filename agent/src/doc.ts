import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';

// One document per demo: the shared state people (through the web app and the chat agent) and
// the pipeline both edit, in commits. No secrets: logins stay with the environment on the host.

export type Ticket = { key: string; summary: string; description: string; acceptance: string[] };
export type Step = { act: string; narration: string };
export type Segment = {
  id: string;
  title: string; // "Step 1: …"
  subtitle: string;
  tickets: string[];
  steps: Step[];
  assert?: string;
};
export type Plan = {
  product: string;
  title: string;
  summary: string;
  tags: string[];
  stats: { value: string; label: string }[];
  titleNarration: string;
  proves: { subtitle: string; cards: { title: string; text: string }[]; outcome: string; narration: string };
  segments: Segment[];
  close: { message: string; delivered: string; next: string; value: string; narration: string };
};
export type Gate = 'plan' | 'final';
export type Decision = 'approve' | 'revise' | 'rebuild';
export type SegmentState = { status: 'pending' | 'rehearsing' | 'rehearsed' | 'failed'; error?: string; rehearsedHash?: string };

export type Demo = {
  id: string;
  title: string;
  createdAt: number;
  createdBy: string;
  input: {
    target: string; // an environment from targets.json (its URL and login)
    appUrl: string; // may hold ${VAR} placeholders, filled from the environment
    readyText: string; // text on the start page once the app has loaded
    tickets: string[];
    audience: string;
    notes: string;
  };
  stage: string;
  message: string;
  error: string | null;
  tickets: Ticket[];
  plan: Plan | null;
  problems: string[];
  review: { gate: Gate | null; decision: Decision | null; feedback: string; by: string; at: number };
  segments: Record<string, SegmentState>;
  video: { file: string; seconds: number; at: number } | null;
  activity: { at: number; who: string; text: string }[];
  conversationId?: number | null; // the chat thread (a Pi Durable conversation) this demo belongs to
  notice?: { seq: number; text: string } | null; // the latest event the chat agent should hear about
  steps?: Partial<Record<Stage, StepStatus>>; // each pipeline stage's status, for the progress list
};

export const STAGES = ['plan', 'review', 'rehearse', 'voice', 'take', 'render', 'final'] as const;
export type Stage = (typeof STAGES)[number];
export type StepStatus = 'pending' | 'active' | 'waiting' | 'done' | 'failed';

// Moves the progress list from one stage to the next. Forward: what was passed is done. Back
// after a failure: the stage that failed says so, the rest stay. Back on purpose (revise,
// rebuild): everything after the stage returned to starts over.
export function moveStage(demo: Demo, to: string, failed = false) {
  const from = demo.stage;
  const steps = (demo.steps ??= {});
  const i = STAGES.indexOf(from as Stage);
  const j = STAGES.indexOf(to as Stage);
  if (to === 'done') {
    for (const s of STAGES) steps[s] = 'done';
    return;
  }
  if (i >= 0 && from !== to) steps[from as Stage] = failed ? 'failed' : 'done';
  if (j < 0) return;
  if (i >= 0 && j > i) for (const s of STAGES.slice(i + 1, j)) steps[s] = 'done';
  if (j <= i && !failed) for (const s of STAGES.slice(j + 1)) steps[s] = 'pending';
  steps[to as Stage] = to === 'review' || to === 'final' ? 'waiting' : 'active';
}

export type DemoSeed = { id: string; title: string; createdBy: string; input: Demo['input'] };

export const DemoDoc = defineDocFamily<Demo, DemoSeed>({
  kind: 'demo',
  version: 1,
  scope: 'session',
  family: true,
  initial: (seed) => ({
    id: seed.id,
    title: seed.title,
    createdAt: Date.now(),
    createdBy: seed.createdBy,
    input: seed.input,
    stage: 'queued',
    message: 'Waiting to start',
    error: null,
    tickets: [],
    plan: null,
    problems: [],
    review: { gate: null, decision: null, feedback: '', by: '', at: 0 },
    segments: {},
    video: null,
    activity: [],
    conversationId: null,
    notice: null,
  }),
  checkpointWhen: () => false,
});

// The list of demos, newest last.
export const DemoIndex = defineDoc<{ ids: string[] }>({
  kind: 'demo.index',
  version: 1,
  scope: 'session',
  initial: () => ({ ids: [] }),
  checkpointWhen: () => false,
});

// Something the chat agent should hear about (a gate, a failure, done); see chat.ts.
export function notice(demo: Demo, text: string) {
  demo.notice = { seq: (demo.notice?.seq ?? 0) + 1, text };
}

export function log(demo: Demo, who: string, text: string) {
  demo.activity.push({ at: Date.now(), who, text });
  if (demo.activity.length > 200) demo.activity.splice(0, demo.activity.length - 200);
}
