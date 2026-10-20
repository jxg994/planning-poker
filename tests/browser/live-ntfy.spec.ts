import { test, expect } from '@playwright/test';

// Uses the public ntfy.sh service (about 6 messages per run). Opt in with NTFY_LIVE=1.
test.skip(!process.env.NTFY_LIVE, 'Set NTFY_LIVE=1 to run against the real ntfy.sh');

test('two browsers estimate together through the real ntfy.sh', async ({ browser }) => {
  const errors: string[] = [];
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  for (const page of [host, guest]) page.on('pageerror', (error) => errors.push(error.message));

  await host.goto('./');
  await host.getByLabel('Your name').fill('Live host');
  await host.getByRole('button', { name: 'Create a room' }).click();
  await expect(host.getByRole('heading', { name: 'Planning room' })).toBeVisible({ timeout: 30_000 });
  const code = (await host.getByLabel('Room code', { exact: true }).textContent())!.trim();

  await guest.goto('./');
  await guest.getByLabel('Your name').fill('Live guest');
  await guest.getByLabel('Room code').fill(code);
  await guest.getByRole('button', { name: 'Join →', exact: true }).click();
  await expect(guest.getByRole('heading', { name: 'Planning room' })).toBeVisible({ timeout: 30_000 });
  await expect(host.locator('.people-list li')).toHaveCount(2);

  await host.getByRole('button', { name: 'Vote 13', exact: true }).click();
  await expect(guest.locator('.status-pill')).toHaveText('1 / 2 voted');
  await expect(guest.locator('.visible-vote')).toHaveCount(0);
  await guest.getByRole('button', { name: 'Vote 21', exact: true }).click();
  for (const page of [host, guest]) await expect(page.locator('.visible-vote')).toHaveText(['13', '21']);

  await host.getByRole('link', { name: 'Leave room' }).click();
  await expect(guest.getByRole('alert')).toContainText('host left');
  expect(errors).toEqual([]);
  for (const page of [host, guest]) await page.context().close();
});
