import './style.css';
import { launchFireworks } from './fireworks.ts';
import { NtfyTransport, ntfyUrl, topicFor } from './ntfy.ts';
import { Room } from './room.ts';
import { createRoomCode, isConsensus, isName, isRoomCode, normalizeRoomCode, OPTIONS } from './state.ts';
import type { Snapshot, Vote } from './state.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
let room: Room | undefined;
let state: Snapshot | undefined;
let myVote: Vote | null = null;
let pending: Vote | null = null;
let connecting = false;
let reconnecting = false;
let failure = '';
let notice = '';
let sendError = '';
let storageWarning = '';
let savedName = readStorage('poker.name');
let lastRoom = readStorage('poker.room');

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch (error) {
    console.warn('Browser storage is unavailable:', error);
    storageWarning = 'Browser storage is unavailable. Your name and last room will not be remembered.';
    return '';
  }
}

function saveStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn('Could not save browser preferences:', error);
    storageWarning = 'Your browser could not save your name or last room.';
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

/** null: home page; string: room code; undefined: invalid link. */
function route(): string | null | undefined {
  if (!location.hash || location.hash === '#/' || location.hash === '#') return null;
  const match = location.hash.match(/^#\/room\/([a-zA-Z0-9]+)\/?$/);
  if (!match) return undefined;
  const code = normalizeRoomCode(match[1]);
  return isRoomCode(code) ? code : undefined;
}

function roomLink(code: string): string {
  return `${location.href.split('#')[0]}#/room/${code}`;
}

/** Banners render in a toast area so they never push the page into scrolling on desktop. */
function shell(content: string, banners = ''): void {
  app.innerHTML = `
    <main>${content}</main>
    <div class="toasts">${storageWarning ? `<p class="banner warning" role="status">${escape(storageWarning)}</p>` : ''}${banners}</div>`;
}

function render(): void {
  const code = route();
  if (state && room) {
    renderRoom();
    return;
  }
  if (code === undefined) {
    document.title = 'Planning Poker';
    shell(`<section class="welcome"><p class="eyebrow">LOST YOUR WAY?</p><h1>That link doesn't look right.</h1>
      <p class="intro">Room links look like <code>#/room/ABCDE</code>. Check the code or start a fresh room.</p>
      <a class="button primary" href="#/">Go to home</a></section>`);
    return;
  }
  const joining = code !== null;
  document.title = joining ? `Join room ${code} | Planning Poker` : 'Planning Poker';
  const disabled = connecting ? 'disabled' : '';
  shell(`
    <section class="welcome">
      <p class="eyebrow">${joining ? 'A SEAT AT THE TABLE' : 'LESS GUESSWORK. MORE TEAMWORK.'}</p>
      <h1>${joining ? 'Let’s get you<br>in the room.' : 'Get on the<br><span>same page.</span>'}</h1>
      <p class="intro">${joining
        ? `You’re joining room <strong class="code-text">${code}</strong>. Pick a name and put your estimate on the table.`
        : 'A little planning poker for your next big idea.<br>Create a room, share the code, and estimate together.'}</p>
      <form id="entry-form" class="entry-card" novalidate>
        <label for="name">Your name</label>
        <input id="name" name="name" placeholder="e.g. Alex" autocomplete="nickname" maxlength="40"
          value="${escape(savedName)}" required ${disabled}>
        ${joining ? `<button class="button primary" type="submit" value="join" ${disabled}>
            ${connecting ? 'Connecting...' : `Join room ${code} →`}</button>
          <p class="form-hint">The host needs to keep their room open.</p>`
        : `<button class="button primary" type="submit" value="create" ${disabled}>
            ${connecting ? 'Connecting...' : 'Create a room →'}</button>
          <div class="divider"><span>or join with a code</span></div>
          <label for="code">Room code</label>
          <div class="code-row">
            <input id="code" name="code" class="code-input" placeholder="ABCDE" maxlength="6" autocomplete="off"
              autocapitalize="characters" spellcheck="false" ${disabled}>
            <button class="button secondary" type="submit" value="join" ${disabled}>Join →</button>
          </div>`}
      </form>
      ${joining ? '<a class="text-link" href="#/">← Create a different room</a>' :
        lastRoom && isRoomCode(lastRoom) ? `<a class="text-link" href="#/room/${lastRoom}">Rejoin room ${lastRoom} →</a>` : ''}
    </section>`, `
      ${failure ? `<div class="banner error" role="alert">${escape(failure)}</div>` : ''}
      ${sendError ? `<div class="banner error" role="alert">${escape(sendError)}</div>` : ''}
      ${notice ? `<p class="banner" role="status">${escape(notice)}</p>` : ''}`);

  const form = document.querySelector<HTMLFormElement>('#entry-form')!;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const nameInput = form.querySelector<HTMLInputElement>('#name')!;
    const codeInput = form.querySelector<HTMLInputElement>('#code');
    const action = (event.submitter as HTMLButtonElement | null)?.value ?? (joining ? 'join' : 'create');
    const name = nameInput.value.trim();
    if (!isName(name)) {
      nameInput.setCustomValidity('Enter a name between 1 and 40 characters.');
      nameInput.reportValidity();
      return;
    }
    let target = code;
    if (!joining && action === 'join' && codeInput) {
      target = normalizeRoomCode(codeInput.value);
      if (!isRoomCode(target)) {
        codeInput.setCustomValidity('Enter the 5-character room code, e.g. ABCDE.');
        codeInput.reportValidity();
        return;
      }
    }
    savedName = name;
    saveStorage('poker.name', name);
    if (target) {
      if (!joining) history.pushState(null, '', `#/room/${target}`);
      start(name, target, false);
    } else {
      const created = createRoomCode();
      history.pushState(null, '', `#/room/${created}`);
      start(name, created, true);
    }
  });
  form.querySelectorAll('input').forEach((input) => input.addEventListener('input', () => input.setCustomValidity('')));
}

