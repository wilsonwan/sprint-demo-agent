import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for the vision model during a take. Any request it receives
// means the take was not fully served from the rehearsal cache, so it fails
// the request and counts it.
export async function startModelStub() {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    // Only the /v1 base path is the model. Some dev environments probe every new
    // listening port with `GET /`, which is not a model call.
    if (!req.url?.startsWith('/v1/')) {
      res.writeHead(404).end();
      return;
    }
    calls.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model-stub: take must not call the model' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
