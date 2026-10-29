import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { Badge } from '@/components/ui/badge';
import { ChatMessage } from '@/components/ui/chat-message';
import { InputMessage } from '@/components/ui/input-message';
import { ThinkingIndicator } from '@/components/ui/thinking-indicator';
import type { ChatItem, ToolChip } from '@/lib/use-thread';

const TOOL_LABELS: Record<string, [running: string, done: string]> = {
  list_environments: ['Checking environments', 'Checked environments'],
  start_demo: ['Starting the demo', 'Started the demo'],
  get_demo: ['Reading the demo', 'Read the demo'],
  edit_plan: ['Editing the plan', 'Edited the plan'],
  decide: ['Recording the decision', 'Recorded the decision'],
};

function Chip({ tool }: { tool: ToolChip }) {
  const [running, done] = TOOL_LABELS[tool.name] ?? [tool.name, tool.name];
  const detail = tool.name === 'decide' ? `: ${String(tool.args.decision)}` : tool.name === 'edit_plan' ? `: ${((tool.args.changes as unknown[]) ?? []).length || 'steps'} change(s)` : '';
  return (
    <Badge color={tool.status === 'error' ? 'red' : tool.status === 'running' ? 'blue' : 'gray'} title={tool.result}>
      {tool.status === 'running' ? running : tool.status === 'error' ? `${done} (failed)` : done}
      {detail}
    </Badge>
  );
}

function Item({ item }: { item: ChatItem }) {
  if (item.kind === 'event') {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">Pipeline · {item.text}</span>
      </div>
    );
  }
  if (item.kind === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        {item.by && <span className="pr-1 text-xs text-muted-foreground">{item.by}</span>}
        <ChatMessage from="user">{item.text}</ChatMessage>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {item.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.tools.map((t) => (
            <Chip key={t.id} tool={t} />
          ))}
        </div>
      )}
      {item.text ? (
        <ChatMessage from="assistant">
          <div className="prose-chat">
            <Markdown>{item.text}</Markdown>
          </div>
        </ChatMessage>
      ) : (
        item.streaming && <ThinkingIndicator />
      )}
      {item.error && <p className="text-sm text-destructive">The model failed: {item.error}</p>}
    </div>
  );
}

export function Chat({ items, running, onSend, onStop, disabled, empty }: {
  items: ChatItem[];
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  disabled?: boolean;
  empty?: React.ReactNode;
}) {
  const [value, setValue] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  // A block body: scrollIntoView returns a Promise in newer browsers, which React would take for a cleanup.
  useEffect(() => {
    void bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length, items.at(-1)?.kind === 'assistant' && (items.at(-1) as { text: string }).text.length]);
  const lastIsLive = items.at(-1)?.kind === 'assistant' && (items.at(-1) as { streaming: boolean }).streaming;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-4 px-4 py-6">
          {items.length === 0 && empty}
          {items.map((item) => (
            <Item key={item.id} item={item} />
          ))}
          {running && !lastIsLive && <ThinkingIndicator />}
          <div ref={bottom} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[640px] px-4 pb-4">
        <InputMessage
          value={value}
          onValueChange={setValue}
          onSend={(text) => {
            if (!text.trim()) return;
            onSend(text.trim());
            setValue('');
          }}
          // One surface above the chat (fluid's default is the same level), so it doesn't blend in.
          className="bg-surface-4 shadow-surface-5"
          status={running ? 'streaming' : 'idle'}
          onStop={onStop}
          disabled={disabled}
          placeholder={disabled ? 'Type your name in the sidebar first' : 'Tell the agent what to demo, or what to change…'}
          suggestions={items.length === 0 ? ['Make a demo for PROJ-123 on QA', 'Which environments can you record?'] : undefined}
        />
      </div>
    </div>
  );
}
