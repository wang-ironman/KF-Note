import { latestNote, latestVisit, monthlyReference, onceReference, unitPrice } from './core.mjs';

const label = {
  areaBasis: { unknown: '未确认', 建筑面积: '建筑面积', 套内面积: '套内面积', 使用面积: '使用面积' },
  direction: { unknown: '未确认', south: '南', north: '北', east: '东', west: '西', southeast: '东南', southwest: '西南', both: '南北通透', other: '其他' },
  elevator: { unknown: '未确认', yes: '有电梯', no: '无电梯' },
  source: { unknown: '来源未确认', observed: '现场观察', spoken: '房东或中介口述', document: '合同或文件', estimate: '自己估算' },
  period: { month: '月', quarter: '季度', year: '年', season: '供暖季', once: '一次性' },
  unit: { flat: '整项', sqm: '每平方米' },
  payer: { unknown: '承担方未确认', self: '自己承担', other: '他人承担' },
  status: { unknown: '金额未确认', known: '已知', included: '已包含', free: '确认免费' },
  heating: { unknown: '未确认', central: '集中供暖', self: '自采暖', ac: '空调取暖', other: '其他' },
  furnitureStatus: { unknown: '未确认', none: '无家具', partial: '部分配备', full: '配备较全' },
  pets: { unknown: '未确认', allowed: '允许', 'not-allowed': '不允许', conditional: '有条件允许' },
  utility: { water: '水', electricity: '电', gas: '燃气' },
  pricing: { unknown: '价格类型未确认', civil: '民用', commercial: '商用' },
  payment: { unknown: '缴费方未确认', self: '自己缴费', landlord: '房东代收', included: '已包含' },
  method: { walk: '步行', bike: '骑行', transit: '公共交通', drive: '驾车' },
  conclusion: { consider: '待考虑', favorite: '心仪', excluded: '已排除' },
  nature: { commodity: '商品房', reform: '房改房', affordable: '经济适用房', commercial: '商业或公寓', other: '其他' },
};

const clean = value => typeof value === 'string' ? value.replace(/[\s\u00a0]+/g, ' ').trim() : '';
const filled = value => clean(value) !== '';
const knownNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fmt = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
const sourceText = value => label.source[value] ?? (filled(value) ? clean(value) : '来源未确认');
const hasSource = value => filled(value) && value !== 'unknown';
const sourceSuffix = value => hasSource(value) ? `（${sourceText(value)}）` : '';
const termsSource = (specific, general) => hasSource(specific) ? specific : general;
const noteDate = visit => {
  const time = Date.parse(visit?.at ?? '');
  return Number.isFinite(time) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(time) : '看房日期未记录';
};

function expenseDescription(expense) {
  const parts = [clean(expense.name) || '其他费用'];
  if (expense.status === 'included') parts.push('已包含');
  else if (expense.status === 'free') parts.push('确认免费');
  else if (expense.status === 'known' && knownNumber(expense.amount)) {
    if (expense.period === 'once') parts.push(`一次性 ${fmt(expense.amount)} 元`);
    else {
      const period = label.period[expense.period] ?? '周期未确认';
      const unit = expense.unit === 'sqm' ? '元/㎡' : '元';
      parts.push(`${fmt(expense.amount)} ${unit}/${period}`);
      if (expense.unit === 'sqm') {
        if (typeof expense.billingArea === 'number' && expense.billingArea > 0) parts.push(`计费面积 ${fmt(expense.billingArea)} ㎡`);
        else parts.push('计费面积待确认');
      }
      if (expense.period === 'season' || expense.period === 'year') {
        const item = monthlyReference({ mode: 'buy', expenses: [expense] }).items[0];
        if (item?.monthly !== null && item?.monthly !== undefined) parts.push(`年化约 ${fmt(item.monthly)} 元/月`);
        else if (expense.period === 'season' && expense.seasonAnnual !== true) parts.push('年化频次待确认');
      }
    }
  } else parts.push(expense.period === 'once' ? '一次性金额待确认' : '金额待确认');
  parts.push(label.payer[expense.payer] ?? '承担方未确认');
  if (filled(expense.remark)) parts.push(clean(expense.remark));
  if (sourceSuffix(expense.source)) parts.push(sourceText(expense.source));
  return parts.join('，');
}

