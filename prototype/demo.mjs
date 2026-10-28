import { createHouse, createState, createVisit } from './core.mjs';

const datedVisit = (house, at, observation) => {
  const visit = createVisit(at);
  visit.impression = observation.impression;
  visit.pros = observation.pros;
  visit.cons = observation.cons;
  visit.notes = {
    environment: { text: observation.environment, updatedAt: at },
    whole: { text: observation.whole, updatedAt: at },
  };
  visit.commutes = [
    { targetId: 'target-office', method: observation.method, minutes: observation.minutes, source: '实地估算' },
  ];
  house.visits.push(visit);
  house.updatedAt = at;
};

const setKnownExpense = (house, name, amount, period = 'month') => {
  const expense = house.expenses.find(item => item.name === name);
  Object.assign(expense, { status: 'known', amount, period, unit: 'flat', payer: 'self', source: '演示报价' });
};

export function createDemoState() {
  const state = createState();
  state.settings.mode = 'rent';
  state.settings.targets = [
    { id: 'target-office', name: '演示公司', address: '虚构地址：示例路 1 号' },
    { id: 'target-station', name: '演示地铁站', address: '虚构地址：示例广场' },
  ];

  const rentA = createHouse('rent', {
    name: '演示·梧桐里 A 座（虚构）', price: 5200, area: 68, areaBasis: '建筑面积',
    layout: '两室一厅', floor: '8', totalFloors: '18', direction: 'south', elevator: 'yes',
    address: '虚构地址：梧桐路 18 号', channel: 'agent', conclusion: 'consider',
  }, '2026-10-03T09:00:00.000Z');
  rentA.terms.pets = 'allowed';
  rentA.terms.furnitureStatus = 'partial';
  rentA.terms.furniture = ['床', '衣柜'];
  setKnownExpense(rentA, '物业费', 260);
  setKnownExpense(rentA, '网费', 80);
  rentA.expenses.find(item => item.name === '中介费').amount = 2600;
  Object.assign(rentA.expenses.find(item => item.name === '中介费'), { status: 'known', payer: 'self', source: '演示报价' });
  datedVisit(rentA, '2026-10-04T10:30:00.000Z', {
    impression: '采光不错，厨房需要复看。', pros: '近公交，卧室安静。', cons: '厨房收纳少。',
    environment: '上午楼下车流较少。', whole: '整体维护尚可。', method: 'walk', minutes: 16,
  });
  datedVisit(rentA, '2026-10-08T16:00:00.000Z', {
    impression: '二看后仍可考虑。', pros: '房东允许养猫。', cons: '确认家具维修责任。',
    environment: '晚高峰有少量车流声。', whole: '补看了厨房水槽和窗户。', method: 'transit', minutes: 24,
  });

  const rentB = createHouse('rent', {
    name: '演示·云杉公寓 B 室（虚构）', price: 4300, area: 52, areaBasis: '套内面积',
    layout: '一室一厅', floor: '5', totalFloors: '12', direction: 'east', elevator: 'yes',
    address: '虚构地址：云杉街 6 号', channel: 'owner', conclusion: 'consider',
  }, '2026-10-05T08:00:00.000Z');
  rentB.terms.pets = 'not-allowed';
  rentB.terms.petConditions = '演示条款：不接受宠物';
  rentB.terms.furnitureStatus = 'full';
  rentB.terms.furniture = ['床', '书桌', '冰箱'];
  setKnownExpense(rentB, '物业费', 180);
  rentB.expenses.find(item => item.name === '网费').status = 'included';
  Object.assign(rentB.utilities.find(item => item.type === 'electricity'), {
    pricing: 'civil', rate: 0.58, payment: 'self', source: '演示账单',
  });
  datedVisit(rentB, '2026-10-06T13:00:00.000Z', {
    impression: '家具齐全，宠物限制不合适。', pros: '交通方便。', cons: '不接受宠物。',
    environment: '楼道整洁。', whole: '户型紧凑。', method: 'transit', minutes: 19,
  });

  const buyA = createHouse('buy', {
    name: '演示·溪岸花园 2 栋（虚构）', price: 320, area: 89, areaBasis: '建筑面积',
    layout: '三室两厅', floor: '11', totalFloors: '24', direction: 'south', elevator: 'yes',
    address: '虚构地址：溪岸路 20 号', channel: 'agent', conclusion: 'consider',
  }, '2026-10-02T07:00:00.000Z');
  buyA.ownership = { builtYear: 2018, nature: 'commodity', years: 70, startYear: 2018, held: 'yes', sole: 'unknown', source: '演示资料' };
  setKnownExpense(buyA, '物业费', 356);
  setKnownExpense(buyA, '取暖费', 1200, 'season');
  buyA.expenses.find(item => item.name === '取暖费').seasonAnnual = true;
  Object.assign(buyA.expenses.find(item => item.name === '契税'), { status: 'known', amount: 96000, payer: 'self', source: '演示估算' });
  buyA.expenses.find(item => item.name === '增值税').status = 'free';
  datedVisit(buyA, '2026-10-07T09:30:00.000Z', {
    impression: '房屋状态较好，产权资料待核对。', pros: '小区安静。', cons: '总价接近预算上限。',
    environment: '早间周边安静。', whole: '厨房和卫生间近期翻新。', method: 'drive', minutes: 20,
  });

  const buyB = createHouse('buy', {
    name: '演示·青禾苑 5 号楼（虚构）', price: 268, area: 76, areaBasis: '套内面积',
    layout: '两室两厅', floor: '3', totalFloors: '9', direction: 'west', elevator: 'no',
    address: '虚构地址：青禾巷 3 号', channel: 'owner', conclusion: 'consider',
  }, '2026-10-01T06:00:00.000Z');
  buyB.ownership = { builtYear: 2009, nature: 'commodity', years: 70, startYear: 2009, held: 'unknown', sole: 'unknown', source: 'unknown' };
  buyB.expenses.find(item => item.name === '物业费').unit = 'sqm';
  buyB.expenses.find(item => item.name === '物业费').billingArea = null;
  buyB.expenses.find(item => item.name === '个税').status = 'unknown';
  datedVisit(buyB, '2026-10-09T11:00:00.000Z', {
    impression: '楼梯房，需核实产权和费用。', pros: '总价相对低。', cons: '楼层较高且无电梯。',
    environment: '附近有早市。', whole: '屋内需要局部维修。', method: 'walk', minutes: 28,
  });

  state.houses.push(rentA, rentB, buyA, buyB);
  return state;
}
