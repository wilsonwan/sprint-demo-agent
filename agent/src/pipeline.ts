// The durable pipeline: one `demo.pipeline` task per demo, with a `demo.rehearse` child task
// per segment that needs rehearsing.
//
//   plan ─▶ review ─▶ rehearse ─▶ rehearsed ─▶ voice ─▶ take ─▶ render ─▶ final ─▶ done
//    ▲        │ revise                │ a step failed                       │ revise / rebuild
//    └────────┘◀──────────────────────┘◀─────────────────────────────────────┘
//
// `review` and `final` are human gates: the phase watches the demo document until someone
// decides on the web page. Every phase commits its next checkpoint together with the
// document change it reports, so a restart resumes at the phase that was running. Work in a
// phase is cached on disk (voice per slide, take per segment, rehearsal per step), so a phase
// that reruns after a crash or an edit redoes only what changed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import { defineExtension, defineTask, type TaskId, type TaskRuntime, type Tx } from '@earendil-works/pi-durable';
import { demoDir } from './config.ts';
import { DemoDoc, log, moveStage, notice, type Decision, type Demo, type DemoSeed, type Gate, type Segment } from './doc.ts';
import { midsceneEnv } from './models.ts';
import { checkTarget, expandUrl } from './guard.ts';
import { ensureSession, getTarget } from './targets.ts';
import { fetchTickets } from './stages/ingest.ts';
import { lint, writePlan } from './stages/plan.ts';
import { render, takeAll, voiceAll } from './stages/produce.ts';
import { cachedSteps, recorder } from './stages/record.ts';

type Input = { demoId: string; seed: DemoSeed };
type Checkpoint =
  | { phase: 'plan'; feedback: string }
  | { phase: 'review' }
  | { phase: 'rehearse' }
  | { phase: 'rehearsed'; children: TaskId<null>[] }
  | { phase: 'voice' }
  | { phase: 'take' }
  | { phase: 'render' }
  | { phase: 'final' };
type Result = { video: string | null };
type Runtime = TaskRuntime<Input, Checkpoint, Result, object>;
const AGENT = 'agent';

const demoOf = (tx: Tx, input: Input) => tx.doc(DemoDoc, input.demoId, input.seed);

async function read(runtime: { snapshot: TaskRuntime<unknown, { phase: string }, unknown, object>['snapshot'] }, input: Input, ctx: Context) {
  const demo = await runtime.snapshot(DemoDoc, input.demoId, ctx);
  if (!demo) throw new Error(`demo ${input.demoId} has no document`);
  return demo as Demo;
}

// Moves to `next`, reporting the stage on the document in the same commit.
async function advance(runtime: Runtime, input: Input, next: Checkpoint, stage: string, message: string, ctx: Context, edit?: (d: Demo) => void) {
  await runtime.commit(async (tx) => {
    const d = await demoOf(tx, input);
    edit?.(d);
    const failed = !!d.error || (d.stage === 'rehearse' && Object.values(d.segments).some((s) => s.status === 'failed'));
    moveStage(d, stage, failed);
    d.stage = stage;
    d.message = message;
    // Gates are where people come in: tell the chat agent.
    if (next.phase === 'review' || next.phase === 'final') notice(d, `${message}${d.error ? `. Error: ${d.error}` : ''}`);
    return { status: 'running', checkpoint: next };
  }, ctx);
}

// A recoverable failure: back to the plan gate with the error, so a person can fix and retry.
async function toReview(runtime: Runtime, input: Input, error: unknown, ctx: Context) {
  const message = error instanceof Error ? error.message : String(error);
  await advance(runtime, input, { phase: 'review' }, 'review', 'Needs a look: something failed', ctx, (d) => {
    d.error = message;
    log(d, AGENT, `Failed: ${message}`);
  });
}

