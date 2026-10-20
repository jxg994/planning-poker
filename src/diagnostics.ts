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
        Object.assign(report, summarizeStats(stats));
      } catch (error) {
        console.warn('Could not collect WebRTC diagnostics:', error);
      }
      if (this.stopped || finished) return;
      this.publish();
      if (pc.signalingState === 'closed') cleanup();
    };
    const onChange = () => { void sample(); };
    const onError = (event: RTCPeerConnectionIceErrorEvent) => {
      errors.add(event.errorCode);
      onChange();
    };
    const events = ['signalingstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'connectionstatechange', 'datachannel'];
    events.forEach((event) => pc.addEventListener(event, onChange));
    pc.addEventListener('icecandidateerror', onError);
    const timer = setInterval(onChange, 1_000);
    const cleanup = () => {
      finished = true;
      clearInterval(timer);
      events.forEach((event) => pc.removeEventListener(event, onChange));
      pc.removeEventListener('icecandidateerror', onError);
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