function start(name: string, code: string, host: boolean): void {
  room?.close();
  failure = '';
  notice = '';
  sendError = '';
  state = undefined;
  myVote = null;
  pending = null;
  reconnecting = false;
  connecting = true;
  render();
  const current = new Room({
    code,
    name,
    host,
    transport: new NtfyTransport(ntfyUrl(), topicFor(code)),
    callbacks: {
      onReady: () => {
        connecting = false;
        lastRoom = code;
        saveStorage('poker.room', code);
      },
      onState: (next, mine) => {
        // Celebrate only a reveal seen live, not the first state of someone joining a revealed round.
        const justRevealed = state !== undefined && next.revealed && !(state.revealed && state.round === next.round);
        if (justRevealed && isConsensus(next)) launchFireworks();
        if (next.round !== state?.round) pending = null;
        if (mine !== null && mine === pending) pending = null;
        state = next;
        myVote = mine;
        render();
      },
      onStatus: (status) => {
        reconnecting = status === 'reconnecting';
        render();
      },
      onNotice: (message) => {
        notice = message;
        render();
      },
      onError: (message) => {
        sendError = message;
        pending = null;
        render();
      },
      onEnd: (message) => {
        if (room !== current) return;
        // A host's code is dead once its room ends; return home instead of offering to join it.
        if (host) history.replaceState(null, '', '#/');
        room = undefined;
        failure = message;
        notice = '';
        state = undefined;
        pending = null;
        connecting = false;
        reconnecting = false;
        render();
      },
    },
  });
  room = current;
}

