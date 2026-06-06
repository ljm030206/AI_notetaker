// frontend/src/lib/firebase.ts

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCqUCsR1485O4Nx35_i5ECEMM3xJ1-KYC8",
  authDomain: "ainotetaker-ad8c4.firebaseapp.com",
  projectId: "ainotetaker-ad8c4",
  storageBucket: "ainotetaker-ad8c4.firebasestorage.app",
  messagingSenderId: "961154095004",
  appId: "1:961154095004:web:492eb88b6c28efd04f1a59",
  measurementId: "G-8VM12FH4DQ"
};

// Next.js 환경에서 Firebase가 여러 번 초기화되는 것을 방지
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);
const db = getFirestore(app, "main");

export { app, auth, db };