import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { ConversationId, Harness, TaskId, Tx } from '@earendil-works/pi-durable';
import { demoDir } from './config.ts';
import { DemoDoc, DemoIndex, log, type Demo, type DemoSeed } from './doc.ts';
import { Pipeline } from './pipeline.ts';
import { checkTarget } from './guard.ts';
import { getTarget } from './targets.ts';

export type NewDemo = {
  title: string;
  tickets: string[];
  by: string;
  target: string; // an environment from targets.json
  audience?: string;
  notes?: string;
  conversationId?: ConversationId | null;
};

export function newDemoId(title: string) {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'demo'}-${randomBytes(2).toString('hex')}`;
}

// Creates a demo's document and starts its pipeline, in one commit.
export async function createDemo(tx: Tx, id: string, d: NewDemo) {
  const target = getTarget(d.target);
  if (!d.tickets.length) throw new Error('A demo needs at least one ticket');
  const seed: DemoSeed = {
    id,
    title: d.title,
    createdBy: d.by,
    input: {
      target: target.id,
      appUrl: target.appUrl,
      readyText: target.readyText ?? '',
      tickets: d.tickets,
      audience: d.audience ?? '',
      notes: d.notes ?? '',
    },
  };
  checkTarget(seed.input.appUrl);
  const doc = await tx.doc(DemoDoc, id, seed);
  doc.conversationId = d.conversationId ?? null;
  log(doc, d.by, `Started the demo for ${d.tickets.join(', ')}`);
  (await tx.doc(DemoIndex)).ids.push(id);
  await tx.createTask(Pipeline, { demoId: id, seed }, { ownership: { kind: 'conversation' }, ...(d.conversationId && { conversationId: d.conversationId }) });
  return seed;
}

// Deletes a demo and everything it made: stops its pipeline (and the rehearsals it owns) and
// waits for that, since the pipeline's abort handler writes to the document; then retires the
// document, drops it from the index and deletes its files.
export async function deleteDemo(harness: Harness, id: string) {
  const demo = (await harness.snapshot(DemoDoc, id, ctx)) as Demo | undefined;
  const { tasks } = await harness.inspect(ctx);
  const pipelines = tasks.filter((t) => t.record.kind === 'demo.pipeline' && (t.record.input as { demoId?: string } | null)?.demoId === id);
  for (const t of pipelines) {
    const taskId = t.record.id as TaskId;
    await harness.abortTask(taskId, ctx);
    await Promise.race([harness.waitForTask(taskId, ctx), new Promise((r) => setTimeout(r, 30_000))]);
  }
  await harness.commit(async (tx) => {
    const index = await tx.doc(DemoIndex);
    index.ids = index.ids.filter((x) => x !== id);
    if (demo) await tx.retireDoc(DemoDoc, id);
  }, ctx);
  rmSync(demoDir(id), { recursive: true, force: true });
}