// Waits for a person's decision at a gate, watching the document.
async function decision(runtime: Runtime, input: Input, gate: Gate, ctx: Context): Promise<{ decision: Decision; feedback: string; by: string }> {
  await runtime.commit(async (tx) => {
    const d = await demoOf(tx, input);
    if (d.review.gate !== gate) d.review = { gate, decision: null, feedback: '', by: '', at: 0 };
    return undefined;
  }, ctx);
  const watch = await runtime.watchDoc(DemoDoc, input.demoId, ctx);
  if (!watch) throw new Error('demo document is missing');
  try {
    return await new Promise((resolve, reject) => {
      const check = (d: Readonly<Demo> | null) => {
        if (d?.review.gate === gate && d.review.decision) resolve({ decision: d.review.decision, feedback: d.review.feedback, by: d.review.by });
      };
      runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason ?? new Error('aborted')), { once: true });
      check(watch.value);
      watch.start(async (d) => check(d));
    });
  } finally {
    await watch.stop();
  }
}

function clearGate(d: Demo, who: string, text: string) {
  d.review = { gate: null, decision: null, feedback: '', by: '', at: 0 };
  d.error = null;
  log(d, who, text);
}

// Whether a segment's rehearsal is still good: same steps, same app, every step cached.
function rehearsalHash(demo: Demo, s: Segment) {
  return createHash('sha256').update(JSON.stringify([demo.input.appUrl, demo.input.readyText, s.steps.map((st) => st.act), s.assert ?? ''])).digest('hex').slice(0, 16);
}
function needsRehearsal(demo: Demo, s: Segment) {
  const cached = cachedSteps(join(demoDir(demo.id), 'cache', `${s.id}.cache.yaml`));
  return demo.segments[s.id]?.rehearsedHash !== rehearsalHash(demo, s) || s.steps.some((st) => !cached.has(st.act));
}

// Where and as whom the browser opens the app. An environment from targets.json gets a saved
// session the agent keeps valid, logging in again when it has expired.
async function recorderEnv(demo: Demo) {
  checkTarget(demo.input.appUrl);
  const sessionFile = await ensureSession(getTarget(demo.input.target));
  return { appUrl: expandUrl(demo.input.appUrl), sessionFile };
}

export const Rehearse = defineTask<{ demoId: string; seed: DemoSeed; segmentId: string }, { phase: 'run' }, null>({
  name: 'demo.rehearse',
  version: 1,
  initial: () => ({ phase: 'run' }),
  phases: {
    run: async (task, runtime, ctx) => {
      const input = { demoId: task.input.demoId, seed: task.input.seed };
      const demo = await read(runtime, input, ctx);
      const segment = demo.plan?.segments.find((s) => s.id === task.input.segmentId);
      const setState = (state: Demo['segments'][string], text: string) =>
        runtime.commit(async (tx) => {
          const d = await demoOf(tx, input);
          d.segments[task.input.segmentId] = state;
          log(d, AGENT, text);
          return state.status === 'rehearsed'
            ? { status: 'terminal', outcome: { status: 'completed', result: null } }
            : state.status === 'failed'
              ? { status: 'terminal', outcome: { status: 'failed', error: { message: state.error ?? 'failed' } } }
              : undefined;
        }, ctx);
      if (!segment) return setState({ status: 'failed', error: 'segment no longer in the plan' }, `Rehearsal skipped: ${task.input.segmentId} is gone`);
      await setState({ status: 'rehearsing' }, `Rehearsing "${segment.title}"`);
      const dir = demoDir(demo.id);
      try {
        const spec = { id: segment.id, readyText: demo.input.readyText, steps: segment.steps.map((s) => ({ act: s.act })), assert: segment.assert, cacheDir: join(dir, 'cache'), outDir: join(dir, 'segments', segment.id) };
        const env = await recorderEnv(demo);
        await recorder('rehearse', spec, { ...env, model: await midsceneEnv(runtime.models) }, runtime.signal);
        // Replay it once without the model, so a step that can't be replayed fails here, not in the take.
        try {
          await recorder('verify', { ...spec, assert: undefined }, env, runtime.signal);
        } catch (error) {
          throw new Error(`Rehearsed fine, but replaying it without the model failed: ${error instanceof Error ? error.message : error}`);
        }
        await setState({ status: 'rehearsed', rehearsedHash: rehearsalHash(demo, segment) }, `Rehearsed "${segment.title}"`);
      } catch (error) {
        if (runtime.signal.aborted) throw error; // closing: rerun after restart
        const message = error instanceof Error ? error.message : String(error);
        await setState({ status: 'failed', error: message }, `Rehearsal of "${segment.title}" failed`);
      }
    },
  },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
});

