import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEARTBEAT_MS, JOIN_TIMEOUT_MS, MAX_PARTICIPANTS, parseEnvelope, Room, TICK_MS, TIMEOUT_MS,
} from '../src/room.ts';
import type { Clock, RoomCallbacks, Transport, TransportHandlers } from '../src/room.ts';
import type { Snapshot, Vote } from '../src/state.ts';

class ManualClock implements Clock {
  time = 1_000_000;
  private timers = new Map<number, { at: number; callback: () => void }>();
  private next = 1;
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }
  clearTimeout(id: unknown): void { this.timers.delete(id as number); }
  /** Advances time, firing due timers in order. */
  async advance(ms: number, bus: Bus): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
      await bus.flush();
    }
    this.time = end;
    await bus.flush();
  }
}

/** An in-order, in-memory topic standing in for ntfy.sh. */
class Bus {
  published: string[] = [];
  failures: Error[] = [];
  private subscribers = new Set<FakeTransport>();
  private queue: (() => void)[] = [];

  transport(): FakeTransport { return new FakeTransport(this); }
  subscribe(transport: FakeTransport): void {
    this.subscribers.add(transport);
    this.queue.push(() => transport.handlers?.onReady());
  }
  unsubscribe(transport: FakeTransport): void { this.subscribers.delete(transport); }
  publish(body: string): Promise<void> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    this.published.push(body);
    const recipients = [...this.subscribers];
    this.queue.push(() => recipients.forEach((subscriber) => {
      if (this.subscribers.has(subscriber)) subscriber.handlers?.onMessage(body);
    }));
    return Promise.resolve();
  }
  inject(envelope: object): void {
    const body = JSON.stringify(envelope);
    const recipients = [...this.subscribers];
    this.queue.push(() => recipients.forEach((subscriber) => subscriber.handlers?.onMessage(body)));
  }
  async flush(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const task = this.queue.shift();
      if (!task) {
        await new Promise((resolve) => setImmediate(resolve));
        if (!this.queue.length) return;
        continue;
      }
      task();
    }
    throw new Error('Bus did not settle');
  }
  types(): string[] { return this.published.map((body) => JSON.parse(body).t); }
}

class FakeTransport implements Transport {
  handlers?: TransportHandlers;
  closed = false;
  private bus: Bus;
  constructor(bus: Bus) { this.bus = bus; }
  connect(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.bus.subscribe(this);
  }
  publish(body: string): Promise<void> {
    return this.bus.publish(body);
  }
  close(): void {
    this.closed = true;
    this.bus.unsubscribe(this);
  }
  /** Simulates a dropped subscription; messages published meanwhile are missed. */
  down(): void {
    this.bus.unsubscribe(this);
    this.handlers?.onDown();
  }
  up(): void { this.bus.subscribe(this); }
}

interface Client {
  room: Room;
  transport: FakeTransport;
  view?: Snapshot;
  myVote: Vote | null;
  ready: boolean;
  ended?: string;
  errors: string[];
  notices: string[];
  statuses: string[];
}

function client(bus: Bus, clock: ManualClock, name: string, host: boolean, code = 'ABCDE'): Client {
  const transport = bus.transport();
  const result = { transport, myVote: null, ready: false, errors: [], notices: [], statuses: [] } as unknown as Client;
  const callbacks: RoomCallbacks = {
    onReady: () => { result.ready = true; },
    onState: (view, mine) => { result.view = view; result.myVote = mine; },
    onStatus: (status) => { result.statuses.push(status); },
    onNotice: (message) => { result.notices.push(message); },
    onError: (message) => { result.errors.push(message); },
    onEnd: (message) => { result.ended = message; },
  };
  result.room = new Room({ code, name, host, transport, callbacks, clock });
  return result;
}

async function setup(guests = 2) {
  const bus = new Bus();
  const clock = new ManualClock();
  const host = client(bus, clock, 'Alex', true);
  await bus.flush();
  const others: Client[] = [];
  for (const name of ['Sam', 'Taylor', 'Jo'].slice(0, guests)) {
    const guest = client(bus, clock, name, false);
    await bus.flush();
    others.push(guest);
  }
  return { bus, clock, host, guests: others };
}

function names(view?: Snapshot): string[] {
  return view?.participants.map((person) => person.name) ?? [];
}

