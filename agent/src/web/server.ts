import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { watchEvents, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import { createThread, deleteThread, postMessage, ThreadIndex } from '../chat.ts';
import { demoDir, ROOT } from '../config.ts';
import { DemoDoc, DemoIndex, log, type Decision, type Demo, type DemoSeed, type Plan } from '../doc.ts';
import { listTargets } from '../targets.ts';
import { WebSocketServer, type WebSocket } from 'ws';
import { isRemote, keyCookie, remoteAllowed, startTunnel, stopTunnel, tunnelState } from '../tunnel.ts';
import { lint } from '../stages/plan.ts';

// The web app's API: chat threads, each thread's demo (live, plan edits, gate decisions, the
// video) and sharing. Several browsers can watch and edit the same demo; edits are commits on its
// document. No accounts: a name typed in the app is recorded with each message and decision.

export function startWeb(harness: Harness, host: string, port: number) {
  // The React app (web/, built to web/dist).
  const DIST = join(ROOT, 'web/dist');
  const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.html': 'text/html; charset=utf-8' };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    // Through the tunnel, everything needs this tunnel's share key (no login of our own).
    const remote = isRemote(req);
    if (remote) {
      const access = remoteAllowed(req, url);
      if (access === 'denied') {
        if (parts[0] === 'api') return json(res, { error: 'This link needs a valid share key' }, 401);
        return send(res, 401, DENIED_PAGE, 'text/html; charset=utf-8');
      }
      if (access === 'set-cookie') {
        url.searchParams.delete('key');
        res.writeHead(302, { 'set-cookie': keyCookie(), location: url.pathname + (url.search || '') });
        return res.end();
      }
    }

    // Sharing is controlled from this machine only.
    if (parts[0] === 'api' && parts[1] === 'tunnel') {
      if (remote) return json(res, { error: 'Sharing can only be changed on the agent host' }, 403);
      if (req.method === 'GET') return json(res, tunnelState());
      if (req.method === 'POST') {
        const b = await body(req);
        const emails = String(b.allowedEmails ?? '').split(/[\s,]+/).map((e) => e.trim()).filter(Boolean);
        return json(res, await startTunnel(port, need(b.by, 'your name'), emails));
      }
      if (req.method === 'DELETE') {
        for (const s of remoteSockets) s.close(4001, 'sharing stopped');
        return json(res, stopTunnel());
      }
    }
    if (req.method === 'GET' && parts[0] !== 'api') {
      const file = join(DIST, url.pathname.replace(/\.\.+/g, ''));
      if (url.pathname.startsWith('/assets/') && existsSync(file)) {
        return send(res, 200, readFileSync(file), TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream');
      }
      const index = join(DIST, 'index.html');
      return existsSync(index) ? send(res, 200, readFileSync(index), TYPES['.html']) : send(res, 404, 'Build the web app first: cd web && npm run build');
    }
    if (parts[0] !== 'api') return send(res, 404, 'not found');

    if (parts[1] === 'threads') {
      if (parts.length === 2 && req.method === 'GET') return json(res, ((await harness.snapshot(ThreadIndex, ctx))?.threads ?? []).slice().reverse());
      if (parts.length === 2 && req.method === 'POST') {
        const b = await body(req);
        return json(res, { id: await createThread(harness, need(b.by, 'your name')) }, 201);
      }
      const threadId = Number(parts[2]);
      if (req.method === 'DELETE' && parts.length === 3) {
        await deleteThread(harness, threadId);
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'messages') {
        const b = await body(req);
        await postMessage(harness, threadId, need(b.by, 'your name'), need(b.text, 'a message'));
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'stop') {
        const conversation = await harness.conversation(threadId as unknown as ConversationId, ctx);
        await conversation?.abort?.(ctx);
        return json(res, { ok: true });
      }
      return send(res, 404, 'not found');
    }

    if (req.method === 'GET' && parts[1] === 'targets') return json(res, listTargets().map((t) => ({ id: t.id, label: t.label, appUrl: t.appUrl })));
    if (parts[1] === 'demos' && parts.length === 2 && req.method === 'GET') return json(res, await listDemos());
    const id = parts[2];
    if (parts[1] !== 'demos' || !id) return send(res, 404, 'not found');
    const demo = (await harness.snapshot(DemoDoc, id, ctx)) as Demo | undefined;
    if (!demo) return send(res, 404, 'no such demo');

    if (req.method === 'GET' && parts.length === 3) return json(res, demo);
    if (req.method === 'PUT' && parts[3] === 'plan') return json(res, await editPlan(id, demo, await body(req)));
    if (req.method === 'POST' && parts[3] === 'decision') return json(res, await decide(id, demo, await body(req)));
    if (req.method === 'GET' && parts[3] === 'video') return video(req, res, join(demoDir(id), 'demo.mp4'));
    if (req.method === 'GET' && parts[3] === 'report' && parts[4]) {
      const segment = parts[4].replace(/[^a-z0-9-]/g, '');
      const file = join(demoDir(id), 'segments', segment, 'midscene_run', 'report', `${segment}-rehearse.html`);
      return existsSync(file) ? send(res, 200, readFileSync(file), 'text/html; charset=utf-8') : send(res, 404, 'no report yet');
    }
    return send(res, 404, 'not found');
  }

  async function listDemos() {
    const index = await harness.snapshot(DemoIndex, ctx);
    const demos = await Promise.all((index?.ids ?? []).map((id) => harness.snapshot(DemoDoc, id, ctx)));
    return demos.filter(Boolean).reverse().map((d) => ({ id: d!.id, title: d!.title, stage: d!.stage, message: d!.message, createdAt: d!.createdAt, createdBy: d!.createdBy }));
  }

  // People edit the plan only at a gate, while the pipeline waits.
  async function editPlan(id: string, demo: Demo, b: { plan?: Plan; by?: string }) {
    if (!demo.review.gate) throw new HttpError(409, 'The plan can be edited while the demo waits for review');
    const by = need(b.by, 'your name');
    const plan = b.plan;
    if (!plan || !Array.isArray(plan.segments)) throw new HttpError(400, 'plan missing');
    await harness.commit(async (tx) => {
      const d = await tx.doc(DemoDoc, id, seedOf(demo));
      d.plan = plan;
      d.problems = lint(plan);
      log(d, by, 'Edited the plan');
    }, ctx);
    return { ok: true };
  }

  async function decide(id: string, demo: Demo, b: { decision?: Decision; feedback?: string; by?: string }) {
    const by = need(b.by, 'your name');
    if (!demo.review.gate) throw new HttpError(409, 'Nothing is waiting for a decision');
    if (!['approve', 'revise', 'rebuild'].includes(b.decision ?? '')) throw new HttpError(400, 'unknown decision');
    if (b.decision === 'revise' && !b.feedback?.trim() && demo.plan) throw new HttpError(400, 'Say what should change');
    await harness.commit(async (tx) => {
      const d = await tx.doc(DemoDoc, id, seedOf(demo));
      d.review = { ...d.review, decision: b.decision!, feedback: b.feedback ?? '', by, at: Date.now() };
    }, ctx);
    return { ok: true };
  }

  // Live updates over one WebSocket (/api/live): a client subscribes to "thread:<id>" (Pi Durable
  // agent events) and "demo:<id>" (the demo document). (Quick tunnels don't carry server-sent events.)
  const wss = new WebSocketServer({ noServer: true });
  const remoteSockets = new Set<WebSocket>();
  wss.on('connection', (socket: WebSocket, remote: boolean) => {
    if (remote) remoteSockets.add(socket);
    const subs = new Map<string, () => void>();
    const sendTo = (topic: string, data: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify({ topic, data }));
    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { op: 'sub' | 'unsub'; topic: string };
        if (msg.op === 'unsub' || subs.has(msg.topic)) {
          subs.get(msg.topic)?.();
          subs.delete(msg.topic);
          if (msg.op === 'unsub') return;
        }
        const [kind, id] = [msg.topic.slice(0, msg.topic.indexOf(':')), msg.topic.slice(msg.topic.indexOf(':') + 1)];
        if (kind === 'thread') {
          const stream = await watchEvents(harness, Number(id) as unknown as ConversationId, ctx);
          sendTo(msg.topic, [stream.snapshot]);
          stream.start(async (events) => void sendTo(msg.topic, events));
          subs.set(msg.topic, () => void stream.stop());
        } else if (kind === 'demo') {
          const watch = await harness.watchDoc(DemoDoc, id, ctx);
          if (!watch) return sendTo(msg.topic, null);
          sendTo(msg.topic, watch.value);
          watch.start(async (d) => void sendTo(msg.topic, d));
          subs.set(msg.topic, () => void watch.stop());
        }
      } catch (error) {
        console.error('live:', error instanceof Error ? error.message : error);
      }
    });
    socket.on('close', () => {
      remoteSockets.delete(socket);
      for (const stop of subs.values()) stop();
    });
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, { error: error instanceof Error ? error.message : String(error) }, status);
      else res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const remote = isRemote(req);
    if (url.pathname !== '/api/live' || (remote && remoteAllowed(req, url) !== 'ok')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, remote));
  });
  server.listen(port, host, () => console.log(`web page: http://${host}:${port}/`));
  return server;
}

const DENIED_PAGE = `<!doctype html><meta charset="utf-8"><title>Sprint demos</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;color:#333">
<div style="max-width:420px;text-align:center"><h2>This link needs a share key</h2>
<p>Ask whoever runs the agent for the current share link. Links stop working when sharing is turned off.</p></div>`;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const need = (v: string | undefined, what: string) => {
  if (!v?.trim()) throw new HttpError(400, `Missing ${what}`);
  return v.trim();
};
const seedOf = (d: Demo): DemoSeed => ({ id: d.id, title: d.title, createdBy: d.createdBy, input: d.input });

async function body(req: IncomingMessage) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw new HttpError(413, 'too large');
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON');
  }
}
function send(res: ServerResponse, status: number, data: string | Buffer, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(data);
}
function json(res: ServerResponse, data: unknown, status = 200) {
  send(res, status, JSON.stringify(data), 'application/json');
}
function video(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!existsSync(file)) return send(res, 404, 'no video yet');
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (!range) {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'accept-ranges': 'bytes' });
    return void createReadStream(file).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  res.writeHead(206, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
  createReadStream(file, { start, end }).pipe(res);
}
