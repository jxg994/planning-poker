import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import {
  createSession, isName, isPeerId, isRecord, isSnapshot, isVote,
  join, leave, reset, snapshot, vote,
} from './state.ts';
import type { Session, Snapshot, Vote } from './state.ts';

interface Callbacks {
  onReady: (hostId: string, selfId: string) => void;
  onState: (state: Snapshot) => void;
  onNotice: (message: string) => void;
  onEnd: (message: string) => void;
}

interface Guest {
  connection: DataConnection;
  joined: boolean;
  lastSeen: number;
}

const HEARTBEAT_MS = 5_000;
const TIMEOUT_MS = 30_000;

export class PokerNetwork {
  private peer: Peer;
  private session?: Session;
  private hostConnection?: DataConnection;
  private guests = new Map<string, Guest>();
  private timer: ReturnType<typeof setInterval>;
  private deadline: ReturnType<typeof setTimeout>;
  private lastHostSeen = Date.now();
  private stopped = false;
  private ready = false;
  private current?: Snapshot;
  selfId = '';

  constructor(
    private name: string,
    private hostId: string | null,
    private callbacks: Callbacks,
  ) {
    // Use STUN only: no TURN relay or application server carries votes.
    this.peer = new Peer({
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    });
    this.deadline = setTimeout(() => {
      this.end('Could not connect within 30 seconds. The host may have left, or your network may block WebRTC. Try again.');
    }, TIMEOUT_MS);
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.peer.on('open', (id) => this.open(id));
    this.peer.on('connection', (connection) => this.accept(connection));
    this.peer.on('error', (error) => {
      if (this.stopped) return;
      console.error('PeerJS error:', error);
      if (error.type === 'peer-unavailable' && this.ready && this.session) {
        this.callbacks.onNotice('A participant could not be reached. They can try joining again.');
      } else if (this.ready && (error.type === 'network' || error.type === 'socket-error' ||
                 error.type === 'socket-closed' || error.type === 'disconnected')) {
        this.callbacks.onNotice('Signaling is unavailable. Existing peer connections may still work; new participants may not be able to join. Leave and reconnect if needed.');
      } else {
        this.end(error.type === 'peer-unavailable'
          ? 'The host could not be found. Check the link, or ask the host to create a new session.'
          : `Connection failed (${error.type}). Check your connection and try again.`);
      }
    });
    this.peer.on('disconnected', () => {
      if (!this.stopped) {
        this.callbacks.onNotice('Disconnected from the signaling service. Reconnecting...');
        this.peer.reconnect();
      }
    });
    this.peer.on('close', () => {
      if (!this.stopped) this.end('The peer connection closed. Please reconnect.');
    });
  }

  private open(id: string): void {
    if (this.stopped) return;
    if (this.selfId) {
      this.callbacks.onNotice('Signaling connection restored.');
      return;
    }
    this.selfId = id;
    if (this.hostId === null) {
      this.hostId = id;
      this.session = createSession(id, this.name);
      this.connected();
      this.broadcast();
    } else {
      const connection = this.peer.connect(this.hostId, { reliable: true, serialization: 'json' });
      this.hostConnection = connection;
      connection.on('open', () => this.send(connection, { type: 'join', name: this.name }));
      connection.on('data', (data: unknown) => this.receiveFromHost(data));
      connection.on('close', () => this.end('The host disconnected. This session has ended. You can create a new session from the home page.'));
      connection.on('error', (error) => {
        console.error('Host connection error:', error);
        this.end('Connection to the host failed. Your network may block WebRTC. Try again or ask for a new session link.');
      });
    }
  }

  private connected(): void {
    this.ready = true;
    clearTimeout(this.deadline);
    this.callbacks.onReady(this.hostId!, this.selfId);
  }