test('create, two joins, one vote each, and reveal use 8 published messages', async () => {
  const { bus, host, guests: [sam, taylor] } = await setup();
  assert.ok(host.ready && sam.ready && taylor.ready);
  for (const person of [host, sam, taylor]) assert.deepEqual(names(person.view), ['Alex', 'Sam', 'Taylor']);
  assert.deepEqual(bus.types(), ['join', 'state', 'join', 'state']);

  await host.room.castVote(5);
  await bus.flush();
  await sam.room.castVote(8);
  await bus.flush();
  // Before reveal, every view shows who voted but no values.
  for (const person of [host, sam, taylor]) {
    assert.equal(person.view!.revealed, false);
    assert.deepEqual(person.view!.participants.map((p) => [p.hasVoted, p.vote]), [[true, null], [true, null], [false, null]]);
  }
  assert.equal(sam.myVote, 8);
  await taylor.room.castVote(0);
  await bus.flush();
  for (const person of [host, sam, taylor]) {
    assert.equal(person.view!.revealed, true);
    assert.deepEqual(person.view!.participants.map((p) => p.vote), [5, 8, 0]);
  }
  assert.deepEqual(bus.types(), ['join', 'state', 'join', 'state', 'vote', 'vote', 'vote', 'state']);
});

test('votes can change before reveal; anyone resets after reveal; stale actions are ignored', async () => {
  const { bus, host, guests: [sam] } = await setup(1);
  assert.equal(await sam.room.resetRound(), false);
  await sam.room.castVote(3);
  await bus.flush();
  await sam.room.castVote(13);
  await bus.flush();
  assert.equal(sam.myVote, 13);
  await host.room.castVote(1);
  await bus.flush();
  assert.deepEqual(sam.view!.participants.map((p) => p.vote), [1, 13]);
  assert.equal(await sam.room.castVote(21), false);
  await sam.room.resetRound();
  await host.room.resetRound(); // Concurrent reset of the same round must not skip a round.
  await bus.flush();
  for (const person of [host, sam]) {
    assert.equal(person.view!.round, 2);
    assert.equal(person.view!.revealed, false);
    assert.equal(person.myVote, null);
  }
});

test('a late joiner during a round counts toward reveal, and after reveal waits for the next round', async () => {
  const { bus, clock, host, guests: [sam] } = await setup(1);
  await host.room.castVote(2);
  await bus.flush();
  const taylor = client(bus, clock, 'Taylor', false);
  await bus.flush();
  assert.deepEqual(taylor.view!.participants.map((p) => p.hasVoted), [true, false, false]);
  await sam.room.castVote(3);
  await taylor.room.castVote(5);
  await bus.flush();
  assert.equal(host.view!.revealed, true);

  const jo = client(bus, clock, 'Jo', false);
  await bus.flush();
  assert.equal(jo.view!.revealed, true);
  assert.deepEqual(jo.view!.participants.map((p) => p.vote), [2, 3, 5, null]);
  assert.equal(await jo.room.castVote(8), false);
  await jo.room.resetRound();
  await bus.flush();
  assert.equal(host.view!.round, 2);
  assert.equal(host.view!.participants.length, 4);
});

test('explicit departures update everyone; a leaver who was the last non-voter triggers reveal', async () => {
  const { bus, host, guests: [sam, taylor] } = await setup();
  await host.room.castVote(3);
  await sam.room.castVote(5);
  await bus.flush();
  taylor.room.leave();
  await bus.flush();
  for (const person of [host, sam]) {
    assert.deepEqual(names(person.view), ['Alex', 'Sam']);
    assert.equal(person.view!.revealed, true);
  }
  host.room.leave();
  await bus.flush();
  assert.match(sam.ended!, /host left/);
});

test('joining a room with no host gives up after two attempts with an actionable error', async () => {
  const bus = new Bus();
  const clock = new ManualClock();
  const guest = client(bus, clock, 'Sam', false, 'ZZZZZ');
  await bus.flush();
  await clock.advance(JOIN_TIMEOUT_MS * 2 + 1, bus);
  assert.match(guest.ended!, /No host answered in room ZZZZZ/);
  assert.deepEqual(bus.types(), ['join', 'join']);
});

