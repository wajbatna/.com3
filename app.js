// app.js — منطق الواجهة الأمامية (الزبون) — ثنائي اللغة + حساب + بطاقة العضوية
import { db, auth, app } from "./firebase.js";
import { getLang, setLang, t } from "./i18n.js";
import {
  collection,
  onSnapshot,
  addDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";
const functions = getFunctions(app, "europe-west1");
const createOrderCallable = httpsCallable(functions, "createOrder");
const redeemRewardCallable = httpsCallable(functions, "redeemReward");
const submitReviewCallable = httpsCallable(functions, "submitOrderReview");
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  deleteUser,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const authReady = setPersistence(auth, browserLocalPersistence).catch(() => {});

const PLANS_META = [
  { id: "daily", days: 1, discount: 0 },
  { id: "weekly", days: 7, discount: 0.1 },
  { id: "monthly", days: 30, discount: 0.2 },
];
const CAT_IDS = ["all", "breakfast", "lunch", "dinner"];
const CAT_EMOJI = { all: "🍽", breakfast: "☀", lunch: "🍲", dinner: "🌙" };
// طرق الأداء المتاحة للزبون فصفحة إتمام الطلب — الأدمين كيقدر يفعّل/يعطّل كل وحدة ويحط ليها RIB من لوحة التحكم (config/paymentMethods)
const PAYMENT_METHODS = [
  { id: "card", icon: "💳" },
  { id: "cod", icon: "💵" },
  { id: "tpe", icon: "📟" },
  { id: "cih", icon: "🏦", img: "img/payments/cih.png" },
  { id: "fellah", icon: "🌾", img: "img/payments/fellah.jpg" },
  { id: "cashplus", icon: "💸", img: "img/payments/cashplus.jpg" },
  { id: "wafacash", icon: "💰", img: "img/payments/wafacash.jpg" },
  { id: "tijari", icon: "🏛", img: "img/payments/tijari.jpg" },
  { id: "baridbank", icon: "📮", img: "img/payments/baridbank.jpg" },
];
// كيرجع HTML ديال أيقونة طريقة الأداء: تصويرة الشركة إلا كانت، وإلا الإيموجي كـ fallback
function paymentIconHtml(pm) {
  return pm.img
    ? `<img src="${pm.img}" alt="${pm.id}" class="pay-icon-img" onerror="this.outerHTML='${pm.icon}'">`
    : pm.icon;
}
// الحد الأدنى لعدد أيام الطلب باش يستحق الزبون بطاقة العضوية تلقائياً
const MEMBERSHIP_MIN_DAYS = 3;
const PHONE_RE = /^(0[5-7]\d{8}|\+212[5-7]\d{8})$/;

// قواعد احتساب النقاط الافتراضية — الأدمين يقدر يبدلها من config/pointsRules،
// وإلا ما كايناش وثيقة، هاد القيم هي لي كتخدم
const DEFAULT_POINTS_RULES = {
  firstOrderPoints: 50,
  perDirham: 10, // كل 10 دراهم = نقطة وحدة
  reviewPoints: 10,
  referralPoints: 150,
  streak3Bonus: 50,
  monthly5Bonus: 100,
  monthly10Bonus: 200,
};
const TIERS = [
  { id: "bronze", min: 0, max: 499 },
  { id: "silver", min: 500, max: 999 },
  { id: "gold", min: 1000, max: 1999 },
  { id: "vip", min: 2000, max: Infinity },
];
let pointsRules = { ...DEFAULT_POINTS_RULES };

let lang = getLang();
let meals = [];
let dailyMealImage = "";
let cart = {};
let category = "all",
  plan = "weekly";
// طرق الأداء: الإعدادات (RIB/تفعيل) جاية من config/paymentMethods، والطريقة المختارة فالطلب الحالي
let paymentMethodsConfig = {};
let paymentMethod = null;
let paymentPickerOpen = false;
// مكان الاستلام (منزل/عمل) ونوع الوجبة (غداء/عشاء) المختارين فالطلب الحالي
let deliveryLocation = null;
let mealType = null;

/* ---------- الحساب / تسجيل الدخول ---------- */
let currentUser = null; // كائن Firebase Auth
let userProfile = null; // { phone, gender, avatar }
let membershipData = null; // { name, phone, avatar, startDate, endDate, ... } أو null
let authTab = "login";
let signupGender = "male";
let countdownInterval = null;
let pendingCheckoutAfterLogin = false;
let pendingSupportAfterLogin = false;
let profileIncomplete = false; // true إلا دخل الزبون بـ Google/Apple ومازال ما كملش رقم الهاتف/الجنس
let chatUnsubscribe = null;
let unreadUnsubscribe = null;
let hasUnreadSupport = false; // حالة وجود رسائل دعم غير مقروءة — كتحدث نقطة التنبيه فالقائمة وزر ☰

const googleProvider = new GoogleAuthProvider();
const appleProvider = new OAuthProvider("apple.com");

function phoneToEmail(phone) {
  return `${phone}@wajbati.app`;
}
function normalizePhone(raw) {
  // كيحول أي صيغة (+212612345678 / 212612345678 / 0612345678) لنفس الصيغة الموحدة
  // باش نفس رقم الهاتف يعطي دائماً نفس "الإيميل المصطنع"، فتسجيل الدخول يخدم بجد
  let p = String(raw || "").replace(/[\s-]/g, "").trim();
  if (p.startsWith("+212")) p = "0" + p.slice(4);
  else if (p.startsWith("212") && p.length === 12) p = "0" + p.slice(3);
  return p;
}
function avatarFor(gender) {
  return gender === "female" ? "👩" : "👨";
}

function money(n) {
  const cur = lang === "fr" ? "DH" : "درهم";
  const locale = lang === "fr" ? "fr-FR" : "ar-MA";
  return `${Math.round(n).toLocaleString(locale)} ${cur}`;
}
function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const locale = lang === "fr" ? "fr-FR" : "ar-MA";
  return date.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}
function filtered() {
  return category === "all" ? meals : meals.filter((m) => m.category === category);
}
function cartItems() {
  return Object.entries(cart)
    .map(([id, qty]) => {
      const m = meals.find((x) => x.id === id);
      return m ? { ...m, qty } : null;
    })
    .filter(Boolean);
}
function dailyTotal() {
  return cartItems().reduce((s, m) => s + m.price * m.qty, 0);
}
function total() {
  // تقدير أولي (قبل ما يختار الزبون التواريخ الحقيقية فنافذة الطلب) — مبني على مدة الباقة النموذجية فقط
  const p = PLANS_META.find((x) => x.id === plan);
  return dailyTotal() * p.days * (1 - p.discount);
}
function actualDays() {
  const from = document.getElementById("dateFrom")?.value;
  const to = document.getElementById("dateTo")?.value;
  if (!from || !to) return null;
  const f = new Date(from + "T00:00:00");
  const tt = new Date(to + "T00:00:00");
  const d = Math.round((tt - f) / 86400000) + 1;
  return d > 0 ? d : null;
}
function checkoutTotal() {
  // السعر الحقيقي: مبني على عدد الأيام الفعلي المختار (من - إلى)، ماشي على مدة الباقة الثابتة
  const p = PLANS_META.find((x) => x.id === plan);
  const days = actualDays() ?? p.days;
  return dailyTotal() * days * (1 - p.discount);
}
function count() {
  return Object.values(cart).reduce((a, b) => a + b, 0);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}
function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
// كينسخ نص لحافظة الجهاز (RIB أو اسم صاحب الحساب) وكيبين ✓ فالزر لمدة قصيرة كتأكيد للزبون
function copyToClipboard(btn) {
  const text = btn.dataset.copy || "";
  const done = () => {
    const original = btn.textContent;
    btn.textContent = "✓";
    setTimeout(() => {
      btn.textContent = original;
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, cb) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (e) {
    /* تجاهل */
  }
  document.body.removeChild(ta);
  if (cb) cb();
}
// رقم طلب مختصر وقابل للقراءة مشتق من معرّف الوثيقة فـ Firestore (بلا الحاجة لعداد مركزي جديد)
function orderCode(id) {
  return "WJ-" + String(id || "").slice(0, 8).toUpperCase();
}
// نسخ رقم الطلب لحافظة الجهاز (يخدم فـ Android وiPhone والكمبيوتر) مع تنبيه تأكيدي
function copyOrderNumber(btn) {
  const text = btn.dataset.copy || "";
  const s = t(lang);
  const done = () => toast(s.orderNumberCopied);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

/* ---------- إشعارات Toast (بدل alert) ---------- */
let toastTimer = null;
function toast(msg, type = "success") {
  const box = document.getElementById("toasts");
  if (!box) return;
  // إشعار واحد فقط فكل مرة باش ما يتراكموش مع الضغط المتكرر
  box.innerHTML = "";
  clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.className = "toast" + (type === "error" ? " error" : "");
  el.textContent = msg;
  box.appendChild(el);
  toastTimer = setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 260);
  }, 2600);
}
function scrollToMenu() {
  const el = document.getElementById("menu");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}
/* ═══════ نغمة تنبيه رسائل الدعم — مصنوعة بالكود (بلا ملف صوتي)، تحترم قيود التشغيل التلقائي ═══════ */
let notifyAudioCtx = null;
let notifyAudioUnlocked = false;
function unlockNotifySound() {
  if (notifyAudioUnlocked) return;
  try {
    notifyAudioCtx = notifyAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (notifyAudioCtx.state === "suspended") notifyAudioCtx.resume();
    notifyAudioUnlocked = true;
  } catch (e) {
    /* المتصفح ما كيدعمش Web Audio — التنبيه النصي/البصري كيبقى خدام وحدو */
  }
}
["click", "touchstart", "keydown"].forEach((evt) => document.addEventListener(evt, unlockNotifySound, { once: true, passive: true }));
function playNotifySound() {
  if (!notifyAudioUnlocked || !notifyAudioCtx) return; // المتصفح مازال ما سمحش بالصوت — التنبيه النصي كيبقى كافي، والنظام ما يتوقفش
  try {
    const ctx = notifyAudioCtx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1175, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.34);
  } catch (e) {
    /* أي خطأ فالصوت ما كيوقفش الإشعار النصي */
  }
}
function goToCart() {
  const el = document.getElementById("cartPanel");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}
function bump(el) {
  if (!el) return;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

/* ---------- بانر وجبة اليوم (فوق الفئات: الكل/الفطور/الغداء/العشاء) ---------- */
function renderDailyMealBanner() {
  const banner = document.getElementById("dailyMealBanner");
  const img = document.getElementById("dailyMealImg");
  if (!banner || !img) return;
  if (dailyMealImage) {
    img.src = dailyMealImage;
    banner.classList.add("show");
  } else {
    banner.classList.remove("show");
  }
}

/* ---------- نصوص ثابتة (رأس الصفحة، الفوتر...) ---------- */
function applyStaticText() {
  const s = t(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = s.dir;
  document.getElementById("badgeText").textContent = s.badge;
  document.getElementById("dailyMealBadge").textContent = s.dailyMealBadge;
  document.getElementById("tagline").textContent = s.tagline;
  document.getElementById("trust1b").textContent = s.trust1[0];
  document.getElementById("trust1s").textContent = s.trust1[1];
  document.getElementById("trust2b").textContent = s.trust2[0];
  document.getElementById("trust2s").textContent = s.trust2[1];
  document.getElementById("trust3b").textContent = s.trust3[0];
  document.getElementById("trust3s").textContent = s.trust3[1];
  document.getElementById("mobileTotalLabel").textContent = s.mobileTotalLabel;
  document.getElementById("mobileCheckoutBtn").textContent = s.mobileCheckoutBtn;
  document.getElementById("footerText").textContent = s.footer;
  document.querySelectorAll(".lang-btn").forEach((b) => {
    const on = b.dataset.lang === lang;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  // ترجمة العناصر الثابتة المعلّمة بـ data-i18n / data-i18n-aria (يدعم مسارات مثل how1.0)
  const pick = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), s);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const v = pick(el.dataset.i18n);
    if (typeof v === "string") el.textContent = v;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const v = pick(el.dataset.i18nAria);
    if (typeof v === "string") el.setAttribute("aria-label", v);
  });
  const dmImg = document.getElementById("dailyMealImg");
  if (dmImg) dmImg.alt = s.dailyMealBadge.replace(/^\S+\s/, "");
  document.title = lang === "fr" ? "Wajbati — Cuisine marocaine maison authentique" : "وجبتي — أكل بيتي مغربي أصيل";
  updateAccountButton();
}

