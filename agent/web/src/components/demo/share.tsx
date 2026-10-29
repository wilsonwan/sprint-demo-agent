import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InputCopy } from '@/components/ui/input-copy';
import { Switch } from '@/components/ui/switch';
import { api, type Tunnel } from '@/lib/api';
import { useIcons } from '@/lib/icon-context';

// Sharing through a Cloudflare quick tunnel, for teammates. Only shown on the agent host
// (the API refuses remote callers, so a teammate never sees this button).
export function ShareButton({ by }: { by: string }) {
  const icons = useIcons();
  const Users = icons.users;
  const [tunnel, setTunnel] = useState<Tunnel | null>(null);
  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const load = () => api.tunnel().then((t) => live && setTunnel(t)).catch(() => live && setTunnel(null));
    load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  if (!tunnel) return null; // not the agent host

  const on = tunnel.status === 'on';
  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      const next = on || tunnel.status === 'starting' ? await api.stopTunnel() : await api.startTunnel(by, emails);
      setTunnel(next);
      if (next.status === 'error') setError(next.error ?? 'Sharing failed');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm ${on ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
        title={on ? 'Shared through a Cloudflare tunnel' : 'Share with teammates'}
      >
        <Users className="size-4" />
        {on ? 'Shared' : 'Share'}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Share with teammates</DialogTitle>
            <DialogDescription>
              Opens a temporary public link through a Cloudflare quick tunnel. Everyone with the link sees and edits the same demos and chats live.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 pt-2">
            <Switch label={busy ? (on ? 'Stopping…' : 'Starting the tunnel…') : on ? 'Sharing is on' : 'Sharing is off'} checked={on || tunnel.status === 'starting'} onToggle={toggle} disabled={busy || !by} />
            {!on && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">Only these people (optional): emails or domains like *@example.com. They get a one-time PIN by email.</span>
                <input
                  className="rounded-lg border bg-background px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-[color:var(--fluid-accent)]"
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="Anyone with the link"
                />
              </label>
            )}
            {on && tunnel.shareUrl && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Share link (it includes a secret key; a new one is made every time sharing turns on)</span>
                <InputCopy value={tunnel.shareUrl} />
                <p className="text-xs text-muted-foreground">
                  Started by {tunnel.startedBy}
                  {tunnel.allowedEmails.length ? ` · only ${tunnel.allowedEmails.join(', ')} (email PIN)` : ' · anyone with the link'}
                </p>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              People with the link can start demos against your environments (with the saved app logins), use your Copilot through the agent, and read the Jira tickets it fetches. Turn sharing off when you're done: the link stops working at once. Quick tunnels have no uptime guarantee.
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
