import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

// Sharing the agent with teammates through a Cloudflare quick tunnel (a random
// *.trycloudflare.com URL, no Cloudflare account). The agent has no login of its own, so a
// tunnel always comes with a secret share key: a request that arrives through the tunnel needs
// it (as ?key= once, then a cookie), and each tunnel gets a new one. Optionally, cloudflared
// asks visitors for an email one-time PIN (--allowed-mail). Quick tunnels don't carry
// server-sent events, which is why the web app's live updates use a WebSocket.

export type TunnelState = {
  status: 'off' | 'starting' | 'on' | 'error';
  url: string | null;
  shareUrl: string | null;
  allowedEmails: string[];
  error: string | null;
  startedBy: string | null;
  startedAt: number | null;
};

const COOKIE = 'sda_key';
let child: ChildProcess | null = null;
let key: string | null = null;
let state: TunnelState = { status: 'off', url: null, shareUrl: null, allowedEmails: [], error: null, startedBy: null, startedAt: null };

export const tunnelState = () => state;

function cloudflaredPath() {
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir && existsSync(join(dir, 'cloudflared'))) return join(dir, 'cloudflared');
  const local = join(homedir(), '.local/bin/cloudflared');
  return existsSync(local) ? local : null;
}

export function startTunnel(port: number, by: string, allowedEmails: string[]): Promise<TunnelState> {
  if (child) return Promise.resolve(state);
  const bin = cloudflaredPath();
  if (!bin) {
    state = { ...state, status: 'error', error: 'cloudflared is not installed on the agent host. Install it to ~/.local/bin from https://github.com/cloudflare/cloudflared/releases' };
    return Promise.resolve(state);
  }
  key = randomBytes(18).toString('base64url');
  const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  if (allowedEmails.length) args.push('--allowed-mail', allowedEmails.join(','));
  state = { status: 'starting', url: null, shareUrl: null, allowedEmails, error: null, startedBy: by, startedAt: Date.now() };
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  return new Promise((resolve) => {
    let log = '';
    const timer = setTimeout(() => {
      if (state.status === 'starting') fail('cloudflared started but gave no trycloudflare.com URL within 30 s');
    }, 30_000);
    const fail = (error: string) => {
      clearTimeout(timer);
      proc.kill();
      child = null;
      key = null;
      state = { ...state, status: 'error', url: null, shareUrl: null, error };
      resolve(state);
    };
    const onOutput = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-4000);
      const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0];
      if (url && state.status === 'starting') {
        clearTimeout(timer);
        state = { ...state, status: 'on', url, shareUrl: `${url}/?key=${key}` };
        resolve(state);
      }
    };
    proc.stdout!.on('data', onOutput);
    proc.stderr!.on('data', onOutput);
    proc.on('exit', (code) => {
      if (child !== proc) return;
      child = null;
      key = null;
      if (state.status === 'starting') fail(`cloudflared exited (${code}): ${log.split('\n').filter((l) => /ERR|error/i.test(l)).slice(-2).join(' ') || 'no output'}`);
      else state = { ...state, status: 'off', url: null, shareUrl: null, error: code ? `cloudflared stopped (${code})` : null };
    });
  });
}

export function stopTunnel() {
  child?.kill();
  child = null;
  key = null;
  state = { ...state, status: 'off', url: null, shareUrl: null, error: null };
  return state;
}

// A request that came through the tunnel (cloudflared adds Cloudflare's headers, and the Host
// is the trycloudflare name) rather than from a browser on this machine.
export function isRemote(req: IncomingMessage) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  return !!req.headers['cf-connecting-ip'] || !!req.headers['cf-ray'] || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Whether a remote request may in: only while a tunnel is on, and only with this tunnel's key.
export function remoteAllowed(req: IncomingMessage, url: URL): 'ok' | 'set-cookie' | 'denied' {
  if (!key || state.status !== 'on') return 'denied';
  const fromQuery = url.searchParams.get('key');
  if (fromQuery && same(fromQuery, key)) return 'set-cookie';
  const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return cookie && same(cookie, key) ? 'ok' : 'denied';
}

export const keyCookie = () => `${COOKIE}=${key}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
