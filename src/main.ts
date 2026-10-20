import './style.css';
import { PokerNetwork } from './network.ts';
import { isName, OPTIONS } from './state.ts';
import type { Snapshot, Vote } from './state.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
let network: PokerNetwork | undefined;
let state: Snapshot | undefined;
let selfId = '';
let selected: Vote | null = null;
let connecting = false;
let failure = '';
let notice = '';
let storageWarning = '';
let savedName = readStorage('poker.name');
let lastSession = readStorage('poker.session');

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch (error) {
    console.warn('Browser storage is unavailable:', error);
    storageWarning = 'Browser storage is unavailable. Your name and last session will not be remembered.';
    return '';
  }
}

function saveStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn('Could not save browser preferences:', error);
    storageWarning = 'Your browser could not save your name or last session.';
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function route(): string | null | undefined {
  if (!location.hash || location.hash === '#/' || location.hash === '#') return null;
  return location.hash.match(/^#\/planning-poker\/([a-zA-Z0-9_-]{1,128})\/?$/)?.[1];
}

function sessionLink(id: string): string {
  return `${location.href.split('#')[0]}#/planning-poker/${id}`;
}

function shell(content: string): void {
  app.innerHTML = `
    <header class="site-header">
      <a class="brand" href="#/" aria-label="Planning Poker home">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
        planning<span class="brand-light">poker</span>
      </a>
      <span class="prototype-badge">PEER-TO-PEER PROTOTYPE</span>
    </header>
    <main>${storageWarning ? `<p class="banner warning" role="status">${escape(storageWarning)}</p>` : ''}${content}</main>
    <footer>Small cards. Shared understanding.<span>Powered by WebRTC &amp; PeerJS</span></footer>`;
}

function render(): void {
  const id = route();
  if (state) {
    renderSession();
    return;
  }
  if (id === undefined) {
    shell('<section class="welcome"><p class="eyebrow">LOST YOUR WAY?</p><h1>That link doesn\'t look right.</h1><p>Check your session link or start a fresh session.</p><a class="button primary" href="#/">Go to home</a></section>');
    return;
  }
  const joining = id !== null;
  document.title = joining ? 'Join session | Planning Poker' : 'Planning Poker';
  shell(`
    <section class="welcome">
      <p class="eyebrow">${joining ? 'A SEAT AT THE TABLE' : 'LESS GUESSWORK. MORE TEAMWORK.'}</p>
      <h1>${joining ? 'Let’s get you<br>in the room.' : 'Get on the<br><span>same page.</span>'}</h1>
      <p class="intro">${joining
        ? 'Pick a name, meet your team, and put your estimate on the table.'
        : 'A little planning poker for your next big idea.<br>Create a session, share a link, and estimate together.'}</p>
      <form id="name-form" class="entry-card">
        <label for="name">Your name</label>
        <input id="name" name="name" placeholder="e.g. Alex" autocomplete="nickname" maxlength="40"
          value="${escape(savedName)}" required ${connecting ? 'disabled' : ''}>
        <button class="button primary" type="submit" ${connecting ? 'disabled' : ''}>
          ${connecting ? 'Connecting...' : joining ? 'Join session →' : 'Create a session →'}
        </button>
        <p class="form-hint">${joining ? 'The host needs to keep their session open.' : 'No account. No installs. Just your team.'}</p>
      </form>
      ${failure ? `<div class="banner error" role="alert">${escape(failure)}</div>` : ''}
      ${notice ? `<p class="banner" role="status">${escape(notice)}</p>` : ''}
      ${joining ? '<a class="text-link" href="#/">← Create a different session</a>' :
        lastSession ? `<a class="text-link" href="#/planning-poker/${escape(lastSession)}">Rejoin your last session →</a>` : ''}
      <div class="how-it-works">
        <div><span>01</span><strong>Gather your team</strong><p>One link brings everyone in.</p></div>
        <div><span>02</span><strong>Pick your estimate</strong><p>Vote independently. No peeking.</p></div>
        <div><span>03</span><strong>Reveal &amp; discuss</strong><p>Everyone votes. Cards flip.</p></div>
      </div>
      <p class="network-note">This prototype uses PeerJS’s public signaling service and STUN servers to connect browsers.
        Votes are sent over WebRTC to the host. Keep the host’s tab open; sessions are not saved.</p>
    </section>`);
  document.querySelector<HTMLFormElement>('#name-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#name')!;
    const name = input.value.trim();
    if (!isName(name)) {
      input.setCustomValidity('Enter a name between 1 and 40 characters.');
      input.reportValidity();
      return;
    }
    savedName = name;
    saveStorage('poker.name', name);
    start(name, id);
  });
  document.querySelector<HTMLInputElement>('#name')?.addEventListener('input', (event) => {
    (event.target as HTMLInputElement).setCustomValidity('');
  });
}

