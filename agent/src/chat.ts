// The chat agent: one Pi Durable conversation per thread, on the text model, with tools that
// start a demo, read it, edit its plan and decide at its gates. Everyone viewing a thread sees
// the same conversation live; it survives restarts like the pipeline does.
//
// Pipeline events reach the agent as messages: when a demo's document gets a new notice (a
// gate, a failure, done), the notifier submits "[pipeline] …" to the demo's thread, with a
// request ID that makes it happen once even across restarts.
import { BACKGROUND_CONTEXT as ctx, type Context } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineExtension, defineTool, type ConversationId, type Harness, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { MODEL } from './config.ts';
import { createDemo, deleteDemo, newDemoId } from './demos.ts';
import { DemoDoc, DemoIndex, log, type Decision, type Demo, type DemoSeed, type Plan } from './doc.ts';
import { lint } from './stages/plan.ts';
import { listTargets } from './targets.ts';

export type Thread = { id: number; title: string; demoId: string | null; createdAt: number; createdBy: string; lastBy: string };

export const ThreadIndex = defineDoc<{ threads: Thread[] }>({
  kind: 'chat.threads',
  version: 1,
  scope: 'session',
  initial: () => ({ threads: [] }),
  checkpointWhen: () => false,
});

const INSTRUCTIONS = `You are the sprint demo agent. You turn Jira tickets into a narrated demo video of the real app,
and you work with the people in this chat to get it right.

How a demo is made (a durable pipeline you drive with tools):
1. plan: you read the tickets and the app's start page and write a plan: a title card, a "what this demo proves"
   slide, one segment per feature (plain-English steps a vision model performs in the app, each with one narration
   sentence), and a closing card.
2. review gate: people check the plan. Edits go through edit_plan; "approve" moves on; "revise" rewrites the plan
   with their feedback.
3. rehearse: each segment is performed once in the app and cached. A failed step comes back to the review gate.
4. voice, take, render: the voice-over is generated, each segment is recorded with its actions on the narration's
   cues, and the slides and recordings are joined into a video.
5. final gate: people watch the video and approve it, rebuild after edits, or ask for changes.

Messages from people start with their name in brackets, like "[Wilson] make the intro shorter". Messages starting
with "[pipeline]" are events from the pipeline, not from a person.

How to behave:
- Keep replies short and plain. Use short bullet lists. No headings for small replies.
- Start a demo only when someone gives you tickets (and an environment, or there's only one). Use list_environments
  to see the environments.
- When the plan reaches review: call get_demo, summarise each segment in one line, then list risks: steps that
  create, change or delete data in the app; steps that name pages or buttons the start page doesn't show; narration
  that doesn't match its step; problems the pipeline found. Then ask what to change or whether to approve.
- Make the edits people ask for with edit_plan, then say what you changed in a line or two.
- Call decide only when a person clearly asks for that decision (approve, rebuild or revise). Never approve on your
  own, and never because a [pipeline] message arrived.
- When a rehearsal or a take fails, say which part failed and propose the matching fix, then wait for the person:
  - "Step N (...) ..." failed: reword that step to name what's on screen (edit segments.<id>.steps.<n>.act).
  - "The end check (...) failed": the steps worked; the segment's assert claims something one screenshot can't show
    or that isn't true. Edit segments.<id>.assert to state only what's visible.
  - "Rehearsed fine, but replaying it without the model failed": the rehearsal worked; the no-model replay didn't
    (often the page was still loading). Say so plainly; approving again retries it.
  Don't reword a step whose problem is the end check.
- When the video is ready, say how long it is and ask them to watch it in the panel on the right.`;

function threadOf(threads: Thread[], id: ConversationId) {
  return threads.find((t) => t.id === (id as unknown as number));
}

async function demoOfThread(api: ToolExecutionApi, context: Context): Promise<{ thread: Thread; demo: Demo | null }> {
  const index = await api.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(ThreadIndex))) as { threads: Thread[] }, context);
  const thread = threadOf(index.threads, api.conversationId);
  if (!thread) throw new Error('this conversation is not a demo thread');
  if (!thread.demoId) return { thread, demo: null };
  const demo = await api.commit(async (tx) => {
    const d = await tx.doc(DemoDoc, thread.demoId!, { id: thread.demoId!, title: '', createdBy: '', input: {} as DemoSeed['input'] });
    return JSON.parse(JSON.stringify(d)) as Demo;
  }, context);
  return { thread, demo };
}

const text = (s: string) => ({ output: [{ type: 'text' as const, text: s }] });

const listEnvironments = defineTool({
  name: 'list_environments',
  description: 'List the environments a demo can be recorded against (from the agent host).',
  parameters: Type.Object({}),
  execute: async () => text(JSON.stringify(listTargets().map((t) => ({ id: t.id, label: t.label, url: t.appUrl })))),
});