/* ---------- القائمة الجانبية (☰) بدل أزرار رأس الصفحة ---------- */
// يفصل الإيموجي الأول عن النص (النصوص فالترجمة كلها بصيغة "إيموجي نص")
function splitIcon(str) {
  const idx = (str || "").indexOf(" ");
  if (idx === -1) return { icon: "", text: str || "" };
  return { icon: str.slice(0, idx), text: str.slice(idx + 1) };
}

function openSidebar() {
  renderSidebar();
  const sb = document.getElementById("sidebar");
  sb.classList.add("show");
  sb.setAttribute("aria-hidden", "false");
  document.getElementById("sidebarOverlay").classList.add("show");
  document.getElementById("menuBtn").setAttribute("aria-expanded", "true");
  syncBodyScrollLock();
  setTimeout(() => sb.querySelector(".side-item, .sidebar-close")?.focus(), 50);
}
function closeSidebar() {
  const sb = document.getElementById("sidebar");
  const wasOpen = sb.classList.contains("show");
  sb.classList.remove("show");
  sb.setAttribute("aria-hidden", "true");
  document.getElementById("sidebarOverlay").classList.remove("show");
  document.getElementById("menuBtn").setAttribute("aria-expanded", "false");
  syncBodyScrollLock();
  if (wasOpen) document.getElementById("menuBtn").focus({ preventScroll: true });
}
// كيمنع تمرير الصفحة ملي كاينة نافذة أو قائمة مفتوحة، وكيرجعو ملي تتسكر
function syncBodyScrollLock() {
  const anyModal = document.querySelector(".modal.show");
  const sidebarOpen = document.getElementById("sidebar")?.classList.contains("show");
  document.body.classList.toggle("no-scroll", !!(anyModal || sidebarOpen));
}
// إغلاق النوافذ بالضغط خارجها أو بزر Escape
const MODAL_CLOSERS = {
  checkoutModal: () => closeCheckout(),
  membershipModal: () => closeMembership(),
  accountModal: () => {
    if (!profileIncomplete) closeAccount(); // إكمال الملف الشخصي إجباري بعد Google/Apple
  },
  rewardsModal: () => closeRewards(),
  rateModal: () => closeRateOrder(),
  supportModal: () => closeSupport(),
};
function closeTopModal() {
  if (document.getElementById("sidebar").classList.contains("show")) {
    closeSidebar();
    return true;
  }
  const open = [...document.querySelectorAll(".modal.show")].pop();
  if (open && MODAL_CLOSERS[open.id]) {
    MODAL_CLOSERS[open.id]();
    return true;
  }
  return false;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTopModal();
});
document.querySelectorAll(".modal").forEach((m) => {
  let downOnBackdrop = false;
  m.addEventListener("mousedown", (e) => (downOnBackdrop = e.target === m));
  m.addEventListener("touchstart", (e) => (downOnBackdrop = e.target === m), { passive: true });
  m.addEventListener("click", (e) => {
    if (e.target === m && downOnBackdrop && MODAL_CLOSERS[m.id]) MODAL_CLOSERS[m.id]();
  });
});
// كيراقب فتح/إغلاق النوافذ: قفل التمرير + labels لأزرار × + ربط label بالحقل
const a11yObserver = new MutationObserver(() => {
  syncBodyScrollLock();
  const s = t(lang);
  document.querySelectorAll(".modal .close:not([aria-label])").forEach((b) => b.setAttribute("aria-label", s.closeAria));
  document.querySelectorAll(".modal label:not([for])").forEach((l) => {
    const f = l.nextElementSibling;
    if (f && f.id && /^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName)) l.setAttribute("for", f.id);
  });
});
document.querySelectorAll(".modal").forEach((m) => a11yObserver.observe(m, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true }));
// يسكر القائمة قبل ما يشغل الإجراء المطلوب (فتح الدعم، المكافآت...)
function openSidebarAction(fnName) {
  closeSidebar();
  window[fnName]();
}

function renderSidebar() {
  const s = t(lang);
  const body = document.getElementById("sidebarBody");
  if (!body) return;
  const items = [];

  const support = splitIcon(s.supportBtn);
  items.push(`<button type="button" class="side-item" onclick="openSidebarAction('openSupport')">
    <span class="side-icon">${support.icon}<span class="side-badge" id="sideSupportBadge"></span></span>
    <span class="side-label">${support.text}</span>
  </button>`);

  if (currentUser) {
    const myOrders = splitIcon(s.myOrdersBtn);
    items.push(`<button type="button" class="side-item" onclick="openSidebarAction('openMyOrders')">
      <span class="side-icon">${myOrders.icon}</span>
      <span class="side-label">${myOrders.text}</span>
    </button>`);
    const rewards = splitIcon(s.rewardsBtn);
    items.push(`<button type="button" class="side-item" onclick="openSidebarAction('openRewards')">
      <span class="side-icon">${rewards.icon}</span>
      <span class="side-label">${rewards.text}</span>
    </button>`);
  }

  if (currentUser && membershipData) {
    const memText = lang === "fr" ? "Carte de membre" : "بطاقة العضوية";
    items.push(`<button type="button" class="side-item" onclick="openSidebarAction('openMembership')">
      <span class="side-icon">🎫</span>
      <span class="side-label">${memText}</span>
    </button>`);
  }

  const account =
    currentUser && userProfile
      ? { icon: userProfile.avatar || "👤", text: userProfile.phone || userProfile.name || (lang === "fr" ? "Mon compte" : "حسابي") }
      : splitIcon(s.accountBtnLogin);
  items.push(`<button type="button" class="side-item" onclick="openSidebarAction('openAccount')">
    <span class="side-icon">${account.icon}</span>
    <span class="side-label">${account.text}</span>
  </button>`);

  body.innerHTML = items.join("");
  syncSupportBadgeUI();
}
// نبقيو الاسم القديم شغال (كيتصاوب عليه نداء فبزاف ديال الأماكن) وكيدير تحديث القائمة الجانبية
function updateAccountButton() {
  renderSidebar();
}
function switchLang(l) {
  if (l === lang) return;
  lang = l;
  setLang(l);
  applyStaticText();
  updateAccountButton();
  render();
}

/* ---------- عرض القائمة والسلة ---------- */
function renderCategories() {
  const s = t(lang);
  document.getElementById("categories").innerHTML = CAT_IDS.map(
    (id) => `<button type="button" class="cat ${category === id ? "active" : ""}" aria-pressed="${category === id}" onclick="setCategory('${id}')">
      <span class="cat-circle">${CAT_EMOJI[id]}</span>
      <span class="cat-label">${s.categories[id]}</span>
    </button>`
  ).join("");
}
function setCategory(c) {
  category = c;
  render();
}
let lastTouchedId = null;
function mealName(id) {
  return meals.find((x) => x.id === id)?.name || "";
}
function add(id) {
  const first = !cart[id];
  cart[id] = (cart[id] || 0) + 1;
  lastTouchedId = id;
  render();
  setTimeout(() => (lastTouchedId = null), 600);
  if (first) toast(t(lang).toastAdded(mealName(id)));
  bump(document.getElementById("headerCartCount"));
  bump(document.getElementById("mobileCartCount"));
}
function remove(id) {
  lastTouchedId = id;
  if (cart[id] > 1) {
    cart[id]--;
    render();
  } else {
    delete cart[id];
    render();
    toast(t(lang).toastRemoved);
  }
}
function removeAll(id) {
  delete cart[id];
  render();
  toast(t(lang).toastRemoved);
}

function qtyControl(m, s) {
  const pop = lastTouchedId === m.id ? " pop" : "";
  return `<div class="qty${pop}" role="group" aria-label="${escapeAttr(m.name)}"><button type="button" aria-label="${escapeAttr(s.minusAria(m.name))}" onclick="remove('${m.id}')">−</button><b aria-live="polite">${cart[m.id]}</b><button type="button" class="plus" aria-label="${escapeAttr(s.plusAria(m.name))}" onclick="add('${m.id}')">+</button></div>`;
}
function renderMeals() {
  const s = t(lang);
  const list = filtered();
  const el = document.getElementById("meals");
  if (!meals.length) {
    el.innerHTML = `<div class="empty">${s.emptyNoMeals}</div>`;
    return;
  }
  el.innerHTML = list.length
    ? list
        .map(
          (m) => `
 <article class="meal">
  <div class="meal-img${m.image ? "" : " no-img"}">
   ${
     m.image
       ? `<img src="${escapeAttr(m.image)}" alt="${escapeAttr(m.name)}" width="640" height="400" loading="lazy" decoding="async" onerror="this.parentNode.classList.add('no-img');this.remove()">`
       : ""
   }
   <span class="category">${s.categories[m.category] || ""}</span>
  </div>
  <div class="meal-body">
   <h3>${escapeHtml(m.name)}</h3>
   <div class="desc">${escapeHtml(m.description || "")}</div>
   <div class="meal-bottom">
    <span class="price">${money(m.price)}</span>
    ${
      cart[m.id]
        ? qtyControl(m, s)
        : `<button type="button" class="add" aria-label="${escapeAttr(s.addBtn + " — " + m.name)}" onclick="add('${m.id}')">${s.addBtn}</button>`
    }
   </div>
  </div>
 </article>`
        )
        .join("")
    : `<div class="empty">${s.emptyCategory}</div>`;
}

