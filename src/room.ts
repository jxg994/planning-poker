import {
  cloneSession, createSession, isClientId, isName, isRecord, isSession, isVote,
  join, leave, randomId, reset, snapshot, vote,
} from './state.ts';
import type { Session, Snapshot, Vote } from './state.ts';

/** A shared publish/subscribe channel. Every subscriber, including the sender, receives each message. */
export interface Transport {
  connect(handlers: TransportHandlers): void;
  publish(body: string, options?: { keepalive?: boolean }): Promise<void>;
  close(): void;
}

export interface TransportHandlers {
  /** The subscription is active. Called again after every reconnect. */
  onReady(): void;
  onMessage(text: string): void;
  /** The subscription was interrupted; the transport keeps retrying. */
  onDown(): void;
}

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface RoomCallbacks {
  onReady(): void;
  onState(view: Snapshot, myVote: Vote | null): void;
  onStatus(status: 'live' | 'reconnecting'): void;
  onNotice(message: string): void;
  onError(message: string): void;
  onEnd(message: string): void;
}

export interface RoomOptions {
  code: string;
  name: string;
  host: boolean;
  transport: Transport;
  callbacks: RoomCallbacks;
  clock?: Clock;
}

type Body =
  | { t: 'join'; name: string }
  | { t: 'vote'; round: number; value: Vote }
  | { t: 'reset'; round: number }
  | { t: 'leave' }
  | { t: 'ping' }
  | { t: 'end' }
  | { t: 'full'; to: string }
  | { t: 'state'; session: Session; seqs: Record<string, number> };

export type Envelope = Body & { v: 1; from: string; seq: number };

export const JOIN_TIMEOUT_MS = 10_000;
export const JOIN_ATTEMPTS = 2;
export const CONNECT_TIMEOUT_MS = 20_000;
export const MAX_PARTICIPANTS = 20;
// ntfy.sh turns messages over 4,096 bytes into attachments.
export const MAX_MESSAGE_BYTES = 4_000;
const RESYNC_COOLDOWN_MS = 30_000;
const GAP_RESYNC_DELAY_MS = 3_000;
const REPLAY_WINDOW_MS = 30_000;
const RECENT_SENDER_MS = 120_000;
const VOTE_REPAIR_AFTER_MS = 5_000;
const LOG_LIMIT = 200;

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

function isSeq(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseEnvelope(text: string): Envelope | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.v !== 1 || !isClientId(data.from) || !isSeq(data.seq) || data.seq < 1) return null;
  switch (data.t) {
    case 'join':
      return isName(data.name) ? data as Envelope : null;
    case 'vote':
      return isSeq(data.round) && isVote(data.value) ? data as Envelope : null;
    case 'reset':
      return isSeq(data.round) ? data as Envelope : null;
    case 'leave': case 'ping': case 'end':
      return data as Envelope;
    case 'full':
      return isClientId(data.to) ? data as Envelope : null;
    case 'state':
      return isSession(data.session) && isRecord(data.seqs) &&
        Object.entries(data.seqs).every(([id, seq]) => isClientId(id) && isSeq(seq)) ? data as Envelope : null;
    default:
      return null;
  }
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Upper-bound size of a state message, leaving room for a few recently departed senders. */
export function stateBytes(session: Session): number {
  const seqs = Object.fromEntries(session.participants.map((person) => [person.id, 999_999]));
  return byteLength(JSON.stringify({ v: 1, from: session.hostId, seq: 999_999, t: 'state', session, seqs })) + 300;
}

export function createClientId(): string {
  return randomId('abcdefghijklmnopqrstuvwxyz0123456789', 12);
}

interface Logged { envelope: Envelope; at: number }

/**
 * One participant's view of a room. Every client applies the same ordered event stream
 * (join/vote/reset/leave) to its own copy of the session. The host publishes full state
 * when someone joins or reconnects, when votes are revealed, and when it removes a
 * participant, so clients converge even if they missed messages. There are no
 * heartbeats: an idle room publishes nothing.
 */
