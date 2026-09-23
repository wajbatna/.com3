// firebase.js
// -----------------------------------------------------------------------
// خطوات الإعداد (مرة وحدة فقط):
// 1) روح لـ https://console.firebase.google.com وصاوب مشروع جديد
// 2) Project settings ⚙ → General → "Your apps" → أضف Web app → نسخ الإعدادات ولصقها تحت
// 3) فعّل Firestore Database (Build → Firestore Database → Create database)
// 4) فعّل Authentication → Sign-in method → Email/Password
// 5) من Authentication → Users → أضف حساب للأدمين (email + password) يدوياً
// 6) باش يخدم زر "المتابعة عبر Google": Authentication → Sign-in method → فعّل Google
// 7) باش يخدم زر "المتابعة عبر Apple": Authentication → Sign-in method → فعّل Apple
//    (خاصك حساب Apple Developer وتصاوب Service ID + Key من developer.apple.com،
//    وتزيد الـ redirect URI ديال Firebase فإعدادات Apple — التفاصيل فوثائق Firebase)
// -----------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyCLNN2ejx6BDwGgwdkKGLfL3odS2i_V5Rc",
  authDomain: "wajbatna-c83ee.firebaseapp.com",
  databaseURL: "https://wajbatna-c83ee-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "wajbatna-c83ee",
  storageBucket: "wajbatna-c83ee.firebasestorage.app",
  messagingSenderId: "825720260240",
  appId: "1:825720260240:web:50b38212905480e883ba15",
  measurementId: "G-RQYEY82MS6",
};

const app = initializeApp(firebaseConfig);

export { app };
export const db = getFirestore(app);
export const auth = getAuth(app);

// Analytics تخدم غير فدومين حقيقي منشور (ماشي فمعاينة/localhost)، فهاد الفحص كيمنع أخطاء فالكونسول
isSupported().then((ok) => {
  if (ok) getAnalytics(app);
});

