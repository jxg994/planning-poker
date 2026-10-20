import { test, expect, devices } from '@playwright/test';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

const FAKE_NTFY = 'http://127.0.0.1:5175';
const { defaultBrowserType: _, ...phone } = devices['Pixel 7'];

async function control(path: string): Promise<unknown> {
  const response = await fetch(`${FAKE_NTFY}/__control/${path}`, { method: 'POST' });
  return response.json();
}

async function published(): Promise<{ topic: string; body: string; cache: string | null }[]> {
  return ((await control('stats')) as { published: { topic: string; body: string; cache: string | null }[] }).published;
}

async function open(browser: Browser, errors: string[], options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext(options);
  await context.addInitScript((url) => { (globalThis as { __POKER_NTFY_URL__?: string }).__POKER_NTFY_URL__ = url; }, FAKE_NTFY);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return page;
}

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('./');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Create a room' }).click();
  await expect(page.getByRole('heading', { name: 'Planning room' })).toBeVisible();
  const code = (await page.getByLabel('Room code', { exact: true }).textContent())!.trim();
  expect(code).toMatch(/^[2-9A-HJKMNP-Z]{5}$/);
  return code;
}

async function joinByLink(page: Page, link: string, name: string): Promise<void> {
  await page.goto(link);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: /Join room/ }).click();
  await expect(page.getByRole('heading', { name: 'Planning room' })).toBeVisible();
}

test.beforeEach(async () => {
  await control('reset');
});

test('create, join by typed code and link, hide votes, reveal, late join, reset, and departures', async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, errors);
  const guest = await open(browser, errors, phone);
  const third = await open(browser, errors);

  const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight);
  await host.goto('./');
  expect(await fits(host)).toBe(true);
  const code = await createRoom(host, 'Alex');
  const link = await host.getByLabel('Room link').inputValue();
  expect(link).toMatch(new RegExp(`#/room/${code}$`));
  expect(await published()).toEqual([]);

  // Manual entry on a phone: lowercase with a stray space still works.
  await guest.goto('./');
  await guest.getByLabel('Your name').fill('Sam <script>');
  await guest.getByLabel('Room code').fill(` ${code.toLowerCase()}`);
  await guest.getByRole('button', { name: 'Join →', exact: true }).tap();
  await expect(guest.getByRole('heading', { name: 'Planning room' })).toBeVisible();
  expect(guest.url()).toContain(`#/room/${code}`);
  await expect(host.locator('.people-list li')).toHaveCount(2);
  await expect(host.locator('.people-list')).toContainText('Sam <script>');

  await host.getByRole('button', { name: 'Vote 0', exact: true }).click();
  await expect(guest.locator('.status-pill')).toHaveText('1 / 2 voted');
  await expect(guest.locator('.person-vote.visible-vote')).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Start next round' })).toHaveCount(0);
  await guest.getByRole('button', { name: 'Vote 8', exact: true }).tap();
  for (const page of [host, guest]) {
    await expect(page.getByRole('heading', { name: 'Cards on the table' })).toBeVisible();
    await expect(page.locator('.visible-vote')).toHaveText(['0', '8']);
  }

  await joinByLink(third, link, 'Taylor');
  await expect(third.getByRole('heading', { name: 'Cards on the table' })).toBeVisible();
  await expect(third.getByRole('button', { name: 'Vote 5', exact: true })).toBeDisabled();
  await expect(third.locator('.visible-vote')).toHaveText(['0', '8', '—']);

  await guest.getByRole('button', { name: 'Start next round' }).tap();
  for (const page of [host, guest, third]) {
    await expect(page.locator('.round-label')).toHaveText('ROUND 2');
    await expect(page.locator('.status-pill')).toHaveText('0 / 3 voted');
    await expect(page.getByRole('button', { name: 'Vote 0', exact: true })).toHaveAttribute('aria-pressed', 'false');
  }
  await host.getByRole('button', { name: 'Vote 3', exact: true }).click();
  await guest.getByRole('button', { name: 'Vote 5', exact: true }).tap();
  await expect(third.locator('.status-pill')).toHaveText('2 / 3 voted');
  await third.getByRole('link', { name: 'Leave room' }).click();
  await expect(host.getByRole('heading', { name: 'Cards on the table' })).toBeVisible();
  await expect(host.locator('.visible-vote')).toHaveText(['3', '5']);

  await host.getByRole('button', { name: 'Copy link' }).click();
  expect(await fits(host)).toBe(true);

  const messages = await published();
  expect(messages.every((message) => message.cache === 'no')).toBe(true);
  expect(new Set(messages.map((message) => message.topic))).toEqual(new Set([`jxg994-planning-poker-${code}`]));

  expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await host.getByRole('link', { name: 'Leave room' }).click();
  await expect(guest.getByRole('alert')).toContainText('host left');
  await expect(guest.getByLabel('Your name')).toHaveValue('Sam <script>');
  expect(errors).toEqual([]);
  for (const page of [host, guest, third]) await page.context().close();
});