const startDemo = defineTool({
  name: 'start_demo',
  description: 'Start a demo in this thread for the given Jira tickets and environment. Only one demo per thread.',
  parameters: Type.Object({
    title: Type.String({ description: 'Short title, e.g. the feature name' }),
    tickets: Type.Array(Type.String(), { description: 'Jira keys, e.g. ["PROJ-123"]' }),
    environment: Type.String({ description: 'An environment id from list_environments' }),
    audience: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String({ description: 'What to show or not claim, from the people in the chat' })),
  }),
  execute: async (args, api, context) => {
    const id = newDemoId(args.title);
    await api.commit(async (tx) => {
      const index = await tx.doc(ThreadIndex);
      const thread = threadOf(index.threads, api.conversationId);
      if (!thread) throw new Error('this conversation is not a demo thread');
      if (thread.demoId) throw new Error(`this thread already has a demo (${thread.demoId})`);
      await createDemo(tx, id, { title: args.title, tickets: args.tickets, target: args.environment, audience: args.audience, notes: args.notes, by: thread.lastBy || 'agent', conversationId: api.conversationId });
      thread.demoId = id;
      thread.title = args.title;
    }, context);
    return text(`Started demo ${id}. The plan comes back for review in about a minute.`);
  },
});

const getDemo = defineTool({
  name: 'get_demo',
  description: "Read this thread's demo: stage, gate, problems, error, the plan, rehearsal status per segment, the video.",
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const { demo } = await demoOfThread(api, context);
    if (!demo) return text('No demo in this thread yet.');
    const { stage, message, error, problems, review, plan, segments, video, input, tickets } = demo;
    return text(JSON.stringify({ stage, message, gate: review.gate, error, problems, environment: input.target, tickets: tickets.map((t) => `${t.key}: ${t.summary}`), plan, segments, video }));
  },
});

const editPlan = defineTool({
  name: 'edit_plan',
  description: `Edit this thread's plan while it waits at a gate. Each change sets one text field by its path in the plan,
e.g. "titleNarration", "proves.cards.1.text", "close.message", "segments.<id>.subtitle",
"segments.<id>.steps.<n>.act", "segments.<id>.steps.<n>.narration" (steps count from 0). To replace a segment's
steps (add, remove, reorder), use set_steps instead.`,
  parameters: Type.Object({
    changes: Type.Array(Type.Object({ path: Type.String(), value: Type.String() })),
    setSteps: Type.Optional(Type.Object({
      segment: Type.String({ description: 'segment id' }),
      steps: Type.Array(Type.Object({ act: Type.String(), narration: Type.String() })),
    })),
  }),
  execute: async (args, api, context) => {
    const { thread, demo } = await demoOfThread(api, context);
    if (!demo?.plan) throw new Error('there is no plan to edit yet');
    if (!demo.review.gate) throw new Error('the pipeline is running; the plan can only be edited at a gate');
    const plan = demo.plan;
    for (const { path, value } of args.changes) setPath(plan, path, value);
    if (args.setSteps) {
      const segment = plan.segments.find((s) => s.id === args.setSteps!.segment);
      if (!segment) throw new Error(`no segment "${args.setSteps.segment}"`);
      segment.steps = args.setSteps.steps;
    }
    const problems = lint(plan);
    await api.commit(async (tx) => {
      const d = await tx.doc(DemoDoc, demo.id, { id: demo.id, title: demo.title, createdBy: demo.createdBy, input: demo.input });
      d.plan = plan;
      d.problems = problems;
      log(d, thread.lastBy || 'agent', `Edited the plan: ${[...args.changes.map((c) => c.path), ...(args.setSteps ? [`steps of ${args.setSteps.segment}`] : [])].join(', ')}`);
    }, context);
    return text(`Saved. ${problems.length ? `Problems now: ${problems.join('; ')}` : 'No problems found.'}`);
  },
});

const decide = defineTool({
  name: 'decide',
  description: 'Record a person\'s decision at the gate: "approve" (plan: rehearse and record; video: done), "rebuild" (video gate: redo what the edits changed), or "revise" (rewrite the plan with feedback). Only when a person asks for it.',
  parameters: Type.Object({
    decision: Type.Union([Type.Literal('approve'), Type.Literal('rebuild'), Type.Literal('revise')]),
    feedback: Type.Optional(Type.String()),
  }),
  execute: async (args, api, context) => {
    const { thread, demo } = await demoOfThread(api, context);
    if (!demo?.review.gate) throw new Error('nothing is waiting for a decision');
    if (args.decision === 'rebuild' && demo.review.gate !== 'final') throw new Error('rebuild is for the video gate; at plan review, approve');
    await api.commit(async (tx) => {
      const d = await tx.doc(DemoDoc, demo.id, { id: demo.id, title: demo.title, createdBy: demo.createdBy, input: demo.input });
      d.review = { ...d.review, decision: args.decision as Decision, feedback: args.feedback ?? '', by: thread.lastBy || 'agent', at: Date.now() };
    }, context);
    return text(`Recorded "${args.decision}" for the ${demo.review.gate} gate.`);
  },
});

