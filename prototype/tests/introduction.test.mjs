import test from 'node:test';
import assert from 'node:assert/strict';
import { createHouse, createVisit } from '../core.mjs';
import { houseIntroduction } from '../house-introduction.mjs';

const date = day => `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`;

test('buy introduction uses zero values, area basis, ownership, and personal-record wording', () => {
  const house = createHouse('buy', {
    name: '北苑一号', price: 0, area: 80, areaBasis: '套内面积', layout: '2室1厅', direction: 'south',
    floor: '5', totalFloors: '18', elevator: 'yes', address: '示例路 1 号', conclusion: 'favorite',
  }, date(1));
  house.ownership = { builtYear: 2008, nature: 'commodity', years: 70, startYear: 2009, held: 'yes', sole: 'yes', source: 'document' };
  house.visits[0].impression = '采光不错\n下午有阳光';
  house.contacts.push({ name: '联系人', phone: '13800138000' });
  house.lat = 39.9;
  house.lng = 116.4;
  const text = houseIntroduction(house, { settings: { targets: [] }, photos: [] });

  assert.match(text, /总价 0 万元/);
  assert.match(text, /面积 80 ㎡（套内面积）/);
  assert.match(text, /按已记录面积折合约 0 元\/㎡/);
  assert.match(text, /产权性质 商品房/);
  assert.match(text, /个人判断：心仪/);
  assert.match(text, /2026年10月1日个人看房记录：整体感受“采光不错 下午有阳光”/);
  assert.doesNotMatch(text, /13800138000|39\.9|116\.4/);
  assert.doesNotMatch(text, /\r|\n/);
});

test('rent introduction distinguishes zero, known and unknown fees, seasonal area charges, deposit and terms', () => {
  const house = createHouse('rent', {
    name: '河畔公寓', price: 0, area: 60, areaBasis: '建筑面积', layout: '1室1厅', direction: 'east',
    floor: '7', totalFloors: '12', elevator: 'yes', address: '河畔路',
  }, date(1));
  const property = house.expenses.find(expense => expense.category === 'property');
  Object.assign(property, { status: 'known', amount: 1.2, period: 'month', unit: 'sqm', billingArea: 60, payer: 'self', source: 'estimate' });
  const heating = house.expenses.find(expense => expense.category === 'heating');
  Object.assign(heating, { status: 'known', amount: 90, period: 'season', seasonAnnual: true, unit: 'sqm', billingArea: 60, payer: 'self', source: 'spoken' });
  const agency = house.expenses.find(expense => expense.category === 'agency');
  Object.assign(agency, { status: 'known', amount: 0, payer: 'self', source: 'document' });
  house.terms = {
    ...house.terms, heating: 'central', furnitureStatus: 'partial', furniture: ['空调', '冰箱'],
    furnitureNotes: '餐桌有磨损', pets: 'conditional', petConditions: '仅可养猫，需额外押金',
    deposit: 2, depositUnit: 'months', payment: '押一付三', lease: '一年起', source: 'unknown',
    heatingSource: 'document', furnitureSource: 'observed', petsSource: 'spoken', rentSource: 'estimate',
  };
  const text = houseIntroduction(house, { settings: { targets: [] }, photos: [] });

  assert.match(text, /月租 0 元\/月/);
  assert.match(text, /物业费，1\.2 元\/㎡\/月，计费面积 60 ㎡/);
  assert.match(text, /取暖费，90 元\/㎡\/供暖季，计费面积 60 ㎡，年化约 450 元\/月/);
  assert.match(text, /含按年摊算项目/);
  assert.match(text, /中介费，一次性 0 元/);
  assert.match(text, /押金 2 个月租金/);
  assert.match(text, /宠物：有条件允许（仅可养猫，需额外押金）/);
  assert.match(text, /餐桌有磨损/);
  assert.match(text, /取暖方式：集中供暖（合同或文件）/);
  assert.match(text, /家具：部分配备，包括空调、冰箱，餐桌有磨损（现场观察）/);
  assert.match(text, /宠物：有条件允许（仅可养猫，需额外押金）（房东或中介口述）/);
  assert.match(text, /押金 2 个月租金（自己估算）/);
  assert.doesNotMatch(text, /来源未确认/);
});

