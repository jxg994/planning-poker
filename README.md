# Planning Poker

A static planning poker prototype. Vite bundles the TypeScript app; browsers
exchange messages through the free public [ntfy.sh](https://ntfy.sh) service.
There is no application server, database, account, or API key.

## Run locally

Requires Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open the printed URL (normally `http://127.0.0.1:5173/planning-poker/`). Use
separate browsers, private windows, or devices to try a shared room; a local
dev server talks to the real ntfy.sh.

```sh
npm test            # state and room-protocol tests (Node, no network)
npm run build       # type-check and build dist/
npm run preview
```

`npm run test:browser` runs Playwright end-to-end tests in Google Chrome against
a local ntfy stand-in (`tests/support/fake-ntfy.ts`), so they don't use the
public service. They cover creating and joining rooms, hidden votes, reveal,
reset, late joins, departures, send failures, reconnects, and a phone viewport.
One optional smoke test uses the real ntfy.sh (about 6 messages per run):

```sh
NTFY_LIVE=1 npx playwright test live-ntfy
```

## How to use

1. Enter a name and select **Create a room**. Its creator is the host.
2. Share the five-character room code (for example `K7QXM`) or the room link.
   Teammates type the code on the home page, or open the link and enter a name.
3. Choose from **0, 1, 2, 3, 5, 8, 13, 21**. You can change your vote before reveal.
4. When every participant at the table has voted, results reveal automatically.
5. Anyone can select **Start next round** to clear all votes.

Room links use `#/room/:code`, so shared links load directly on GitHub Pages
without a fallback server. Codes are case-insensitive and avoid look-alike
characters (no 0/O, 1/I/L). Your name and last room code are remembered in local
storage; joining still requires confirmation. Room state exists only in the
participants' browser memory.

## How it works

Each room is one ntfy topic, `jxg994-planning-poker-<CODE>`. Every browser
subscribes with Server-Sent Events and publishes small JSON messages with HTTPS
POST, using `?cache=no` so ntfy.sh doesn't store them for later delivery.

- A joiner waits until ntfy confirms the subscription, then posts `join`. The
  host replies with the full room state. The joiner retries once after 10 seconds,
  then reports that no host answered.
- Votes, resets, and departures are events that every browser applies, in the
  order ntfy delivers them, to its own copy of the state. Votes reveal locally
  once everyone has voted, and the host also publishes its state at that point
  so everyone converges on the same result.
- Messages carry per-sender sequence numbers. Duplicates are ignored. After a
  dropped connection, or a detected gap in a sequence, a guest requests fresh
  state from the host. Because messages aren't cached, missed messages are never
  replayed; the room shows *Reconnecting* until it resyncs. If the host missed a
  vote, the voter's browser sends it again.
- Idle participants send a heartbeat every 2.5 minutes. The host removes anyone
  silent for 6 minutes; guests end the room if the host is silent that long.
  Leaving the room or closing the tab announces the departure immediately when
  the browser allows it.
- The host leaving ends the room. There is no host migration or recovery.

Message cost: creating a room publishes nothing. A join costs 2 messages, each
vote or reset 1, and each reveal 1 more (the host's state). Three people joining and voting once
publish 8 messages in total. Idle heartbeats add about 24 messages per person per
hour, which is the largest cost in long sessions.

## Limitations and privacy

- **Not private.** All ntfy.sh topics are public. Room codes are short
  (31⁵ ≈ 28.6 million combinations), guessable, and are **not passwords**. Anyone
  who knows or guesses a code can read every message in that room (names and
  vote values, including votes not yet revealed) and could post fake messages,
  such as joins or votes under someone else's identity. The app hides votes until
  reveal, but they are visible in every participant's browser and in transit to
  ntfy.sh. The ntfy.sh operator can see all messages. Don't enter sensitive data.
- **Rate limits.** ntfy.sh allows anonymous users about **250 published messages
  per day per IP address**, with a burst of 60 requests and then 1 request per
  5 seconds (checked October 2026; limits can change). People behind the same
  office network or VPN share one allowance, so a long, busy session can run out.
  Rejected messages show an error with ntfy's response, and the action isn't
  applied. Repeated abuse can get an IP address temporarily banned.
- **Availability.** ntfy.sh is a free service with no availability guarantee for
  this app. Some networks block it. Message delivery isn't guaranteed; the app
  detects and repairs common gaps, but this is not a production-grade protocol.
- **Code collisions.** Codes are random and there is no collision check at
  creation. If two live rooms happen to share a code, both hosts answer the
  next join; a host that sees another host's messages ends its room and asks
  everyone to create a new one.
- **Room size.** A room holds up to 20 people, fewer with very long names, so
  state fits in ntfy's 4,096-byte message limit.
- Keep the host's tab open and the device awake. Sleeping or backgrounded tabs
  pause timers and may lose the connection. The app resyncs when they return; a
  guest who was removed in the meantime rejoins automatically.
- Newcomers count toward an unfinished round. If results have already been
  revealed, newcomers wait for the next round. A solo host's vote reveals
  immediately.

## GitHub Pages

The included Actions workflow tests, builds, and deploys `dist/` on pushes to
`main`. In the repository's **Settings > Pages**, set **Source** to
**GitHub Actions** before deploying (rather than deploying files directly from
the branch). Then push the changes or run the workflow manually.

The configured base path is `/planning-poker/`. If you rename the repository or
use a custom domain, update `base` in `vite.config.ts`.
