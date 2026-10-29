import { useState } from 'react';
import { Chat } from '@/components/demo/chat';
import { DemoPanel, stageColor } from '@/components/demo/demo-panel';
import { ResizablePanel } from '@/components/demo/resizable-panel';
import { ShareButton } from '@/components/demo/share';
import { ThemeToggle } from '@/components/demo/theme-toggle';
import { SidebarInsetTopbar } from '@/components/demo/inset-topbar';
import { Badge } from '@/components/ui/badge';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownContent, DropdownMenu, DropdownTrigger } from '@/components/ui/dropdown';
import { MenuItem } from '@/components/ui/menu-item';
import { SidebarMenuAction } from '@/components/ui/sidebar';
import { useIcons } from '@/lib/icon-context';
import { api, type Thread } from '@/lib/api';
import { useDemo, usePoll } from '@/lib/use-demo';
import { useThread } from '@/lib/use-thread';

function readThread() {
  const id = new URLSearchParams(location.search).get('thread');
  return id ? Number(id) : null;
}

export default function App() {
  const icons = useIcons();
  const [who, setWho] = useState(() => localStorage.getItem('who') ?? '');
  const [threadId, setThreadId] = useState<number | null>(readThread);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const MoreIcon = icons['more-vertical'];
  const PanelIcon = icons['panel-right'];
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('panel') !== 'closed');
  const togglePanel = () => {
    localStorage.setItem('panel', panelOpen ? 'closed' : 'open');
    setPanelOpen(!panelOpen);
  };
  const XIcon = icons.x;
  const [refresh, setRefresh] = useState(0);
  const threads = usePoll(() => api.threads(), 3000, [refresh]) ?? [];
  const thread: Thread | undefined = threads.find((t) => t.id === threadId);
  const { items, running } = useThread(threadId);
  const demo = useDemo(thread?.demoId ?? null);

  const open = (id: number | null) => {
    setThreadId(id);
    history.replaceState(null, '', id == null ? '/' : `/?thread=${id}`);
  };
  const send = async (text: string) => {
    setError('');
    try {
      let id = threadId;
      if (id == null) {
        id = (await api.newThread(who)).id;
        open(id);
      }
      await api.send(id, who, text);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await api.deleteThread(deleting.id);
      if (deleting.id === threadId) open(null);
      setDeleting(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.title}”?</DialogTitle>
            <DialogDescription>
              This stops its pipeline if it's running and deletes the chat, the demo and everything it made: the plan, rehearsals, recordings, voice-over and video. It can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button className="bg-red-600 hover:bg-red-700" disabled={deleteBusy} onClick={confirmDelete}>
              {deleteBusy ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Sidebar variant="inset">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="flex size-7 items-center justify-center rounded-lg bg-[color:var(--fluid-accent)] text-sm font-semibold text-white">D</div>
            <span className="font-medium">Sprint demos</span>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton icon={icons.plus} onClick={() => open(null)}>
                New demo
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Demos</SidebarGroupLabel>
            <SidebarMenu>
              {threads.map((t) => (
                <SidebarMenuItem key={t.id}>
                  <SidebarMenuButton isActive={t.id === threadId} onClick={() => open(t.id)}>
                    <span className="truncate">{t.title}</span>
                  </SidebarMenuButton>
                  <DropdownMenu>
                    <DropdownTrigger
                      render={
                        <SidebarMenuAction showOnHover aria-label={`Options for ${t.title}`}>
                          <MoreIcon />
                        </SidebarMenuAction>
                      }
                    />
                    <DropdownContent className="w-[200px] min-w-0" align="start" sideOffset={4}>
                      <MenuItem index={0} icon={XIcon} label="Delete…" onSelect={() => setDeleting(t)} />
                    </DropdownContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="px-2">
            <ThemeToggle />
          </div>
          <label className="flex flex-col gap-1 px-2 pb-1 text-xs text-muted-foreground">
            Your name
            <input
              className="rounded-lg border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-[color:var(--fluid-accent)]"
              value={who}
              placeholder="Shown on your messages"
              onChange={(e) => {
                setWho(e.target.value);
                localStorage.setItem('who', e.target.value.trim());
              }}
            />
          </label>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="flex min-h-0 flex-col overflow-hidden">
        <SidebarInsetTopbar>
          <span className="truncate text-sm font-medium">{thread?.title ?? 'New demo'}</span>
          {demo && <Badge color={stageColor(demo.stage)}>{demo.stage}</Badge>}
          <div className="ml-auto flex items-center gap-1 pr-1.5">
            <ShareButton by={who.trim()} />
          {demo && (
            <button
              type="button"
              onClick={togglePanel}
              aria-pressed={panelOpen}
              aria-label={panelOpen ? 'Hide the demo panel' : 'Show the demo panel'}
              title={panelOpen ? 'Hide the demo panel' : 'Show the demo panel'}
              className={`hidden size-8 items-center justify-center rounded-lg lg:flex ${
                panelOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <PanelIcon className="size-4" />
            </button>
          )}
          </div>
        </SidebarInsetTopbar>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <Chat
              items={items}
              running={running}
              disabled={!who.trim()}
              onSend={send}
              onStop={() => threadId != null && void api.stop(threadId)}
              empty={
                <div className="flex flex-col gap-2 py-16 text-center">
                  <p className="text-xl font-medium">What should we demo?</p>
                  <p className="text-sm text-muted-foreground">Give me the Jira tickets and the environment. I'll plan it, rehearse it in the app and record it, and check with you along the way.</p>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              }
            />
          </div>
          {demo && panelOpen && (
            <ResizablePanel>
              <DemoPanel demo={demo} by={who.trim()} />
            </ResizablePanel>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
