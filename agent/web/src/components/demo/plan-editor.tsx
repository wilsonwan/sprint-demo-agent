import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, type Demo, type Plan } from '@/lib/api';

// The plan as a form, for editing a specific part directly instead of asking the agent.
// Saving needs the demo to be waiting at a gate (the pipeline doesn't change plans mid-run).

const field = 'w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-[color:var(--fluid-accent)]';

function Text({ label, value, onChange, area }: { label: string; value: string; onChange: (v: string) => void; area?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {area ? (
        <textarea className={`${field} min-h-16 resize-y`} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className={field} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function PlanEditor({ demo, by, open, onOpenChange }: { demo: Demo; by: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setPlan(demo.plan ? structuredClone(demo.plan) : null);
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!plan) return null;
  const editable = !!demo.review.gate;
  const update = (fn: (p: Plan) => void) =>
    setPlan((p) => {
      const next = structuredClone(p!);
      fn(next);
      return next;
    });
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.savePlan(demo.id, by, plan);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="flex max-h-[85svh] flex-col">
        <DialogHeader>
          <DialogTitle>Edit plan</DialogTitle>
          <DialogDescription>
            {editable ? 'Changes apply when you save. Only what you change is redone.' : 'The pipeline is running; the plan can be edited when it next waits for review.'}
          </DialogDescription>
        </DialogHeader>
        {/* A div scrolls; a <fieldset> can't be a reliable scroll container. */}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-2">
        <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-6">
          <Section title="Title card">
            <div className="grid grid-cols-2 gap-3">
              <Text label="Title" value={plan.title} onChange={(v) => update((p) => void (p.title = v))} />
              <Text label="Product" value={plan.product} onChange={(v) => update((p) => void (p.product = v))} />
            </div>
            <Text label="Summary" value={plan.summary} onChange={(v) => update((p) => void (p.summary = v))} />
            <Text label="Narration" area value={plan.titleNarration} onChange={(v) => update((p) => void (p.titleNarration = v))} />
          </Section>

          <Section title="What this demo proves">
            <Text label="Subtitle" value={plan.proves.subtitle} onChange={(v) => update((p) => void (p.proves.subtitle = v))} />
            {plan.proves.cards.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_2fr] gap-3">
                <Text label={`Card ${i + 1}`} value={c.title} onChange={(v) => update((p) => void (p.proves.cards[i].title = v))} />
                <Text label="Text" value={c.text} onChange={(v) => update((p) => void (p.proves.cards[i].text = v))} />
              </div>
            ))}
            <Text label="Outcome" value={plan.proves.outcome} onChange={(v) => update((p) => void (p.proves.outcome = v))} />
            <Text label="Narration" area value={plan.proves.narration} onChange={(v) => update((p) => void (p.proves.narration = v))} />
          </Section>

          {plan.segments.map((s, si) => (
            <Section key={s.id} title={`Segment ${si + 1} · ${s.id}`}>
              <div className="grid grid-cols-2 gap-3">
                <Text label="Slide title" value={s.title} onChange={(v) => update((p) => void (p.segments[si].title = v))} />
                <Text label="Subtitle" value={s.subtitle} onChange={(v) => update((p) => void (p.segments[si].subtitle = v))} />
              </div>
              <div className="grid grid-cols-[1.5rem_1fr_1fr_1.75rem] gap-x-3 gap-y-2 text-xs text-muted-foreground">
                <span />
                <span>What the agent does in the app</span>
                <span>What the narrator says meanwhile</span>
                <span />
                {s.steps.map((step, k) => (
                  <div key={k} className="contents">
                    <span className="pt-2 text-sm">{k + 1}</span>
                    <textarea className={`${field} min-h-14`} value={step.act} onChange={(e) => update((p) => void (p.segments[si].steps[k].act = e.target.value))} />
                    <textarea className={`${field} min-h-14`} value={step.narration} onChange={(e) => update((p) => void (p.segments[si].steps[k].narration = e.target.value))} />
                    <button
                      type="button"
                      aria-label={`Remove step ${k + 1}`}
                      className="mt-1.5 size-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => update((p) => void p.segments[si].steps.splice(k, 1))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div>
                <Button size="compact" variant="ghost" onClick={() => update((p) => void p.segments[si].steps.push({ act: '', narration: '' }))}>
                  Add step
                </Button>
              </div>
              <Text label="Checked at the end (what one screenshot shows)" value={s.assert ?? ''} onChange={(v) => update((p) => void (p.segments[si].assert = v))} />
            </Section>
          ))}

          <Section title="Close">
            <Text label="Key message" value={plan.close.message} onChange={(v) => update((p) => void (p.close.message = v))} />
            <div className="grid grid-cols-3 gap-3">
              <Text label="Delivered now" area value={plan.close.delivered} onChange={(v) => update((p) => void (p.close.delivered = v))} />
              <Text label="Next evolution" area value={plan.close.next} onChange={(v) => update((p) => void (p.close.next = v))} />
              <Text label="Business value" area value={plan.close.value} onChange={(v) => update((p) => void (p.close.value = v))} />
            </div>
            <Text label="Narration" area value={plan.close.narration} onChange={(v) => update((p) => void (p.close.narration = v))} />
          </Section>
        </fieldset>
        </div>
        <DialogFooter className="items-center">
          {error && <p className="mr-auto text-sm text-destructive">{error}</p>}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!editable || saving || !by} onClick={save}>
            {saving ? 'Saving…' : 'Save plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
