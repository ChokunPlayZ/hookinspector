import { expect, test } from '@playwright/test';

test('follows the system theme until a keyboard-accessible choice is saved', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#10151d');

  await page.getByRole('button', { name: 'Switch to light mode' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('hookinspector.theme'))).toBe('light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f3f5f7');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('applies a saved theme before the app loads, without an inline script', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('hookinspector.theme', 'light'));
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#root')).toBeEmpty();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
});

test('can switch themes when browser storage is unavailable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('Storage unavailable'); };
    Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(errors).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} theme keeps text, syntax, and controls high contrast`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    await expect(page.locator('.connection-status')).toHaveText('Live');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const contrast = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const luminance = (token: string) => {
        const hex = style.getPropertyValue(token).trim().slice(1);
        const channels = [0, 2, 4].map((offset) => {
          const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
          return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const pairs: [string, string, number][] = [];
      const add = (foreground: string, backgrounds: string[], minimum = 4.5) => {
        backgrounds.forEach((background) => pairs.push([foreground, background, minimum]));
      };
      add('--text', ['--canvas', '--surface', '--code-background']);
      add('--secondary', ['--canvas', '--surface', '--surface-raised', '--surface-hover', '--accent-soft', '--endpoint-footer', '--success-soft']);
      add('--muted', ['--canvas', '--surface', '--surface-subtle', '--surface-raised', '--accent-soft', '--code-background']);
      add('--accent', ['--canvas', '--surface', '--accent-soft']);
      add('--on-accent', ['--accent', '--accent-dark']);
      add('--accent-text', ['--endpoint-surface', '--accent-soft', '--code-background']);
      add('--warning', ['--warning-soft']);
      add('--success', ['--surface', '--success-soft']);
      add('--danger', ['--surface', '--danger-soft']);
      for (const syntax of ['key', 'string', 'number', 'boolean']) add(`--syntax-${syntax}`, ['--code-background']);
      for (const method of ['other', 'post', 'get', 'put', 'patch', 'delete', 'options']) add(`--method-${method}`, [`--method-${method}-bg`]);
      add('--control-border', ['--surface', '--surface-subtle'], 3);
      return pairs.map(([foreground, background, minimum]) => {
        const a = luminance(foreground);
        const b = luminance(background);
        return { foreground, background, minimum, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
    });
    for (const { foreground, background, minimum, ratio } of contrast) {
      expect(ratio, `${theme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(minimum);
    }

    await page.getByRole('button', { name: 'Send a test request' }).click();
    await expect(page.locator('.code-view')).toContainText('hello.webhook');
    await expect(page.locator('.body-code')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(17, 25, 35)' : 'rgb(245, 247, 250)');
    await page.getByRole('tab', { name: /Headers/ }).click();
    await expect(page.locator('.pair-table')).toContainText('X-Hook-Inspector');
    await page.getByRole('button', { name: 'Quick guide' }).click();
    await expect(page.getByRole('dialog')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(25, 33, 44)' : 'rgb(255, 255, 255)');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });
}