function renderCart() {
  const s = t(lang);
  const items = cartItems();
  const el = document.getElementById("cartPanel");
  const n = count();
  document.body.classList.toggle("cart-has-items", n > 0);
  ["headerCartCount", "mobileCartCount"].forEach((id) => {
    const c = document.getElementById(id);
    if (!c) return;
    c.textContent = n;
    c.classList.toggle("show", n > 0);
  });
  if (!items.length) {
    el.innerHTML = `<section class="panel cart-empty">
  <div class="ico" aria-hidden="true">🛒</div>
  <h2>${s.cartEmptyTitle}</h2>
  <p>${s.cartEmptyText}</p>
  <a class="add" href="#menu">${s.browseMeals}</a>
 </section>`;
    return;
  }
  document.getElementById("mobileTotal").textContent = money(total());
  const p = PLANS_META.find((x) => x.id === plan);
  el.innerHTML = `<section class="panel">
  <h2 style="margin-top:0;color:var(--primary);font-size:20px;font-weight:900">${s.choosePlan}</h2>
  <div class="plans" role="group">${PLANS_META.map((x) => {
    const [label, note] = s.plans[x.id];
    return `<button type="button" class="plan ${plan === x.id ? "active" : ""}" aria-pressed="${plan === x.id}" onclick="choosePlan('${x.id}')"><strong>${label}${
      x.discount ? `<span class="discount">${note}</span>` : ""
    }</strong><small style="color:var(--muted)">${x.days} ${x.days === 1 ? s.day : s.days}</small></button>`;
  }).join("")}</div>
  <h3 class="cart-head">🛒 ${s.cartTitle} <small>(${n} ${s.itemsSuffix})</small></h3>
  ${items
    .map(
      (i) => `<div class="cart-row">
    ${i.image ? `<img class="cart-thumb" src="${escapeAttr(i.image)}" alt="${escapeAttr(i.name)}" width="64" height="64" loading="lazy" decoding="async" onerror="this.remove()">` : ""}
    <div class="cart-info"><b>${escapeHtml(i.name)}</b><small>${money(i.price)} ${s.perDish}</small></div>
    <div class="cart-ctrl">
      <div class="qty" role="group" aria-label="${escapeAttr(i.name)}">
        <button type="button" aria-label="${escapeAttr(s.minusAria(i.name))}" onclick="remove('${i.id}')">−</button><b aria-live="polite">${i.qty}</b><button type="button" class="plus" aria-label="${escapeAttr(s.plusAria(i.name))}" onclick="add('${i.id}')">+</button>
      </div>
      <span class="cart-line" aria-label="${escapeAttr(s.lineTotal)}">${money(i.price * i.qty)}</span>
      <button type="button" class="trash-btn" aria-label="${escapeAttr(s.removeAria(i.name))}" onclick="removeAll('${i.id}')">🗑</button>
    </div>
  </div>`
    )
    .join("")}
  <div class="summary">
   <div class="sumrow"><span>${s.dailyCost}</span><b>${money(dailyTotal())}</b></div>
   <div class="sumrow"><span>${s.planDuration}</span><b>× ${p.days}</b></div>
   ${p.discount ? `<div class="sumrow" style="color:var(--primary-light)"><span>${s.planDiscount}</span><b>-${Math.round(p.discount * 100)}%</b></div>` : ""}
   <div class="sumrow total"><span>${s.finalTotal}</span><b>${money(total())}</b></div>
  </div>
  <div class="field-note" style="text-align:center;margin-top:8px">${s.estimatedNote}</div>
  <button type="button" class="checkout" onclick="openCheckout()">${s.continueCheckout}</button>
 </section>`;
}
function choosePlan(p) {
  plan = p;
  render();
}
function render() {
  renderCategories();
  renderMeals();
  renderCart();
}