test('send failures are shown, and dropped subscriptions reconnect and resync', async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, errors);
  const guest = await open(browser, errors);
  const code = await createRoom(host, 'Alex');
  await joinByLink(guest, `./#/room/${code}`, 'Sam');

  await control('fail-publish?status=429&count=1');
  await guest.getByRole('button', { name: 'Vote 5', exact: true }).click();
  await expect(guest.getByRole('alert')).toContainText('HTTP 429');
  await expect(guest.getByRole('alert')).toContainText('250 messages per day');
  await expect(guest.getByRole('button', { name: 'Vote 5', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(host.locator('.status-pill')).toHaveText('0 / 2 voted');
  await guest.getByRole('button', { name: 'Dismiss' }).click();
  await expect(guest.getByRole('alert')).toHaveCount(0);
  await guest.getByRole('button', { name: 'Vote 5', exact: true }).click();
  await expect(host.locator('.status-pill')).toHaveText('1 / 2 voted');

  // The browser reconnects automatically after a dropped stream; the guest then resyncs.
  const before = (await published()).length;
  await control('drop');
  await expect.poll(async () => (await published()).slice(before).map((m) => JSON.parse(m.body).t))
    .toEqual(expect.arrayContaining(['join', 'state']));
  // A refused subscription (e.g. HTTP 429) closes the EventSource; the app retries with backoff.
  await control('fail-subscribe?status=429&count=2');
  await control('drop');
  await expect(guest.getByRole('status').filter({ hasText: 'Reconnecting' })).toBeVisible();
  await expect(guest.getByRole('status').filter({ hasText: 'Reconnecting' })).toHaveCount(0, { timeout: 20_000 });
  await expect(host.getByRole('status').filter({ hasText: 'Reconnecting' })).toHaveCount(0, { timeout: 20_000 });
  await host.getByRole('button', { name: 'Vote 2', exact: true }).click();
  for (const page of [host, guest]) await expect(page.locator('.visible-vote')).toHaveText(['2', '5']);
  expect(errors).toEqual([]);
  for (const page of [host, guest]) await page.context().close();
});

test('the host can remove someone who vanished without leaving', async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, errors);
  const guest = await open(browser, errors);
  const gone = await open(browser, errors);
  const code = await createRoom(host, 'Alex');
  await joinByLink(guest, `./#/room/${code}`, 'Sam');
  await joinByLink(gone, `./#/room/${code}`, 'Taylor');
  await expect(guest.getByRole('button', { name: /Remove/ })).toHaveCount(0);

  // Going offline first means the leave message on close never arrives.
  await gone.context().setOffline(true);
  await gone.context().close();
  await host.getByRole('button', { name: 'Vote 2', exact: true }).click();
  await guest.getByRole('button', { name: 'Vote 3', exact: true }).click();
  await expect(host.locator('.status-pill')).toHaveText('2 / 3 voted');
  await expect(host.locator('.people-note')).toContainText('Remove them');

  await host.getByRole('button', { name: 'Remove Taylor' }).click();
  for (const page of [host, guest]) {
    await expect(page.locator('.people-list li')).toHaveCount(2);
    await expect(page.locator('.visible-vote')).toHaveText(['2', '3']);
  }
  expect(errors).toEqual([]);
  for (const page of [host, guest]) await page.context().close();
});

