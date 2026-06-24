// Firebase initialization – shared across the app
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBHYfvHY2Bs0xPcwdjlQ86uYWGGH9NITLM",
  authDomain: "garantijos-4f397.firebaseapp.com",
  projectId: "garantijos-4f397",
  storageBucket: "garantijos-4f397.firebasestorage.app",
  messagingSenderId: "178623389138",
  appId: "1:178623389138:web:b0cfa084fec80b80b7fc0b"
};

// VAPID public key for Web Push (safe to expose publicly)
export const VAPID_KEY = "BOQH_YMvcD5Yc6ziqPno_Y2g0SkQBpuJuLKdNjS01VG4H8Q6YgJKeDps_RbVPtckxHSjq2VbjdXFO4AVS3s6DJI";

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

export const db = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export const storage = getStorage(firebaseApp);
