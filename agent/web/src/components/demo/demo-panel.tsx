import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { TabItem, TabPanel, Tabs, TabsList } from '@/components/ui/tabs';
import { api, type Demo, type StepStatus } from '@/lib/api';
import { useIcons } from '@/lib/icon-context';
import { PlanEditor } from './plan-editor';

const STAGES: { id: string; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'review', label: 'Plan review' },
  { id: 'rehearse', label: 'Rehearse in the app' },
  { id: 'voice', label: 'Voice-over' },
  { id: 'take', label: 'Record' },
  { id: 'render', label: 'Render' },
  { id: 'final', label: 'Video review' },
];

export function stageColor(stage: string) {
  return stage === 'done' ? 'green' : stage === 'review' || stage === 'final' ? 'amber' : stage === 'stopped' ? 'red' : 'blue';
}

// Each stage's status: from the pipeline when it recorded one, else worked out from the stage.
function statusOf(demo: Demo, id: string, i: number): StepStatus {
  const recorded = demo.steps?.[id];
  if (recorded) return recorded;
  const at = demo.stage === 'done' ? STAGES.length : STAGES.findIndex((s) => s.id === demo.stage);
  return i < at ? 'done' : i === at ? (id === 'review' || id === 'final' ? 'waiting' : 'active') : 'pending';
}

function StepIcon({ status }: { status: StepStatus }) {
  const icons = useIcons();
  const box = 'flex size-5 shrink-0 items-center justify-center rounded-full';
  if (status === 'done') {
    const Check = icons.check;
    return <span className={`${box} bg-emerald-500 text-white`}><Check className="size-3" /></span>;
  }
  if (status === 'failed') {
    const X = icons.x;
    return <span className={`${box} bg-red-500 text-white`}><X className="size-3" /></span>;
  }
  if (status === 'active') {
    const Loader = icons.loader;
    return <span className={`${box} text-[color:var(--fluid-accent)]`}><Loader className="size-4 animate-spin" /></span>;
  }
  if (status === 'waiting') return <span className={`${box} border-2 border-amber-500 bg-amber-500/15`} />;
  return <span className={`${box} border border-border`} />;
}

const STATUS_TEXT: Record<StepStatus, string> = { pending: '', active: 'Running', waiting: 'Waiting for you', done: '', failed: 'Failed' };

const BAR: Record<StepStatus, string> = {
  done: 'bg-emerald-500',
  active: 'bg-[color:var(--fluid-accent)] animate-pulse',
  waiting: 'bg-amber-500',
  failed: 'bg-red-500',
  pending: 'bg-border',
};