export class Room {
  readonly selfId = createClientId();
  readonly code: string;
  readonly isHost: boolean;
  private name: string;
  private transport: Transport;
  private callbacks: RoomCallbacks;
  private clock: Clock;
  private session?: Session;
  private hostId?: string;
  private seq = 0;
  private lastSeq = new Map<string, number>();
  private log: Logged[] = [];
  private lastSeen = new Map<string, number>();
  private lastResync = -Infinity;
  private lastHostResync = -Infinity;
  private intent?: { round: number; value: Vote; at: number };
  private joined = false;
  private everReady = false;
  private stopped = false;
  private joinAttempts = 0;
  private joinTimer?: unknown;
  private connectTimer?: unknown;
  private gapTimer?: unknown;

  constructor(options: RoomOptions) {
    this.code = options.code;
    this.name = options.name;
    this.isHost = options.host;
    this.transport = options.transport;
    this.callbacks = options.callbacks;
    this.clock = options.clock ?? realClock;
    if (this.isHost) {
      this.hostId = this.selfId;
      this.session = createSession(this.selfId, this.name);
    }
    this.connectTimer = this.clock.setTimeout(() => this.end(
      'Could not connect to ntfy.sh within 20 seconds. Check your connection, or whether a network filter blocks ntfy.sh, and try again.',
    ), CONNECT_TIMEOUT_MS);
    this.transport.connect({
      onReady: () => this.ready(),
      onMessage: (text) => this.receive(text),
      onDown: () => {
        if (!this.stopped && this.everReady) this.callbacks.onStatus('reconnecting');
      },
    });
  }

  castVote(value: Vote): Promise<boolean> {
    if (!this.session || !this.joined || this.session.revealed || !isVote(value)) return Promise.resolve(false);
    this.intent = { round: this.session.round, value, at: this.clock.now() };
    return this.publish({ t: 'vote', round: this.session.round, value });
  }

  resetRound(): Promise<boolean> {
    if (!this.session || !this.joined || !this.session.revealed) return Promise.resolve(false);
    return this.publish({ t: 'reset', round: this.session.round });
  }

  /**
   * Host only: removes someone who left without saying goodbye (e.g. their laptop slept),
   * so the round can reveal. If they are actually still here, their browser rejoins.
   */
  removeParticipant(id: string): boolean {
    if (!this.isHost || !this.session || this.stopped || id === this.selfId ||
        !this.session.participants.some((person) => person.id === id)) return false;
    leave(this.session, id);
    this.publishState();
    this.emit();
    return true;
  }

  /** Announces departure (best effort, survives page unload) and stops. */
  leave(): void {
    if (this.stopped) return;
    if (this.everReady) void this.publish({ t: this.isHost ? 'end' : 'leave' }, true);
    this.close();
  }

  close(): void {
    this.stopped = true;
    for (const timer of [this.joinTimer, this.connectTimer, this.gapTimer]) {
      if (timer !== undefined) this.clock.clearTimeout(timer);
    }
    this.transport.close();
  }

  private ready(): void {
    if (this.stopped) return;
    const reconnect = this.everReady;
    this.everReady = true;
    this.clock.clearTimeout(this.connectTimer);
    if (reconnect) this.callbacks.onStatus('live');
    if (this.isHost) {
      if (!reconnect) {
        this.joined = true;
        this.callbacks.onReady();
        this.emit();
      } else {
        // Messages may have been missed while disconnected: publish state so guests can
        // detect and re-send anything the host did not receive.
        this.publishState();
      }
    } else if (!reconnect) {
      this.sendJoin();
    } else if (this.joined) {
      this.resync(true);
    }
  }

  private sendJoin(): void {
    this.joinAttempts += 1;
    void this.publish({ t: 'join', name: this.name }).then((sent) => {
      if (!sent && !this.joined) this.end('Could not send your join request to ntfy.sh. See the message above and try again.');
    });
    this.joinTimer = this.clock.setTimeout(() => {
      if (this.joined || this.stopped) return;
      if (this.joinAttempts < JOIN_ATTEMPTS) {
        this.sendJoin();
      } else {
        this.end(`No host answered in room ${this.code}. Check the code, and make sure the host still has the room open.`);
      }
    }, JOIN_TIMEOUT_MS);
  }