/* ---------- إتمام الطلب ---------- */
function openCheckout() {
  const s = t(lang);
  if (!cartItems().length) return;
  if (!currentUser) {
    pendingCheckoutAfterLogin = true;
    authTab = "login";
    document.getElementById("accountModal").classList.add("show");
    renderAccountAuth();
    return;
  }
  document.getElementById("checkoutModal").classList.add("show");
  // الدفع عند الاستلام هو الخيار الافتراضي إلا كان مفعّل (الزبون يقدر يبدلو)
  paymentMethod = enabledPaymentMethods().some((pm) => pm.id === "cod") ? "cod" : null;
  paymentPickerOpen = false;
  // نبداو من جديد فكل مرة: بلا اختيار مسبق ديال المكان، والوقت الحالي كيقترح غداء أو عشاء بشكل افتراضي فقط
  deliveryLocation = null;
  mealType = new Date().getHours() >= 16 ? "dinner" : "lunch";
  document.getElementById("checkoutContent").innerHTML = `
 <div class="modal-head"><h3>${s.checkoutTitle}</h3><button type="button" class="close" aria-label="${s.closeAria}" onclick="closeCheckout()">×</button></div>
 <div class="notice">${s.checkoutNotice}</div>
 ${enabledPaymentMethods().some((pm) => pm.id === "cod") ? `<div class="cod-note">${s.codHighlight}</div>` : ""}
 <form onsubmit="submitOrder(event)" novalidate>
  <label for="name">${s.fullName}</label><input id="name" required autocomplete="name" placeholder="${s.fullNamePh}">
  <label for="phone">${s.phone}</label><input id="phone" required type="tel" inputmode="tel" autocomplete="tel" placeholder="${s.phonePh}">

  <label>${s.deliveryLocationTitle}</label>
  <div class="choice-row" id="deliveryLocationPicker" role="group" aria-label="${s.deliveryLocationTitle}">
    <button type="button" class="choice-btn ${deliveryLocation === "home" ? "active" : ""}" aria-pressed="${deliveryLocation === "home"}" onclick="selectDeliveryLocation('home')"><span class="choice-emoji">🏠</span>${s.deliveryHome}</button>
    <button type="button" class="choice-btn ${deliveryLocation === "work" ? "active" : ""}" aria-pressed="${deliveryLocation === "work"}" onclick="selectDeliveryLocation('work')"><span class="choice-emoji">💼</span>${s.deliveryWork}</button>
  </div>

  <label>${s.mealTypeTitle}</label>
  <div class="choice-row" id="mealTypePicker" role="group" aria-label="${s.mealTypeTitle}">
    <button type="button" class="choice-btn ${mealType === "lunch" ? "active" : ""}" aria-pressed="${mealType === "lunch"}" onclick="selectMealType('lunch')"><span class="choice-emoji">🍽️</span>${s.mealTypeLunch}</button>
    <button type="button" class="choice-btn ${mealType === "dinner" ? "active" : ""}" aria-pressed="${mealType === "dinner"}" onclick="selectMealType('dinner')"><span class="choice-emoji">🌙</span>${s.mealTypeDinner}</button>
  </div>

  <label for="address" id="addressLabel">${deliveryLocation === "work" ? s.addressLabelWork : s.addressLabelHome}</label>
  <div style="display:flex;gap:8px;align-items:center">
    <input id="address" required autocomplete="street-address" placeholder="${s.addressPh}" style="flex:1;min-width:0" oninput="document.getElementById('mapLink').value=''">
    <button type="button" id="locBtn" class="location-btn" onclick="useMyLocation()">${s.locateBtn}</button>
  </div>
  <input type="hidden" id="mapLink" value="">
  <div id="locStatus" class="field-note"></div>

  <div class="schedule-box">
    <div class="schedule-title">${s.scheduleTitle}</div>
    <div class="date-grid">
      <div><label for="dateFrom">${s.fromDate}</label><input id="dateFrom" type="date" required onchange="onDateFromChange()"></div>
      <div><label for="dateTo">${s.toDate}</label><input id="dateTo" type="date" required onchange="updateSchedulePreview()"></div>
    </div>
    <div class="time-row">
      <div><label for="deliveryTime">${s.deliveryTime}</label><input id="deliveryTime" type="time" required onchange="updateSchedulePreview()"></div>
    </div>
    <div id="schedulePreview" class="schedule-preview">${s.schedulePreviewDefault}</div>
  </div>

  <div class="schedule-box" style="background:#f0fdf4;border-color:#a7f3d0">
    <div class="schedule-title" style="color:#065f46">${s.paymentMethodLabel}</div>
    <div id="paymentMethodPicker">${paymentMethodBoxHtml()}</div>
  </div>

  <label for="notes">${s.notes}</label><textarea id="notes" rows="2" placeholder="${s.notesPh}"></textarea>
  <div class="summary" id="checkoutSummary">${checkoutSummaryHtml()}</div>
  <button class="checkout" type="submit">${s.confirmOrder}</button>
 </form>`;
  setupScheduleDefaults();
  if (userProfile) {
    if (userProfile.name) document.getElementById("name").value = userProfile.name;
    if (userProfile.phone) document.getElementById("phone").value = userProfile.phone;
    if (userProfile.address) document.getElementById("address").value = userProfile.address;
  }
}
// كيبني تفصيل حساب المجموع فصفحة إتمام الطلب (تكلفة اليوم × عدد الأيام الحقيقي المختار، وخصم الباقة إلا كان)
// باش الزبون يشوف بعينيه كيفاش تحسب نسبة 10%/20% ديال الباقة، ماشي غير رقم نهائي بلا تفصيل
function checkoutSummaryHtml() {
  const s = t(lang);
  const p = PLANS_META.find((x) => x.id === plan);
  const days = actualDays() ?? p.days;
  return `
   <div class="sumrow"><span>${s.dailyCost}</span><b>${money(dailyTotal())}</b></div>
   <div class="sumrow"><span>${s.planDuration}</span><b>× ${days}</b></div>
   ${p.discount ? `<div class="sumrow" style="color:#047857"><span>${s.planDiscount}</span><b>-${p.discount * 100}%</b></div>` : ""}
   <div class="sumrow total"><span>${s.subscriptionTotal}</span><b id="checkoutTotalDisplay">${money(checkoutTotal())}</b></div>`;
}
function closeCheckout() {
  document.getElementById("checkoutModal").classList.remove("show");
}
/* ---------- طريقة الأداء ---------- */
function enabledPaymentMethods() {
  return PAYMENT_METHODS.filter((pm) => (paymentMethodsConfig[pm.id]?.enabled ?? true) !== false);
}
function paymentMethodBoxHtml() {
  const s = t(lang);
  const list = enabledPaymentMethods();
  const selected = PAYMENT_METHODS.find((p) => p.id === paymentMethod);
  const cfg = paymentMethod ? paymentMethodsConfig[paymentMethod] || {} : null;
  return `
   <button type="button" class="pay-toggle" aria-expanded="${paymentPickerOpen}" onclick="togglePaymentPicker()">
     <span>${selected ? paymentIconHtml(selected) + " " + s.paymentMethods[selected.id] : s.choosePaymentMethod}</span>
     <span aria-hidden="true">${paymentPickerOpen ? "▲" : "▼"}</span>
   </button>
   ${
     paymentPickerOpen
       ? `<div class="pay-list">${list
           .map(
             (pm) =>
               `<button type="button" class="pay-item ${paymentMethod === pm.id ? "active" : ""}" aria-pressed="${paymentMethod === pm.id}" onclick="selectPaymentMethod('${pm.id}')">${paymentIconHtml(pm)} ${
                 s.paymentMethods[pm.id]
               }</button>`
           )
           .join("")}</div>`
       : ""
   }
   ${
     cfg && (cfg.rib || cfg.holder || cfg.note)
       ? `<div class="notice pay-info" style="margin-top:10px">
       <b>${s.paymentInstructionsTitle}</b>
       ${
         cfg.rib
           ? `<div class="pay-info-row">
              <div><span>${s.paymentRibLabel}</span><b class="pay-info-value">${escapeHtml(cfg.rib)}</b></div>
              <button type="button" class="copy-btn" data-copy="${escapeAttr(cfg.rib)}" onclick="copyToClipboard(this)">${s.copyBtn}</button>
            </div>`
           : ""
       }
       ${
         cfg.holder
           ? `<div class="pay-info-row">
              <div><span>${s.paymentHolderLabel}</span><b class="pay-info-value">${escapeHtml(cfg.holder)}</b></div>
              <button type="button" class="copy-btn" data-copy="${escapeAttr(cfg.holder)}" onclick="copyToClipboard(this)">${s.copyBtn}</button>
            </div>`
           : ""
       }
       ${cfg.note ? `<div class="pay-info-note">${escapeHtml(cfg.note)}</div>` : ""}
     </div>`
       : ""
   }`;
}
function togglePaymentPicker() {
  paymentPickerOpen = !paymentPickerOpen;
  const el = document.getElementById("paymentMethodPicker");
  if (el) el.innerHTML = paymentMethodBoxHtml();
}
function selectPaymentMethod(id) {
  paymentMethod = id;
  paymentPickerOpen = false;
  const el = document.getElementById("paymentMethodPicker");
  if (el) el.innerHTML = paymentMethodBoxHtml();
}
// اختيار مكان الاستلام (منزل/عمل): كيبدل الزر النشيط وكيبدل تسمية حقل العنوان تبعاً لهاد الاختيار
function selectDeliveryLocation(loc) {
  const s = t(lang);
  deliveryLocation = loc;
  const el = document.getElementById("deliveryLocationPicker");
  if (el) {
    el.querySelectorAll(".choice-btn").forEach((btn, i) => {
      const active = i === 0 ? loc === "home" : loc === "work";
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }
  const label = document.getElementById("addressLabel");
  if (label) label.textContent = loc === "work" ? s.addressLabelWork : s.addressLabelHome;
}
// اختيار نوع الوجبة (غداء/عشاء)
function selectMealType(type) {
  mealType = type;
  const el = document.getElementById("mealTypePicker");
  if (el) {
    el.querySelectorAll(".choice-btn").forEach((btn, i) => {
      const active = i === 0 ? type === "lunch" : type === "dinner";
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }
}
// كيحسب تاريخ النهاية تلقائياً بناءً على مدة الباقة المختارة (يومي = يوم، أسبوعي = 7 أيام، شهري = 30 يوم)
function planEndDate(fromValue) {
  const p = PLANS_META.find((x) => x.id === plan);
  const start = new Date(fromValue + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + (p.days - 1));
  return end.toISOString().slice(0, 10);
}
function setupScheduleDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  const from = document.getElementById("dateFrom"),
    to = document.getElementById("dateTo");
  if (from && to) {
    from.min = today;
    to.min = today;
    if (!from.value) from.value = today;
    // تاريخ النهاية كيتحسب تلقائياً حسب الباقة المختارة (يومي/أسبوعي/شهري) باش المجموع فصفحة إتمام الطلب يبان مباشرة مطابق للي بان فالسلة
    if (!to.value) to.value = planEndDate(from.value);
    to.min = from.value;
    updateSchedulePreview();
  }
}
// كيتنفذ ملي الزبون يبدل تاريخ البداية — كيعاود يحسب تاريخ النهاية تلقائياً حسب مدة الباقة، وكيحدث المجموع فالوقت الحقيقي
function onDateFromChange() {
  const from = document.getElementById("dateFrom"),
    to = document.getElementById("dateTo");
  if (from && from.value) {
    to.min = from.value;
    to.value = planEndDate(from.value);
  }
  updateSchedulePreview();
}
function updateSchedulePreview() {
  const s = t(lang);
  const from = document.getElementById("dateFrom")?.value,
    to = document.getElementById("dateTo")?.value;
  const time = document.getElementById("deliveryTime")?.value;
  const box = document.getElementById("schedulePreview");
  const summaryBox = document.getElementById("checkoutSummary");
  if (summaryBox) summaryBox.innerHTML = checkoutSummaryHtml();
  if (!box) return;
  if (!from || !to || !time) {
    box.textContent = s.schedulePreviewDefault;
    return;
  }
  if (to < from) {
    box.textContent = s.scheduleInvalid;
    return;
  }
  box.innerHTML = s.schedulePreview(formatDate(new Date(from + "T00:00:00")), formatDate(new Date(to + "T00:00:00")), time);
}

function useMyLocation() {
  const s = t(lang);
  const btn = document.getElementById("locBtn");
  const status = document.getElementById("locStatus");
  const field = document.getElementById("address");
  if (!btn || !status || !field) return;

  if (!window.isSecureContext && location.hostname !== "localhost") {
    status.textContent = s.locSecure;
    status.style.color = "#dc2626";
    return;
  }
  if (!navigator.geolocation) {
    status.textContent = s.locUnsupported;
    status.style.color = "#dc2626";
    return;
  }

  btn.disabled = true;
  btn.textContent = s.locWaiting;
  status.style.color = "#064e3b";
  status.textContent = s.locPermissionNote;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const mapLinkField = document.getElementById("mapLink");
      if (mapLinkField) mapLinkField.value = `https://www.google.com/maps?q=${latitude},${longitude}`;
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&accept-language=${lang}&zoom=18`
        );
        const data = await res.json();
        field.value = data.display_name || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        status.style.color = "#047857";
        status.textContent = s.locSuccess;
      } catch (e) {
        field.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        status.style.color = "#047857";
        status.textContent = s.locSuccessCoords;
      }
      btn.disabled = false;
      btn.textContent = s.locRefresh;
    },
    (err) => {
      btn.disabled = false;
      btn.textContent = s.locRetry;
      status.style.color = "#dc2626";
      if (err.code === 1) status.textContent = s.locDenied;
      else if (err.code === 3) status.textContent = s.locTimeout;
      else status.textContent = s.locFailed;
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 }
  );
}

async function submitOrder(e) {
  e.preventDefault();
  const s = t(lang);
  // الطلب كيتطلب حساب مسجل (قواعد Firestore كتفرض هادشي): إلا سالات الجلسة والنموذج مازال مفتوح، نرجعو الزبون لتسجيل الدخول والسلة كتبقى محفوظة
  if (!currentUser) {
    pendingCheckoutAfterLogin = true;
    closeCheckout();
    openAccount();
    return;
  }
  const phone = normalizePhone(document.getElementById("phone").value);
  if (!document.getElementById("name").value.trim()) {
    toast(s.fullName + " ✗", "error");
    document.getElementById("name").focus();
    return;
  }
  if (!PHONE_RE.test(phone)) {
    toast(s.phoneInvalid, "error");
    document.getElementById("phone").focus();
    return;
  }
  if (!document.getElementById("address").value.trim()) {
    toast(s.address + " ✗", "error");
    document.getElementById("address").focus();
    return;
  }
  if (!deliveryLocation) {
    toast(s.deliveryLocationRequired, "error");
    return;
  }
  if (!mealType) {
    toast(s.mealTypeRequired, "error");
    return;
  }
  const dateFrom = document.getElementById("dateFrom").value;
  const dateTo = document.getElementById("dateTo").value;
  const deliveryTime = document.getElementById("deliveryTime").value;
  if (!dateFrom || !dateTo || !deliveryTime) {
    toast(s.scheduleMissing, "error");
    return;
  }
  if (dateTo < dateFrom) {
    toast(s.scheduleDateOrder, "error");
    return;
  }
  if (!paymentMethod) {
    toast(s.paymentMethodRequired, "error");
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = s.sendingOrder;
  }

  const durationDays = actualDays() || 1;
  const name = document.getElementById("name").value.trim();
  const address = document.getElementById("address").value.trim();
  const mapLink = document.getElementById("mapLink")?.value || "";

  const order = {
    uid: currentUser ? currentUser.uid : null,
    customer: {
      name,
      phone,
      address,
      mapLink,
      notes: document.getElementById("notes").value.trim(),
    },
    schedule: { dateFrom, dateTo, deliveryTime },
    plan,
    durationDays,
    paymentMethod,
    paymentMethodLabel: s.paymentMethods[paymentMethod] || paymentMethod,
    deliveryLocation,
    mealType,
    lang,
    items: cartItems().map((x) => ({ mealId: x.id, qty: x.qty })),
  };

  try {
    const callableResult = await createOrderCallable(order);
    const result = callableResult.data || {};
    const orderId = result.orderId;
    const confirmedTotal = Number(result.total || 0);
    // نحفظو معلومات الزبون (الاسم والعنوان) فحسابو باش تتعبى تلقائياً فالمرة الجاية
    if (currentUser) {
      try {
        await setDoc(doc(db, "users", currentUser.uid), { name, address, phone }, { merge: true });
        userProfile = { ...userProfile, name, address, phone };
      } catch (e) {
        /* ما توقفش الطلب إلا فشل حفظ الملف الشخصي */
      }
    }
    cart = {};
    render();
    // حالة تأكيد الطلب فنفس النافذة (ما كتتمسحش ملي كيتحدثو الأطباق)
    const box = document.getElementById("checkoutContent");
    box.innerHTML = `
     <div class="confirm-box" role="status">
       <div class="confirm-check" aria-hidden="true">✓</div>
       <h2>${s.orderSuccessTitle}</h2>
       <p>${s.orderRefLabel}</p>
       <div class="confirm-ref">${orderCode(orderId)}</div>
       <button type="button" class="copy-link-btn" data-copy="${escapeAttr(orderCode(orderId))}" onclick="copyOrderNumber(this)" style="border:0;background:#f0fdf4;color:#047857;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:800;cursor:pointer;margin:2px 0 10px">${s.copyOrderNumber}</button>
       <p>${s.orderWillContact(escapeHtml(phone))}</p>
       <p style="font-weight:800">${money(confirmedTotal)}</p>
       <button type="button" class="checkout" onclick="closeCheckout();scrollToMenu()">${s.newOrderBtn}</button>
     </div>`;
    box.scrollTop = 0;
  } catch (err) {
    toast(s.orderError, "error");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = s.confirmOrder;
    }
  }
}

/* ---------- نظام الحساب: تسجيل الدخول / التسجيل / الملف الشخصي ---------- */
/* ═══════ نظام النقاط والولاء ═══════ */
function tierFor(lifetimePoints) {
  return TIERS.find((tr) => lifetimePoints >= tr.min && lifetimePoints <= tr.max) || TIERS[0];
}
function tierLabel(tierId, s) {
  return { bronze: s.tierBronze, silver: s.tierSilver, gold: s.tierGold, vip: s.tierVip }[tierId] || s.tierBronze;
}

async function awardPoints() {
  // النقاط الحساسة تُسجّل حصريًا داخل Cloud Functions.
}

// كود الدعوة → uid ديال صاحبو. كنقراو وثيقة referralCodes/{CODE} بالاسم (ماشي استعلام على users، حيت users مقفلة على الزبناء)
async function lookupReferrerUid(code, ownUid) {
  const clean = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(clean)) return null;
  try {
    const snap = await getDoc(doc(db, "referralCodes", clean));
    const refUid = snap.exists() ? snap.data().uid : null;
    return refUid && refUid !== ownUid ? refUid : null;
  } catch (e) {
    return null;
  }
}
// كيسجل كود الدعوة ديال الزبون (referralCodes/{CODE} = { uid }) إلا ماكانش مسجل — مرة وحدة، وما كيوقف حتى شي عملية إلا فشل
async function ensureReferralCodeDoc(uid, code) {
  if (!uid || !/^[A-Z0-9]{6}$/.test(code || "")) return;
  try {
    const ref = doc(db, "referralCodes", code);
    const snap = await getDoc(ref);
    if (!snap.exists()) await setDoc(ref, { uid });
  } catch (e) {
    /* غير أساسي */
  }
}

async function fetchPointsSummary(uid) {
  // الرصيد الحقيقي = مجموع كل عمليات النقط ديال الزبون (كنحسبوه هنا، ماشي رقم مخزن قابل للتلاعب)
  let entries = [];
  try {
    const q = query(collection(db, "pointsLog"), where("uid", "==", uid));
    const snap = await getDocs(q);
    entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    entries = [];
  }
  entries.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  let balance = 0,
    lifetime = 0;
  entries.forEach((en) => {
    const p = Number(en.points) || 0;
    balance += p;
    if (p > 0) lifetime += p;
  });
  return { balance, lifetime, entries };
}

async function awardOrderPoints() {
  // يتم احتساب النقاط آمنًا داخل Cloud Function createOrder.
}

/* ---------- صفحة "مكافآتي" ---------- */
async function openRewards() {
  if (!currentUser) {
    pendingCheckoutAfterLogin = false;
    openAccount();
    return;
  }
  document.getElementById("accountModal").classList.remove("show");
  document.getElementById("rewardsModal").classList.add("show");
  document.getElementById("rewardsContent").innerHTML = `<div class="empty">⏳...</div>`;
  await renderRewardsPage();
}
function closeRewards() {
  document.getElementById("rewardsModal").classList.remove("show");
}

/* ═══════ طلباتي: لائحة الطلبات السابقة + رقم الطلب القابل للنسخ + التفاصيل ═══════ */
// خريطة القيمة الفعلية المخزنة فـ Firestore (status) إلى مفتاح ثابت للترجمة/الألوان
const ORDER_STATUS_KEYS = {
  "قيد المراجعة": "pending",
  "تم قبول الطلب": "accepted",
  "قيد التحضير": "preparing",
  "خرج للتوصيل": "outForDelivery",
  "تم التسليم": "delivered",
  ملغي: "cancelled",
};
function orderStatusKey(status) {
  return ORDER_STATUS_KEYS[status] || "pending";
}
function orderStatusBadge(status, s) {
  const key = orderStatusKey(status);
  return `<span class="status-badge status-${key}">${s.orderStatus[key]}</span>`;
}
async function openMyOrders() {
  if (!currentUser) {
    openAccount();
    return;
  }
  const s = t(lang);
  document.getElementById("accountModal").classList.remove("show");
  document.getElementById("myOrdersModal").classList.add("show");
  document.getElementById("myOrdersContent").innerHTML = `<div class="modal-head"><h3>${s.myOrdersTitle}</h3><button class="close" onclick="closeMyOrders()">×</button></div><div class="empty" style="padding:30px">…</div>`;
  await renderMyOrdersList();
}
function closeMyOrders() {
  document.getElementById("myOrdersModal").classList.remove("show");
}
// كاش بسيط فالذاكرة لطلبات الزبون الحالية (باش زر "التفاصيل" ما يعاودش يقرا Firestore)
let myOrdersCache = [];
async function renderMyOrdersList() {
  const s = t(lang);
  const uid = currentUser.uid;
  try {
    const snap = await getDocs(query(collection(db, "orders"), where("uid", "==", uid)));
    myOrdersCache = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  } catch (e) {
    document.getElementById("myOrdersContent").innerHTML = `<div class="modal-head"><h3>${s.myOrdersTitle}</h3><button class="close" onclick="closeMyOrders()">×</button></div><div class="empty" style="padding:30px">${s.orderError}</div>`;
    return;
  }
  const cardsHtml = myOrdersCache.length
    ? myOrdersCache
        .map(
          (o) => `
      <div class="order-card">
        <div class="order-card-top">
          <span class="order-code">${orderCode(o.id)}</span>
          ${orderStatusBadge(o.status, s)}
        </div>
        <div class="order-card-meta">${formatDate(o.schedule?.dateFrom || "")} · ${money(o.total)}</div>
        <div class="order-card-actions">
          <button type="button" class="copy-link-btn" data-copy="${escapeAttr(orderCode(o.id))}" onclick="copyOrderNumber(this)" style="border:0;background:#f0fdf4;color:#047857;border-radius:10px;padding:6px 12px;font-size:12px;font-weight:800;cursor:pointer">${s.copyOrderNumber}</button>
          <button type="button" class="btn-outline-sm" onclick="openOrderDetail('${o.id}')">${s.orderDetailsBtn}</button>
        </div>
      </div>`
        )
        .join("")
    : `<div class="empty" style="padding:30px">${s.noOrdersYet}</div>`;
  document.getElementById("myOrdersContent").innerHTML = `
    <div class="modal-head"><h3>${s.myOrdersTitle}</h3><button class="close" onclick="closeMyOrders()">×</button></div>
    ${cardsHtml}`;
}
function openOrderDetail(id) {
  const s = t(lang);
  const o = myOrdersCache.find((x) => x.id === id);
  if (!o) return;
  const itemsHtml = (o.items || [])
    .map(
      (it) =>
        `<div class="order-detail-row"><span>${escapeHtml(it.name)} ×${escapeHtml(it.qty)}</span><b>${money((it.price || 0) * (it.qty || 0))}</b></div>`
    )
    .join("");
  const locLabel = o.deliveryLocation === "work" ? s.deliveryWork : o.deliveryLocation === "home" ? s.deliveryHome : s.notSpecified;
  const mealLabel = o.mealType === "lunch" ? s.mealTypeLunch : o.mealType === "dinner" ? s.mealTypeDinner : s.notSpecified;
  document.getElementById("myOrdersContent").innerHTML = `
    <div class="modal-head"><h3>${orderCode(o.id)}</h3><button class="close" onclick="closeMyOrders()">×</button></div>
    <button type="button" class="link-btn" style="margin-bottom:10px" onclick="renderMyOrdersList()">${s.backToOrders}</button>
    <div class="order-detail-section">
      <div class="order-detail-row"><span>${s.orderStatusLabel}</span>${orderStatusBadge(o.status, s)}</div>
      <div class="order-detail-row"><span>${s.orderDateLabel}</span><b>${formatDate(o.schedule?.dateFrom || "")}</b></div>
      <button type="button" class="copy-link-btn" data-copy="${escapeAttr(orderCode(o.id))}" onclick="copyOrderNumber(this)" style="margin-top:6px;border:0;background:#f0fdf4;color:#047857;border-radius:10px;padding:6px 12px;font-size:12px;font-weight:800;cursor:pointer">${s.copyOrderNumber}</button>
    </div>
    <div class="order-detail-section">
      <h4>📍 ${s.deliveryLocationTitle}</h4>
      <div class="order-detail-row"><span>${locLabel}</span></div>
      <div class="order-detail-row"><span>${s.orderAddressLabel}</span><span>${escapeHtml(o.customer?.address || s.notSpecified)}</span></div>
    </div>
    <div class="order-detail-section">
      <h4>🍽️ ${s.mealTypeTitle}</h4>
      <div class="order-detail-row"><span>${mealLabel}</span></div>
    </div>
    <div class="order-detail-section">
      <h4>🛒 ${s.orderItemsLabel}</h4>
      ${itemsHtml}
    </div>
    <div class="order-detail-section">
      <div class="order-detail-row"><span>${s.orderPaymentLabel}</span><span>${escapeHtml(o.paymentMethodLabel || s.notSpecified)}</span></div>
      <div class="order-detail-row"><span>${s.orderTotalLabel}</span><b>${money(o.total)}</b></div>
    </div>
    ${
      o.customer?.notes
        ? `<div class="order-detail-section"><h4>📝 ${s.orderNotesLabel}</h4><div class="order-detail-row"><span>${escapeHtml(o.customer.notes)}</span></div></div>`
        : ""
    }
  `;
}

async function renderRewardsPage() {
  const s = t(lang);
  const uid = currentUser.uid;
  ensureReferralCodeDoc(uid, userProfile?.referralCode); // باش رابط الدعوة يخدم (كيتسجل مرة وحدة)

  const [{ balance, lifetime, entries }, rewardsSnap, ordersSnap] = await Promise.all([
    fetchPointsSummary(uid),
    getDocs(query(collection(db, "rewards"), where("active", "==", true))).catch(() => ({ docs: [] })),
    getDocs(query(collection(db, "orders"), where("uid", "==", uid))).catch(() => ({ docs: [] })),
  ]);

  const rewards = rewardsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.pointsCost - b.pointsCost);
  const orders = ordersSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  const tier = tierFor(lifetime);
  const nextReward = rewards.find((r) => r.pointsCost > balance);
  const cheapestCost = rewards.length ? rewards[0].pointsCost : null;
  const progressTarget = nextReward ? nextReward.pointsCost : cheapestCost;
  const progressPct = progressTarget ? Math.max(0, Math.min(100, Math.round((balance / progressTarget) * 100))) : 100;

  const referralLink = `${window.location.origin}${window.location.pathname}?ref=${userProfile?.referralCode || ""}`;

  const rewardsHtml = rewards.length
    ? rewards
        .map(
          (r) => `<div class="reward-card">
      <div class="reward-name">${escapeHtml(r.name)}</div>
      ${r.description ? `<div class="reward-desc">${escapeHtml(r.description)}</div>` : ""}
      <div class="reward-bottom">
        <span class="reward-cost">${r.pointsCost} ${s.pointsLabel}</span>
        <button class="add" ${balance < r.pointsCost ? "disabled style='opacity:.4;cursor:not-allowed'" : ""} onclick="redeemReward('${r.id}')">${s.redeemBtn}</button>
      </div>
    </div>`
        )
        .join("")
    : "";

  const historyHtml = entries.length
    ? entries
        .slice(0, 20)
        .map(
          (en) =>
            `<div class="history-row"><span>${escapeHtml(en.reason || "")}</span><b style="color:${
              en.points >= 0 ? "#047857" : "#dc2626"
            }">${en.points >= 0 ? "+" : ""}${en.points}</b></div>`
        )
        .join("")
    : `<div class="empty" style="padding:20px">${s.noPointsHistory}</div>`;

  const unratedOrders = orders.filter((o) => !o.reviewed).slice(0, 5);
  const ordersHtml = unratedOrders.length
    ? unratedOrders
        .map(
          (o) =>
            `<div class="history-row"><span>${formatDate(o.schedule?.dateFrom || o.createdAt)} — ${money(o.total)}</span><button class="link-btn" onclick="openRateOrder('${
              o.id
            }')">${s.rateOrder}</button></div>`
        )
        .join("")
    : orders.length
    ? ""
    : `<div class="empty" style="padding:20px">${s.noOrdersYet}</div>`;

  document.getElementById("rewardsContent").innerHTML = `
   <div class="modal-head"><h3>${s.rewardsTitle}</h3><button class="close" onclick="closeRewards()">×</button></div>
   <div class="points-hero">
     <div class="points-balance">${balance} <small>${s.pointsLabel}</small></div>
     <div class="points-tier">${tierLabel(tier.id, s)}</div>
   </div>
   <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${progressPct}%"></div></div>
   <p style="text-align:center;font-size:13px;color:#57534e;margin:8px 0 20px">
     ${nextReward ? s.progressToNext(nextReward.pointsCost - balance, escapeHtml(nextReward.name)) : rewards.length ? s.allRewardsUnlocked : ""}
   </p>

   ${rewards.length ? `<h4 style="margin:16px 0 10px;color:var(--primary)">${s.availableRewards}</h4><div class="rewards-grid">${rewardsHtml}</div>` : ""}

   <div class="referral-box">
     <div style="font-weight:900;margin-bottom:4px">${s.inviteFriend}</div>
     <div style="font-size:12px;opacity:.85;margin-bottom:10px">${s.inviteFriendDesc}</div>
     <button type="button" class="location-btn" style="width:100%;justify-content:center" onclick="copyReferralLink('${referralLink}')">${s.copyReferralLink}</button>
   </div>

   ${
     unratedOrders.length
       ? `<h4 style="margin:20px 0 10px;color:var(--primary)">${s.myOrdersToRate}</h4><div class="history-list">${ordersHtml}</div>`
       : ""
   }

   <h4 style="margin:20px 0 10px;color:var(--primary)">${s.pointsHistory}</h4>
   <div class="history-list">${historyHtml}</div>
  `;
}

function copyReferralLink(link) {
  const s = t(lang);
  navigator.clipboard
    .writeText(link)
    .then(() => toast(s.copied))
    .catch(() => toast(link));
}

async function redeemReward(rewardId) {
  const s = t(lang);
  try {
    const result = await redeemRewardCallable({ rewardId });
    const code = result.data?.code;
    document.getElementById("rewardsContent").innerHTML = `
      <div class="modal-head"><h3>${s.redeemSuccessTitle}</h3><button class="close" onclick="closeRewards()">×</button></div>
      <div class="notice" style="text-align:center">
        <div style="font-size:15px;margin-bottom:10px">${s.redeemCodeNote}</div>
        <div style="font-size:26px;font-weight:900;letter-spacing:3px;color:var(--primary)">${escapeHtml(code)}</div>
      </div>
      <button class="checkout" style="margin-top:16px" onclick="closeRewards()">${s.closeRedeem}</button>`;
    await renderRewardsPage();
  } catch (e) {
    toast(s.notEnoughPoints, "error");
  }
}

/* ---------- تقييم الطلب ---------- */
let ratingValue = 5;
function openRateOrder(orderId) {
  const s = t(lang);
  document.getElementById("rewardsModal").classList.remove("show");
  document.getElementById("rateModal").classList.add("show");
  ratingValue = 5;
  document.getElementById("rateContent").innerHTML = `
   <div class="modal-head"><h3>${s.rateModalTitle}</h3><button class="close" onclick="closeRateOrder()">×</button></div>
   <div id="starsRow" style="text-align:center;margin:16px 0"></div>
   <textarea id="rateComment" rows="2" placeholder="..."></textarea>
   <button class="checkout" style="margin-top:14px" onclick="submitRating('${orderId}')">${s.rateSubmit}</button>`;
  renderStars();
}
function renderStars() {
  const row = document.getElementById("starsRow");
  if (!row) return;
  row.innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" aria-label="${n}/5" aria-pressed="${n === ratingValue}" style="border:0;background:none;padding:0 3px;min-width:var(--tap);min-height:var(--tap);font-size:34px;line-height:1;cursor:pointer;color:${n <= ratingValue ? "var(--accent)" : "var(--border)"}" onclick="setRating(${n})">★</button>`)
    .join("");
}
function setRating(n) {
  ratingValue = n;
  renderStars();
}
function closeRateOrder() {
  document.getElementById("rateModal").classList.remove("show");
}
async function submitRating(orderId) {
  const s = t(lang);
  const comment = document.getElementById("rateComment").value.trim();
  try {
    await submitReviewCallable({ orderId, rating: ratingValue, comment });
    document.getElementById("rateContent").innerHTML = `<div class="notice" style="text-align:center;font-size:16px">${s.rateThanks}</div>
     <button class="checkout" style="margin-top:14px" onclick="closeRateOrder()">${s.closeRedeem}</button>`;
  } catch (e) {
    toast(s.orderError, "error");
  }
}



/* ═══════ الدردشة مع الدعم ═══════ */
// كيقبل غير تصويرة data:image/... base64 صحيحة، وأي شي آخر ما كيتحقنش فـ HTML
function safeChatImageHtml(v) {
  const src = String(v ?? "");
  if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src)) return `<div class="chat-text">📷</div>`;
  return `<img src="${escapeAttr(src)}" class="chat-image" onclick="window.open(this.src, '_blank')">`;
}
function renderChatMessages(messages) {
  const s = t(lang);
  const box = document.getElementById("chatMessages");
  if (!box) return;
  box.innerHTML = messages.length
    ? messages
        .map(
          (m) =>
            `<div class="chat-bubble ${m.senderRole === "customer" ? "chat-mine" : "chat-theirs"}">${
              m.imageData
                ? safeChatImageHtml(m.imageData)
                : `<div class="chat-text">${escapeHtml(m.text)}</div>`
            }</div>`
        )
        .join("")
    : `<div class="empty" style="padding:30px 10px">${s.supportEmpty}</div>`;
  box.scrollTop = box.scrollHeight;
}

