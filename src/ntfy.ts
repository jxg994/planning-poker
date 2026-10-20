import type { Transport, TransportHandlers } from './room.ts';

export const DEFAULT_NTFY_URL = 'https://ntfy.sh';
// Namespaces this app's topics on the shared public server.
export const TOPIC_PREFIX = 'jxg994-planning-poker-';

export function topicFor(code: string): string {
  return `${TOPIC_PREFIX}${code}`;
}

/** Tests point the app at a local stand-in server; production always uses ntfy.sh. */
export function ntfyUrl(): string {
  const override = (globalThis as { __POKER_NTFY_URL__?: unknown }).__POKER_NTFY_URL__;
  return typeof override === 'string' ? override : DEFAULT_NTFY_URL;
}

export function describePublishFailure(status: number, detail: string): string {
  const suffix = detail ? ` Server said: "${detail}".` : '';
  if (status === 429) {
    return 'ntfy.sh refused the message because a rate limit was reached (HTTP 429). The free public ' +
      'server allows each IP address about 250 messages per day, shared by everyone on the same network.' + suffix;
  }
  return `ntfy.sh rejected the message (HTTP ${status}).${suffix}`;
}

const MAX_RETRY_MS = 30_000;

export class NtfyTransport implements Transport {
  private source?: EventSource;
  private handlers?: TransportHandlers;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryMs = 2_000;
  private closed = false;
  private baseUrl: string;
  private topic: string;

  constructor(baseUrl: string, topic: string) {
    this.baseUrl = baseUrl;
    this.topic = topic;
  }

  connect(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const source = new EventSource(`${this.baseUrl}/${encodeURIComponent(this.topic)}/sse`);
    this.source = source;
    source.addEventListener('open', (event) => {
      // The browser's own "open" has no data. ntfy's named "open" event means the subscription is active.
      if (source === this.source && event instanceof MessageEvent && event.data) {
        this.retryMs = 2_000;
        this.handlers?.onReady();
      }
    });
    source.addEventListener('message', (event) => {
      if (source !== this.source) return;
      try {
        const data: unknown = JSON.parse(event.data);
        if (typeof data === 'object' && data !== null && 'event' in data && data.event === 'message' &&
            'message' in data && typeof data.message === 'string') {
          this.handlers?.onMessage(data.message);
        }
      } catch {
        console.warn('Ignored malformed ntfy event.');
      }
    });
    source.addEventListener('error', () => {
      if (this.closed || source !== this.source) return;
      this.handlers?.onDown();
      // The browser retries CONNECTING sources itself; a CLOSED source (e.g. HTTP 429) needs a manual retry.
      if (source.readyState === EventSource.CLOSED) {
        this.retryTimer = setTimeout(() => this.open(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
      }
    });
  }

  async publish(body: string, options?: { keepalive?: boolean }): Promise<void> {
    let response: Response;
    try {
      // A query parameter and plain-text body keep this a simple CORS request (no preflight).
      response = await fetch(`${this.baseUrl}/${encodeURIComponent(this.topic)}?cache=no`, {
        method: 'POST',
        body,
        keepalive: options?.keepalive ?? false,
      });
    } catch {
      throw new Error('Could not reach ntfy.sh to send your update. Check your connection and try again.');
    }
    if (!response.ok) {
      let detail = '';
      try {
        const data: unknown = await response.json();
        if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
          detail = data.error;
        }
      } catch {
        // Some failures (e.g. proxies) return non-JSON bodies.
      }
      throw new Error(describePublishFailure(response.status, detail));
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.source?.close();
  }
}
