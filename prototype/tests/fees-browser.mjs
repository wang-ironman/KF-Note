import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['prototype/server.mjs'], {
  env: { ...process.env, PORT: '4179' }, stdio: 'ignore',
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch('http://localhost:4179')).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'test server did not start');
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:4179');
  await page.locator('[data-mode="rent"]').first().click();
  await page.locator('[data-page="new"]:visible').first().click();
  const houseForm = page.locator('#new-house');
  await houseForm.locator('[name="name"]').fill('费用测试房源');
  await houseForm.locator('[name="price"]').fill('1000');
  await houseForm.locator('button.primary').click();
  await page.getByRole('heading', { name: '费用测试房源' }).waitFor();
  await page.locator('[data-tab="fees"]').click();

  const fixedStatus = page.locator('details.fee-card [data-scope="expense"][data-field="status"]');
  const statusCount = await fixedStatus.count();
  assert.ok(statusCount >= 3, `expected at least three fixed-fee status selects; found ${statusCount}`);
  for (let index = 0; index < statusCount; index++) {
    const select = fixedStatus.nth(index);
    const options = await select.locator('option').evaluateAll(items => items.map(option => ({ value: option.value, disabled: option.disabled })));
    assert.ok(options.every(option => option.value === '' || ['free', 'known'].includes(option.value)),
      `fixed-fee status exposed an unsupported choice: ${JSON.stringify(options)}`);
    assert.ok(options.some(option => option.value === '' && option.disabled),
      'fixed-fee status must retain an empty disabled placeholder');
    const card = select.locator('xpath=ancestor::details');
    if (await card.getAttribute('open') === null) await card.locator('summary').click();
    await select.selectOption('free');
    await page.waitForFunction(index => document.querySelectorAll('details.fee-card [data-scope="expense"][data-field="status"]')[index]?.value === 'free', index);
  }
  const payerSelect = page.locator('details.fee-card [data-scope="expense"][data-field="payer"]');
  for (let index = 0; index < await payerSelect.count(); index++) {
    const payer = payerSelect.nth(index);
    assert.equal(await payer.inputValue(), 'other', 'free fee must be recorded as paid by another party');
    assert.equal(await payer.isDisabled(), true, 'payer should not be independently editable');
  }

  const propertyStatus = page.locator('details.fee-card').filter({ hasText: '物业费' }).locator('[data-scope="expense"][data-field="status"]');
  const propertyCardBefore = page.locator('details.fee-card').filter({ hasText: '物业费' });
  if (await propertyCardBefore.getAttribute('open') === null) await propertyCardBefore.locator('summary').click();
  await propertyStatus.selectOption('known');
  const propertyCard = page.locator('details.fee-card').filter({ hasText: '物业费' });
  const propertyAmount = propertyCard.locator('[data-scope="expense"][data-field="amount"]');
  assert.equal(await propertyAmount.getAttribute('required'), '');
  assert.equal(await propertyCard.locator('[data-scope="expense"][data-field="payer"]').inputValue(), 'self');
  await propertyAmount.fill('100');
  await page.waitForFunction(() => document.querySelector('#monthly-reference')?.textContent.includes('¥1,100/月'));

  const agencyPanel = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '中介费' }) });
  const agencyAmounts = agencyPanel.locator('[data-scope="agency"][data-field="amount"]');
  assert.equal(await agencyAmounts.count(), 2, 'agency panel should have separate one-time and monthly amount fields');
  const agencyFields = await agencyAmounts.evaluateAll(items => items.map((item, index) => ({
    index, id: item.dataset.id, label: item.closest('label')?.textContent || '',
  })));
  const onceIndex = agencyFields.find(item => item.label.includes('一次性'))?.index;
  const monthlyIndex = agencyFields.find(item => item.label.includes('每月'))?.index;
  assert.notEqual(onceIndex, undefined, `one-time agency amount field was not labeled: ${JSON.stringify(agencyFields)}`);
  assert.notEqual(monthlyIndex, undefined, `monthly agency amount field was not labeled: ${JSON.stringify(agencyFields)}`);
  await agencyAmounts.nth(onceIndex).fill('500');
  await agencyAmounts.nth(monthlyIndex).fill('80');
  await page.waitForFunction(() => document.querySelector('#monthly-reference')?.textContent.includes('¥1,180/月'));
  await page.waitForFunction(() => document.querySelector('#once-reference')?.textContent.includes('¥500'));

  const heatingStatus = page.locator('details.fee-card').filter({ hasText: '取暖费' }).locator('[data-scope="expense"][data-field="status"]');
  const heatingBefore = page.locator('details.fee-card').filter({ hasText: '取暖费' });
  if (await heatingBefore.getAttribute('open') === null) await heatingBefore.locator('summary').click();
  await heatingStatus.selectOption('free');
  await heatingStatus.selectOption('known');
  const heatingCard = page.locator('details.fee-card').filter({ hasText: '取暖费' });
  assert.equal(await heatingCard.locator('[data-scope="expense"][data-field="amount"]').inputValue(), '',
    'switching free to self-paid must not reuse a previous amount');
  await page.waitForFunction(() => document.querySelector('#monthly-reference')?.textContent.includes('1 项未确认'));

  await page.waitForFunction(async () => {
    const { loadState } = await import('/storage.mjs');
    const state = await loadState();
    const house = state?.houses.find(item => item.name === '费用测试房源');
    const property = house?.expenses.find(item => item.name === '物业费');
    const agency = house?.expenses.find(item => item.category === 'agency' && item.period === 'once');
    return property?.amount === 100 && property.payer === 'self' && agency?.amount === 500;
  });
  await page.reload();
  await page.locator('[data-open-house]').first().click();
  await page.locator('[data-tab="fees"]').click();
  await page.waitForFunction(() => document.querySelector('#monthly-reference')?.textContent.includes('¥1,180/月'));
  await page.waitForFunction(() => document.querySelector('#once-reference')?.textContent.includes('¥500'));

  const roundTrip = await page.evaluate(async () => {
    const storage = await import('/storage.mjs');
    const before = await storage.loadState();
    const backup = await storage.exportBackup();
    const restored = await storage.importBackup(backup);
    const house = restored.houses.find(item => item.name === '费用测试房源');
    return {
      same: JSON.stringify(restored) === JSON.stringify(before),
      agency: house.expenses.filter(item => item.category === 'agency').map(item => ({ period: item.period, amount: item.amount })),
      fees: house.expenses.map(item => ({ name: item.name, status: item.status, amount: item.amount, payer: item.payer })),
    };
  });
  assert.equal(roundTrip.same, true, 'ZIP import/export should preserve the full fee state');
  assert.deepEqual(roundTrip.agency, [{ period: 'once', amount: 500 }, { period: 'month', amount: 80 }]);
  assert.deepEqual(roundTrip.fees.filter(item => ['物业费', '取暖费', '网费'].includes(item.name)).map(({ name, status, amount, payer }) => ({ name, status, amount, payer })), [
    { name: '物业费', status: 'known', amount: 100, payer: 'self' },
    { name: '取暖费', status: 'known', amount: null, payer: 'self' },
    { name: '网费', status: 'free', amount: null, payer: 'other' },
  ]);
  assert.deepEqual(errors, [], `browser runtime errors: ${errors.join('; ')}`);
  console.log('Fees browser integration passed: fixed-fee statuses, separate agency costs, monthly/one-time totals, reload and ZIP roundtrip.');
} finally {
  await browser?.close();
  server.kill();
}