  private accept(connection: DataConnection): void {
    if (!this.session || !isPeerId(connection.peer) || this.guests.has(connection.peer)) {
      connection.on('open', () => connection.close());
      return;
    }
    const guest: Guest = { connection, joined: false, lastSeen: Date.now() };
    this.guests.set(connection.peer, guest);
    connection.on('data', (data: unknown) => {
      if (this.stopped || !this.session || !isRecord(data)) {
        console.warn('Ignored invalid participant message.');
        return;
      }
      guest.lastSeen = Date.now();
      if (data.type === 'join' && !guest.joined && isName(data.name)) {
        guest.joined = true;
        join(this.session, connection.peer, data.name.trim());
        this.broadcast();
      } else if (!guest.joined) {
        console.warn('Rejected participant without a valid name.');
        connection.close();
        this.removeGuest(connection.peer);
      } else if (data.type === 'vote' && isVote(data.value) && Number.isSafeInteger(data.round)) {
        if (vote(this.session, connection.peer, Number(data.round), data.value)) this.broadcast();
      } else if (data.type === 'reset' && Number.isSafeInteger(data.round)) {
        if (reset(this.session, Number(data.round))) this.broadcast();
      } else if (data.type !== 'pong') {
        console.warn('Ignored invalid or out-of-date participant message:', data.type);
      }
    });
    connection.on('close', () => this.removeGuest(connection.peer));
    connection.on('error', (error) => {
      console.error('Participant connection error:', error);
      this.callbacks.onNotice('A participant lost their connection.');
      connection.close();
      this.removeGuest(connection.peer);
    });
  }

  private receiveFromHost(data: unknown): void {
    if (this.stopped) return;
    if (isRecord(data) && data.type === 'ping') {
      this.lastHostSeen = Date.now();
      if (this.hostConnection) this.send(this.hostConnection, { type: 'pong' });
      return;
    }
    if (!isRecord(data) || data.type !== 'state' || !isSnapshot(data.state) ||
        data.state.hostId !== this.hostId ||
        !data.state.participants.some((person) => person.id === this.selfId)) {
      console.error('Rejected invalid session state from host.');
      this.end('The host sent invalid session data. Please leave and reconnect.');
      return;
    }
    this.lastHostSeen = Date.now();
    this.current = data.state;
    if (!this.ready) this.connected();
    this.callbacks.onState(data.state);
  }

  private send(connection: DataConnection, data: object): void {
    if (!connection.open || this.stopped) return;
    connection.send(data);
  }

  private broadcast(): void {
    if (!this.session || this.stopped) return;
    this.current = snapshot(this.session);
    for (const guest of this.guests.values()) {
      if (guest.joined) this.send(guest.connection, { type: 'state', state: this.current });
    }
    this.callbacks.onState(this.current);
  }

  private removeGuest(id: string): void {
    const guest = this.guests.get(id);
    if (!guest) return;
    this.guests.delete(id);
    if (this.session && guest.joined && !this.stopped) {
      leave(this.session, id);
      this.broadcast();
    }
  }

  private heartbeat(): void {
    if (!this.ready || this.stopped) return;
    if (this.session) {
      for (const [id, guest] of this.guests) {
        if (Date.now() - guest.lastSeen > TIMEOUT_MS) {
          guest.connection.close();
          this.removeGuest(id);
        } else if (guest.joined) {
          this.send(guest.connection, { type: 'ping' });
        }
      }
    } else if (Date.now() - this.lastHostSeen > TIMEOUT_MS) {
      this.end('The host stopped responding. The session has ended; try reconnecting.');
    }
  }

  castVote(value: Vote): void {
    if (!this.current || this.stopped) return;
    if (this.session) {
      if (vote(this.session, this.selfId, this.current.round, value)) this.broadcast();
    } else if (this.hostConnection) {
      this.send(this.hostConnection, { type: 'vote', round: this.current.round, value });
    }
  }

  reset(): void {
    if (!this.current || this.stopped) return;
    if (this.session) {
      if (reset(this.session, this.current.round)) this.broadcast();
    } else if (this.hostConnection) {
      this.send(this.hostConnection, { type: 'reset', round: this.current.round });
    }
  }

  private end(message: string): void {
    if (this.stopped) return;
    this.close();
    this.callbacks.onEnd(message);
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.deadline);
    clearInterval(this.timer);
    this.peer.destroy();
    this.guests.clear();
  }
}