  /** Asks the host for full state. */
  private resync(force = false): void {
    const now = this.clock.now();
    if (this.stopped || (!force && now - this.lastResync < RESYNC_COOLDOWN_MS)) return;
    this.lastResync = now;
    void this.publish({ t: 'join', name: this.name });
  }

  private async publish(body: Body, keepalive = false): Promise<boolean> {
    if (this.stopped && !keepalive) return false;
    const seq = ++this.seq;
    const text = JSON.stringify({ v: 1, from: this.selfId, seq, ...body });
    try {
      await this.transport.publish(text, keepalive ? { keepalive } : undefined);
      return true;
    } catch (error) {
      // Reuse the sequence number if nothing was sent after it, so others do not see a gap.
      if (this.seq === seq) this.seq -= 1;
      if (!this.stopped) {
        this.callbacks.onError(error instanceof Error ? error.message : 'Could not send to ntfy.sh.');
      }
      return false;
    }
  }

  private publishState(): void {
    if (!this.isHost || !this.session || this.stopped) return;
    const now = this.clock.now();
    const ids = new Set(this.session.participants.map((person) => person.id));
    const seqs: Record<string, number> = {};
    for (const [id, seq] of this.lastSeq) {
      if (ids.has(id) || now - (this.lastSeen.get(id) ?? 0) < RECENT_SENDER_MS) seqs[id] = seq;
    }
    void this.publish({ t: 'state', session: this.session, seqs });
  }

  private receive(text: string): void {
    if (this.stopped) return;
    const envelope = parseEnvelope(text);
    if (!envelope) return;
    const last = this.lastSeq.get(envelope.from);
    if (last !== undefined && envelope.seq <= last) return;
    this.lastSeq.set(envelope.from, envelope.seq);
    const now = this.clock.now();
    this.log.push({ envelope, at: now });
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.lastSeen.set(envelope.from, now);
    if (last !== undefined && envelope.seq > last + 1 && envelope.from !== this.selfId) this.gap();

    if (this.isHost) this.hostReceive(envelope);
    else this.guestReceive(envelope);
  }

  private gap(): void {
    if (this.isHost) {
      const now = this.clock.now();
      if (now - this.lastHostResync < RESYNC_COOLDOWN_MS) return;
      this.lastHostResync = now;
      this.publishState();
    } else if (this.joined && this.gapTimer === undefined) {
      // Wait briefly: the host may already be publishing state for everyone.
      this.gapTimer = this.clock.setTimeout(() => {
        this.gapTimer = undefined;
        this.resync();
      }, GAP_RESYNC_DELAY_MS);
    }
  }

  private hostReceive(envelope: Envelope): void {
    const session = this.session!;
    if (envelope.from === this.selfId) {
      if (envelope.t === 'vote' || envelope.t === 'reset') this.apply(envelope);
      return;
    }
    if (envelope.t === 'state' || envelope.t === 'end') {
      this.end(`Another room is already using code ${this.code}. Create a new room to get a different code.`);
      return;
    }
    if (envelope.t === 'join') {
      const known = session.participants.some((person) => person.id === envelope.from);
      if (!known) {
        const trial = cloneSession(session);
        join(trial, envelope.from, envelope.name.trim());
        if (trial.participants.length > MAX_PARTICIPANTS || stateBytes(trial) > MAX_MESSAGE_BYTES) {
          void this.publish({ t: 'full', to: envelope.from });
          return;
        }
      }
      this.apply(envelope);
      this.publishState();
      return;
    }
    this.apply(envelope);
  }

