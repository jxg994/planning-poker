import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, isName, isPeerId, isSnapshot, join, leave, OPTIONS, reset, snapshot, vote,
} from '../src/state.ts';

function room() {
  const session = createSession('host', 'Alex');
  join(session, 'guest', 'Sam');
  return session;
}

test('the exact voting options include zero', () => {
  assert.deepEqual(OPTIONS, [0, 1, 2, 3, 5, 8, 13, 21]);
});

test('votes stay hidden until every participant has voted, including zero votes', () => {
  const session = room();
  vote(session, 'host', 1, 0);
  assert.equal(session.revealed, false);
  assert.deepEqual(snapshot(session).participants[0], {
    id: 'host', name: 'Alex', vote: null, hasVoted: true,
  });
  vote(session, 'guest', 1, 13);
  assert.equal(session.revealed, true);
  assert.deepEqual(snapshot(session).participants.map((person) => person.vote), [0, 13]);
});

test('a participant can change their vote before reveal, but not after', () => {
  const session = room();
  vote(session, 'host', 1, 3);
  vote(session, 'host', 1, 8);
  vote(session, 'guest', 1, 5);
  assert.equal(vote(session, 'host', 1, 21), false);
  assert.equal(session.participants[0].vote, 8);
});

test('reset clears votes, increments the round, and rejects stale messages', () => {
  const session = room();
  assert.equal(reset(session, 1), false);
  vote(session, 'host', 1, 2);
  vote(session, 'guest', 1, 3);
  assert.equal(reset(session, 1), true);
  assert.equal(session.round, 2);
  assert.equal(session.revealed, false);
  assert.ok(session.participants.every((person) => person.vote === null));
  assert.equal(vote(session, 'guest', 1, 8), false);
  assert.equal(reset(session, 1), false);
  assert.equal(vote(session, 'guest', 2, 8), true);
});

test('disconnected participants no longer block reveal', () => {
  const session = room();
  vote(session, 'host', 1, 5);
  leave(session, 'guest');
  assert.equal(session.revealed, true);
  assert.equal(session.participants.length, 1);
});

test('a participant joining mid-round counts toward reveal', () => {
  const session = room();
  vote(session, 'host', 1, 2);
  join(session, 'third', 'Taylor');
  vote(session, 'guest', 1, 3);
  assert.equal(session.revealed, false);
  vote(session, 'third', 1, 5);
  assert.equal(session.revealed, true);
});

test('joining after reveal preserves results and includes the newcomer in the next round', () => {
  const session = room();
  vote(session, 'host', 1, 2);
  vote(session, 'guest', 1, 3);
  join(session, 'third', 'Taylor');
  assert.equal(session.revealed, true);
  assert.equal(vote(session, 'third', 1, 5), false);
  assert.equal(isSnapshot(snapshot(session)), true);
  reset(session, 1);
  assert.equal(vote(session, 'third', 2, 5), true);
});

test('a solo host reveals after their vote', () => {
  const session = createSession('host', 'Alex');
  vote(session, 'host', 1, 1);
  assert.equal(session.revealed, true);
});

test('duplicate joins and unknown voters do not change membership or votes', () => {
  const session = room();
  join(session, 'guest', 'Imposter');
  assert.equal(session.participants.length, 2);
  assert.equal(session.participants[1].name, 'Sam');
  assert.equal(vote(session, 'unknown', 1, 3), false);
});

test('snapshots do not reference mutable host state', () => {
  const session = room();
  const publicState = snapshot(session);
  publicState.participants[0].name = 'Changed';
  assert.equal(session.participants[0].name, 'Alex');
});

test('names, peer IDs, and network snapshots are validated', () => {
  assert.equal(isName('   '), false);
  assert.equal(isName('a'.repeat(41)), false);
  assert.equal(isPeerId('../bad-id'), false);
  assert.equal(isPeerId('peer-123_abc'), true);
  const valid = snapshot(room());
  assert.equal(isSnapshot(valid), true);
  assert.equal(isSnapshot({ ...valid, round: 0 }), false);
  assert.equal(isSnapshot({ ...valid, participants: [] }), false);
  assert.equal(isSnapshot({ ...valid, participants: [valid.participants[0], valid.participants[0]] }), false);
  assert.equal(isSnapshot({ ...valid, participants: [{ ...valid.participants[0], vote: 5 }] }), false);
  assert.equal(isSnapshot({ ...valid, hostId: 'missing' }), false);
});