// Sets a text field of the plan by a dotted path. Segment ids or indexes both work.
function setPath(plan: Plan, path: string, value: string) {
  const keys = path.split('.');
  let node: Record<string, unknown> | unknown[] = plan as unknown as Record<string, unknown>;
  for (const [i, key] of keys.entries()) {
    const last = i === keys.length - 1;
    let k: string | number = key;
    if (Array.isArray(node)) {
      k = /^\d+$/.test(key) ? Number(key) : node.findIndex((x) => (x as { id?: string }).id === key);
      if (k < 0 || k >= node.length) throw new Error(`"${path}": no "${key}"`);
    } else if (!(key in node)) throw new Error(`"${path}": no "${key}"`);
    if (last) {
      const current = (node as Record<string | number, unknown>)[k];
      if (typeof current !== 'string') throw new Error(`"${path}" is not a text field`);
      (node as Record<string | number, unknown>)[k] = value;
    } else node = (node as Record<string | number, unknown>)[k] as Record<string, unknown>;
  }
}

export const chatExtension = defineExtension({ name: 'sprint-demo-chat', tools: [listEnvironments, startDemo, getDemo, editPlan, decide] });

const agentChange = () => ({
  model: { provider: MODEL.provider, modelId: MODEL.id },
  thinkingLevel: 'low' as const,
  extensions: [chatExtension],
  instructions: INSTRUCTIONS,
});

// Threads store their agent settings when created; bring them all up to date on startup so
// changed instructions or models reach existing threads.
export async function refreshThreads(harness: Harness) {
  for (const t of (await harness.snapshot(ThreadIndex, ctx))?.threads ?? []) {
    const conversation = await harness.conversation(t.id as unknown as ConversationId, ctx);
    await conversation?.configure(agentChange(), ctx);
  }
}

export async function createThread(harness: Harness, by: string) {
  const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: agentChange() }, ctx);
  await harness.commit(async (tx) => {
    (await tx.doc(ThreadIndex)).threads.push({ id: conversation.id as unknown as number, title: 'New demo', demoId: null, createdAt: Date.now(), createdBy: by, lastBy: by });
  }, ctx);
  return conversation.id as unknown as number;
}

// Deletes a thread with its demo and the demo's files. The conversation's transcript stays in
// the database (Pi Durable has no delete), but nothing lists or reaches it any more.
export async function deleteThread(harness: Harness, threadId: number) {
  const thread = (await harness.snapshot(ThreadIndex, ctx))?.threads.find((t) => t.id === threadId);
  if (!thread) throw new Error('no such thread');
  const conversation = await harness.conversation(threadId as unknown as ConversationId, ctx);
  await conversation?.abort(ctx).catch(() => {});
  if (thread.demoId) await deleteDemo(harness, thread.demoId);
  await harness.commit(async (tx) => {
    const index = await tx.doc(ThreadIndex);
    index.threads = index.threads.filter((t) => t.id !== threadId);
  }, ctx);
}

export async function postMessage(harness: Harness, threadId: number, by: string, content: string) {
  const conversation = await harness.conversation(threadId as unknown as ConversationId, ctx);
  if (!conversation) throw new Error('no such thread');
  await harness.commit(async (tx) => {
    const thread = threadOf((await tx.doc(ThreadIndex)).threads, conversation.id);
    if (thread) thread.lastBy = by;
  }, ctx);
  // A message sent while the agent works is taken in at its next step.
  await conversation.submit({ type: 'input', content: `[${by}] ${content}`, whenBusy: 'steer' }, ctx);
}

// Hands each demo's new notices to its thread, once (the request ID survives restarts).
export function startNotifier(harness: Harness) {
  const seen = new Map<string, number>();
  const tick = async () => {
    const index = await harness.snapshot(DemoIndex, ctx);
    for (const id of index?.ids ?? []) {
      const demo = (await harness.snapshot(DemoDoc, id, ctx)) as Demo | undefined;
      if (!demo?.conversationId || !demo.notice || seen.get(id) === demo.notice.seq) continue;
      const conversation = await harness.conversation(demo.conversationId as unknown as ConversationId, ctx);
      if (!conversation) continue;
      await conversation.submit({
        type: 'input',
        content: `[pipeline] ${demo.notice.text}`,
        whenBusy: 'followUp',
        requestId: `${id}:notice:${demo.notice.seq}`,
      }, ctx);
      seen.set(id, demo.notice.seq);
    }
  };
  const timer = setInterval(() => void tick().catch((e) => console.error('notifier:', e instanceof Error ? e.message : e)), 2000);
  return () => clearInterval(timer);
}