function openSupport() {
  if (!currentUser) {
    pendingSupportAfterLogin = true;
    openAccount();
    return;
  }
  const s = t(lang);
  document.getElementById("supportModal").classList.add("show");
  document.getElementById("supportContent").innerHTML = `
   <div class="modal-head"><h3>${s.supportTitle}</h3><button class="close" onclick="closeSupport()">×</button></div>
   <div id="chatMessages" class="chat-box"></div>
   <div id="supportImageStatus" style="font-size:12px;color:#78716c;margin-top:6px"></div>
   <form id="supportForm" style="display:flex;gap:8px;margin-top:10px" onsubmit="sendSupportMessage(event)">
    <button type="button" class="chat-photo-btn" onclick="document.getElementById('supportImageInput').click()" title="${s.supportSendImage}">📷</button>
    <input type="file" id="supportImageInput" accept="image/*" style="display:none" onchange="handleSupportImageSelected(event)">
    <input id="supportInput" placeholder="${s.supportPlaceholder}" style="flex:1" required autocomplete="off">
    <button class="add" type="submit">${s.supportSend}</button>
   </form>`;
  if (chatUnsubscribe) chatUnsubscribe();
  const uid = currentUser.uid;
  const q = query(collection(db, "messages"), where("threadId", "==", uid));
  chatUnsubscribe = onSnapshot(q, (snap) => {
    const messages = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    renderChatMessages(messages);
    messages
      .filter((m) => m.senderRole === "admin" && !m.readByCustomer)
      .forEach((m) => updateDoc(doc(db, "messages", m.id), { readByCustomer: true }).catch(() => {}));
  });
}
function closeSupport() {
  document.getElementById("supportModal").classList.remove("show");
  if (chatUnsubscribe) {
    chatUnsubscribe();
    chatUnsubscribe = null;
  }
}
async function sendSupportMessage(e) {
  e.preventDefault();
  const input = document.getElementById("supportInput");
  const text = input.value.trim();
  if (!text || !currentUser) return;
  input.value = "";
  try {
    await addDoc(collection(db, "messages"), {
      threadId: currentUser.uid,
      senderUid: currentUser.uid,
      senderRole: "customer",
      text,
      readByCustomer: true,
      readByAdmin: false,
      createdAt: serverTimestamp(),
    });
  } catch (e2) {
    input.value = text; // نرجعو النص للحقل إلا فشل الإرسال
  }
}
// كيضغط الصورة (تصغير الأبعاد + JPEG) قبل ما يصيفطها، حيت ما كاينش Firebase Storage فهاد المشروع
// والرسائل كتخزن مباشرة فـ Firestore، فخاصنا الحجم يبقى صغير
function compressImageFile(file, maxDim = 1000, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode-failed"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function handleSupportImageSelected(event) {
  const s = t(lang);
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !currentUser) return;
  const statusBox = document.getElementById("supportImageStatus");
  if (statusBox) statusBox.textContent = s.supportImageSending;
  try {
    let dataUrl = await compressImageFile(file, 1000, 0.7);
    // إلا بقات الصورة كبيرة، نعاودو نضغطوها بجودة أقل
    if (dataUrl.length > 900000) dataUrl = await compressImageFile(file, 700, 0.5);
    if (dataUrl.length > 900000) {
      if (statusBox) statusBox.textContent = s.supportImageTooBig;
      return;
    }
    await addDoc(collection(db, "messages"), {
      threadId: currentUser.uid,
      senderUid: currentUser.uid,
      senderRole: "customer",
      text: "",
      imageData: dataUrl,
      readByCustomer: true,
      readByAdmin: false,
      createdAt: serverTimestamp(),
    });
    if (statusBox) statusBox.textContent = "";
  } catch (e) {
    if (statusBox) statusBox.textContent = s.supportImageFailed;
  }
}