// One line: a bar per stage and where the demo is. "Details" opens the full list.
function Progress({ demo }: { demo: Demo }) {
  const [open, setOpen] = useState(false);
  const statuses = STAGES.map((s, i) => statusOf(demo, s.id, i));
  const current = demo.stage === 'done' ? -1 : STAGES.findIndex((s) => s.id === demo.stage);
  const failed = STAGES.find((_, i) => statuses[i] === 'failed');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1" aria-hidden>
        {STAGES.map((s, i) => (
          <span key={s.id} title={`${s.label}: ${statuses[i]}`} className={`h-1.5 flex-1 rounded-full ${BAR[statuses[i]]}`} />
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{demo.stage === 'done' ? 'Done' : (STAGES[current]?.label ?? demo.stage)}</span>
        <span className="truncate text-muted-foreground">{demo.message}</span>
        <button type="button" className="ml-auto shrink-0 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
          {open ? 'Hide steps' : 'Steps'}
        </button>
      </div>
      {failed && !open && <p className="text-xs text-red-500">{failed.label} failed last time</p>}
      {open && <StageList demo={demo} />}
    </div>
  );
}

function StageList({ demo }: { demo: Demo }) {
  const segments = demo.plan?.segments ?? [];
  return (
    <ol className="flex flex-col pt-1">
      {STAGES.map((s, i) => {
        const status = statusOf(demo, s.id, i);
        const last = i === STAGES.length - 1;
        const detail =
          s.id === 'rehearse' && segments.length && status !== 'pending'
            ? segments.map((seg) => `${seg.id}: ${demo.segments[seg.id]?.status ?? 'pending'}`).join(' · ')
            : '';
        return (
          <li key={s.id} className="grid grid-cols-[1.25rem_1fr] gap-x-3">
            <div className="flex flex-col items-center">
              <StepIcon status={status} />
              {!last && <span className={`w-px flex-1 ${status === 'done' ? 'bg-emerald-500/50' : 'bg-border'}`} />}
            </div>
            <div className={`pb-3 ${status === 'pending' ? 'text-muted-foreground' : ''}`}>
              <div className="flex items-baseline gap-2 text-sm">
                <span className={status === 'active' || status === 'waiting' ? 'font-medium' : ''}>{s.label}</span>
                {STATUS_TEXT[status] && (
                  <span className={`text-xs ${status === 'failed' ? 'text-red-500' : status === 'waiting' ? 'text-amber-600' : 'text-muted-foreground'}`}>
                    {STATUS_TEXT[status]}
                  </span>
                )}
              </div>
              {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Timeline({ demo }: { demo: Demo }) {
  if (!demo.activity.length) return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  return (
    <ol className="flex flex-col">
      {demo.activity.map((a, i) => {
        const last = i === demo.activity.length - 1;
        const agent = a.who === 'agent';
        return (
          <li key={i} className="grid grid-cols-[0.75rem_1fr] gap-x-3">
            <div className="flex flex-col items-center pt-1.5">
              <span className={`size-2 shrink-0 rounded-full ${agent ? 'bg-[color:var(--fluid-accent)]' : 'bg-amber-500'}`} />
              {!last && <span className="mt-1 w-px flex-1 bg-border" />}
            </div>
            <div className="pb-3 text-sm">
              <p>
                <span className="font-medium">{agent ? 'Agent' : a.who}</span> <span className="text-muted-foreground">{a.text}</span>
              </p>
              <p className="text-xs text-muted-foreground">{new Date(a.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' })}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Gate({ demo, by, onEdit }: { demo: Demo; by: string; onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decide = async (decision: 'approve' | 'rebuild') => {
    setBusy(true);
    setError('');
    try {
      await api.decide(demo.id, by, decision);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const final = demo.review.gate === 'final';
  return (
    <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-500/30 dark:bg-amber-500/5">
      <p className="text-sm font-medium">{final ? 'The video is ready for review' : 'The plan is waiting for review'}</p>
      <p className="text-xs text-muted-foreground">Ask the agent in the chat, edit the plan yourself, or decide here.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="compact" disabled={busy || !by || (!final && !demo.plan)} onClick={() => decide('approve')}>
          {final ? 'Approve video' : 'Approve and record'}
        </Button>
        {final && (
          <Button size="compact" variant="secondary" disabled={busy || !by} onClick={() => decide('rebuild')}>
            Rebuild with edits
          </Button>
        )}
        {demo.plan && (
          <Button size="compact" variant="ghost" onClick={onEdit}>
            Edit plan
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

function PlanView({ demo, onEdit }: { demo: Demo; onEdit: () => void }) {
  const plan = demo.plan;
  if (!plan) return <p className="text-sm text-muted-foreground">The plan isn't written yet.</p>;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{plan.title}</p>
          <p className="text-muted-foreground">{plan.summary}</p>
        </div>
        <Button size="compact" variant="secondary" onClick={onEdit}>
          {demo.review.gate ? 'Edit' : 'View all'}
        </Button>
      </div>
      {plan.segments.map((s) => {
        const state = demo.segments[s.id];
        return (
          <div key={s.id} className="rounded-xl border bg-surface-3 p-3 shadow-surface-2">
            <div className="flex items-center gap-2">
              <p className="flex-1 font-medium">{s.title}</p>
              {state && <Badge color={state.status === 'rehearsed' ? 'green' : state.status === 'failed' ? 'red' : 'blue'}>{state.status}</Badge>}
            </div>
            <p className="text-muted-foreground">{s.subtitle}</p>
            <ol className="mt-2 flex flex-col gap-2">
              {s.steps.map((step, i) => (
                <li key={i} className="grid grid-cols-[1.25rem_1fr] gap-x-2">
                  <span className="text-muted-foreground">{i + 1}</span>
                  <span>{step.act}</span>
                  <span />
                  <span className="text-muted-foreground italic">“{step.narration}”</span>
                </li>
              ))}
            </ol>
            {state?.error && <p className="mt-2 text-destructive">{state.error}</p>}
            {state && state.status !== 'pending' && (
              <a className="mt-2 inline-block text-xs text-[color:var(--fluid-accent)] underline" href={`/api/demos/${demo.id}/report/${s.id}`} target="_blank">
                Rehearsal report
              </a>
            )}
          </div>
        );
      })}
      <div className="rounded-xl border bg-surface-3 p-3 shadow-surface-2">
        <p className="font-medium">Close: {plan.close.message}</p>
        <p className="mt-1 text-muted-foreground">Delivered: {plan.close.delivered}</p>
        <p className="text-muted-foreground">Next: {plan.close.next}</p>
      </div>
    </div>
  );
}

export function DemoPanel({ demo, by }: { demo: Demo; by: string }) {
  const [tab, setTab] = useState(demo.video ? 'video' : 'plan');
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <PlanEditor demo={demo} by={by} open={editing} onOpenChange={setEditing} />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{demo.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {demo.input.tickets.join(', ')} · {demo.input.target}
          </p>
        </div>
        <Badge color={stageColor(demo.stage)}>{demo.stage}</Badge>
      </div>
      <Progress demo={demo} />
      {demo.review.gate && <Gate demo={demo} by={by} onEdit={() => setEditing(true)} />}
      {demo.error && <Banner status="error">{demo.error}</Banner>}
      {demo.problems.length > 0 && (
        <Banner status="warning">
          <ul className="list-disc pl-4">
            {demo.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Banner>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabItem value="video" label="Video" />
          <TabItem value="plan" label="Plan" />
          <TabItem value="activity" label="Activity" />
        </TabsList>
        <TabPanel value="video" className="pt-3">
          {demo.video ? (
            <div className="flex flex-col gap-2">
              <video className="w-full rounded-xl bg-black" controls src={`/api/demos/${demo.id}/video?t=${demo.video.at}`} />
              <p className="text-xs text-muted-foreground">
                {demo.video.seconds} s ·{' '}
                <a className="underline" href={`/api/demos/${demo.id}/video?t=${demo.video.at}`} download={`${demo.id}.mp4`}>
                  Download
                </a>
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No video yet.</p>
          )}
        </TabPanel>
        <TabPanel value="plan" className="pt-3">
          <PlanView demo={demo} onEdit={() => setEditing(true)} />
        </TabPanel>
        <TabPanel value="activity" className="pt-3">
          <Timeline demo={demo} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
