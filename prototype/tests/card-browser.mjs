import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['prototype/server.mjs'], { env: { ...process.env, PORT: '4176' }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://localhost:4176')).ok) break; } catch {} await delay(100); }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:4176');
  await page.locator('[data-mode="rent"]').first().click();
  await page.locator('[data-page="new"]:visible').first().click();
  await page.locator('#new-house [name="name"]').fill('只填名称的房子');
  await page.locator('#new-house button[type="submit"], #new-house button:not([type])').last().click();
  await page.getByRole('heading', { name: '只填名称的房子' }).waitFor();
  await page.locator('#save-state').getByText('已保存到本机').waitFor();
  await page.reload();
  // Re-enter an unfinished record via cover, body text and card whitespace.
  for (const selector of ['.cover', '.house-observation', '.house-body']) {
    await page.locator(`.house-card ${selector}`).click({ position: { x: 5, y: 5 } });
    await page.getByRole('heading', { name: '只填名称的房子' }).waitFor({ timeout: 3000 });
    assert.ok(await page.getByRole('heading', { name: '只填名称的房子' }).isVisible(), `${selector} must open the unfinished house`);
    await page.locator('[data-scope="note"][data-field="text"]').fill('退出后继续补写');
    await page.locator('#save-state').getByText('已保存到本机').waitFor();
    await page.locator('[data-page="list"]:visible').first().click();
  }
  // Comparing must never navigate, including clicking its label text.
  await page.locator('.house-card .check-label').click();
  await page.locator('#save-state').getByText('已保存到本机').waitFor();
  assert.ok(await page.locator('.house-card').isVisible());
  assert.equal(await page.locator('.house-card input[data-compare]').isChecked(), true);
  await page.locator('.house-card input[data-compare]').uncheck();
  assert.ok(await page.locator('.house-card').isVisible());
  await page.locator('.house-title').click();
  assert.equal(await page.locator('[data-scope="note"][data-field="text"]').inputValue(), '退出后继续补写');
  assert.deepEqual(errors, []);
  console.log('Card regression passed: unfinished record reopened by cover/body/whitespace; comparison stays independent.');
} finally { await browser?.close(); server.kill(); }