// كتحدث نقطة التنبيه فزر ☰ وفعنصر "الدعم" داخل القائمة الجانبية على حساب hasUnreadSupport
function syncSupportBadgeUI() {
  const menuDot = document.getElementById("menuDot");
  if (menuDot) menuDot.style.display = hasUnreadSupport ? "block" : "none";
  const sideBadge = document.getElementById("sideSupportBadge");
  if (sideBadge) sideBadge.style.display = hasUnreadSupport ? "block" : "none";
}
let lastSeenUnreadIds = new Set();
let unreadWatchInitialized = false;
function watchUnreadMessages(uid) {
  if (unreadUnsubscribe) unreadUnsubscribe();
  lastSeenUnreadIds = new Set();
  unreadWatchInitialized = false;
  const q = query(collection(db, "messages"), where("threadId", "==", uid));
  unreadUnsubscribe = onSnapshot(q, (snap) => {
    const unreadIds = new Set();
    snap.docs.forEach((d) => {
      const m = d.data();
      if (m.senderRole === "admin" && !m.readByCustomer) unreadIds.add(d.id);
    });
    // نبينو الصوت/التنبيه غير على رسالة جديدة فعلاً (ماشي أول تحميل، وماشي ونافذة الدعم محلولة)
    if (unreadWatchInitialized) {
      const hasNew = [...unreadIds].some((id) => !lastSeenUnreadIds.has(id));
      if (hasNew) {
        playNotifySound();
        const supportOpen = document.getElementById("supportModal")?.classList.contains("show");
        if (!supportOpen) toast(t(lang).newSupportMessageToast);
      }
    }
    lastSeenUnreadIds = unreadIds;
    unreadWatchInitialized = true;
    hasUnreadSupport = unreadIds.size > 0;
    syncSupportBadgeUI();
  });
}
function stopWatchingUnreadMessages() {
  if (unreadUnsubscribe) {
    unreadUnsubscribe();
    unreadUnsubscribe = null;
  }
  // الإصلاح: بلا هاد السطر كانت نقطة التنبيه كتبقى بادية بعد تسجيل الخروج
  // حتى ولو ماكاينش رسائل غير مقروءة للمستخدم الجديد
  hasUnreadSupport = false;
  lastSeenUnreadIds = new Set();
  unreadWatchInitialized = false;
  syncSupportBadgeUI();
}

function openAccount() {
  document.getElementById("accountModal").classList.add("show");
  if (currentUser && profileIncomplete) renderCompleteProfile();
  else if (currentUser) renderAccountProfile();
  else {
    authTab = "login";
    renderAccountAuth();
  }
}
function closeAccount() {
  document.getElementById("accountModal").classList.remove("show");
  pendingCheckoutAfterLogin = false;
}
function switchAuthTab(tabName) {
  authTab = tabName;
  renderAccountAuth();
}
function selectSignupGender(g) {
  signupGender = g;
  const male = document.getElementById("genderMaleOpt");
  const female = document.getElementById("genderFemaleOpt");
  if (male && female) {
    male.classList.toggle("active", g === "male");
    female.classList.toggle("active", g === "female");
  }
}

// أزرار المتابعة عبر Google / Apple — كتبان تحت نموذج الدخول والتسجيل بجوج
function socialLoginHtml(s) {
  return `
   <div class="social-divider"><span>${s.orContinueWith}</span></div>
   <button type="button" class="social-btn google-btn" onclick="signInWithGoogle()">
     <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
       <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
       <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
       <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
       <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
     </svg>
     <span>${s.continueWithGoogle}</span>
   </button>
   <button type="button" class="social-btn apple-btn" onclick="signInWithApple()">
     <svg width="16" height="16" viewBox="0 0 384 512" fill="currentColor" aria-hidden="true">
       <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/>
     </svg>
     <span>${s.continueWithApple}</span>
   </button>`;
}