export const Pipeline = defineTask<Input, Checkpoint, Result>({
  name: 'demo.pipeline',
  version: 1,
  initial: () => ({ phase: 'plan', feedback: '' }),
  phases: {
    plan: async (task, runtime, ctx) => {
      const input = task.input;
      await runtime.commit(async (tx) => {
        const d = await demoOf(tx, input);
        moveStage(d, 'plan');
        d.stage = 'plan';
        d.message = 'Reading the tickets and the app, then writing the plan';
        return undefined;
      }, ctx);
      try {
        let demo = await read(runtime, input, ctx);
        const tickets = await fetchTickets(demo.input.tickets);
        await runtime.commit(async (tx) => void ((await demoOf(tx, input)).tickets = tickets), ctx);
        const dir = demoDir(demo.id);
        let snapshot = '';
        const env = await recorderEnv(demo); // logs in first if the environment's session has expired
        try {
          await recorder('snapshot', { id: 'start', readyText: demo.input.readyText, steps: [], cacheDir: join(dir, 'cache'), outDir: join(dir, 'snapshot') }, env, runtime.signal);
          snapshot = readFileSync(join(dir, 'snapshot', 'snapshot.txt'), 'utf8');
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          snapshot = `(could not open the app: ${error instanceof Error ? error.message : error})`;
        }
        const appProblem = snapshot.startsWith('(could not open the app') ? [`Couldn't open the app while planning, so the steps are guesses: ${snapshot.slice(25, -1)}`] : [];
        demo = await read(runtime, input, ctx);
        const plan = await writePlan(runtime.models as Models, demo, snapshot, task.state.checkpoint.feedback, demo.id);
        const problems = [...appProblem, ...lint(plan)];
        await advance(runtime, input, { phase: 'review' }, 'review', problems.length ? 'Plan ready, with problems to fix' : 'Plan ready for review', ctx, (d) => {
          d.plan = plan;
          d.problems = problems;
          d.error = null;
          log(d, AGENT, `Wrote a plan with ${plan.segments.length} segment(s)${problems.length ? ` and ${problems.length} problem(s)` : ''}`);
        });
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        await toReview(runtime, input, error, ctx);
      }
    },

    review: async (task, runtime, ctx) => {
      const input = task.input;
      const { decision: choice, feedback, by } = await decision(runtime, input, 'plan', ctx);
      const demo = await read(runtime, input, ctx);
      if (choice === 'revise' || !demo.plan) {
        await advance(runtime, input, { phase: 'plan', feedback }, 'plan', 'Revising the plan', ctx, (d) => clearGate(d, by, feedback ? `Asked for changes: ${feedback}` : 'Asked to try again'));
        return;
      }
      await advance(runtime, input, { phase: 'rehearse' }, 'rehearse', 'Rehearsing the segments in the app', ctx, (d) => {
        d.problems = lint(d.plan!);
        clearGate(d, by, 'Approved the plan');
      });
    },

    rehearse: async (task, runtime, ctx) => {
      const input = task.input;
      const demo = await read(runtime, input, ctx);
      const todo = demo.plan!.segments.filter((s) => needsRehearsal(demo, s));
      if (!todo.length) return advance(runtime, input, { phase: 'voice' }, 'voice', 'Recording the voice-over', ctx);
      await runtime.commit(async (tx) => {
        const d = await demoOf(tx, input);
        const children: TaskId<null>[] = [];
        for (const s of todo) {
          d.segments[s.id] = { status: 'pending' };
          children.push(await tx.createTask(Rehearse, { ...input, segmentId: s.id }, { ownership: { kind: 'task', taskId: task.id } }));
        }
        d.message = `Rehearsing ${todo.length} segment(s) in the app`;
        return { status: 'waiting', checkpoint: { phase: 'rehearsed', children }, on: children, policy: 'allSettled' };
      }, ctx);
    },

    rehearsed: async (task, runtime, ctx) => {
      const input = task.input;
      const outcomes = await runtime.outcomes(task.state.checkpoint.children, ctx);
      const failed = outcomes.filter((o) => o.status !== 'completed');
      if (failed.length) {
        await advance(runtime, input, { phase: 'review' }, 'review', `${failed.length} segment(s) failed rehearsal: edit their steps, then approve`, ctx, (d) => {
          d.problems = Object.entries(d.segments).filter(([, s]) => s.status === 'failed').map(([id, s]) => `Rehearsal of ${id} failed: ${s.error}`);
        });
        return;
      }
      await advance(runtime, input, { phase: 'voice' }, 'voice', 'Recording the voice-over', ctx);
    },

    voice: async (task, runtime, ctx) => {
      const demo = await read(runtime, task.input, ctx);
      try {
        await voiceAll(demoDir(demo.id), demo.plan!, runtime.signal);
        await advance(runtime, task.input, { phase: 'take' }, 'take', 'Recording the takes', ctx, (d) => log(d, AGENT, 'Voice-over ready'));
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        await toReview(runtime, task.input, error, ctx);
      }
    },

    take: async (task, runtime, ctx) => {
      const demo = await read(runtime, task.input, ctx);
      try {
        await takeAll(demoDir(demo.id), demo.plan!, await recorderEnv(demo), demo.input.readyText, runtime.signal);
        await advance(runtime, task.input, { phase: 'render' }, 'render', 'Rendering the video', ctx, (d) => log(d, AGENT, 'Takes recorded'));
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        // A take that calls the model means the cache is stale: rehearse again.
        await advance(runtime, task.input, { phase: 'review' }, 'review', 'A take failed', ctx, (d) => {
          d.error = error instanceof Error ? error.message : String(error);
          for (const s of d.plan!.segments) delete d.segments[s.id]?.rehearsedHash;
        });
      }
    },

    render: async (task, runtime, ctx) => {
      const demo = await read(runtime, task.input, ctx);
      try {
        const seconds = await render(demoDir(demo.id), demo.plan!, runtime.signal);
        await advance(runtime, task.input, { phase: 'final' }, 'final', 'Video ready for review', ctx, (d) => {
          d.video = { file: 'demo.mp4', seconds: Math.round(seconds * 10) / 10, at: Date.now() };
          log(d, AGENT, `Rendered demo.mp4 (${seconds.toFixed(1)} s)`);
        });
      } catch (error) {
        if (runtime.signal.aborted) throw error;
        await toReview(runtime, task.input, error, ctx);
      }
    },

    final: async (task, runtime, ctx) => {
      const input = task.input;
      const { decision: choice, feedback, by } = await decision(runtime, input, 'final', ctx);
      if (choice === 'revise') {
        await advance(runtime, input, { phase: 'plan', feedback }, 'plan', 'Revising the plan', ctx, (d) => clearGate(d, by, `Asked for changes: ${feedback}`));
      } else if (choice === 'rebuild') {
        await advance(runtime, input, { phase: 'rehearse' }, 'rehearse', 'Rebuilding with the edits', ctx, (d) => clearGate(d, by, 'Rebuilt with edits'));
      } else {
        await runtime.commit(async (tx) => {
          const d = await demoOf(tx, input);
          moveStage(d, 'done');
          d.stage = 'done';
          d.message = 'Approved';
          clearGate(d, by, 'Approved the video');
          notice(d, 'The video was approved; the demo is done');
          return { status: 'terminal', outcome: { status: 'completed', result: { video: d.video ? join(demoDir(d.id), d.video.file) : null } } };
        }, ctx);
      }
    },
  },
  abort: (task, runtime, ctx) =>
    runtime.commit(async (tx) => {
      const d = await demoOf(tx, task.input);
      d.stage = 'stopped';
      d.message = 'Stopped';
      return { status: 'terminal', outcome: { status: 'aborted' } };
    }, ctx),
});

export const demoExtension = defineExtension({ name: 'sprint-demo', tasks: [Pipeline, Rehearse] });
