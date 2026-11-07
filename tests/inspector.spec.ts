import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('creates a private endpoint and displays a real test request live', async ({ page }) => {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url()); });
  await page.goto('/');
  await expect(page.locator('.endpoint-url')).toContainText('/h/');
  await expect(page.locator('.connection-status')).toHaveText('Live');
  await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();
  await page.getByRole('button', { name: 'Send a test request' }).click();
  await expect(page.locator('.request-row')).toHaveCount(1);
  await expect(page.locator('.code-view')).toContainText('hello.webhook');
  await expect(page.locator('.code-view')).toContainText('4900');
  await page.getByRole('tab', { name: /Headers/ }).click();
  await expect(page.locator('.pair-table')).toContainText('X-Hook-Inspector');
  await expect(page.locator('.pair-table')).not.toContainText('hi_owner');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.locator('.pair-table')).toContainText('127.0.0.1');
  await expect(page.locator('.pair-table')).toContainText('Body read time');
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test('inspects external malformed JSON, original headers, and repeated query parameters', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('Live');
  const url = await page.locator('.endpoint-url').innerText();
  const response = await request.post(`${url}/orders?tag=first&tag=second&empty=`, {
    headers: { 'Content-Type': 'application/json', 'X-Trace-Id': 'trace-123' },
    data: Buffer.from('{ malformed json \r\n'),
  });
  expect(response.ok()).toBe(true);
  await expect(page.locator('.request-row')).toHaveCount(1);
  await expect(page.locator('.raw-code')).toHaveText('{ malformed json \r\n');
  await page.getByRole('tab', { name: /Headers/ }).click();
  await expect(page.locator('.pair-table')).toContainText('trace-123');
  await page.getByRole('tab', { name: /Query params/ }).click();
  await expect(page.locator('.pair-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.pair-table')).toContainText('first');
  await expect(page.locator('.pair-table')).toContainText('second');
  await expect(page.locator('.pair-table')).toContainText('(empty)');
});

test('filters and clears captured requests while keeping the endpoint active', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('Live');
  const url = await page.locator('.endpoint-url').innerText();
  await request.post(`${url}/orders`, { data: { event: 'order.created' } });
  await request.get(`${url}/health?ok=true`);
  await expect(page.locator('.request-row')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Filter by method' }).selectOption('POST');
  await expect(page.locator('.request-row')).toHaveCount(1);
  await expect(page.locator('.request-row')).toContainText('/orders');
  await page.getByRole('combobox', { name: 'Filter by method' }).selectOption('ALL');
  await page.getByRole('textbox', { name: 'Search requests' }).fill('does-not-exist');
  await expect(page.getByRole('heading', { name: 'No matching requests' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.locator('.request-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear all requests', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear all requests' }).click();
  await expect(page.locator('.request-row')).toHaveCount(0);
  expect(await page.locator('.endpoint-url').innerText()).toBe(url);
  await expect(page.getByRole('heading', { name: 'Ready when you are.' })).toBeVisible();
  await request.post(url, { data: 'still here' });
  await expect(page.locator('.request-row')).toHaveCount(1);
});

test('replaces an endpoint, revokes the old URL, and applies the chosen lifetime', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('Live');
  const previous = await page.locator('.endpoint-url').innerText();
  await page.getByRole('button', { name: 'New endpoint', exact: true }).click();
  await page.getByLabel('Keep this endpoint alive for').selectOption('1');
  await page.getByRole('button', { name: 'Create endpoint', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.connection-status')).toHaveText('Live');
  expect(await page.locator('.endpoint-url').innerText()).not.toBe(previous);
  await expect(page.locator('.expiry-badge')).toHaveText(/1h 0m left|60m left|59m left/);
  await expect.poll(async () => (await request.post(previous, { data: 'revoked' })).status()).toBe(404);
});

test('keeps inspection private and restores the same inbox on reload', async ({ page, request, browser }) => {
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('Live');
  const url = await page.locator('.endpoint-url').innerText();
  const id = url.split('/').at(-1)!;
  expect((await request.get(`/api/inboxes/${id}`)).status()).toBe(404);
  await request.post(url, { data: { private: true } });
  await expect(page.locator('.request-row')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.endpoint-url')).toHaveText(url);
  await expect(page.locator('.request-row')).toHaveCount(1);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await other.goto('http://127.0.0.1:4173/');
    await expect(other.locator('.connection-status')).toHaveText('Live');
    expect(await other.locator('.endpoint-url').innerText()).not.toBe(url);
    await expect(other.locator('.request-row')).toHaveCount(0);
  } finally { await context.close(); }
});

test('renders hostile payloads as inert text and exposes binary data as Base64', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('Live');
  const url = await page.locator('.endpoint-url').innerText();
  await request.post(url, { data: '<script>window.hacked = true</script><img src=x onerror="window.hacked=true">' });
  await expect(page.locator('.raw-code')).toContainText('<script>');
  expect(await page.evaluate(() => 'hacked' in window)).toBe(false);
  await request.post(url, { headers: { 'Content-Type': 'application/octet-stream' }, data: Buffer.from([0, 255, 254, 42]) });
  await expect(page.getByRole('heading', { name: 'This is a binary payload' })).toBeVisible();
  await page.getByRole('button', { name: 'View Base64', exact: true }).click();
  await expect(page.locator('.raw-code')).toHaveText('AP/+Kg==');
});

test('opens the guide and privacy dialogs and closes them with Escape', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Quick guide' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Get the whole picture' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'A note on privacy' }).click();
  await expect(page.getByRole('heading', { name: 'What gets stored?' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('copies the endpoint and exports original body bytes and full request metadata', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.locator('.connection-status')).toHaveText('Live');
  const url = await page.locator('.endpoint-url').innerText();
  await page.getByRole('button', { name: 'Copy URL', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await page.getByRole('button', { name: 'Copy cURL', exact: true }).click();
  const command = await page.evaluate(() => navigator.clipboard.readText());
  expect(command.split('\n')[0]).toBe(`curl -X POST '${url}' \\`);
  expect(command.split('\n')[1]).toBe("  -H 'Content-Type: application/json' \\");
  expect(command).not.toContain('\n+');
  const payload = Buffer.from([0, 255, 254, 42]);
  await request.post(url, { headers: { 'Content-Type': 'application/octet-stream' }, data: payload });
  await expect(page.getByRole('heading', { name: 'This is a binary payload' })).toBeVisible();
  const bodyDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original body' }).click();
  const downloadedBody = await bodyDownload;
  expect(await readFile((await downloadedBody.path())!)).toEqual(payload);
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export full request as JSON' }).click();
  const downloadedRequest = await exportDownload;
  const data = JSON.parse(await readFile((await downloadedRequest.path())!, 'utf8')) as { bodyBase64: string; method: string; headers: string[][] };
  expect(data.bodyBase64).toBe(payload.toString('base64'));
  expect(data.method).toBe('POST');
  expect(data.headers.length).toBeGreaterThan(0);
});
