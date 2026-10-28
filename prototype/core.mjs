const id = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const validModes = new Set(['buy', 'rent']);
const monthlyPeriods = new Set(['month', 'quarter', 'year', 'season']);
const basicHouseFields = [
  'name', 'price', 'area', 'areaBasis', 'layout', 'floor', 'totalFloors',
  'direction', 'elevator', 'address', 'sourceLink', 'lat', 'lng', 'locationConfirmed',
  'channel', 'conclusion', 'rejectionReason',
];

export function createState() {
  return {
    version: 1,
    settings: { mode: null, targets: [], lastBackupAt: null },
    houses: [],
    photos: [],
    compare: { buy: [], rent: [] },
  };
}

export function createVisit(now = new Date().toISOString()) {
  return {
    id: id(),
    at: now,
    createdAt: now,
    updatedAt: now,
    impression: '',
    pros: '',
    cons: '',
    notes: {},
    commutes: [],
  };
}

export function createSpace(type, name) {
  return { id: id(), type, name };
}

export function createExpense(category, name, period = 'month') {
  return {
    id: id(), category, name, status: 'unknown', amount: null, period,
    unit: 'flat', billingArea: null, seasonAnnual: false, payer: 'unknown', source: 'unknown', remark: '',
  };
}

export function createHouse(mode, input = {}, now = new Date().toISOString()) {
  if (!validModes.has(mode)) throw new TypeError("mode must be 'buy' or 'rent'");
  const house = {
    id: id(),
    mode,
    name: '',
    price: null,
    area: null,
    areaBasis: 'unknown',
    layout: '',
    floor: '',
    totalFloors: '',
    direction: 'unknown',
    elevator: 'unknown',
    address: '',
    sourceLink: '',
    lat: null,
    lng: null,
    locationConfirmed: false,
    channel: 'unknown',
    conclusion: 'consider',
    rejectionReason: '',
    coverId: null,
    planId: null,
    spaces: [
      createSpace('bedroom', '主卧'),
      createSpace('kitchen', '厨房'),
      createSpace('bathroom', '卫生间'),
      createSpace('living', '客厅'),
    ],
    contacts: [],
    visits: [],
    expenses: [],
    utilities: [
      { type: 'water', pricing: 'unknown', rate: null, payment: 'unknown', source: 'unknown' },
      { type: 'electricity', pricing: 'unknown', rate: null, payment: 'unknown', source: 'unknown' },
      { type: 'gas', pricing: 'unknown', rate: null, payment: 'unknown', source: 'unknown' },
    ],
    terms: {
      heating: 'unknown', furnitureStatus: 'unknown', furniture: [], furnitureNotes: '', pets: 'unknown',
      petConditions: '', deposit: null, depositUnit: 'amount', payment: '', lease: '', source: 'unknown',
    },
    ownership: {
      builtYear: null, nature: 'unknown', years: null, startYear: null, held: 'unknown',
      sole: 'unknown', source: 'unknown',
    },
    createdAt: now,
    updatedAt: now,
  };
  for (const field of basicHouseFields) {
    if (Object.hasOwn(input, field)) house[field] = input[field];
  }
  house.visits.push(createVisit(now));
  for (const [category, name] of [['property', '物业费'], ['heating', '取暖费'], ['network', '网费']]) {
    house.expenses.push(createExpense(category, name));
  }
  if (mode === 'rent') {
    house.expenses.push(createExpense('agency', '中介费', 'once'));
  } else {
    for (const [category, name] of [['tax-deed', '契税'], ['tax-vat', '增值税'], ['tax-income', '个税'], ['agency', '中介费']]) {
      house.expenses.push(createExpense(category, name, 'once'));
    }
  }
  return house;
}