function start(name: string, hostId: string | null): void {
  network?.close();
  failure = '';
  notice = '';
  connecting = true;
  render();
  network = new PokerNetwork(name, hostId, {
    onReady: (id, peerId) => {
      selfId = peerId;
      connecting = false;
      lastSession = id;
      saveStorage('poker.session', id);
      history.replaceState(null, '', `#/planning-poker/${id}`);
    },
    onState: (next) => {
      if (next.round !== state?.round) selected = null;
      state = next;
      render();
    },
    onNotice: (message) => {
      notice = message;
      render();
    },
    onEnd: (message) => {
      failure = message;
      notice = '';
      state = undefined;
      selected = null;
      connecting = false;
      render();
    },
  });
}

function renderSession(): void {
  if (!state) return;
  const me = state.participants.find((person) => person.id === selfId)!;
  const voted = state.participants.filter((person) => person.hasVoted).length;
  const host = state.hostId === selfId;
  const resultVotes = state.participants.flatMap((person) => person.vote === null ? [] : [person.vote]);
  const average = resultVotes.length
    ? (resultVotes.reduce<number>((sum, value) => sum + value, 0) / resultVotes.length).toFixed(1)
    : '—';
  const status = state.revealed ? 'Cards on the table' : 'Make your estimate';
  document.title = `Round ${state.round} | Planning Poker`;
  shell(`
    <section class="session">
      <div class="session-heading">
        <div><p class="eyebrow">YOUR TEAM’S ESTIMATION SPACE</p><h1>Planning room<span class="live-dot" title="Connected"></span></h1></div>
        <a class="button secondary small" href="#/">Leave session</a>
      </div>
      <div class="share-bar">
        <span class="share-label">Better together. Invite your team.</span>
        <label class="sr-only" for="session-link">Session link</label>
        <input id="session-link" readonly value="${escape(sessionLink(state.hostId))}">
        <button class="button secondary small" id="copy-link">Copy link</button>
      </div>
      ${notice ? `<p class="banner" role="status">${escape(notice)}</p>` : ''}
      <div class="room-grid">
        <section class="voting-panel" aria-labelledby="voting-title">
          <div class="panel-top"><span class="round-label">ROUND ${state.round}</span>
            <span class="status-pill ${state.revealed ? 'revealed' : ''}">${state.revealed ? 'Revealed' : `${voted} / ${state.participants.length} voted`}</span>
          </div>
          <h2 id="voting-title">${status}</h2>
          <p class="muted">${state.revealed
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
              : `<p class="vote-feedback">${me.hasVoted ? 'Your vote is in. Waiting for the team...' : 'Your card is waiting for you.'}</p>
              <p class="muted">${me.hasVoted ? 'You can change your vote until everyone has voted.' : 'Votes reveal automatically when everyone has voted.'}</p>`}
          </div>
          <div class="table-note"><span class="mini-dot"></span> ${host
            ? 'You’re hosting. Keep this tab open to keep the room alive.'
            : 'Connected to the host. If they leave, this room closes.'}</div>
        </section>
        <aside class="people-panel" aria-labelledby="people-title">
          <div class="people-heading"><h2 id="people-title">At the table</h2><span class="count">${state.participants.length}</span></div>
          <p class="muted">Same room. Independent thinking.</p>
          <ul class="people-list">
            ${state.participants.map((person, index) => `<li>
              <span class="avatar avatar-${index % 4}" aria-hidden="true">${escape(person.name.charAt(0).toUpperCase())}</span>
              <div class="person-info"><strong>${escape(person.name)}${person.id === selfId ? ' <span class="you">(you)</span>' : ''}</strong>
                <span>${person.id === state!.hostId ? 'Host' : 'Participant'}</span></div>
              <span class="person-vote ${state!.revealed ? 'visible-vote' : person.hasVoted ? 'voted' : ''}"
                aria-label="${state!.revealed ? person.vote === null ? 'Joining next round' : `Voted ${person.vote}` : person.hasVoted ? 'Has voted' : 'Not voted'}">
                ${state!.revealed ? person.vote ?? '—' : person.hasVoted ? '✓' : '…'}</span>
            </li>`).join('')}
          </ul>
          <p class="people-note">${state.revealed ? 'A fresh round clears every card.' : 'No spoilers. Estimates stay hidden until everyone is ready.'}</p>
        </aside>
      </div>
      <p class="network-note">Only connected participants count toward the reveal. Anyone can start the next round.
        A lost connection can take about 30 seconds to detect.</p>
    </section>`);

  document.querySelectorAll<HTMLButtonElement>('[data-vote]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = Number(button.dataset.vote) as Vote;
      selected = value;
      network?.castVote(value);
      render();
    });
  });
  document.querySelector('#reset')?.addEventListener('click', () => network?.reset());
  document.querySelector('#copy-link')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sessionLink(state!.hostId));
      notice = 'Session link copied. Send it to your team!';
    } catch (error) {
      console.warn('Clipboard access failed:', error);
      notice = 'Could not copy automatically. Select and copy the session link above.';
    }
    render();
  });
}

window.addEventListener('hashchange', () => {
  network?.close();
  network = undefined;
  state = undefined;
  selected = null;
  selfId = '';
  connecting = false;
  failure = '';
  notice = '';
  render();
});
window.addEventListener('pagehide', () => network?.close());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    network = undefined;
    state = undefined;
    connecting = false;
    failure = 'Your connection closed while this page was away. Join again to reconnect.';
    render();
  }
});
render();