test('unknown rent and missing billing area are unresolved while a zero utility rate stays zero', () => {
  const house = createHouse('rent', { name: '待补信息房源' }, date(1));
  const property = house.expenses.find(expense => expense.category === 'property');
  Object.assign(property, { status: 'known', amount: 0, unit: 'sqm', billingArea: null, payer: 'self' });
  const water = house.utilities.find(utility => utility.type === 'water');
  Object.assign(water, { pricing: 'civil', rate: 0, payment: 'self', source: 'observed' });
  const text = houseIntroduction(house, { settings: { targets: [] }, photos: [] });

  assert.doesNotMatch(text, /月租 0 元\/月/);
  assert.match(text, /计费面积待确认/);
  assert.match(text, /水费：民用，0 元\/吨，自己缴费/);
  assert.match(text, /主要信息待确认：月租、面积、户型、朝向、楼层、电梯情况、地址、宠物政策、押金/);
  assert.match(text, /按月汇总：另有 4 项待确认，暂无法汇总已知金额/);
});

test('latest notes use the viewing date, cover multiple rooms, and preserve commute source', () => {
  const house = createHouse('rent', { name: '记录丰富房源' }, date(1));
  const oldVisit = house.visits[0];
  oldVisit.at = date(2);
  oldVisit.notes.environment = { text: '老环境记录', updatedAt: date(10) };
  oldVisit.notes.amenities = { text: '旧生活配套', updatedAt: date(10) };
  oldVisit.notes[`space:${house.spaces[0].id}`] = { text: '旧卧室记录', updatedAt: date(10) };
  const latest = createVisit(date(8));
  latest.impression = '临街但通风';
  latest.pros = '厨房\n宽敞';
  latest.cons = '卧室偏暗';
  latest.notes.environment = { text: '环境新观察', updatedAt: date(1) };
  latest.notes.amenities = { text: '附近有超市', updatedAt: date(1) };
  latest.notes[`space:${house.spaces[0].id}`] = { text: '主卧安静', updatedAt: date(1) };
  latest.commutes = [{ targetId: 'work', method: 'transit', minutes: 0, source: 'estimate' }];
  house.visits.push(latest);
  house.spaces.push({ id: 'study', type: 'other', name: '书房' });
  latest.notes['space:study'] = { text: '有窗\n可做书房', updatedAt: date(1) };
  const state = { settings: { targets: [{ id: 'work', name: '公司' }] }, photos: [] };
  const text = houseIntroduction(house, state);

  assert.match(text, /2026年10月8日个人看房记录：整体感受“临街但通风”/);
  assert.match(text, /个人记录的优点：厨房 宽敞/);
  assert.match(text, /小区配套（2026年10月8日）：环境新观察/);
  assert.match(text, /生活配套（2026年10月8日）：附近有超市/);
  assert.doesNotMatch(text, /老环境记录|旧生活配套|旧卧室记录/);
  assert.match(text, /主卧（2026年10月8日）：主卧安静/);
  assert.match(text, /书房（2026年10月8日）：有窗 可做书房/);
  assert.match(text, /地图估算至公司：公共交通 0 分钟/);
  assert.doesNotMatch(text, /\r|\n/);
});