export function duplicateHouse(state, houseId, now = new Date().toISOString()) {
  const source = state.houses.find(house => house.id === houseId);
  if (!source) throw new TypeError('找不到要复制的房源');
  const house = structuredClone(source);
  const houseIdMap = new Map([[source.id, id()]]);
  const spaceIds = new Map(source.spaces.map(space => [space.id, id()]));
  const contactIds = new Map(source.contacts.map(contact => [contact.id, id()]));
  const expenseIds = new Map(source.expenses.map(expense => [expense.id, id()]));
  const visitIds = new Map(source.visits.map(visit => [visit.id, id()]));
  const photoMetadata = state.photos.filter(photo => photo.houseId === source.id);
  const photoIds = new Map(photoMetadata.map(photo => [photo.id, id()]));
  const remapSection = key => {
    const match = /^space:(.+)$/.exec(key);
    return match && spaceIds.has(match[1]) ? `space:${spaceIds.get(match[1])}` : key;
  };

  house.id = houseIdMap.get(source.id);
  house.name = `${source.name}（副本）`;
  house.createdAt = now;
  house.updatedAt = now;
  house.spaces = house.spaces.map(space => ({ ...space, id: spaceIds.get(space.id) }));
  house.contacts = house.contacts.map(contact => ({ ...contact, id: contactIds.get(contact.id) }));
  house.expenses = house.expenses.map(expense => ({ ...expense, id: expenseIds.get(expense.id) }));
  house.visits = house.visits.map(visit => {
    const notes = {};
    for (const [key, note] of Object.entries(visit.notes)) notes[remapSection(key)] = note;
    return { ...visit, id: visitIds.get(visit.id), notes };
  });
  house.coverId = house.coverId === null ? null : photoIds.get(house.coverId);
  house.planId = house.planId === null ? null : photoIds.get(house.planId);

  const photos = photoMetadata.map(photo => ({
    ...photo,
    id: photoIds.get(photo.id),
    houseId: house.id,
    visitId: photo.visitId === null ? null : visitIds.get(photo.visitId),
    sectionKey: remapSection(photo.sectionKey),
  }));
  const pairs = photoMetadata.map(photo => ({ from: photo.id, to: photoIds.get(photo.id) }));
  return { house, photos, pairs };
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareVisits(a, b) {
  return timestamp(a.at) - timestamp(b.at)
    || timestamp(a.createdAt) - timestamp(b.createdAt)
    || String(a.id).localeCompare(String(b.id));
}

export function latestVisit(house) {
  return [...(house?.visits ?? [])].sort(compareVisits).at(-1) ?? null;
}

export function latestNote(house, key, photos = []) {
  const visits = house?.visits ?? [];
  const candidates = visits.filter(visit =>
    (typeof visit.notes?.[key]?.text === 'string' && visit.notes[key].text.trim() !== '')
    || photos.some(photo => photo.houseId === house.id && photo.visitId === visit.id && photo.sectionKey === key),
  ).sort(compareVisits);
  const visit = candidates.at(-1);
  return visit ? { visit, note: visit.notes?.[key] ?? { text: '' } } : null;
}

function numberAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function unknownItem(items, expense, reason) {
  items.push({ name: expense.name, monthly: null, reason });
}

export function monthlyReference(house) {
  let known = 0;
  let unknown = 0;
  let hasAmortized = false;
  const items = [];
  const add = (name, monthly, reason = '') => {
    known += monthly;
    items.push({ name, monthly, reason });
  };

  if (house?.mode === 'rent') {
    if (numberAmount(house.price)) add('租金', house.price);
    else {
      unknown += 1;
      unknownItem(items, { name: '租金' }, '租金金额未知');
    }
  }

  for (const expense of house?.expenses ?? []) {
    if (expense.period === 'once' || expense.payer === 'other') continue;
    if (expense.status === 'included' || expense.status === 'free') {
      add(expense.name, 0);
      continue;
    }
    let reason = '';
    if (expense.status !== 'known') reason = '费用金额未知';
    else if (expense.payer !== 'self') reason = '付款方未确认由自己承担';
    else if (!monthlyPeriods.has(expense.period)) reason = '计费周期无效';
    else if (expense.period === 'season' && expense.seasonAnnual !== true) reason = '季节费用的年化频次未确认';
    else if (!numberAmount(expense.amount)) reason = '费用金额无效或未知';
    else if (expense.unit !== 'flat' && expense.unit !== 'sqm') reason = '计费单位无效';
    else if (expense.unit === 'sqm' && !(typeof expense.billingArea === 'number' && Number.isFinite(expense.billingArea) && expense.billingArea > 0)) {
      reason = '按面积计费但计费面积未知';
    }
    if (reason) {
      unknown += 1;
      unknownItem(items, expense, reason);
      continue;
    }
    const periodMonths = { month: 1, quarter: 3, year: 12, season: 12 }[expense.period];
    const total = expense.amount * (expense.unit === 'sqm' ? expense.billingArea : 1);
    const monthly = total / periodMonths;
    if (expense.period === 'season' || expense.period === 'year') hasAmortized = true;
    add(expense.name, monthly, expense.period === 'season' || expense.period === 'year' ? '按全年12个月摊算' : '');
  }
  return { known, unknown, items, hasAmortized };
}

export function onceReference(house) {
  let known = 0;
  let unknown = 0;
  const items = [];
  for (const expense of house?.expenses ?? []) {
    if (expense.period !== 'once' || expense.payer === 'other') continue;
    if (expense.status === 'included' || expense.status === 'free') {
      items.push({ name: expense.name, monthly: 0, reason: '' });
    } else if (expense.status === 'known' && expense.payer === 'self' && numberAmount(expense.amount)) {
      known += expense.amount;
      items.push({ name: expense.name, monthly: expense.amount, reason: '' });
    } else {
      unknown += 1;
      const reason = expense.status === 'known' && expense.payer !== 'self'
        ? '付款方未确认由自己承担'
        : expense.status === 'known' ? '费用金额无效或未知' : '费用金额未知';
      items.push({ name: expense.name, monthly: null, reason });
    }
  }
  return { known, unknown, items };
}

export function unitPrice(house) {
  return house?.mode === 'buy'
    && numberAmount(house.price)
    && typeof house.area === 'number' && Number.isFinite(house.area) && house.area > 0
    && house.areaBasis !== 'unknown'
    ? house.price * 10000 / house.area
    : null;
}
