// Opens the durable session, installs the demo tasks, resumes unfinished work and serves the
// web page. Usage: tsx src/main.ts [--host 127.0.0.1] [--port 4400]
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { DB_PATH, MODEL } from './config.ts';
import { openModels } from './models.ts';
import { chatExtension, refreshThreads, startNotifier } from './chat.ts';
import { demoExtension } from './pipeline.ts';
import { stopTunnel } from './tunnel.ts';
import { startWeb } from './web/server.ts';

// A closed pipe on our own output (e.g. a `| tee` that Ctrl+C killed first) must not crash the
// process mid-close: a crash counts toward every waiting task's restart limit, a close doesn't.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const models = openModels();
const registry = createRegistry();
// Task definitions aren't stored: install them before resuming, or pending tasks stay blocked.
registry.install(demoExtension);
registry.install(chatExtension);
const harness = await Harness.open(
  await openNodeSqliteStorage(DB_PATH),
  {
    models,
    registry,
    onReport: (error, info) => console.error(`[${info.type}]`, 'task' in info ? info.task?.kind : '', error instanceof Error ? error.message : error),
  },
  ctx,
);
harness.resume();

const inspection = await harness.inspect(ctx);
for (const t of inspection.tasks) if (t.state.kind === 'blocked') console.warn(`task ${t.record.id} (${t.record.kind}) is blocked: ${JSON.stringify(t.state)}`);
console.log(`models: ${MODEL.provider}/${MODEL.id} (text), ${MODEL.visionProvider}/${MODEL.visionId} (rehearsals)`);
const server = startWeb(harness, arg('host', '127.0.0.1'), Number(arg('port', '4400')));
await refreshThreads(harness);
const stopNotifier = startNotifier(harness);

// A clean close doesn't count toward a task's restart limit; a crash does.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    // Ctrl+C reaches both tsx and this process, so a second signal is normal: ignore it.
    if (closing) return;
    closing = true;
    console.log('closing…');
    stopNotifier();
    stopTunnel();
    server.close();
    await harness.close(ctx);
    process.exit(0);
  });
}
void harness.closed.then((end) => {
  if (closing) return;
  console.error('session ended:', end);
  process.exit(1);
});
