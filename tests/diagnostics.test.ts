import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionDiagnostics, summarizeStats } from '../src/diagnostics.ts';

test('diagnostics expose candidate types and check counts without sensitive fields', () => {
  const stats = new Map([
    ['local', { type: 'local-candidate', candidateType: 'host', address: 'private-address', usernameFragment: 'secret' }],
    ['remote', { type: 'remote-candidate', candidateType: 'srflx', address: 'public-address' }],
    ['pair', { type: 'candidate-pair', state: 'in-progress', nominated: false, requestsSent: 238, responsesReceived: 0, localCandidateId: 'private-id' }],
  ]);
  const summary = summarizeStats(stats);
  assert.deepEqual(summary, {
    localCandidateTypes: ['host'],
    remoteCandidateTypes: ['srflx'],
    candidatePairs: [{ state: 'in-progress', nominated: false, requestsSent: 238, responsesReceived: 0 }],
  });
  assert.doesNotMatch(JSON.stringify(summary), /private-address|public-address|secret|private-id/);
});

test('diagnostics retain the final signaling report on shutdown', () => {
  const reports: string[] = [];
  const diagnostics = new ConnectionDiagnostics((text) => reports.push(text));
  diagnostics.setSignaling('Connected to PeerJS; peer ID assigned');
  diagnostics.stop();
  diagnostics.setSignaling('Should not appear');
  assert.equal(reports.length, 2);
  assert.match(reports[1], /Connected to PeerJS/);
});
