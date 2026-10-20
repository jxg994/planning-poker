// A minimal local stand-in for the ntfy.sh endpoints the app uses, so browser tests
// don't load the public service. Run: node tests/support/fake-ntfy.ts [port]
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const port = Number(process.argv[2] ?? process.env.FAKE_NTFY_PORT ?? 5175);
const subscribers = new Map<string, Set<ServerResponse>>();
let published: { topic: string; body: string; cache: string | null }[] = [];
let publishFailures: number[] = [];
let subscribeFailures: number[] = [];
let counter = 0;

function id(): string {
  return `m${(++counter).toString(36).padStart(9, '0')}`;
}

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function event(topic: string, type: string, message?: string): object {
  return { id: id(), time: Math.floor(Date.now() / 1000), event: type, topic, ...(message === undefined ? {} : { message }) };
}

function failures(url: URL): number[] {
  return Array(Number(url.searchParams.get('count') ?? 1)).fill(Number(url.searchParams.get('status') ?? 429));
}

const server = createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'OPTIONS') {
    res.writeHead(200).end();
    return;
  }

  if (parts[0] === '__control') {
    switch (parts[1]) {
      case 'stats':
        return json(res, 200, {
          published,
          subscribers: Object.fromEntries([...subscribers].map(([topic, set]) => [topic, set.size])),
        });
      case 'reset':
        published = [];
        publishFailures = [];
        subscribeFailures = [];
        return json(res, 200, {});
      case 'fail-publish':
        publishFailures.push(...failures(url));
        return json(res, 200, {});
      case 'fail-subscribe':
        subscribeFailures.push(...failures(url));
        return json(res, 200, {});
      case 'drop':
        for (const set of subscribers.values()) for (const subscriber of set) subscriber.destroy();
        subscribers.clear();
        return json(res, 200, {});
      default:
        return json(res, 404, { error: 'unknown control' });
    }
  }

  const topic = parts[0];
  if (!topic || !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
    return json(res, 404, { code: 40401, http: 404, error: 'page not found' });
  }

  if (req.method === 'GET' && parts[1] === 'sse') {
    const failure = subscribeFailures.shift();
    if (failure) return json(res, failure, { code: failure * 100 + 1, http: failure, error: 'limit reached: too many requests' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // A short reconnect delay keeps reconnect tests fast.
    res.write(`retry: 500\nevent: open\ndata: ${JSON.stringify(event(topic, 'open'))}\n\n`);
    const set = subscribers.get(topic) ?? new Set<ServerResponse>();
    set.add(res);
    subscribers.set(topic, set);
    const keepalive = setInterval(() => {
      res.write(`event: keepalive\ndata: ${JSON.stringify(event(topic, 'keepalive'))}\n\n`);
    }, 30_000);
    res.on('close', () => {
      clearInterval(keepalive);
      set.delete(res);
    });
    return;
  }

  if ((req.method === 'POST' || req.method === 'PUT') && parts.length === 1) {
    const body = await readBody(req);
    const failure = publishFailures.shift();
    if (failure) return json(res, failure, { code: failure * 100 + 1, http: failure, error: 'limit reached: too many requests' });
    if (Buffer.byteLength(body) > 4096) return json(res, 413, { error: 'test server: message would become an attachment' });
    const message = event(topic, 'message', body);
    const header = req.headers['cache'] ?? req.headers['x-cache'];
    published.push({ topic, body, cache: url.searchParams.get('cache') ?? (typeof header === 'string' ? header : null) });
    for (const subscriber of subscribers.get(topic) ?? []) subscriber.write(`data: ${JSON.stringify(message)}\n\n`);
    return json(res, 200, message);
  }

  json(res, 404, { code: 40401, http: 404, error: 'page not found' });
});

server.listen(port, '127.0.0.1', () => console.log(`fake ntfy listening on http://127.0.0.1:${port}`));
