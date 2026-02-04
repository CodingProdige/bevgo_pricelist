import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const clientFirebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_CLIENT_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_CLIENT_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_CLIENT_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_CLIENT_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_CLIENT_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_CLIENT_FIREBASE_APP_ID
};

const clientApp = getApps().some((app) => app.name === "client")
  ? getApp("client")
  : initializeApp(clientFirebaseConfig, "client");

const clientDb = getFirestore(clientApp);

export { clientFirebaseConfig, clientApp, clientDb };