function renderAccountAuth() {
  const s = t(lang);
  const notice = pendingCheckoutAfterLogin ? `<div class="notice" style="background:#fffbeb;border-color:#fde68a;color:#92400e">${s.loginRequiredNotice}</div>` : "";
  const el = document.getElementById("accountContent");
  if (authTab === "login") {
    el.innerHTML = `
     <div class="modal-head"><h3>${s.loginTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
     ${notice}
     <div class="auth-tabs">
       <button type="button" class="auth-tab active">${s.loginTab}</button>
       <button type="button" class="auth-tab" onclick="switchAuthTab('signup')">${s.signupTab}</button>
     </div>
     <form onsubmit="submitLogin(event)">
       <label>${s.phone}</label><input id="loginPhone" required type="tel" inputmode="tel" placeholder="${s.phonePh}">
       <label>${s.passwordLabel}</label><input id="loginPassword" required type="password" placeholder="${s.passwordPh}">
       <p id="authError" style="color:#dc2626;font-size:12px;margin:6px 0 0"></p>
       <button class="checkout" type="submit" style="width:100%;margin-top:14px">${s.loginBtn}</button>
     </form>
     ${socialLoginHtml(s)}`;
  } else {
    el.innerHTML = `
     <div class="modal-head"><h3>${s.signupTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
     ${notice}
     <div class="auth-tabs">
       <button type="button" class="auth-tab" onclick="switchAuthTab('login')">${s.loginTab}</button>
       <button type="button" class="auth-tab active">${s.signupTab}</button>
     </div>
     <form onsubmit="submitSignup(event)">
       <label>${s.phone}</label><input id="signupPhone" required type="tel" inputmode="tel" placeholder="${s.phonePh}">
       <label>${s.genderLabel}</label>
       <div class="gender-row">
         <div class="gender-opt active" id="genderMaleOpt" onclick="selectSignupGender('male')">${s.genderMale}</div>
         <div class="gender-opt" id="genderFemaleOpt" onclick="selectSignupGender('female')">${s.genderFemale}</div>
       </div>
       <label>${s.passwordLabel}</label><input id="signupPassword" required type="password" placeholder="${s.passwordPh}">
       <label>${s.confirmPassword}</label><input id="signupPassword2" required type="password" placeholder="${s.passwordPh}">
       <p id="authError" style="color:#dc2626;font-size:12px;margin:6px 0 0"></p>
       <button class="checkout" type="submit" style="width:100%;margin-top:14px">${s.signupBtn}</button>
     </form>
     ${socialLoginHtml(s)}`;
  }
  signupGender = "male";
}

// تسجيل الدخول عبر Google/Apple — نافذة منبثقة، وonAuthStateChanged كيدير الباقي (بما فيه فتح نموذج إكمال الملف الشخصي إلا كان الحساب جديد)
async function signInWithGoogle() {
  const s = t(lang);
  const errEl = document.getElementById("authError");
  try {
    await authReady;
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (err?.code !== "auth/popup-closed-by-user" && errEl) errEl.textContent = s.socialLoginError;
  }
}
async function signInWithApple() {
  const s = t(lang);
  const errEl = document.getElementById("authError");
  try {
    await authReady;
    await signInWithPopup(auth, appleProvider);
  } catch (err) {
    if (err?.code !== "auth/popup-closed-by-user" && errEl) errEl.textContent = s.socialLoginError;
  }
}

// نموذج إكمال الملف الشخصي — كيبان مرة وحدة بعد أول تسجيل دخول عبر Google/Apple باش الزبون يعطي رقم الهاتف والجنس
function renderCompleteProfile() {
  const s = t(lang);
  const el = document.getElementById("accountContent");
  el.innerHTML = `
   <div class="modal-head"><h3>${s.completeProfileTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
   <div class="notice">${s.completeProfileDesc}</div>
   <form onsubmit="submitCompleteProfile(event)">
     <label>${s.phone}</label><input id="completePhone" required type="tel" inputmode="tel" placeholder="${s.phonePh}">
     <label>${s.genderLabel}</label>
     <div class="gender-row">
       <div class="gender-opt active" id="genderMaleOpt" onclick="selectSignupGender('male')">${s.genderMale}</div>
       <div class="gender-opt" id="genderFemaleOpt" onclick="selectSignupGender('female')">${s.genderFemale}</div>
     </div>
     <p id="authError" style="color:#dc2626;font-size:12px;margin:6px 0 0"></p>
     <button class="checkout" type="submit" style="width:100%;margin-top:14px">${s.completeProfileBtn}</button>
   </form>
   <button type="button" class="link-btn" style="width:100%;margin-top:12px" onclick="logoutAccount()">${s.logoutBtn}</button>`;
  signupGender = "male";
}

async function submitCompleteProfile(e) {
  e.preventDefault();
  const s = t(lang);
  const errEl = document.getElementById("authError");
  const phone = normalizePhone(document.getElementById("completePhone").value);
  if (!PHONE_RE.test(phone)) {
    errEl.textContent = s.authPhoneInvalid;
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = s.signingUp;
  try {
    const referredByUid = await lookupReferrerUid(incomingReferralCode, currentUser.uid);
    const profileData = {
      phone,
      gender: signupGender,
      avatar: avatarFor(signupGender),
      referralCode: currentUser.uid.slice(0, 6).toUpperCase(),
      referredByUid,
      referralBonusGiven: false,
      orderCount: 0,
      ordersThisMonth: 0,
      lastOrderMonthKey: "",
      orderMilestone3Given: false,
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, "users", currentUser.uid), profileData);
    ensureReferralCodeDoc(currentUser.uid, profileData.referralCode); // بلا await باش التسجيل ما يتعطلش
    userProfile = { ...profileData, createdAt: new Date().toISOString() };
    profileIncomplete = false;
    updateAccountButton();
    document.getElementById("accountModal").classList.remove("show");
    if (pendingCheckoutAfterLogin) {
      pendingCheckoutAfterLogin = false;
      openCheckout();
    }
    if (pendingSupportAfterLogin) {
      pendingSupportAfterLogin = false;
      openSupport();
    }
  } catch (err) {
    errEl.textContent = s.signupError;
    btn.disabled = false;
    btn.textContent = s.completeProfileBtn;
  }
}