function visitDescription(house, state) {
  const latest = latestVisit(house);
  if (!latest) return [];
  const date = noteDate(latest);
  const parts = [];
  if (filled(latest.impression)) parts.push(`${date}个人看房记录：整体感受“${clean(latest.impression)}”`);
  if (filled(latest.pros)) parts.push(`个人记录的优点：${clean(latest.pros)}`);
  if (filled(latest.cons)) parts.push(`个人记录的顾虑：${clean(latest.cons)}`);
  for (const [key, title] of [['environment', '小区配套'], ['traffic', '现场交通'], ['amenities', '生活配套'], ['layout', '户型观察'], ['whole', '整体观察']]) {
    const latestForKey = latestNote(house, key, state?.photos ?? []);
    if (latestForKey && filled(latestForKey.note.text)) parts.push(`${title}（${noteDate(latestForKey.visit)}）：${clean(latestForKey.note.text)}`);
  }
  for (const space of house.spaces ?? []) {
    const latestForKey = latestNote(house, `space:${space.id}`, state?.photos ?? []);
    if (latestForKey && filled(latestForKey.note.text)) parts.push(`${clean(space.name) || '房间'}（${noteDate(latestForKey.visit)}）：${clean(latestForKey.note.text)}`);
  }
  const targets = state?.settings?.targets ?? [];
  const visitTime = value => {
    const time = Date.parse(value ?? '');
    return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
  };
  const commuteRecords = new Map();
  for (const visit of house.visits ?? []) {
    for (const commute of visit.commutes ?? []) {
      if (!knownNumber(commute.minutes) || !label.method[commute.method]) continue;
      const key = `${commute.targetId}\u0000${commute.method}`;
      const previous = commuteRecords.get(key);
      const currentOrder = [visitTime(visit.at), visitTime(visit.createdAt), String(visit.id ?? '')];
      const previousOrder = previous && [visitTime(previous.visit.at), visitTime(previous.visit.createdAt), String(previous.visit.id ?? '')];
      if (!previous || currentOrder[0] > previousOrder[0]
        || (currentOrder[0] === previousOrder[0] && currentOrder[1] > previousOrder[1])
        || (currentOrder[0] === previousOrder[0] && currentOrder[1] === previousOrder[1] && currentOrder[2] > previousOrder[2])) {
        commuteRecords.set(key, { visit, commute });
      }
    }
  }
  const commutes = [...commuteRecords.values()].flatMap(({ commute }) => {
    const target = targets.find(item => item.id === commute.targetId);
    if (!target || !filled(target.name)) return [];
    const origin = commute.source === 'estimate' ? '地图估算' : '通勤记录';
    const source = commute.source === 'estimate' ? '' : sourceSuffix(commute.source);
    return [`${origin}至${clean(target.name)}：${label.method[commute.method]} ${fmt(commute.minutes)} 分钟${source}`];
  });
  return [...parts, ...commutes];
}

