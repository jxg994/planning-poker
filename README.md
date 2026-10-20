# Planning Poker

A static, two-page planning poker prototype. Vite bundles TypeScript and PeerJS;
there is no application server or database.

## Run locally

Requires Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open the printed URL (normally `http://127.0.0.1:5173/planning-poker/`).
Use separate tabs or devices to try a shared session. Another device must be able
to reach the frontend; the deployed HTTPS site is the simplest way to test that.

```sh
npm test
npm run build
npm run preview
```

For the optional end-to-end checks, install Google Chrome and run
`npm run test:browser`. These use real WebRTC peers in separate browser contexts
and require access to the public PeerJS signaling and Google STUN services.
They are not part of the deployment workflow, since network policies and public
service availability can prevent peer connections. The test browser grants
fake microphone access to expose reachable local ICE candidates without mDNS
discovery. No real microphone is used; the application itself never requests
microphone access or changes browser privacy settings. These checks verify
the protocol, not connectivity across every network/browser combination.

## How to use

1. Enter a name on the home page and create a session. Its creator is the host.
2. Copy the session link and share it. Visitors enter their names to join.
3. Choose from **0, 1, 2, 3, 5, 8, 13, 21**. You can change your vote before reveal.
4. When every connected participant has voted, results reveal automatically.
5. Anyone can select **Start next round** to reset all votes.

Session URLs use `#/planning-poker/:id`, where `:id` is the host's PeerJS ID.
Hash routing lets shared links load directly on GitHub Pages without a fallback
server. Names and the last session ID are remembered in local storage; joining
still requires confirmation. Active membership and votes exist only in memory.

## Networking and limitations

- Browsers contact **PeerJS's public PeerServer** for discovery/signaling.
  The app explicitly configures Google's **STUN service**. This is not
  a zero-third-party-service app. The PeerJS library itself is bundled locally.
- Each participant has a WebRTC data channel to the host. The host distributes
  membership, voted/not-voted status, and revealed results to everyone.
- No TURN relay is configured. Some corporate networks, VPNs, firewalls, or NAT
  combinations will prevent connections. Failures/timeouts appear in the UI.
- Expand **Connection diagnostics** below the page to inspect signaling,
  offer/answer presence, ICE and data-channel states, candidate types, STUN
  error codes, and connectivity requests/responses. On failure the panel opens
  automatically and preserves its last samples. Use **Copy diagnostics** on
  both devices, or take screenshots. Reports exclude addresses, names, session
  IDs, SDP, credentials, and votes. No diagnostics are uploaded automatically.
  A STUN error alone does not establish total failure if public-facing (`srflx`)
  candidates exist. Zero ICE responses do not distinguish NAT from filtering.
- Keep the host's tab open and laptop awake. Leaving, refreshing, or losing the
  host ends the session; there is no host migration or recovery of session state.
  Returning to an ended session link does not recreate it.
- Departures are detected by connection-close events and a 5-second heartbeat
  with a 30-second timeout. Sleeping/backgrounded browsers may be disconnected;
  timer throttling can delay detection. A disconnected guest can join again.
- Newcomers count toward an unfinished round. If results have already been
  revealed, newcomers wait for the next round. A solo host's vote reveals
  immediately.
- Before reveal, the host sends only voted/not-voted status, not vote values.
  **The host can inspect all votes in their own browser.** This is UI privacy,
  not cryptographic ballot secrecy. The host is trusted to coordinate honestly.
- Anyone with the link can join; there is no authentication, room password,
  moderation, persistence, or production availability guarantee.

## GitHub Pages

The included Actions workflow tests, builds, and deploys `dist/` on pushes to
`main`. In the repository's **Settings > Pages**, set **Source** to
**GitHub Actions** before deploying (rather than deploying files directly from
the branch). Then push the changes or run the workflow manually.

The configured base path is `/planning-poker/`. If you rename the repository or
use a custom domain, update `base` in `vite.config.ts`.
