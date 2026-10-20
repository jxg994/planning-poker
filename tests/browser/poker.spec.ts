import { test, expect } from '@playwright/test';

test('real peers join, hide votes, reveal, reset, and handle departures', async ({ page: host, browser }) => {
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const thirdContext = await browser.newContext();
  const third = await thirdContext.newPage();
  const errors: string[] = [];
  for (const page of [host, guest, third]) {
    page.on('pageerror', (error) => errors.push(error.message));
    await page.context().grantPermissions(['microphone']);
    await page.goto('http://127.0.0.1:5173/planning-poker/');
    await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    });
  }

  try {
    await host.goto('./');
    await host.getByLabel('Your name').fill('Alex');
    await host.getByRole('button', { name: 'Create a session' }).click();
    await expect(host.getByRole('heading', { name: 'Planning room' })).toBeVisible();
    const link = await host.getByLabel('Session link').inputValue();
    expect(link).toContain('#/planning-poker/');

    await guest.goto(link);
    await guest.getByLabel('Your name').fill('Sam <script>');
    await guest.getByRole('button', { name: 'Join session' }).click();
    await expect(guest.getByRole('heading', { name: 'Planning room' })).toBeVisible();
    await expect(host.locator('.people-list li')).toHaveCount(2);
    await expect(host.locator('.people-list')).toContainText('Sam <script>');

    await host.getByRole('button', { name: 'Vote 0', exact: true }).click();
    await expect(guest.locator('.status-pill')).toHaveText('1 / 2 voted');
    await expect(guest.locator('.person-vote.visible-vote')).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Start next round' })).toHaveCount(0);
    await guest.getByRole('button', { name: 'Vote 8', exact: true }).click();
    for (const page of [host, guest]) {
      await expect(page.getByRole('heading', { name: 'Cards on the table' })).toBeVisible();
      await expect(page.locator('.visible-vote')).toHaveText(['0', '8']);
    }

    await third.goto(link);
    await third.getByLabel('Your name').fill('Taylor');
    await third.getByRole('button', { name: 'Join session' }).click();
    await expect(third.getByRole('heading', { name: 'Cards on the table' })).toBeVisible();
    await expect(third.getByRole('button', { name: 'Vote 5', exact: true })).toBeDisabled();
    await expect(third.locator('.visible-vote')).toHaveText(['0', '8', '—']);

    await guest.getByRole('button', { name: 'Start next round' }).click();
    for (const page of [host, guest, third]) {
      await expect(page.locator('.round-label')).toHaveText('ROUND 2');
      await expect(page.locator('.status-pill')).toHaveText('0 / 3 voted');
      await expect(page.getByRole('button', { name: 'Vote 0', exact: true })).toHaveAttribute('aria-pressed', 'false');
    }
    await host.getByRole('button', { name: 'Vote 3', exact: true }).click();
    await guest.getByRole('button', { name: 'Vote 5', exact: true }).click();
    await third.getByRole('link', { name: 'Leave session' }).click();
    await expect(host.getByRole('heading', { name: 'Cards on the table' })).toBeVisible();
    await expect(host.locator('.visible-vote')).toHaveText(['3', '5']);

    await guest.setViewportSize({ width: 375, height: 812 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await host.getByRole('link', { name: 'Leave session' }).click();
    await expect(guest.getByRole('alert')).toContainText('host disconnected');
    await expect(guest.getByLabel('Your name')).toHaveValue('Sam <script>');
    expect(errors).toEqual([]);
  } finally {
    await guestContext.close();
    await thirdContext.close();
  }
});

test('bad links and unavailable hosts give actionable errors', async ({ page }) => {
  await page.goto('./#/planning-poker/bad/id');
  await expect(page.getByRole('heading', { name: 'That link doesn\'t look right.' })).toBeVisible();
  await page.goto('./#/planning-poker/missing-host-for-planning-poker-test');
  await page.getByLabel('Your name').fill('Alex');
  await page.getByRole('button', { name: 'Join session' }).click();
  await expect(page.getByRole('alert')).toContainText('host could not be found');
  await expect(page.locator('#connection-diagnostics')).toHaveAttribute('open', '');
  await expect(page.locator('#connection-diagnostics pre')).toContainText('peer-unavailable');
});

test('failed direct connections preserve a copyable report on mobile', async ({ page: host, browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const guest = await context.newPage();
  try {
    // Simulate an unreachable path without modifying the app's ICE configuration.
    await guest.addInitScript(() => {
      const Original = RTCPeerConnection;
      globalThis.RTCPeerConnection = new Proxy(Original, {
        construct(Target, args: ConstructorParameters<typeof RTCPeerConnection>) {
          return new Target({ ...args[0], iceTransportPolicy: 'relay' });
        },
      });
    });
    await host.goto('./');
    await host.getByLabel('Your name').fill('Host');
    await host.getByRole('button', { name: 'Create a session' }).click();
    await expect(host.getByRole('heading', { name: 'Planning room' })).toBeVisible();
    await guest.goto(await host.getByLabel('Session link').inputValue());
    await guest.clock.install();
    await guest.getByLabel('Your name').fill('Guest');
    await guest.getByRole('button', { name: 'Join session' }).click();
    await expect(guest.locator('#connection-diagnostics pre')).toContainText('"remoteDescription": "answer"');
    await expect(host.locator('#connection-diagnostics pre')).toContainText('"remoteDescription": "offer"');
    await guest.clock.fastForward(31_000);
    await expect(guest.getByRole('alert')).toContainText('The host answered');
    await expect(guest.locator('#connection-diagnostics')).toHaveAttribute('open', '');
    const report = await guest.locator('#connection-diagnostics pre').textContent();
    await guest.clock.fastForward(5_000);
    await expect(guest.locator('#connection-diagnostics pre')).toHaveText(report!);
    await guest.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (text: string) => { document.body.dataset.copied = text; } },
        configurable: true,
      });
    });
    await guest.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(guest.locator('#diagnostics-copy-status')).toHaveText('Copied.');
    expect(await guest.locator('body').getAttribute('data-copied')).toBe(report);
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});