test('publish failures are surfaced and do not cause resync traffic', async () => {
  const { bus, clock, host, guests: [sam] } = await setup(1);
  bus.failures.push(new Error('ntfy.sh refused the message because a rate limit was reached (HTTP 429).'));
  assert.equal(await sam.room.castVote(5), false);
  await bus.flush();
  assert.match(sam.errors[0], /HTTP 429/);
  assert.equal(host.view!.participants[1].hasVoted, false);
  const before = bus.published.length;
  assert.equal(await sam.room.castVote(5), true);
  await clock.advance(5_000, bus);
  assert.equal(bus.published.length, before + 1, 'retrying reuses the sequence number, so no gap is detected');
  assert.equal(host.view!.participants[1].hasVoted, true);
});

test('a failed join publish ends the attempt with the server error', async () => {
  const bus = new Bus();
  const clock = new ManualClock();
  client(bus, clock, 'Alex', true);
  await bus.flush();
  bus.failures.push(new Error('ntfy.sh rejected the message (HTTP 500).'));
  const guest = client(bus, clock, 'Sam', false);
  await bus.flush();
  assert.match(guest.errors[0], /HTTP 500/);
  assert.match(guest.ended!, /Could not send your join request/);
});

test('a guest that reconnects resyncs instead of assuming missed messages', async () => {
  const { bus, host, guests: [sam, taylor] } = await setup();
  sam.transport.down();
  assert.deepEqual(sam.statuses, ['reconnecting']);
  await taylor.room.castVote(8);
  await host.room.castVote(8);
  await bus.flush();
  assert.equal(sam.view!.participants[2].hasVoted, false, 'Sam missed the votes while offline');
  sam.transport.up();
  await bus.flush();
  assert.deepEqual(sam.statuses, ['reconnecting', 'live']);
  assert.deepEqual(sam.view!.participants.map((p) => p.hasVoted), [true, false, true]);
  await sam.room.castVote(1);
  await bus.flush();
  assert.deepEqual(sam.view!.participants.map((p) => p.vote), [8, 1, 8]);
});

test('a reconnecting host republishes state and guests re-send votes it missed', async () => {
  const { bus, clock, host, guests: [sam] } = await setup(1);
  host.transport.down();
  await sam.room.castVote(5);
  await bus.flush();
  assert.equal(host.view!.participants[1].hasVoted, false);
  await clock.advance(6_000, bus);
  host.transport.up();
  await bus.flush();
  assert.equal(host.view!.participants[1].hasVoted, true);
  await host.room.castVote(5);
  await bus.flush();
  assert.equal(sam.view!.revealed, true);
});

test('a guest that missed another guest\'s message detects the gap and resyncs', async () => {
  const { bus, clock, host, guests: [sam, taylor] } = await setup();
  await taylor.room.castVote(3); // Taylor seq 2
  await bus.flush();
  sam.transport.down();
  await taylor.room.castVote(5); // seq 3, missed by Sam
  await bus.flush();
  sam.transport.up = () => { (bus as unknown as { subscribers: Set<FakeTransport> }).subscribers.add(sam.transport); };
  sam.transport.up(); // silently resumed, without a ready event
  await taylor.room.castVote(8); // seq 4: Sam sees a gap
  await bus.flush();
  await clock.advance(4_000, bus);
  assert.equal(host.view!.participants[2].hasVoted, true);
  assert.deepEqual(sam.view!.participants.map((p) => p.hasVoted), [false, false, true]);
  assert.ok(bus.types().slice(-2).join() === 'join,state');
});

test('state replay keeps events that reached a guest before the host\'s state', async () => {
  const { bus, host, guests: [sam] } = await setup(1);
  const hostSeq = JSON.parse(bus.published[1]).seq;
  const outsider = 'outsider00001';
  bus.inject({ v: 1, from: outsider, seq: 1, t: 'join', name: 'Late' });
  // A state message the host composed before seeing the join (as if it crossed in flight).
  bus.inject({
    v: 1, from: host.room.selfId, seq: hostSeq + 1, t: 'state',
    session: { hostId: host.room.selfId, round: 1, revealed: false, participants: [
      { id: host.room.selfId, name: 'Alex', vote: null }, { id: sam.room.selfId, name: 'Sam', vote: null },
    ] },
    seqs: { [host.room.selfId]: hostSeq, [sam.room.selfId]: 1 },
  });
  await bus.flush();
  assert.deepEqual(names(sam.view), ['Alex', 'Sam', 'Late']);
});

