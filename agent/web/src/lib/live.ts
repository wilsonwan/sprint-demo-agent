// One WebSocket for every live view (/api/live): subscribe to "thread:<id>" or "demo:<id>"
// and get its data now and after every change. It reconnects on its own and subscribes again,
// and each subscription starts with a full snapshot, so nothing is missed. (Cloudflare quick
// tunnels don't carry server-sent events; WebSockets work there and locally.)

type Listener = (data: any) => void;
const listeners = new Map<string, Set<Listener>>();
let socket: WebSocket | null = null;
let retry = 0;

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    for (const topic of listeners.keys()) ws.send(JSON.stringify({ op: 'sub', topic }));
  };
  ws.onmessage = (msg) => {
    const { topic, data } = JSON.parse(msg.data);
    for (const fn of listeners.get(topic) ?? []) fn(data);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
  };
}

export function subscribe(topic: string, fn: Listener) {
  if (!socket) connect();
  let set = listeners.get(topic);
  if (!set) {
    listeners.set(topic, (set = new Set()));
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 'sub', topic }));
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size) return;
    listeners.delete(topic);
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 'unsub', topic }));
  };
}
