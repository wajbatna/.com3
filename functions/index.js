const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 20 });
const db = getFirestore();

const PLANS = {
  daily: { discount: 0 },
  weekly: { discount: 0.10 },
  monthly: { discount: 0.20 },
};
const PAYMENT_METHODS = new Set(['card','cod','tpe','cih','fellah','cashplus','wafacash','tijari','baridbank']);
const PHONE_RE = /^(0[5-7]\d{8}|\+212[5-7]\d{8})$/;
const DEFAULT_POINTS = {
  firstOrderPoints: 50,
  perDirham: 10,
  reviewPoints: 10,
  referralPoints: 150,
  streak3Bonus: 50,
  monthly5Bonus: 100,
  monthly10Bonus: 200,
};

function requireAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'يجب تسجيل الدخول.');
  return request.auth.uid;
}
function cleanString(v, max) {
  if (typeof v !== 'string' || v.length > max) throw new HttpsError('invalid-argument', 'بيانات نصية غير صالحة.');
  return v.trim();
}
function dateOnly(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function parseDateOnly(v) {
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new HttpsError('invalid-argument', 'تاريخ غير صالح.');
  return d;
}
function daysInclusive(a, b) {
  return Math.floor((parseDateOnly(b) - parseDateOnly(a)) / 86400000) + 1;
}
function assertPhone(phone) {
  if (!PHONE_RE.test(phone)) throw new HttpsError('invalid-argument', 'رقم الهاتف غير صالح.');
}
function assertCustomer(c) {
  if (!c || typeof c !== 'object') throw new HttpsError('invalid-argument', 'بيانات العميل ناقصة.');
  const name = cleanString(c.name, 200);
  const phone = cleanString(c.phone, 20); assertPhone(phone);
  const address = cleanString(c.address, 1000);
  const mapLink = cleanString(c.mapLink || '', 1000);
  const notes = cleanString(c.notes || '', 2000);
  if (mapLink && !/^https:\/\//i.test(mapLink)) throw new HttpsError('invalid-argument', 'رابط الخريطة غير صالح.');
  return { name, phone, address, mapLink, notes };
}
function assertSchedule(s) {
  if (!s || !dateOnly(s.dateFrom) || !dateOnly(s.dateTo) || typeof s.deliveryTime !== 'string' || !/^\d{2}:\d{2}(:\d{2})?$/.test(s.deliveryTime)) {
    throw new HttpsError('invalid-argument', 'بيانات الموعد غير صالحة.');
  }
  if (s.dateTo < s.dateFrom) throw new HttpsError('invalid-argument', 'تاريخ النهاية قبل البداية.');
  const durationDays = daysInclusive(s.dateFrom, s.dateTo);
  if (durationDays < 1 || durationDays > 3650) throw new HttpsError('invalid-argument', 'مدة الطلب غير صالحة.');
  return { dateFrom: s.dateFrom, dateTo: s.dateTo, deliveryTime: s.deliveryTime };
}
async function getPointsRules(transaction) {
  const snap = await transaction.get(db.doc('config/pointsRules'));
  return snap.exists ? { ...DEFAULT_POINTS, ...snap.data() } : DEFAULT_POINTS;
}
function point(n) { return Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0; }
function monthKeyUTC() { return new Date().toISOString().slice(0, 7); }
function awardRef(orderId, suffix) { return db.doc(`pointsLog/${suffix || `order_${orderId}_${crypto.randomUUID()}`}`); }
function reason(kind, extra='') {
  const m = {
    first: 'مكافأة أول طلب', order: `نقاط الطلب ${extra}`, repeat: 'مكافأة تكرار الطلبات', streak3: 'مكافأة الطلب الثالث',
    month5: 'مكافأة 5 طلبات في الشهر', month10: 'مكافأة 10 طلبات في الشهر', referral: `مكافأة إحالة${extra ? `: ${extra}` : ''}`,
    review: 'مكافأة تقييم الطلب', redeem: `استبدال المكافأة: ${extra}`,
  };
  return m[kind] || kind;
}

exports.createOrder = onCall(async (request) => {
  const uid = requireAuth(request);
  const data = request.data || {};
  const customer = assertCustomer(data.customer);
  const schedule = assertSchedule(data.schedule);
  const plan = data.plan;
  if (!PLANS[plan]) throw new HttpsError('invalid-argument', 'الباقة غير صالحة.');
  if (!['home','work'].includes(data.deliveryLocation)) throw new HttpsError('invalid-argument', 'مكان التوصيل غير صالح.');
  if (!['lunch','dinner'].includes(data.mealType)) throw new HttpsError('invalid-argument', 'نوع الوجبة غير صالح.');
  if (!['ar','fr'].includes(data.lang)) throw new HttpsError('invalid-argument', 'اللغة غير صالحة.');
  if (!PAYMENT_METHODS.has(data.paymentMethod)) throw new HttpsError('invalid-argument', 'طريقة الدفع غير صالحة.');
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 100) throw new HttpsError('invalid-argument', 'السلة غير صالحة.');

  const itemMap = new Map();
  for (const item of data.items) {
    if (!item || typeof item.mealId !== 'string' || item.mealId.length > 200 || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100) {
      throw new HttpsError('invalid-argument', 'عنصر في السلة غير صالح.');
    }
    itemMap.set(item.mealId, (itemMap.get(item.mealId) || 0) + item.qty);
  }
  const mealIds = [...itemMap.keys()];
  if (mealIds.length > 100) throw new HttpsError('invalid-argument', 'عدد الأطباق كبير.');

  const orderId = db.collection('orders').doc().id;
  const orderRef = db.doc(`orders/${orderId}`);
  const userRef = db.doc(`users/${uid}`);
  const pointsRulesRef = db.doc('config/pointsRules');
  const paymentRef = db.doc('config/paymentMethods');

  const result = await db.runTransaction(async (tx) => {
    const [userSnap, rulesSnap, paymentSnap, ...mealSnaps] = await Promise.all([
      tx.get(userRef), tx.get(pointsRulesRef), tx.get(paymentRef),
      ...mealIds.map(id => tx.get(db.doc(`meals/${id}`)))
    ]);
    if (!userSnap.exists) throw new HttpsError('failed-precondition', 'حساب المستخدم غير مكتمل.');
    const rules = rulesSnap.exists ? { ...DEFAULT_POINTS, ...rulesSnap.data() } : DEFAULT_POINTS;
    const pm = paymentSnap.exists ? paymentSnap.data() : {};
    if (pm[data.paymentMethod] && pm[data.paymentMethod].enabled === false) throw new HttpsError('failed-precondition', 'طريقة الدفع غير مفعلة.');

    const items = [];
    let dailyTotal = 0;
    mealSnaps.forEach((snap, i) => {
      if (!snap.exists) throw new HttpsError('not-found', `الطبق غير موجود: ${mealIds[i]}`);
      const m = snap.data();
      const qty = itemMap.get(mealIds[i]);
      const price = Number(m.price);
      if (!Number.isFinite(price) || price < 0 || price > 1000000) throw new HttpsError('failed-precondition', 'سعر طبق غير صالح.');
      dailyTotal += price * qty;
      items.push({ mealId: mealIds[i], name: String(m.name || '').slice(0, 200), price, qty });
    });

    const durationDays = daysInclusive(schedule.dateFrom, schedule.dateTo);
    const total = Math.round(dailyTotal * durationDays * (1 - PLANS[plan].discount) * 100) / 100;
    if (!(total > 0) || total > 1000000) throw new HttpsError('failed-precondition', 'إجمالي الطلب غير صالح.');

    const profile = userSnap.data();
    const before = Number(profile.orderCount || 0);
    const newCount = before + 1;
    const month = monthKeyUTC();
    const sameMonth = profile.lastOrderMonthKey === month;
    const monthCount = (sameMonth ? Number(profile.ordersThisMonth || 0) : 0) + 1;

    const order = {
      uid, customer, schedule, plan, durationDays,
      paymentMethod: data.paymentMethod,
      paymentMethodLabel: String(data.paymentMethodLabel || data.paymentMethod).slice(0, 200),
      deliveryLocation: data.deliveryLocation, mealType: data.mealType, lang: data.lang,
      items, total, status: 'قيد المراجعة', createdAt: FieldValue.serverTimestamp(),
    };
    tx.create(orderRef, order);

    const awards = [];
    if (before === 0) awards.push([point(rules.firstOrderPoints), reason('first')]);
    const valuePoints = Math.floor(total / Number(rules.perDirham || 10));
    if (valuePoints > 0) awards.push([valuePoints, reason('order', Math.round(total))]);
    const repeat = newCount >= 10 ? 30 : newCount >= 5 ? 20 : newCount >= 2 ? 10 : 0;
    if (repeat) awards.push([repeat, reason('repeat')]);
    if (newCount === 3 && !profile.orderMilestone3Given) awards.push([point(rules.streak3Bonus), reason('streak3')]);
    if (monthCount === 5) awards.push([point(rules.monthly5Bonus), reason('month5')]);
    if (monthCount === 10) awards.push([point(rules.monthly10Bonus), reason('month10')]);

    awards.forEach(([pts, why], idx) => {
      if (pts > 0) tx.create(awardRef(orderId, `order_${orderId}_${idx}`), { uid, points: pts, reason: why, orderId, createdAt: FieldValue.serverTimestamp() });
    });

    if (before === 0 && profile.referredByUid && !profile.referralBonusGiven && profile.referredByUid !== uid) {
      const refUid = profile.referredByUid;
      tx.create(awardRef(orderId, `ref_${uid}`), { uid: refUid, points: point(rules.referralPoints), reason: reason('referral', customer.name), orderId, createdAt: FieldValue.serverTimestamp() });
    }

    tx.update(userRef, {
      orderCount: newCount, ordersThisMonth: monthCount, lastOrderMonthKey: month,
      orderMilestone3Given: Boolean(profile.orderMilestone3Given || newCount >= 3),
      referralBonusGiven: Boolean(profile.referralBonusGiven || (before === 0 && !!profile.referredByUid)),
    });
    return { orderId, total, durationDays, items };
  });

  // Membership is derived after the order is committed; it is server-controlled.
  await ensureMembership(uid, result.orderId);
  return { orderId: result.orderId, total: result.total, durationDays: result.durationDays, items: result.items };
});

async function ensureMembership(uid, orderId) {
  const snap = await db.collection('orders').where('uid', '==', uid).get();
  let totalDays = 0, minStart = null, maxEnd = null, latest = null;
  snap.forEach(d => {
    const o = d.data(); if (!o.schedule) return;
    totalDays += Number(o.durationDays || 0);
    minStart = !minStart || o.schedule.dateFrom < minStart ? o.schedule.dateFrom : minStart;
    maxEnd = !maxEnd || o.schedule.dateTo > maxEnd ? o.schedule.dateTo : maxEnd;
    latest = d;
  });
  if (totalDays < 3 || !latest) return;
  const profile = (await db.doc(`users/${uid}`).get()).data() || {};
  const existing = await db.doc(`members/${uid}`).get();
  const old = existing.exists ? existing.data() : {};
  await db.doc(`members/${uid}`).set({
    uid, name: latest.data().customer.name, phone: profile.phone || latest.data().customer.phone,
    gender: profile.gender || 'male', avatar: profile.avatar || '👨',
    startDate: minStart, endDate: maxEnd, totalDays, orderId,
    plan: latest.data().plan || null, joinDate: old.joinDate || new Date().toISOString(), updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

exports.redeemReward = onCall(async (request) => {
  const uid = requireAuth(request);
  const rewardId = cleanString(request.data?.rewardId, 100);
  const rewardRef = db.doc(`rewards/${rewardId}`);
  const userRef = db.doc(`users/${uid}`);
  const code = `WJ${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const redemptionRef = db.doc(`redemptions/${code}`);
  const debitRef = db.doc(`pointsLog/redeem_${code}`);

  await db.runTransaction(async tx => {
    const [rewardSnap, userSnap, pointsSnap] = await Promise.all([
      tx.get(rewardRef), tx.get(userRef), tx.get(db.collection('pointsLog').where('uid', '==', uid))
    ]);
    if (!rewardSnap.exists || rewardSnap.data().active !== true) throw new HttpsError('not-found', 'المكافأة غير متاحة.');
    if (!userSnap.exists) throw new HttpsError('failed-precondition', 'الحساب غير موجود.');
    const reward = rewardSnap.data();
    const cost = Number(reward.pointsCost);
    if (!Number.isInteger(cost) || cost <= 0 || cost > 100000) throw new HttpsError('failed-precondition', 'سعر المكافأة غير صالح.');
    let balance = 0; pointsSnap.forEach(s => balance += Number(s.data().points || 0));
    if (balance < cost) throw new HttpsError('failed-precondition', 'الرصيد غير كافٍ.');
    tx.create(debitRef, { uid, points: -cost, reason: reason('redeem', reward.name), orderId: null, createdAt: FieldValue.serverTimestamp() });
    tx.create(redemptionRef, { uid, rewardId, rewardName: String(reward.name).slice(0,200), pointsCost: cost, code, status: 'pending', createdAt: FieldValue.serverTimestamp() });
  });
  return { code };
});

exports.submitOrderReview = onCall(async (request) => {
  const uid = requireAuth(request);
  const orderId = cleanString(request.data?.orderId, 100);
  const rating = Number(request.data?.rating);
  const comment = cleanString(request.data?.comment || '', 1000);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpsError('invalid-argument', 'التقييم غير صالح.');
  const orderRef = db.doc(`orders/${orderId}`);
  await db.runTransaction(async tx => {
    const [orderSnap, rulesSnap] = await Promise.all([tx.get(orderRef), tx.get(db.doc('config/pointsRules'))]);
    if (!orderSnap.exists || orderSnap.data().uid !== uid) throw new HttpsError('not-found', 'الطلب غير موجود.');
    const order = orderSnap.data();
    if (order.reviewed === true) throw new HttpsError('already-exists', 'تم تقييم هذا الطلب مسبقاً.');
    const rules = rulesSnap.exists ? { ...DEFAULT_POINTS, ...rulesSnap.data() } : DEFAULT_POINTS;
    tx.update(orderRef, { reviewed: true, rating, reviewComment: comment });
    const pts = point(rules.reviewPoints);
    if (pts) tx.create(db.doc(`pointsLog/review_${orderId}`), { uid, points: pts, reason: reason('review'), orderId, createdAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

exports.rebuildMembership = onCall(async request => {
  const uid = requireAuth(request);
  await ensureMembership(uid, null);
  return { ok: true };
});
