import { useEffect, useState } from 'react';
import { subscribe } from './live';

// Rebuilds a thread's chat from Pi Durable's agent events (a snapshot, then one batch per
// commit, on the thread:<id> topic of /api/live): committed entries plus the reply being written.

type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
type Message =
  | { role: 'user'; content: string | { type: string; text?: string }[] }
  | { role: 'assistant'; content: Block[]; stopReason?: string; errorMessage?: string }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: { type: string; text?: string }[]; isError?: boolean }
  | { role: string; content?: unknown };
type Entry = { id: string; kind: string; model?: Message[] };

export type ToolChip = { id: string; name: string; args: Record<string, unknown>; status: 'running' | 'done' | 'error'; result?: string };
export type ChatItem =
  | { kind: 'user'; id: string; by: string; text: string }
  | { kind: 'event'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; tools: ToolChip[]; streaming: boolean; error?: string };

type State = { entries: Entry[]; live: Extract<Message, { role: 'assistant' }> | null; running: boolean; toolsRunning: Set<string> };

function apply(state: State, ev: any): State {
  switch (ev.type) {
    case 'snapshot':
      return { entries: [...ev.entries], live: ev.generation?.message ?? null, running: !!ev.run, toolsRunning: new Set(ev.tools.filter((t: any) => t.status !== 'done').map((t: any) => t.callId)) };
    case 'run_start':
      return { ...state, running: true };
    case 'run_end':
      return { ...state, running: false, live: null };
    case 'message_start':
      return ev.message.role === 'assistant' ? { ...state, live: structuredClone(ev.message) } : state;
    case 'message_update': {
      if (!state.live) return state;
      const live = structuredClone(state.live);
      for (const c of ev.changes) {
        if (c.type === 'message') return { ...state, live: c.message };
        if (c.type === 'text_start' || c.type === 'thinking_start' || c.type === 'toolcall_start' || c.type === 'block') live.content[c.contentIndex] = structuredClone(c.block);
        else if (c.type === 'text_delta') (live.content[c.contentIndex] as { text: string }).text += c.delta;
        else if (c.type === 'thinking_delta') (live.content[c.contentIndex] as { thinking: string }).thinking += c.delta;
      }
      return { ...state, live };
    }
    case 'message_end':
    case 'entry_appended': {
      const entries = state.entries.some((e) => e.id === ev.entry.id) ? state.entries : [...state.entries, ev.entry];
      return { ...state, entries, live: ev.type === 'message_end' ? null : state.live };
    }
    case 'tool_execution_start':
      return { ...state, toolsRunning: new Set([...state.toolsRunning, ev.toolCallId]) };
    case 'tool_execution_end': {
      const toolsRunning = new Set(state.toolsRunning);
      toolsRunning.delete(ev.toolCallId);
      const entries = ev.entry && !state.entries.some((e) => e.id === ev.entry.id) ? [...state.entries, ev.entry] : state.entries;
      return { ...state, entries, toolsRunning };
    }
    default:
      return state;
  }
}

const textOf = (content: unknown) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text ?? '').join('') : '';

// Entries to chat items: a person's message, a pipeline event, or one assistant turn-run with
// its tool calls folded in as chips.
function toItems(state: State): ChatItem[] {
  const items: ChatItem[] = [];
  const results = new Map<string, { text: string; error: boolean }>();
  for (const e of state.entries) {
    const m = e.model?.[0];
    if (m?.role === 'toolResult') results.set((m as any).toolCallId, { text: textOf(m.content), error: !!(m as any).isError });
  }
  let current: Extract<ChatItem, { kind: 'assistant' }> | null = null;
  const addAssistant = (id: string, m: Extract<Message, { role: 'assistant' }>, streaming: boolean) => {
    if (!current) {
      current = { kind: 'assistant', id, text: '', tools: [], streaming };
      items.push(current);
    }
    current.streaming = streaming;
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) current.text += (current.text ? '\n\n' : '') + b.text;
      if (b.type === 'toolCall') {
        const r = results.get(b.id);
        current.tools.push({ id: b.id, name: b.name, args: b.arguments ?? {}, status: r ? (r.error ? 'error' : 'done') : 'running', result: r?.text });
      }
    }
    if (m.stopReason === 'error' && m.errorMessage) current.error = m.errorMessage;
  };
  for (const e of state.entries) {
    const m = e.model?.[0];
    if (!m) continue;
    if (m.role === 'user') {
      current = null;
      const text = textOf(m.content);
      const pipeline = /^\[pipeline\]\s*/.exec(text);
      if (pipeline) items.push({ kind: 'event', id: e.id, text: text.slice(pipeline[0].length) });
      else {
        const by = /^\[([^\]]+)\]\s*/.exec(text);
        items.push({ kind: 'user', id: e.id, by: by?.[1] ?? '', text: by ? text.slice(by[0].length) : text });
      }
    } else if (m.role === 'assistant') addAssistant(e.id, m as Extract<Message, { role: 'assistant' }>, false);
  }
  if (state.live) addAssistant('live', state.live, true);
  return items;
}

export function useThread(threadId: number | null) {
  const [state, setState] = useState<State>({ entries: [], live: null, running: false, toolsRunning: new Set() });
  useEffect(() => {
    setState({ entries: [], live: null, running: false, toolsRunning: new Set() });
    if (threadId == null) return;
    return subscribe(`thread:${threadId}`, (events: any[]) => setState((s) => events.reduce(apply, s)));
  }, [threadId]);
  return { items: toItems(state), running: state.running };
}
