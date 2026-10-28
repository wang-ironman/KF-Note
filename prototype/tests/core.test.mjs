import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExpense, createHouse, createState, duplicateHouse, latestNote, latestVisit,
  monthlyReference, onceReference, unitPrice,
} from '../core.mjs';
import { createDemoState } from '../demo.mjs';

test('state and house constructors provide the shared schema and mode-specific defaults', () => {
  const state = createState();
  assert.deepEqual(state, {
    version: 1,
    settings: { mode: null, targets: [], lastBackupAt: null },
    houses: [], photos: [], compare: { buy: [], rent: [] },
  });
  const rent = createHouse('rent', { name: 'R', ignored: true }, '2026-10-01T00:00:00.000Z');
  const buy = createHouse('buy', {}, '2026-10-01T00:00:00.000Z');
  assert.equal(rent.name, 'R');
  assert.equal('ignored' in rent, false);
  assert.equal(rent.visits.length, 1);
  assert.equal(rent.expenses.filter(item => item.period === 'once').length, 1);
  assert.equal(buy.expenses.filter(item => item.period === 'once').length, 4);
  assert.deepEqual(buy.utilities.map(item => item.type), ['water', 'electricity', 'gas']);
  assert.deepEqual(rent.spaces.map(space => [space.type, space.name]), [
    ['bedroom', '主卧'], ['kitchen', '厨房'], ['bathroom', '卫生间'], ['living', '客厅'],
  ]);
  assert.throws(() => createHouse('share'), TypeError);
});

test('house duplication remaps owned IDs and references without mutating source or comparison state', () => {
  const state = createState();
  const source = createHouse('rent', { name: '原房源' }, '2026-10-01T00:00:00.000Z');
  source.spaces[0].name = '书房';
  source.contacts.push({ id: 'contact-1', name: '中介', phone: '123', role: 'agent', company: '', remark: '' });
  source.visits[0].notes[`space:${source.spaces[0].id}`] = { text: '书房安静', updatedAt: '2026-10-02T00:00:00.000Z' };
  source.expenses[0].amount = 321;
  source.coverId = 'photo-1';
  source.planId = 'photo-2';
  state.houses.push(source);
  state.photos.push(
    { id: 'photo-1', houseId: source.id, visitId: source.visits[0].id, sectionKey: `space:${source.spaces[0].id}`, filename: 'room.png', type: 'image/png', size: 4, caption: '', createdAt: '2026-10-02T00:00:00.000Z' },
    { id: 'photo-2', houseId: source.id, visitId: null, sectionKey: 'layout', filename: 'plan.png', type: 'image/png', size: 4, caption: '', createdAt: '2026-10-02T00:00:00.000Z' },
  );
  state.compare.rent.push(source.id);
  const original = structuredClone(state);
  const { house, photos, pairs } = duplicateHouse(state, source.id, '2026-10-03T00:00:00.000Z');

  assert.deepEqual(state, original);
  assert.equal(house.name, '原房源（副本）');
  assert.equal(house.createdAt, '2026-10-03T00:00:00.000Z');
  assert.equal(house.updatedAt, '2026-10-03T00:00:00.000Z');
  assert.equal(house.visits[0].at, source.visits[0].at);
  assert.equal(house.expenses[0].amount, 321);
  assert.notEqual(house.id, source.id);
  assert.notEqual(house.spaces[0].id, source.spaces[0].id);
  assert.notEqual(house.contacts[0].id, source.contacts[0].id);
  assert.notEqual(house.expenses[0].id, source.expenses[0].id);
  assert.notEqual(house.visits[0].id, source.visits[0].id);
  const newSpaceKey = `space:${house.spaces[0].id}`;
  assert.equal(house.visits[0].notes[newSpaceKey].text, '书房安静');
  assert.equal(house.visits[0].notes[`space:${source.spaces[0].id}`], undefined);
  assert.equal(photos[0].houseId, house.id);
  assert.equal(photos[0].visitId, house.visits[0].id);
  assert.equal(photos[0].sectionKey, newSpaceKey);
  assert.equal(house.coverId, photos[0].id);
  assert.equal(house.planId, photos[1].id);
  assert.deepEqual(pairs, [{ from: 'photo-1', to: photos[0].id }, { from: 'photo-2', to: photos[1].id }]);
  assert.deepEqual(state.compare.rent, [source.id]);
  assert.throws(() => duplicateHouse(state, 'missing'), /找不到要复制的房源/);
});

