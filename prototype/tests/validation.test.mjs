import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, createHouse } from '../core.mjs';
import { createDemoState } from '../demo.mjs';
import { validateState } from '../storage.mjs';

function fixture() {
  const state = createState();
  state.settings.mode = 'rent';
  state.houses.push(createHouse('rent', { name: '测试房源' }));
  return state;
}

test('empty, fresh and fictional demo states pass backup validation', () => {
  for (const state of [createState(), fixture(), createDemoState()]) assert.equal(validateState(state), state);
});

test('malformed contact phone and furniture list are rejected before replacing data', () => {
  const contacts = fixture();
  contacts.houses[0].contacts.push({ id: 'contact-test', name: '测试联系人', phone: 123, role: 'other', company: '', remark: '' });
  assert.throws(() => validateState(contacts));
  const furniture = fixture();
  furniture.houses[0].terms.furniture = null;
  assert.throws(() => validateState(furniture));
});

test('utility prices and fee fields reject impossible numeric values', () => {
  const utility = fixture();
  utility.houses[0].utilities[0].rate = -1;
  assert.throws(() => validateState(utility));
  const expense = fixture();
  expense.houses[0].expenses[0].amount = '100';
  assert.throws(() => validateState(expense));
});

test('unknown commute duration is valid, duplicate destination and method is rejected', () => {
  const state = fixture();
  state.settings.targets.push({ id: 'target-test', name: '公司', address: '' });
  const commute = { targetId: 'target-test', method: 'transit', minutes: null, source: '' };
  state.houses[0].visits[0].commutes.push(commute);
  assert.equal(validateState(state), state);
  state.houses[0].visits[0].commutes.push({ ...commute, minutes: 30 });
  assert.throws(() => validateState(state));
});

test('invalid visit dates, space references and cover references are rejected', () => {
  const badDate = fixture();
  badDate.houses[0].visits[0].at = 'not-a-date';
  assert.throws(() => validateState(badDate));
  const badSpace = fixture();
  badSpace.houses[0].visits[0].notes['space:missing'] = { text: '笔记', updatedAt: new Date().toISOString() };
  assert.throws(() => validateState(badSpace));
  const badCover = fixture();
  badCover.houses[0].coverId = 'missing-photo';
  assert.throws(() => validateState(badCover));
});

test('MP4, WebM and 3GP are valid backup media but cannot be cover or floor plan', () => {
  const state = fixture();
  const house = state.houses[0];
  state.photos.push({
    id: 'video-1', houseId: house.id, visitId: null, sectionKey: 'environment',
    filename: 'walkthrough.mp4', type: 'video/mp4', size: 8, caption: '', createdAt: new Date().toISOString(),
  });
  for (const type of ['video/mp4', 'video/webm', 'video/3gpp']) {
    state.photos[0].type = type;
    assert.equal(validateState(state), state);
  }
  house.coverId = 'video-1';
  assert.throws(() => validateState(state));
  house.coverId = null;
  house.planId = 'video-1';
  assert.throws(() => validateState(state));
});

test('one candidate is valid and cross-mode comparison references are rejected', () => {
  const state = fixture();
  state.compare.rent = [state.houses[0].id];
  assert.equal(validateState(state), state);
  const buy = createHouse('buy', { name: '买房' });
  state.houses.push(buy);
  state.compare.rent.push(buy.id);
  assert.throws(() => validateState(state));
});

test('commute coordinates accept legacy targets but reject partial or out-of-range pairs', () => {
  const state = fixture();
  state.settings.targets.push({ id: 'legacy-target', name: '旧公司', address: '' });
  assert.equal(validateState(state), state);
  state.settings.targets[0].lat = 31.2;
  state.settings.targets[0].lng = 121.5;
  assert.equal(validateState(state), state);
  delete state.settings.targets[0].lng;
  assert.throws(() => validateState(state));
  state.settings.targets[0].lng = 181;
  assert.throws(() => validateState(state));
});

test('existing house coordinates can be entered independently while invalid values are rejected', () => {
  const state = fixture();
  state.houses[0].lat = 31.2;
  assert.equal(validateState(state), state);
  state.houses[0].lng = 181;
  assert.throws(() => validateState(state));
});