test('utilities use their measured units, distinct same-name fees amortize independently, and payer-other once fees keep known amounts', () => {
  const house = createHouse('buy', { name: '费用边界房源' }, date(1));
  house.direction = 'other';
  house.terms.heating = 'other';
  house.ownership.held = 'two';
  const water = house.utilities.find(item => item.type === 'water');
  Object.assign(water, { pricing: 'civil', rate: 0, payment: 'landlord' });
  const electricity = house.utilities.find(item => item.type === 'electricity');
  Object.assign(electricity, { pricing: 'commercial', rate: 2, payment: 'self' });
  const gas = house.utilities.find(item => item.type === 'gas');
  Object.assign(gas, { pricing: 'civil', rate: 3, payment: 'included' });
  const annual = {
    id: 'annual-1', category: 'other', name: '同名服务费', status: 'known', amount: 120,
    period: 'year', unit: 'flat', billingArea: null, payer: 'self', source: 'observed', remark: '',
  };
  const seasonal = { ...annual, id: 'season-1', amount: 90, period: 'season', seasonAnnual: false, source: 'spoken' };
  const otherOnce = {
    id: 'once-other', category: 'agency', name: '代办费', status: 'known', amount: 500,
    period: 'once', unit: 'flat', billingArea: null, payer: 'other', source: 'document', remark: '',
  };
  house.expenses.push(annual, seasonal, otherOnce);
  const text = houseIntroduction(house, { settings: { targets: [] }, photos: [] });

  assert.match(text, /朝向其他/);
  assert.match(text, /取暖方式：其他/);
  assert.match(text, /持有年限记录 满两年不满五年/);
  assert.match(text, /水费：民用，0 元\/吨，房东代收/);
  assert.match(text, /电费：商用，2 元\/度，自己缴费/);
  assert.match(text, /燃气费：民用，3 元\/立方米，已包含/);
  assert.match(text, /同名服务费，120 元\/年，年化约 10 元\/月，自己承担，现场观察/);
  assert.match(text, /同名服务费，90 元\/供暖季，年化频次待确认，自己承担，房东或中介口述/);
  assert.match(text, /代办费，一次性 500 元，他人承担，合同或文件/);
});

test('commutes fall back to each target and method latest recorded visit', () => {
  const house = createHouse('rent', { name: '通勤房源' }, date(1));
  house.visits[0].commutes = [
    { targetId: 'work', method: 'walk', minutes: 20, source: 'observed' },
    { targetId: 'work', method: 'transit', minutes: 45, source: 'spoken' },
  ];
  const later = createVisit(date(4));
  later.commutes = [{ targetId: 'work', method: 'walk', minutes: 0, source: 'estimate' }];
  house.visits.push(later);
  const newer = createVisit(date(8));
  newer.commutes = [{ targetId: 'work', method: 'transit', minutes: 30, source: 'observed' }];
  house.visits.push(newer);
  const text = houseIntroduction(house, { settings: { targets: [{ id: 'work', name: '公司' }] }, photos: [] });

  assert.match(text, /地图估算至公司：步行 0 分钟/);
  assert.match(text, /通勤记录至公司：公共交通 30 分钟（现场观察）/);
  assert.doesNotMatch(text, /步行 20 分钟|公共交通 45 分钟/);
});

test('empty house is one paragraph and names essentials to confirm without inventing fees', () => {
  const house = createHouse('buy', {}, date(1));
  const text = houseIntroduction(house, { settings: { targets: [] }, photos: [] });
  assert.equal(text.split(/[\r\n]/).length, 1);
  assert.match(text, /主要信息待确认：总价、面积、户型、朝向、楼层、电梯情况、地址、宠物政策、产权性质/);
  assert.match(text, /物业费，金额待确认，承担方未确认/);
  assert.match(text, /按月汇总：另有 3 项待确认，暂无法汇总已知金额/);
  assert.match(text, /一次性费用合计：另有 4 项待确认，暂无法汇总已知金额/);
  assert.doesNotMatch(text, /已知自付约 0 元\/月|已知自付 0 元/);
  assert.doesNotMatch(text, /物业费[^。；]*0 元/);
});

test('note punctuation does not duplicate the paragraph sentence separator', () => {
  const house = createHouse('rent', { name: '标点房源' }, date(1));
  house.visits[0].notes.whole = { text: '采光好。\n通风待确认。' };
  const text = houseIntroduction(house, { settings: { targets: [] }, photos: [] });
  assert.match(text, /采光好。 通风待确认。/);
  assert.doesNotMatch(text, /。。|\r|\n/);
});