test('house duplication without photos returns empty photo mapping', () => {
  const state = createState();
  const source = createHouse('buy', { name: '无照片' });
  state.houses.push(source);
  const copy = duplicateHouse(state, source.id);
  assert.deepEqual(copy.photos, []);
  assert.deepEqual(copy.pairs, []);
  assert.equal(copy.house.coverId, null);
  assert.equal(copy.house.planId, null);
});

test('unknown values stay unresolved while a known zero is a valid amount', () => {
  const house = createHouse('rent', { price: null }, '2026-10-01T00:00:00.000Z');
  const property = house.expenses.find(item => item.name === '物业费');
  const network = house.expenses.find(item => item.name === '网费');
  Object.assign(property, { status: 'known', amount: 0, payer: 'self' });
  Object.assign(network, { status: 'known', amount: null, payer: 'self' });
  const result = monthlyReference(house);
  assert.equal(result.known, 0);
  assert.equal(result.unknown, 3); // rent, heating, and invalid network amount
  assert.equal(result.items.find(item => item.name === '物业费').monthly, 0);
  assert.equal(result.items.find(item => item.name === '租金').monthly, null);
});

test('monthly calculations normalize quarter, year, and season and require sqm billing area', () => {
  const house = createHouse('buy');
  house.expenses = [
    Object.assign(createExpense('property', '季度费', 'quarter'), { status: 'known', amount: 300, payer: 'self' }),
    Object.assign(createExpense('heating', '年费', 'year'), { status: 'known', amount: 1200, payer: 'self' }),
    Object.assign(createExpense('heating', '季节费', 'season'), { status: 'known', amount: 600, payer: 'self', seasonAnnual: true }),
    Object.assign(createExpense('other', '年费', 'year'), { status: 'known', amount: 1200, payer: 'self' }),
    Object.assign(createExpense('other', '面积费'), { status: 'known', amount: 2, payer: 'self', unit: 'sqm' }),
  ];
  const result = monthlyReference(house);
  assert.equal(result.known, 350);
  assert.equal(result.unknown, 1);
  assert.equal(result.hasAmortized, true);
  assert.equal(result.items.find(item => item.name === '季度费').monthly, 100);
  assert.equal(result.items.find(item => item.name === '季节费').reason, '按全年12个月摊算');
  assert.equal(result.items.find(item => item.name === '年费').reason, '按全年12个月摊算');
  assert.equal(result.items.find(item => item.name === '面积费').monthly, null);
});

test('season fees without confirmed annual frequency remain unknown', () => {
  const house = createHouse('buy');
  house.expenses = [Object.assign(createExpense('heating', '季节费', 'season'), {
    status: 'known', amount: 1200, payer: 'self',
  })];
  const result = monthlyReference(house);
  assert.equal(result.known, 0);
  assert.equal(result.unknown, 1);
  assert.equal(result.hasAmortized, false);
  assert.equal(result.items[0].monthly, null);
  assert.match(result.items[0].reason, /频次未确认/);
});

test('included and free expenses count as zero without duplicating unknowns; other payer is excluded', () => {
  const house = createHouse('buy');
  house.expenses = [
    Object.assign(createExpense('property', '已含'), { status: 'included', payer: 'unknown' }),
    Object.assign(createExpense('network', '免费'), { status: 'free', payer: 'unknown' }),
    Object.assign(createExpense('other', '他人承担'), { status: 'unknown', payer: 'other' }),
  ];
  const result = monthlyReference(house);
  assert.equal(result.known, 0);
  assert.equal(result.unknown, 0);
  assert.deepEqual(result.items.map(item => item.monthly), [0, 0]);
});