test('fireworks celebrate a reveal where everyone agrees, except with reduced motion', async ({ browser }) => {
  const errors: string[] = [];
  const host = await open(browser, errors);
  const guest = await open(browser, errors, { reducedMotion: 'reduce' });
  const code = await createRoom(host, 'Alex');
  await joinByLink(guest, `./#/room/${code}`, 'Sam');

  await host.getByRole('button', { name: 'Vote 3', exact: true }).click();
  await guest.getByRole('button', { name: 'Vote 5', exact: true }).click();
  await expect(host.getByRole('heading', { name: 'Cards on the table' })).toBeVisible();
  await expect(host.locator('canvas.fireworks')).toHaveCount(0);

  await guest.getByRole('button', { name: 'Start next round' }).click();
  await expect(host.locator('.round-label')).toHaveText('ROUND 2');
  await host.getByRole('button', { name: 'Vote 8', exact: true }).click();
  await guest.getByRole('button', { name: 'Vote 8', exact: true }).click();
  for (const page of [host, guest]) await expect(page.getByRole('heading', { name: 'Everyone agrees!' })).toBeVisible();
  await expect(host.locator('canvas.fireworks')).toBeAttached();
  await expect(guest.locator('canvas.fireworks')).toHaveCount(0);
  // The overlay doesn't block clicks and removes itself.
  await host.getByRole('button', { name: 'Copy link' }).click();
  await expect(host.locator('canvas.fireworks')).toHaveCount(0, { timeout: 10_000 });

  // Someone joining after the reveal sees the result but no replayed celebration.
  const late = await open(browser, errors);
  await joinByLink(late, `./#/room/${code}`, 'Jo');
  await expect(late.getByRole('heading', { name: 'Everyone agrees!' })).toBeVisible();
  await expect(late.locator('canvas.fireworks')).toHaveCount(0);
  expect(errors).toEqual([]);
  for (const page of [host, guest, late]) await page.context().close();
});

test('bad links, obsolete links, and rooms without a host give actionable errors', async ({ browser }) => {
  const errors: string[] = [];
  const page = await open(browser, errors, { viewport: { width: 375, height: 812 } });
  await page.goto('./#/room/bad');
  await expect(page.getByRole('heading', { name: 'That link doesn\'t look right.' })).toBeVisible();
  await page.goto('./#/planning-poker/old-peer-id');
  await expect(page.getByRole('heading', { name: 'That link doesn\'t look right.' })).toBeVisible();

  await page.goto('./');
  await page.getByLabel('Your name').fill('Alex');
  await page.getByLabel('Room code').fill('ABC');
  await page.getByRole('button', { name: 'Join →', exact: true }).click();
  expect(await page.getByLabel('Room code').evaluate((input: HTMLInputElement) => input.validationMessage)).toContain('5-character');

  await page.clock.install();
  await page.goto('./#/room/ZZZZZ');
  await page.getByLabel('Your name').fill('Alex');
  await page.getByRole('button', { name: 'Join room ZZZZZ' }).click();
  await expect.poll(async () => (await published()).length).toBe(1);
  await page.clock.fastForward(10_500);
  await expect.poll(async () => (await published()).length).toBe(2);
  await page.clock.fastForward(10_500);
  await expect(page.getByRole('alert')).toContainText('No host answered in room ZZZZZ');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.context().close();
});
