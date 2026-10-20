import { isRecord } from './state.ts';

export function summarizeStats(stats: RTCStatsReport) {
  const localTypes = new Set<string>();
  const remoteTypes = new Set<string>();
  const pairs: { state: string; nominated: boolean; requestsSent: number; responsesReceived: number }[] = [];
  stats.forEach((value: unknown) => {
    if (!isRecord(value)) return;
    if (typeof value.candidateType === 'string') {
      if (value.type === 'local-candidate') localTypes.add(value.candidateType);
      if (value.type === 'remote-candidate') remoteTypes.add(value.candidateType);
    }
    if (value.type === 'candidate-pair') {
      pairs.push({
        state: typeof value.state === 'string' ? value.state : 'unknown',
        nominated: value.nominated === true,
        requestsSent: typeof value.requestsSent === 'number' ? value.requestsSent : 0,
        responsesReceived: typeof value.responsesReceived === 'number' ? value.responsesReceived : 0,
      });
    }
  });
  return {
    localCandidateTypes: [...localTypes].sort(),
    remoteCandidateTypes: [...remoteTypes].sort(),
    candidatePairs: pairs,
  };
}

export class ConnectionDiagnostics {
  private reports: Record<string, unknown>[] = [];
  private cleanups = new Set<() => void>();
  private stopped = false;
  private signaling = 'Contacting PeerJS signaling service';
  private update: (text: string) => void;

  constructor(update: (text: string) => void) {
    this.update = update;
    this.publish();
  }

  setSignaling(message: string): void {
    if (this.stopped) return;
    this.signaling = message;
    this.publish();
  }

  watch(pc: RTCPeerConnection, channelState: () => string, label: string): void {
    const report: Record<string, unknown> = { label };
    const errors = new Set<number>();
    const localTypes = new Set<string>();
    const remoteTypes = new Set<string>();
    const history: Record<string, unknown>[] = [];
    const candidateCalls = { attempted: 0, accepted: 0, rejected: 0 };
    const started = Date.now();
    const record = (event: string, detail: Record<string, unknown> = {}) => {
      if (this.stopped || finished) return;
      history.push({ elapsedMs: Date.now() - started, event, ...detail });
      if (history.length > 100) history.shift();
      this.publish();
    };
    Object.assign(report, {
      history,
      remoteCandidateCalls: candidateCalls,
      candidateObservation: 'Calls observed after the PeerJS connection event; candidates embedded in SDP are not addIceCandidate calls.',
    });
    this.reports.push(report);
    if (this.reports.length > 6) this.reports.shift();
    let finished = false;
    const sample = async () => {
      if (this.stopped || finished) return;
      Object.assign(report, {
        localDescription: pc.localDescription?.type ?? 'none',
        remoteDescription: pc.remoteDescription?.type ?? 'none',
        signaling: pc.signalingState,
        ice: pc.iceConnectionState,
        gathering: pc.iceGatheringState,
        connection: pc.connectionState,
        dataChannel: channelState(),
        stunErrorCodes: [...errors],
      });
      try {
        const stats = await pc.getStats();
        if (this.stopped || finished) return;
        const summary = summarizeStats(stats);
        summary.localCandidateTypes.forEach((type) => localTypes.add(type));
        summary.remoteCandidateTypes.forEach((type) => remoteTypes.add(type));
        if (summary.candidatePairs.length) report.lastNonemptyCandidatePairs = summary.candidatePairs;
        Object.assign(report, summary, {
          everLocalCandidateTypes: [...localTypes].sort(),
          everRemoteCandidateTypes: [...remoteTypes].sort(),
        });
      } catch (error) {
        console.warn('Could not collect WebRTC diagnostics:', error);
      }
      if (this.stopped || finished) return;
      this.publish();
      if (pc.signalingState === 'closed') cleanup();
    };
    const onChange = (event?: Event) => {
      if (event) record(event.type, {
        ice: pc.iceConnectionState,
        connection: pc.connectionState,
        signaling: pc.signalingState,
        dataChannel: channelState(),
      });
      void sample();
    };
    const candidateType = (candidate?: RTCIceCandidateInit | null) => {
      const match = candidate?.candidate?.match(/ typ (host|srflx|prflx|relay)(?: |$)/);
      return match?.[1] ?? 'unknown';
    };
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        const type = candidateType(event.candidate);
        localTypes.add(type);
        record('local-candidate-generated', { candidateType: type });
      } else record('local-candidates-complete');
      void sample();
    };
    // Instrument only this connection; preserve the browser's promise and errors.
    const originalAdd = pc.addIceCandidate;
    function observedAdd(candidate?: RTCIceCandidateInit | null): Promise<void>;
    function observedAdd(candidate: RTCIceCandidateInit | null, success: VoidFunction, failure: RTCPeerConnectionErrorCallback): Promise<void>;
    function observedAdd(candidate?: RTCIceCandidateInit | null, success?: VoidFunction, failure?: RTCPeerConnectionErrorCallback): Promise<void> {
      const type = candidateType(candidate);
      candidateCalls.attempted += 1;
      remoteTypes.add(type);
      record('remote-candidate-received', { candidateType: type });
      const result = success && failure
        ? originalAdd.call(pc, candidate ?? null, success, failure)
        : originalAdd.bind(pc)(candidate);
      void result.then(() => {
        candidateCalls.accepted += 1;
        record('remote-candidate-accepted', { candidateType: type });
      }, (error: unknown) => {
        candidateCalls.rejected += 1;
        record('remote-candidate-rejected', {
          candidateType: type,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      });
      return result;
    }
    pc.addIceCandidate = observedAdd;
    const onError = (event: RTCPeerConnectionIceErrorEvent) => {
      errors.add(event.errorCode);
      onChange();
    };
    const events = ['signalingstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'connectionstatechange', 'datachannel'];
    events.forEach((event) => pc.addEventListener(event, onChange));
    pc.addEventListener('icecandidateerror', onError);
    pc.addEventListener('icecandidate', onCandidate);
    const timer = setInterval(onChange, 1_000);
    const cleanup = () => {
      finished = true;
      clearInterval(timer);
      events.forEach((event) => pc.removeEventListener(event, onChange));
      pc.removeEventListener('icecandidateerror', onError);
      pc.removeEventListener('icecandidate', onCandidate);
      if (pc.addIceCandidate === observedAdd) pc.addIceCandidate = originalAdd;
      this.cleanups.delete(cleanup);
    };
    this.cleanups.add(cleanup);
    void sample();
  }

  private publish(): void {
    this.update(JSON.stringify({
      mode: 'Direct WebRTC; Google STUN only; no TURN relay',
      signaling: this.signaling,
      connections: this.reports,
    }, null, 2));
  }

  stop(): void {
    this.stopped = true;
    this.cleanups.forEach((cleanup) => cleanup());
  }
}