function renderRoom(): void {
  if (!state || !room) return;
  const me = state.participants.find((person) => person.id === room!.selfId)!;
  const selected = pending ?? myVote;
  const voted = state.participants.filter((person) => person.hasVoted).length;
  const resultVotes = state.participants.flatMap((person) => person.vote === null ? [] : [person.vote]);
  const average = resultVotes.length
    ? (resultVotes.reduce<number>((sum, value) => sum + value, 0) / resultVotes.length).toFixed(1)
    : '—';
  const consensus = isConsensus(state);
  const status = consensus ? 'Everyone agrees!' : state.revealed ? 'Cards on the table' : 'Make your estimate';
  document.title = `Round ${state.round} | Room ${room.code} | Planning Poker`;
  shell(`
    <section class="session">
      <div class="session-heading">
        <div><p class="eyebrow">YOUR TEAM’S ESTIMATION SPACE</p>
          <h1>Planning room<span class="live-dot ${reconnecting ? 'offline' : ''}"
            title="${reconnecting ? 'Reconnecting' : 'Connected'}"></span></h1></div>
        <a class="button secondary small" href="#/">Leave room</a>
      </div>
      <div class="share-bar">
        <span class="share-label">Room code <strong class="room-code" aria-label="Room code">${room.code}</strong></span>
        <label class="sr-only" for="room-link">Room link</label>
        <input id="room-link" readonly value="${escape(roomLink(room.code))}">
        <button class="button secondary small" id="copy-link">Copy link</button>
      </div>
      <div class="room-grid">
        <section class="voting-panel" aria-labelledby="voting-title">
          <div class="panel-top"><span class="round-label">ROUND ${state.round}</span>
            <span class="status-pill ${state.revealed ? 'revealed' : ''}">${state.revealed ? 'Revealed' : `${voted} / ${state.participants.length} voted`}</span>
          </div>
          <h2 id="voting-title">${status}</h2>
          <p class="muted">${consensus ? 'Same card all around. On to the next one.' : state.revealed
            ? 'Different numbers? That’s where the conversation starts.'
            : 'How much effort will it take? Choose a card below.'}</p>
          <div class="vote-options" role="group" aria-label="Your estimate">
            ${OPTIONS.map((value) => `<button class="vote-card ${selected === value ? 'selected' : ''}"
              data-vote="${value}" aria-label="Vote ${value}" aria-pressed="${selected === value}"
              ${state!.revealed ? 'disabled' : ''}><span class="card-corner" aria-hidden="true">${value}</span>
              ${value}<span class="card-bottom" aria-hidden="true">${value}</span></button>`).join('')}
          </div>
          <div class="round-feedback" role="status" aria-live="polite">
            ${state.revealed ? `<div class="results-summary"><span>Team average <strong>${average}</strong></span>
              <button class="button primary" id="reset">Start next round →</button></div>
              <p class="muted">${me.hasVoted ? 'All votes are in. Discuss, then start fresh.' : 'You joined after the reveal. Start the next round to vote.'}</p>`
              : `<p class="vote-feedback">${pending !== null ? 'Sending your vote...' : me.hasVoted ? 'Your vote is in. Waiting for the team...' : 'Your card is waiting for you.'}</p>
              <p class="muted">${me.hasVoted ? 'You can change your vote until everyone has voted.' : 'Votes reveal automatically when everyone has voted.'}</p>`}
          </div>
          <div class="table-note"><span class="mini-dot"></span> ${room.isHost
            ? 'You’re hosting. Keep this tab open to keep the room alive.'
            : 'If the host leaves, this room closes.'}</div>
        </section>
        <aside class="people-panel" aria-labelledby="people-title">
          <div class="people-heading"><h2 id="people-title">At the table</h2><span class="count">${state.participants.length}</span></div>
          <p class="muted">Same room. Independent thinking.</p>
          <ul class="people-list">
            ${state.participants.map((person, index) => `<li>
              <span class="avatar avatar-${index % 4}" aria-hidden="true">${escape(person.name.charAt(0).toUpperCase())}</span>
              <div class="person-info"><strong>${escape(person.name)}${person.id === room!.selfId ? ' <span class="you">(you)</span>' : ''}</strong>
                <span>${person.id === state!.hostId ? 'Host' : 'Participant'}</span></div>
              ${room!.isHost && person.id !== room!.selfId ? `<button class="remove-person" data-remove="${person.id}"
                aria-label="Remove ${escape(person.name)}" title="Remove from the table">×</button>` : ''}
              <span class="person-vote ${state!.revealed ? 'visible-vote' : person.hasVoted ? 'voted' : ''}"
                aria-label="${state!.revealed ? person.vote === null ? 'Joining next round' : `Voted ${person.vote}` : person.hasVoted ? 'Has voted' : 'Not voted'}">
                ${state!.revealed ? person.vote ?? '—' : person.hasVoted ? '✓' : '…'}</span>
            </li>`).join('')}
          </ul>
          <p class="people-note">${state.revealed ? 'A fresh round clears every card.'
            : room.isHost && state.participants.length > 1 ? 'Waiting on someone who left without leaving the room? Remove them with ×.'
            : 'No spoilers. Estimates stay hidden until everyone is ready.'}</p>
        </aside>
      </div>
    </section>`, `
      ${reconnecting ? '<p class="banner warning" role="status">Connection to ntfy.sh lost. Reconnecting... Updates sent meanwhile may be missed; the room resyncs when the connection returns.</p>' : ''}
      ${sendError ? `<div class="banner error" role="alert">${escape(sendError)}
        <button class="button secondary small" id="dismiss-error">Dismiss</button></div>` : ''}
      ${notice ? `<p class="banner" role="status">${escape(notice)}</p>` : ''}`);

  document.querySelectorAll<HTMLButtonElement>('[data-vote]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = Number(button.dataset.vote) as Vote;
      if (value === myVote && pending === null) return;
      pending = value;
      sendError = '';
      void room?.castVote(value);
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      sendError = '';
      room?.removeParticipant(button.dataset.remove!);
    });
  });
  document.querySelector('#reset')?.addEventListener('click', () => {
    sendError = '';
    void room?.resetRound();
  });
  document.querySelector('#dismiss-error')?.addEventListener('click', () => {
    sendError = '';
    render();
  });
  document.querySelector('#copy-link')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(roomLink(room!.code));
      notice = `Link copied. Teammates can also type code ${room!.code} on the home page.`;
    } catch (error) {
      console.warn('Clipboard access failed:', error);
      notice = 'Could not copy automatically. Select and copy the room link above.';
    }
    render();
  });
}

function leaveRoom(): void {
  room?.leave();
  room = undefined;
  state = undefined;
  myVote = null;
  pending = null;
  connecting = false;
  reconnecting = false;
}

window.addEventListener('hashchange', () => {
  leaveRoom();
  failure = '';
  notice = '';
  sendError = '';
  render();
});
window.addEventListener('pagehide', () => leaveRoom());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    failure = 'You left the room when this page was put away. Join again to reconnect.';
    render();
  }
});
render();