test('silent departures are removed after the timeout, and heartbeat traffic stays small', async () => {
  const { bus, clock, host, guests: [sam, taylor] } = await setup();
  await host.room.castVote(3);
  await sam.room.castVote(3);
  await bus.flush();
  taylor.transport.close(); // vanished without a leave message
  (taylor.room as unknown as { stopped: boolean }).stopped = true;
  const before = bus.published.length;
  await clock.advance(TIMEOUT_MS + TICK_MS * 2, bus);
  for (const person of [host, sam]) {
    assert.deepEqual(names(person.view), ['Alex', 'Sam']);
    assert.equal(person.view!.revealed, true);
  }
  assert.match(host.notices.at(-1)!, /Taylor stopped responding/);
  assert.equal(sam.ended, undefined);
  const hour = 3_600_000;
  const start = bus.published.length;
  await clock.advance(hour, bus);
  const perHour = bus.published.length - start;
  assert.ok(perHour <= 2 * Math.ceil(hour / HEARTBEAT_MS) + 2, `idle traffic was ${perHour} messages per hour`);
  assert.ok(bus.published.length - before > 0);
});

test('guests end the room when the host goes silent', async () => {
  const { bus, clock, host, guests: [sam] } = await setup(1);
  host.room.close();
  await clock.advance(TIMEOUT_MS + TICK_MS + JOIN_TIMEOUT_MS * 3, bus);
  assert.match(sam.ended!, /host stopped responding/);
});

test('a second host on the same code is detected', async () => {
  const bus = new Bus();
  const clock = new ManualClock();
  const first = client(bus, clock, 'Alex', true);
  await bus.flush();
  const second = client(bus, clock, 'Blair', true);
  await bus.flush();
  const guest = client(bus, clock, 'Sam', false);
  await bus.flush();
  assert.ok([first.ended, second.ended].some((message) => /Another room is already using code ABCDE/.test(message ?? '')));
  assert.ok(guest.ready);
});

test('rooms refuse joins beyond the participant cap', async () => {
  const bus = new Bus();
  const clock = new ManualClock();
  const host = client(bus, clock, 'Host', true);
  await bus.flush();
  const guests: Client[] = [];
  for (let i = 1; i <= MAX_PARTICIPANTS; i++) {
    guests.push(client(bus, clock, `Guest ${i}`, false));
    await bus.flush();
  }
  assert.equal(host.view!.participants.length, MAX_PARTICIPANTS);
  assert.match(guests.at(-1)!.ended!, /room is full/);
  assert.equal(guests[0].view!.participants.length, MAX_PARTICIPANTS);
  for (const body of bus.published) assert.ok(new TextEncoder().encode(body).length <= 4_096);
});

test('a backgrounded tab whose timers paused resyncs rather than dropping everyone', async () => {
  const { bus, clock, host, guests: [sam] } = await setup(1);
  clock.time += TIMEOUT_MS * 2; // Timers frozen, then resumed.
  await clock.advance(TICK_MS, bus);
  assert.deepEqual(names(host.view), ['Alex', 'Sam']);
  assert.equal(sam.ended, undefined);
  assert.equal(host.ended, undefined);
});

test('malformed or foreign messages on the topic are ignored', () => {
  assert.equal(parseEnvelope('hello'), null);
  assert.equal(parseEnvelope('{"v":1,"from":"x","seq":1,"t":"vote","round":1,"value":4}'), null);
  assert.equal(parseEnvelope('{"v":2,"from":"x","seq":1,"t":"ping"}'), null);
  assert.equal(parseEnvelope('{"v":1,"from":"../x","seq":1,"t":"ping"}'), null);
  assert.equal(parseEnvelope('{"v":1,"from":"x","seq":0,"t":"ping"}'), null);
  assert.equal(parseEnvelope('{"v":1,"from":"x","seq":1,"t":"join","name":"   "}'), null);
  assert.ok(parseEnvelope('{"v":1,"from":"x","seq":1,"t":"vote","round":1,"value":0}'));
});