async function submitLogin(e) {
  e.preventDefault();
  const s = t(lang);
  const errEl = document.getElementById("authError");
  const phone = normalizePhone(document.getElementById("loginPhone").value);
  const password = document.getElementById("loginPassword").value;
  if (!PHONE_RE.test(phone)) {
    errEl.textContent = s.authPhoneInvalid;
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = s.loggingIn;
  try {
    await authReady;
    await signInWithEmailAndPassword(auth, phoneToEmail(phone), password);
    // onAuthStateChanged غادي يدير الباقي (تحميل الملف الشخصي وإغلاق المودال)
  } catch (err) {
    errEl.textContent = s.loginError;
    btn.disabled = false;
    btn.textContent = s.loginBtn;
  }
}

async function submitSignup(e) {
  e.preventDefault();
  const s = t(lang);
  const errEl = document.getElementById("authError");
  const phone = normalizePhone(document.getElementById("signupPhone").value);
  const password = document.getElementById("signupPassword").value;
  const password2 = document.getElementById("signupPassword2").value;
  if (!PHONE_RE.test(phone)) {
    errEl.textContent = s.authPhoneInvalid;
    return;
  }
  if (password.length < 8) {
    errEl.textContent = s.authPasswordShort;
    return;
  }
  if (password !== password2) {
    errEl.textContent = s.authPasswordMismatch;
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = s.signingUp;
  try {
    await authReady;
    const cred = await createUserWithEmailAndPassword(auth, phoneToEmail(phone), password);

    // إلا جا الزبون من رابط دعوة (?ref=CODE)، كنقلبو على صاحب هاد الكود باش نربطو بيه
    const referredByUid = await lookupReferrerUid(incomingReferralCode, cred.user.uid);

    const profileData = {
      phone,
      gender: signupGender,
      avatar: avatarFor(signupGender),
      referralCode: cred.user.uid.slice(0, 6).toUpperCase(),
      referredByUid,
      referralBonusGiven: false,
      orderCount: 0,
      ordersThisMonth: 0,
      lastOrderMonthKey: "",
      orderMilestone3Given: false,
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, "users", cred.user.uid), profileData);
    ensureReferralCodeDoc(cred.user.uid, profileData.referralCode); // بلا await باش التسجيل ما يتعطلش
    // onAuthStateChanged قد يكون قرا الوثيقة قبل ما يكتبها setDoc (سباق)، فكنثبتو
    // البيانات الصحيحة هنا مباشرة بدل ما نعتمدو غير على القراءة ديالو
    userProfile = { ...profileData, createdAt: new Date().toISOString() };
    updateAccountButton();
  } catch (err) {
    errEl.textContent = s.signupError;
    btn.disabled = false;
    btn.textContent = s.signupBtn;
  }
}

function logoutAccount() {
  signOut(auth);
  closeAccount();
}

function renderAccountProfile() {
  const s = t(lang);
  const el = document.getElementById("accountContent");
  const avatar = userProfile?.avatar || "👤";
  const phone = userProfile?.phone || "";
  const genderLabel = userProfile?.gender === "female" ? s.genderFemale : s.genderMale;
  el.innerHTML = `
   <div class="modal-head"><h3>${s.profileTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
   <div class="profile-head"><div class="avatar-circle">${avatar}</div><b style="font-size:16px">${escapeHtml(phone)}</b></div>
   <div class="profile-row"><span>${s.profilePhoneLabel}</span><b>${escapeHtml(phone)}</b></div>
   <div class="profile-row"><span>${s.profileGenderLabel}</span><b>${genderLabel}</b></div>
   ${
     membershipData
       ? `<button class="checkout" style="width:100%;margin-top:18px" onclick="openMembership()">${s.goToMembership}</button>`
       : `<div class="notice" style="margin-top:16px">${s.noMembershipYet}</div>`
   }
   <button class="checkout" style="width:100%;margin-top:12px;background:#f59e0b;color:#1c1917" onclick="openRewards()">${s.rewardsBtn}</button>
   <button class="link-btn" style="width:100%;margin-top:14px" onclick="logoutAccount()">${s.logoutBtn}</button>
   <button class="link-btn" style="width:100%;margin-top:8px;color:#dc2626" onclick="openDeleteAccountConfirm()">${s.deleteAccountBtn}</button>`;
}

/* ---------- حذف الحساب نهائياً ---------- */
function openDeleteAccountConfirm() {
  renderDeleteAccountConfirm();
}
function cancelDeleteAccount() {
  renderAccountProfile();
}
function renderDeleteAccountConfirm() {
  const s = t(lang);
  const el = document.getElementById("accountContent");
  el.innerHTML = `
   <div class="modal-head"><h3>${s.deleteAccountConfirmTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
   <div class="notice" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">${s.deleteAccountWarning}</div>
   <form onsubmit="submitDeleteAccount(event)">
     <label>${s.deleteAccountPasswordLabel}</label>
     <input id="deleteAccountPassword" required type="password" placeholder="${s.passwordPh}">
     <p id="deleteAccountError" style="color:#dc2626;font-size:12px;margin:6px 0 0"></p>
     <button type="submit" style="width:100%;margin-top:14px;border:0;background:#dc2626;color:#fff;border-radius:999px;padding:12px;font-weight:800">${s.confirmDeleteBtn}</button>
     <button type="button" class="link-btn" style="width:100%;margin-top:10px" onclick="cancelDeleteAccount()">${s.cancelDeleteBtn}</button>
   </form>`;
}
async function submitDeleteAccount(e) {
  e.preventDefault();
  const s = t(lang);
  const errEl = document.getElementById("deleteAccountError");
  const password = document.getElementById("deleteAccountPassword").value;
  if (!currentUser || !userProfile) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = s.deletingAccount;
  try {
    // إعادة التحقق من كلمة السر إجباري من Firebase قبل حذف أي حساب حساس
    const cred = EmailAuthProvider.credential(phoneToEmail(userProfile.phone), password);
    await reauthenticateWithCredential(currentUser, cred);
    const uid = currentUser.uid;
    // كنمسحو الملف الشخصي وبطاقة العضوية قبل حذف حساب Auth
    // (الطلبات كتبقى محفوظة كسجل تجاري للأدمين، وماشي مرتبطة ببيانات شخصية إضافية)
    try {
      await deleteDoc(doc(db, "members", uid));
    } catch (_) {}
    try {
      if (userProfile.referralCode) await deleteDoc(doc(db, "referralCodes", userProfile.referralCode));
    } catch (_) {}
    await deleteDoc(doc(db, "users", uid));
    await deleteUser(currentUser);
    closeAccount();
    toast(s.accountDeletedMsg);
  } catch (err) {
    errEl.textContent = s.deleteAccountError;
    btn.disabled = false;
    btn.textContent = s.confirmDeleteBtn;
  }
}

/* ---------- بطاقة العضوية (تلقائية بعد طلب من 3 أيام فما فوق) ---------- */
async function loadMembership(uid) {
  try {
    const snap = await getDoc(doc(db, "members", uid));
    membershipData = snap.exists() ? snap.data() : null;
  } catch (e) {
    membershipData = null;
  }
  updateAccountButton();
}

async function maybeCreateMembership() {
  // العضوية تُنشأ وتُحدّث آمنًا داخل Cloud Function createOrder.
}

function openMembership() {
  const s = t(lang);
  if (!membershipData) return;
  document.getElementById("accountModal").classList.remove("show");
  document.getElementById("membershipModal").classList.add("show");
  renderMembershipCard();
  clearInterval(countdownInterval);
  countdownInterval = setInterval(renderCountdownOnly, 1000);
}
function closeMembership() {
  document.getElementById("membershipModal").classList.remove("show");
  clearInterval(countdownInterval);
  countdownInterval = null;
}
function backToProfileFromMembership() {
  document.getElementById("membershipModal").classList.remove("show");
  clearInterval(countdownInterval);
  countdownInterval = null;
  openAccount();
}

function remainingParts(endDate) {
  const end = new Date(endDate + "T23:59:59");
  const diff = end.getTime() - Date.now();
  if (diff <= 0) return null;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return { days, hours, minutes, seconds };
}

function renderMembershipCard() {
  const s = t(lang);
  const m = membershipData;
  if (!m) return;
  const memberId = "MB-" + (currentUser?.uid || "").slice(0, 6).toUpperCase();
  document.getElementById("membershipContent").innerHTML = `
   <div class="modal-head"><h3>${s.cardSubtitle}</h3><button class="close" onclick="closeMembership()">×</button></div>
   <div class="member-card">
     <div class="member-card-brand">وجبتي <span style="opacity:.6;font-size:12px">Wajbati</span></div>
     <div class="member-card-name">${m.avatar || ""} ${escapeHtml(m.name || m.phone || "")}</div>
     <div class="member-card-row"><span>${s.memberSince}</span><b>${formatDate(m.joinDate)}</b></div>
     <div class="member-card-row"><span>${s.validUntil}</span><b>${formatDate(m.endDate + "T00:00:00")}</b></div>
     ${m.plan && s.plans[m.plan] ? `<div class="member-card-row"><span>${s.currentPlanLabel}</span><b>${s.plans[m.plan][0]}</b></div>` : ""}
     <div id="countdownWrap"></div>
     <div class="member-card-id">${memberId}</div>
   </div>
   <button class="link-btn" style="width:100%;margin-top:14px;color:#dc2626" onclick="cancelSubscription()">${s.cancelSubscriptionBtn}</button>
   <button class="link-btn" style="width:100%;margin-top:8px" onclick="backToProfileFromMembership()">${s.backToProfile}</button>`;
  renderCountdownOnly();
}

function renderCountdownOnly() {
  const s = t(lang);
  const wrap = document.getElementById("countdownWrap");
  if (!wrap || !membershipData) return;
  const parts = remainingParts(membershipData.endDate);
  if (!parts) {
    wrap.innerHTML = `
     <div class="notice" style="margin-top:14px;background:rgba(255,255,255,.12);color:#fff;border-color:transparent">${s.membershipExpired}</div>
     <button class="renew-btn" onclick="renewSubscription()">${s.renewSubscriptionBtn}</button>`;
    clearInterval(countdownInterval);
    countdownInterval = null;
    return;
  }
  wrap.innerHTML = `
   <div style="position:relative;font-size:11px;opacity:.75;margin-top:10px">${s.membershipRemaining}</div>
   <div class="countdown">
     <div class="countdown-box"><b>${parts.days}</b><span>${s.countdownDays}</span></div>
     <div class="countdown-box"><b>${parts.hours}</b><span>${s.countdownHours}</span></div>
     <div class="countdown-box"><b>${parts.minutes}</b><span>${s.countdownMinutes}</span></div>
     <div class="countdown-box"><b>${parts.seconds}</b><span>${s.countdownSeconds}</span></div>
   </div>`;
}

// كيلغي اشتراك الزبون فالباقة الحالية — كيمسح بطاقة العضوية ديالو من قاعدة البيانات، دون ما يمس أي حاجة أخرى (النقاط، الطلبات، الحساب...)
async function cancelSubscription() {
  const s = t(lang);
  if (!currentUser || !membershipData) return;
  if (!confirm(s.cancelSubscriptionConfirm)) return;
  try {
    await deleteDoc(doc(db, "members", currentUser.uid));
    membershipData = null;
    clearInterval(countdownInterval);
    countdownInterval = null;
    document.getElementById("membershipModal").classList.remove("show");
    updateAccountButton();
    toast(s.cancelSubscriptionDone);
    openAccount();
  } catch (e) {
    toast(s.cancelSubscriptionError, "error");
  }
}

// كيوجه الزبون باش يجدد الاشتراك: كيسد بطاقة العضوية والحساب، ويمشي لقائمة الأطباق باش يصاوب طلب جديد (البطاقة كتترجع تلقائياً بعد طلب من 3 أيام فما فوق)
function renewSubscription() {
  document.getElementById("membershipModal").classList.remove("show");
  document.getElementById("accountModal").classList.remove("show");
  const meals = document.getElementById("meals");
  if (meals) meals.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- تعريض الدوال للـ HTML (الملف عبارة عن module) ---------- */
Object.assign(window, {
  setCategory,
  add,
  remove,
  removeAll,
  choosePlan,
  openCheckout,
  closeCheckout,
  updateSchedulePreview,
  onDateFromChange,
  togglePaymentPicker,
  selectPaymentMethod,
  copyToClipboard,
  useMyLocation,
  submitOrder,
  render,
  switchLang,
  openAccount,
  closeAccount,
  switchAuthTab,
  selectSignupGender,
  submitLogin,
  submitSignup,
  signInWithGoogle,
  signInWithApple,
  submitCompleteProfile,
  logoutAccount,
  openDeleteAccountConfirm,
  cancelDeleteAccount,
  submitDeleteAccount,
  openMembership,
  closeMembership,
  backToProfileFromMembership,
  cancelSubscription,
  renewSubscription,
  openRewards,
  closeRewards,
  copyReferralLink,
  redeemReward,
  openMyOrders,
  closeMyOrders,
  renderMyOrdersList,
  openOrderDetail,
  copyOrderNumber,
  selectDeliveryLocation,
  selectMealType,
  openRateOrder,
  closeRateOrder,
  setRating,
  submitRating,
  openSupport,
  closeSupport,
  sendSupportMessage,
  handleSupportImageSelected,
  openSidebar,
  closeSidebar,
  openSidebarAction,
  scrollToMenu,
  goToCart,
});

/* ---------- الاشتراك بقائمة الأطباق (تحديث فوري) ---------- */
let mealsUnsub = null;
function subscribeMeals() {
  if (mealsUnsub) mealsUnsub();
  mealsUnsub = onSnapshot(
    query(collection(db, "meals"), orderBy("name")),
    (snap) => {
      meals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    },
    () => {
      // ما كنبينوش أخطاء تقنية للزبون — رسالة مفهومة + زر إعادة المحاولة
      const s = t(lang);
      document.getElementById("meals").innerHTML = `<div class="error-box"><p>⚠️ ${s.loadError}</p><button type="button" class="add" onclick="retryMeals()">${s.retry}</button></div>`;
    }
  );
}
function retryMeals() {
  document.getElementById("meals").innerHTML = '<div class="skel-meal"><div class="skel-img"></div><div class="skel-body"><div class="skel-line w90"></div><div class="skel-line w60"></div><div class="skel-line w40"></div></div></div>'.repeat(3);
  subscribeMeals();
}
window.retryMeals = retryMeals;
subscribeMeals();

/* ---------- الاشتراك بصورة وجبة اليوم (تحديث فوري بمجرد ما الأدمين يبدلها) ---------- */
onSnapshot(
  doc(db, "config", "dailyMeal"),
  (snap) => {
    dailyMealImage = snap.exists() ? snap.data().image || "" : "";
    renderDailyMealBanner();
  },
  () => {}
);

/* ---------- الاشتراك بإعدادات طرق الأداء (RIB/تفعيل) — تحديث فوري بمجرد ما الأدمين يبدلها ---------- */
onSnapshot(
  doc(db, "config", "paymentMethods"),
  (snap) => {
    paymentMethodsConfig = snap.exists() ? snap.data() || {} : {};
    if (paymentMethod && !enabledPaymentMethods().some((pm) => pm.id === paymentMethod)) paymentMethod = null;
    const el = document.getElementById("paymentMethodPicker");
    if (el) el.innerHTML = paymentMethodBoxHtml();
  },
  () => {}
);

/* ---------- حالة تسجيل الدخول ---------- */
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    // زبون داخل عبر Google/Apple ما عندوش وثيقة فـ users بعد (ماشي دخول بكلمة السر، فتلك الحالة submitSignup كيصاوبها هو)
    const isSocialProvider = user.providerData[0]?.providerId !== "password";
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        userProfile = snap.data();
        profileIncomplete = false;
      } else {
        userProfile = { phone: "", gender: "male", avatar: "👨" };
        profileIncomplete = isSocialProvider;
      }
    } catch (e) {
      userProfile = { phone: "", gender: "male", avatar: "👨" };
      profileIncomplete = isSocialProvider;
    }
    if (profileIncomplete) {
      // خاص الزبون يعطي رقم الهاتف والجنس قبل ما يكمل — نبقاو المودال مفتوح ونبانو ليه النموذج
      document.getElementById("accountModal").classList.add("show");
      renderCompleteProfile();
    } else {
      // إغلاق مودال الحساب فوراً وإكمال الطلب — ماشي خاصنا ننتظرو بطاقة العضوية باش الدخول يبان سريع
      document.getElementById("accountModal").classList.remove("show");
      if (pendingCheckoutAfterLogin) {
        pendingCheckoutAfterLogin = false;
        openCheckout();
      }
      if (pendingSupportAfterLogin) {
        pendingSupportAfterLogin = false;
        openSupport();
      }
    }
    updateAccountButton();
    loadMembership(user.uid); // كيكمل فالخلفية، وكيحدث الزر وحدو ملي يوصل
    watchUnreadMessages(user.uid);
  } else {
    userProfile = null;
    membershipData = null;
    profileIncomplete = false;
    stopWatchingUnreadMessages();
  }
  updateAccountButton();
});

applyStaticText();
renderCategories(); // كتبان الفئات فوراً، بلا ما تنتظر جواب Firestore ديال الأطباق
renderCart();
document.getElementById("year").textContent = new Date().getFullYear();

/* ---------- نظام النقاط: تحميل القواعد + التقاط رابط الدعوة ---------- */
getDoc(doc(db, "config", "pointsRules"))
  .then((snap) => {
    if (snap.exists()) pointsRules = { ...DEFAULT_POINTS_RULES, ...snap.data() };
  })
  .catch(() => {});

const urlParams = new URLSearchParams(window.location.search);
const incomingReferralCode = urlParams.get("ref") || null;