test('once reference excludes recurring fees and deposits and preserves payer uncertainty', () => {
  const house = createHouse('rent');
  house.terms.deposit = 5000;
  house.expenses = [
    Object.assign(createExpense('agency', '中介费', 'once'), { status: 'known', amount: 1000, payer: 'self' }),
    Object.assign(createExpense('other', '未知一次费', 'once'), { status: 'known', amount: 300, payer: 'unknown' }),
    Object.assign(createExpense('other', '他人一次费', 'once'), { status: 'unknown', payer: 'other' }),
    Object.assign(createExpense('property', '月费'), { status: 'known', amount: 500, payer: 'self' }),
  ];
  const result = onceReference(house);
  assert.equal(result.known, 1000);
  assert.equal(result.unknown, 1);
  assert.equal(result.items.some(item => item.name.includes('押金')), false);
  assert.equal(result.items.some(item => item.name === '月费'), false);
});

test('buy unit price needs confirmed area basis and never applies to rent', () => {
  const buy = { mode: 'buy', price: 200, area: 80, areaBasis: '建筑面积' };
  assert.equal(unitPrice(buy), 25000);
  assert.equal(unitPrice({ ...buy, areaBasis: 'unknown' }), null);
  assert.equal(unitPrice({ ...buy, area: 0 }), null);
  assert.equal(unitPrice({ ...buy, mode: 'rent' }), null);
  assert.equal(monthlyReference(buy).known, 0); // sale price is not monthly cost
});

test('latest note follows visit date, not note edit time, and ignores blank notes', () => {
  const house = {
    visits: [
      { id: 'old', at: '2026-10-01T00:00:00.000Z', createdAt: '2026-10-01', notes: { whole: { text: '旧观察', updatedAt: '2026-10-10' } } },
      { id: 'new', at: '2026-10-08T00:00:00.000Z', createdAt: '2026-10-08', notes: { whole: { text: '新观察', updatedAt: '2026-10-08' }, kitchen: { text: '  ' } } },
    ],
  };
  assert.equal(latestNote(house, 'whole').visit.id, 'new');
  assert.equal(latestNote(house, 'whole').note.text, '新观察');
  assert.equal(latestNote(house, 'kitchen'), null);
  assert.equal(latestNote(house, 'missing'), null);
  assert.equal(latestVisit(house).id, 'new');
});

test('latest note includes photo-only visits and compares timezone-offset timestamps by instant', () => {
  const house = {
    id: 'house-1',
    visits: [
      { id: 'text', at: '2026-10-08T08:30:00.000Z', createdAt: '2026-10-08T08:30:00.000Z', notes: { whole: { text: '较早文字' } } },
      { id: 'photo', at: '2026-10-08T10:00:00+01:00', createdAt: '2026-10-08T09:00:00.000Z', notes: {} },
      { id: 'earlier', at: '2026-10-08T10:00:00+02:00', createdAt: '2026-10-08T08:00:00.000Z', notes: { whole: { text: '更早瞬间' } } },
    ],
  };
  const photos = [
    { houseId: 'house-1', visitId: 'photo', sectionKey: 'whole' },
    { houseId: 'another-house', visitId: 'photo', sectionKey: 'whole' },
    { houseId: 'house-1', visitId: 'text', sectionKey: 'environment' },
  ];
  const result = latestNote(house, 'whole', photos);
  assert.equal(result.visit.id, 'photo');
  assert.deepEqual(result.note, { text: '' });
});

test('demo has two fictional houses per mode, dated observations, and target-linked commutes', () => {
  const state = createDemoState();
  assert.equal(state.houses.filter(house => house.mode === 'rent').length, 2);
  assert.equal(state.houses.filter(house => house.mode === 'buy').length, 2);
  assert.ok(state.houses.every(house => house.name.includes('演示') && house.name.includes('虚构')));
  assert.ok(state.houses.every(house => house.visits.some(visit => visit.commutes[0]?.targetId === 'target-office')));
  assert.ok(state.houses.some(house => house.mode === 'rent' && house.terms.pets === 'allowed'));
  assert.ok(state.houses.some(house => house.mode === 'rent' && house.terms.pets === 'not-allowed'));
  assert.ok(state.houses.some(house => monthlyReference(house).unknown > 0));
  assert.deepEqual(state.photos, []);
});