export function houseIntroduction(house, state) {
  if (!house || (house.mode !== 'buy' && house.mode !== 'rent')) return '';
  const parts = [];
  const name = clean(house.name);
  if (name) parts.push(name);
  const mode = house.mode === 'buy' ? '买房' : '租房';
  const missing = [];
  const price = knownNumber(house.price) ? `${fmt(house.price)} ${house.mode === 'buy' ? '万元' : '元/月'}` : null;
  const area = typeof house.area === 'number' && Number.isFinite(house.area) && house.area > 0 ? `${fmt(house.area)} ㎡` : null;
  if (price) parts.push(`${mode}，${house.mode === 'buy' ? '总价' : '月租'} ${price}`);
  else missing.push(house.mode === 'buy' ? '总价' : '月租');
  if (area) parts.push(`面积 ${area}（${label.areaBasis[house.areaBasis] ?? (clean(house.areaBasis) || '面积口径未确认')}）`);
  else missing.push('面积');
  if (filled(house.layout)) parts.push(`户型 ${clean(house.layout)}`); else missing.push('户型');
  if (house.direction && house.direction !== 'unknown') parts.push(`朝向${label.direction[house.direction] ?? clean(house.direction)}`);
  else missing.push('朝向');
  if (filled(house.floor) || filled(house.totalFloors)) parts.push(`楼层 ${[clean(house.floor), clean(house.totalFloors) ? `共${clean(house.totalFloors)}层` : ''].filter(Boolean).join('/')}`);
  else missing.push('楼层');
  if (house.elevator && house.elevator !== 'unknown') parts.push(label.elevator[house.elevator] ?? clean(house.elevator));
  else missing.push('电梯情况');
  if (filled(house.address)) parts.push(`地址 ${clean(house.address)}`); else missing.push('地址');
  if (house.mode === 'buy') {
    const perArea = unitPrice(house);
    if (perArea !== null) parts.push(`按已记录面积折合约 ${fmt(perArea)} 元/㎡`);
  }

  const expenses = house.expenses ?? [];
  const monthly = monthlyReference(house);
  const once = onceReference(house);
  if (expenses.length) parts.push(`费用记录：${expenses.map(expenseDescription).join('；')}`);
  const knownMonthly = monthly.known;
  const knownZeroMonthly = monthly.items.some(item => item.monthly === 0);
  if (monthly.unknown) {
    const total = knownMonthly > 0 || knownZeroMonthly ? `已知自付约 ${fmt(knownMonthly)} 元/月，` : '';
    parts.push(`按月汇总：${total}另有 ${monthly.unknown} 项待确认${knownMonthly > 0 || knownZeroMonthly ? '' : '，暂无法汇总已知金额'}${monthly.hasAmortized ? '，含按年摊算项目' : ''}`);
  } else if (knownMonthly > 0 || knownZeroMonthly) {
    parts.push(`按月汇总：已知自付约 ${fmt(knownMonthly)} 元/月${monthly.hasAmortized ? '，含按年摊算项目' : ''}`);
  }
  const knownZeroOnce = once.items.some(item => item.monthly === 0);
  if (once.unknown) {
    const total = once.known > 0 || knownZeroOnce ? `已知自付 ${fmt(once.known)} 元，` : '';
    parts.push(`一次性费用合计：${total}另有 ${once.unknown} 项待确认${once.known > 0 || knownZeroOnce ? '' : '，暂无法汇总已知金额'}`);
  } else if (once.known > 0 || knownZeroOnce) {
    parts.push(`一次性费用合计：已知自付 ${fmt(once.known)} 元`);
  }

  for (const utility of house.utilities ?? []) {
    const title = label.utility[utility.type];
    if (!title) continue;
    if (utility.pricing === 'unknown' && utility.payment === 'unknown' && utility.rate == null) continue;
    const rate = knownNumber(utility.rate) ? `${fmt(utility.rate)} 元` : '费率待确认';
    const unit = { water: '元/吨', electricity: '元/度', gas: '元/立方米' }[utility.type];
    parts.push(`${title}费：${label.pricing[utility.pricing] ?? '价格类型未确认'}，${knownNumber(utility.rate) ? `${fmt(utility.rate)} ${unit}` : rate}，${label.payment[utility.payment] ?? '缴费方未确认'}${sourceSuffix(utility.source)}`);
  }

  const terms = house.terms ?? {};
  const heatingSource = termsSource(terms.heatingSource, terms.source);
  const furnitureSource = termsSource(terms.furnitureSource, terms.source);
  const petsSource = termsSource(terms.petsSource, terms.source);
  const rentSource = termsSource(terms.rentSource, terms.source);
  if (terms.heating && terms.heating !== 'unknown') parts.push(`取暖方式：${label.heating[terms.heating] ?? clean(terms.heating)}${sourceSuffix(heatingSource)}`);
  if (terms.furnitureStatus && terms.furnitureStatus !== 'unknown') parts.push(`家具：${label.furnitureStatus[terms.furnitureStatus] ?? clean(terms.furnitureStatus)}${(terms.furniture ?? []).length ? `，包括${terms.furniture.map(clean).filter(Boolean).join('、')}` : ''}${filled(terms.furnitureNotes) ? `，${clean(terms.furnitureNotes)}` : ''}${sourceSuffix(furnitureSource)}`);
  else if ((terms.furniture ?? []).length || filled(terms.furnitureNotes)) parts.push(`家具记录：${[...(terms.furniture ?? []).map(clean), clean(terms.furnitureNotes)].filter(Boolean).join('、')}${sourceSuffix(furnitureSource)}`);
  if (terms.pets && terms.pets !== 'unknown') parts.push(`宠物：${label.pets[terms.pets] ?? clean(terms.pets)}${filled(terms.petConditions) ? `（${clean(terms.petConditions)}）` : ''}${sourceSuffix(petsSource)}`);
  else missing.push('宠物政策');

  if (house.mode === 'rent') {
    if (terms.deposit !== null && terms.deposit !== undefined && knownNumber(terms.deposit)) parts.push(`押金 ${fmt(terms.deposit)} ${terms.depositUnit === 'months' ? '个月租金' : '元'}${sourceSuffix(rentSource)}`);
    else missing.push('押金');
    if (filled(terms.payment)) parts.push(`付款方式 ${clean(terms.payment)}${sourceSuffix(rentSource)}`);
    if (filled(terms.lease)) parts.push(`租期 ${clean(terms.lease)}${sourceSuffix(rentSource)}`);
  } else {
    const ownership = house.ownership ?? {};
    if (knownNumber(ownership.builtYear) && ownership.builtYear > 0) parts.push(`建成年份 ${fmt(ownership.builtYear)}`);
    if (ownership.nature && ownership.nature !== 'unknown') parts.push(`产权性质 ${label.nature[ownership.nature] ?? clean(ownership.nature)}${sourceSuffix(ownership.source)}`);
    if (knownNumber(ownership.years) && ownership.years > 0) parts.push(`产权年限 ${fmt(ownership.years)} 年`);
    if (knownNumber(ownership.startYear) && ownership.startYear > 0) parts.push(`产权起始年份 ${fmt(ownership.startYear)}`);
    if (ownership.held && ownership.held !== 'unknown') {
      const held = { yes: '满五年', two: '满两年不满五年', less: '不满两年' }[ownership.held];
      if (held) parts.push(`持有年限记录 ${held}`);
    }
    if (ownership.sole && ownership.sole !== 'unknown') parts.push(`是否唯一住房：${ownership.sole === 'yes' ? '是' : ownership.sole === 'no' ? '否' : clean(ownership.sole)}${sourceSuffix(ownership.source)}`);
    if (ownership.nature === 'unknown' || !ownership.nature) missing.push('产权性质');
  }

  const conclusion = label.conclusion[house.conclusion];
  if (conclusion) parts.push(`个人判断：${conclusion}${house.conclusion === 'excluded' && filled(house.rejectionReason) ? `（${clean(house.rejectionReason)}）` : ''}`);
  parts.push(...visitDescription(house, state));
  if (missing.length) parts.push(`主要信息待确认：${[...new Set(missing)].join('、')}`);
  return parts.map(part => part.replace(/。+$/, '')).join('。').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[。；，：、 ]+$/, '') + '。';
}