  private guestReceive(envelope: Envelope): void {
    if (envelope.t === 'full' && envelope.to === this.selfId) {
      this.end('This room is full. Ask the host to create a room for a smaller group.');
      return;
    }
    if (envelope.t === 'state') {
      if (this.hostId === undefined ? envelope.session.hostId === envelope.from &&
          envelope.session.participants.some((person) => person.id === this.selfId)
        : envelope.from === this.hostId) {
        this.adopt(envelope);
      }
      return;
    }
    if (!this.joined) return;
    if (envelope.from === this.hostId && (envelope.t === 'end' || envelope.t === 'leave')) {
      this.end('The host left, so this room has ended. You can create a new room from the home page.');
      return;
    }
    this.apply(envelope);
  }

  /** Applies a membership or voting event to the local session. */
  private apply(envelope: Envelope): void {
    const session = this.session;
    if (!session) return;
    const wasRevealed = session.revealed;
    switch (envelope.t) {
      case 'join':
        join(session, envelope.from, envelope.name.trim());
        break;
      case 'vote':
        vote(session, envelope.from, envelope.round, envelope.value);
        break;
      case 'reset':
        reset(session, envelope.round);
        break;
      case 'leave':
        if (envelope.from !== session.hostId) leave(session, envelope.from);
        break;
      case 'full':
        if (envelope.to !== session.hostId) leave(session, envelope.to);
        break;
      default:
        return;
    }
    // Clients reveal locally; the host's published result settles any ordering differences.
    if (this.isHost && !wasRevealed && session.revealed) this.publishState();
    this.emit();
  }

  private adopt(envelope: Extract<Envelope, { t: 'state' }>): void {
    const now = this.clock.now();
    const firstJoin = !this.joined;
    this.hostId = envelope.session.hostId;
    if (this.gapTimer !== undefined) {
      this.clock.clearTimeout(this.gapTimer);
      this.gapTimer = undefined;
    }
    this.session = cloneSession(envelope.session);
    this.joined = true;
    // Re-apply recent events that reached us before the host's state but that the host had not seen.
    for (const { envelope: event, at } of this.log) {
      if (event === envelope || event.t === 'state' || now - at > REPLAY_WINDOW_MS) continue;
      if (event.seq > (envelope.seqs[event.from] ?? 0)) this.applyQuietly(event);
    }
    for (const [id, seq] of Object.entries(envelope.seqs)) {
      this.lastSeq.set(id, Math.max(this.lastSeq.get(id) ?? 0, seq));
    }
    if (firstJoin) {
      this.clock.clearTimeout(this.joinTimer);
      this.callbacks.onReady();
    }
    const me = this.session.participants.find((person) => person.id === this.selfId);
    const hostCopy = envelope.session.participants.find((person) => person.id === this.selfId);
    if (!me) {
      this.callbacks.onNotice('The host removed you from the table. Rejoining...');
      this.resync(true);
    } else if (this.intent && !envelope.session.revealed && this.intent.round === envelope.session.round &&
               hostCopy?.vote !== this.intent.value && now - this.intent.at > VOTE_REPAIR_AFTER_MS) {
      // The host's state lacks our vote (sent long enough ago to have arrived), so it was missed.
      this.intent.at = now;
      void this.publish({ t: 'vote', round: this.intent.round, value: this.intent.value });
    }
    this.emit();
  }

  private applyQuietly(envelope: Envelope): void {
    const session = this.session!;
    if (envelope.t === 'join') join(session, envelope.from, envelope.name.trim());
    else if (envelope.t === 'vote') vote(session, envelope.from, envelope.round, envelope.value);
    else if (envelope.t === 'reset') reset(session, envelope.round);
    else if (envelope.t === 'leave' && envelope.from !== session.hostId) leave(session, envelope.from);
    else if (envelope.t === 'full' && envelope.to !== session.hostId) leave(session, envelope.to);
  }

  private emit(): void {
    if (!this.session || !this.joined || this.stopped) return;
    const me = this.session.participants.find((person) => person.id === this.selfId);
    if (!me) return;
    this.callbacks.onState(snapshot(this.session), me.vote);
  }

  private end(message: string): void {
    if (this.stopped) return;
    this.close();
    this.callbacks.onEnd(message);
  }
}
