import type { Models } from '@earendil-works/pi-ai';
import type { Demo, Plan } from '../doc.ts';
import { completeJson } from '../models.ts';

export const MAX_NARRATION_CHARS = 280;

const SYSTEM = `You plan sprint demo videos. A video is: a title card, a "what this demo proves" slide, one slide per
recorded segment (a screen recording of the real app), and a closing card, with a voice-over read by a text-to-speech
narrator. Reply with one JSON object only.

Segments:
- Group the tickets' features into 1-4 segments in a logical order. Each segment is recorded from a fresh browser on the
  app's start page, already logged in, so its first step must start from there.
- Steps are plain-English UI actions a vision model performs on the real app, one action each: "Click the Settings gear
  icon at the bottom left of the sidebar", "Type \\"Buy milk\\" into the new todo input and press Enter". Name what is on
  screen (labels, icons, positions). Use the accessibility tree of the start page for exact labels. 2-5 steps per segment.
- Every step is one action: click, type, select, scroll or press a key. Never "observe", "wait", "verify" or "check":
  what the viewer should see goes in the narration, and the end state goes in "assert".
- Only use pages, buttons and labels the tickets or the accessibility tree name. Don't invent pages.
- Avoid actions that change the app's settings or data unless a ticket's feature is that change.
- Never put passwords, tokens or login steps in steps: logging in is done before recording.
- Each step has one narration sentence, said while that step happens, describing it (8 to 16 words).
- "assert" is a short statement of what the screen shows at the end, checked once during rehearsal by a vision model
  looking at one screenshot. Only state what that screenshot can show ("The Whole number checkbox is checked"), never
  history or intent ("by default", "was saved", "still", "after reload"); the narration can say those.

Text:
- Only claim what the tickets and recorded steps show. Card text is final copy for the audience: no instructions,
  placeholders or notes about the video itself.
- Narration is plain spoken English, no markdown or brackets, each narration string at most ${MAX_NARRATION_CHARS}
  characters.`;

const SHAPE = `{
  "product": string,
  "title": string (the feature, 2-5 words),
  "summary": string (one line, what the demo shows),
  "tags": [string, string] (short chips, e.g. "Sprint 42", "Admin workflow"),
  "stats": [{"value": string, "label": string}] (0-2 counts of what the demo covers),
  "titleNarration": string,
  "proves": {"subtitle": string (not "What this demo proves"), "cards": [{"title": string, "text": string}] (2-4, the journey in order), "outcome": string (starts "Demo outcome:"), "narration": string},
  "segments": [{"id": string (kebab-case), "title": string (starts "Step N: "), "subtitle": string, "tickets": [string], "steps": [{"act": string, "narration": string}], "assert": string}],
  "close": {"message": string, "delivered": string, "next": string, "value": string, "narration": string}
}`;

export async function writePlan(models: Models, demo: Demo, appSnapshot: string, feedback: string, sessionId: string): Promise<Plan> {
  const user = `Audience: ${demo.input.audience || 'the sprint review: developers and the product owner'}
Notes from the team: ${demo.input.notes || '(none)'}

Tickets:
${demo.tickets.map((t) => `- ${t.key}: ${t.summary}\n  ${t.description.slice(0, 1500).replace(/\n/g, '\n  ')}${t.acceptance.length ? `\n  Acceptance criteria:\n${t.acceptance.map((a) => `  - ${a}`).join('\n')}` : ''}`).join('\n')}

Accessibility tree of the app's start page (after login):
${appSnapshot || '(not available)'}
${demo.plan && feedback ? `\nThe current plan, which a reviewer wants changed:\n${JSON.stringify(demo.plan)}\n\nReviewer feedback: ${feedback}\nKeep everything the feedback doesn't ask to change.` : ''}
${demo.problems.length ? `\nProblems found in the last attempt, fix them:\n${demo.problems.map((p) => `- ${p}`).join('\n')}` : ''}

Return JSON with this shape:
${SHAPE}`;
  const plan = await completeJson<Plan>(models, SYSTEM, user, sessionId);
  plan.segments.forEach((s, i) => (s.id = slug(s.id || s.title) || `segment-${i + 1}`));
  return plan;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// What a reviewer would catch: notes left on a card (the reference demo has one), narration
// too long for the voice, a step without its sentence, secrets in steps.
export function lint(plan: Plan): string[] {
  const problems: string[] = [];
  // TODO/TBD only in capitals: "todo" can be the product's own word.
  const leaked = (t: string) => /\b(TODO|TBD)\b/.test(t) || /\b(placeholder|lorem|continuous video|this slide|on this slide|voice-?over|narrat)/i.test(t);
  const cardText = [plan.title, plan.summary, ...plan.tags, plan.proves.subtitle, plan.proves.outcome,
    ...plan.proves.cards.flatMap((c) => [c.title, c.text]), ...plan.segments.flatMap((s) => [s.title, s.subtitle]),
    plan.close.message, plan.close.delivered, plan.close.next, plan.close.value];
  for (const text of cardText) if (leaked(text)) problems.push(`Card text reads like a note: "${text}"`);
  if (/what this demo proves/i.test(plan.proves.subtitle)) problems.push('The "what this demo proves" subtitle repeats its heading');
  const narration = [plan.titleNarration, plan.proves.narration, ...plan.segments.map((s) => s.steps.map((st) => st.narration).join(' ')), plan.close.narration];
  for (const text of narration) {
    if (text.length > MAX_NARRATION_CHARS) problems.push(`Narration over ${MAX_NARRATION_CHARS} characters (${text.length}): "${text.slice(0, 60)}…"`);
    if (/[[\]<>*_#]/.test(text)) problems.push(`Narration has markup the voice would misread: "${text.slice(0, 60)}…"`);
  }
  const ids = new Set<string>();
  for (const s of plan.segments) {
    if (ids.has(s.id)) problems.push(`Two segments share the id "${s.id}"`);
    ids.add(s.id);
    if (!s.steps.length) problems.push(`${s.title}: no steps`);
    if (s.assert && /\b(by default|default state|saved|persist|still|after reload|remains|unchanged)\b/i.test(s.assert)) {
      problems.push(`${s.title}: the end check "${s.assert}" claims something a screenshot can't show; say only what's visible`);
    }
    for (const step of s.steps) {
      if (!step.narration?.trim()) problems.push(`${s.title}: step "${step.act}" has no narration`);
      if (/^\s*(observe|wait|verify|check|look|see|notice|confirm)\b/i.test(step.act)) problems.push(`${s.title}: "${step.act}" isn't an action; move it to the narration or the assert`);
      if (/password|passcode|token|secret/i.test(step.act)) problems.push(`${s.title}: step "${step.act}" mentions a secret; logging in happens before recording`);
    }
  }
  return problems;
}
