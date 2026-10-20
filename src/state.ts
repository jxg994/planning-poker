export const OPTIONS = [0, 1, 2, 3, 5, 8, 13, 21] as const;
export type Vote = (typeof OPTIONS)[number];

export interface Participant {
  id: string;
  name: string;
  vote: Vote | null;
}

export interface Session {
  hostId: string;
  round: number;
  revealed: boolean;
  participants: Participant[];
}

export interface Snapshot {
  hostId: string;
  round: number;
  revealed: boolean;
  participants: (Participant & { hasVoted: boolean })[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isVote(value: unknown): value is Vote {
  return OPTIONS.some((option) => option === value);
}

export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value);
}

// Excludes look-alike characters (0/O, 1/I/L) so codes are easy to read aloud and type.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && value.length === CODE_LENGTH &&
    [...value].every((character) => CODE_ALPHABET.includes(character));
}

export function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

export function randomId(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let result = '';
  while (result.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && result.length < length) result += alphabet[byte % alphabet.length];
    }
  }
  return result;
}

export function createRoomCode(): string {
  return randomId(CODE_ALPHABET, CODE_LENGTH);
}

export function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 40;
}

export function createSession(hostId: string, name: string): Session {
  return {
    hostId,
    round: 1,
    revealed: false,
    participants: [{ id: hostId, name, vote: null }],
  };
}

export function join(session: Session, id: string, name: string): void {
  if (!session.participants.some((person) => person.id === id)) {
    session.participants.push({ id, name, vote: null });
  }
}

function revealIfReady(session: Session): void {
  if (session.participants.length > 0 && session.participants.every((person) => person.vote !== null)) {
    session.revealed = true;
  }
}

export function leave(session: Session, id: string): void {
  session.participants = session.participants.filter((person) => person.id !== id);
  revealIfReady(session);
}

export function vote(session: Session, id: string, round: number, value: Vote): boolean {
  const person = session.participants.find((participant) => participant.id === id);
  if (!person || session.revealed || round !== session.round || !isVote(value)) return false;
  person.vote = value;
  revealIfReady(session);
  return true;
}

export function reset(session: Session, round: number): boolean {
  if (!session.revealed || round !== session.round) return false;
  session.round += 1;
  session.revealed = false;
  session.participants.forEach((person) => { person.vote = null; });
  return true;
}

export function cloneSession(session: Session): Session {
  return { ...session, participants: session.participants.map((person) => ({ ...person })) };
}

export function snapshot(session: Session): Snapshot {
  return {
    hostId: session.hostId,
    round: session.round,
    revealed: session.revealed,
    participants: session.participants.map((person) => ({
      ...person,
      vote: session.revealed ? person.vote : null,
      hasVoted: person.vote !== null,
    })),
  };
}

/** Validates the full shared state, including unrevealed votes, received from the host. */
export function isSession(value: unknown): value is Session {
  if (!isRecord(value) || !isClientId(value.hostId) ||
      !Number.isSafeInteger(value.round) || Number(value.round) < 1 ||
      typeof value.revealed !== 'boolean' || !Array.isArray(value.participants) ||
      value.participants.length === 0) return false;

  const ids = new Set<string>();
  for (const person of value.participants) {
    if (!isRecord(person) || !isClientId(person.id) || !isName(person.name) ||
        !(person.vote === null || isVote(person.vote)) || ids.has(person.id)) return false;
    ids.add(person.id);
  }
  if (!ids.has(value.hostId)) return false;
  // An unrevealed round can never have every vote in; the reveal rule would already have fired.
  return value.revealed || value.participants.some((person) => isRecord(person) && person.vote === null);
}
