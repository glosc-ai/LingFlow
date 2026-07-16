import {
  getApps,
  initializeApp,
  type FirebaseApp,
  type FirebaseOptions,
} from 'firebase/app';
import type { Analytics } from 'firebase/analytics';

const LINGFLOW_FIREBASE_APP_NAME = 'lingflow';

/**
 * Firebase Web configuration contains public client identifiers. Service account
 * credentials and other server-side secrets must never be added here.
 */
export const firebaseConfig = Object.freeze({
  apiKey: 'AIzaSyAIzViHof4TNB694JyuxeBwGJYVbXu9HLA',
  authDomain: 'gloscai.firebaseapp.com',
  projectId: 'gloscai',
  storageBucket: 'gloscai.firebasestorage.app',
  messagingSenderId: '224927712933',
  appId: '1:224927712933:web:c3be70e97262e8b9272f4c',
  measurementId: 'G-Q85L0KV4XT',
}) satisfies FirebaseOptions;

let analyticsInitialization: Promise<Analytics | null> | undefined;

export function getLingFlowFirebaseApp(): FirebaseApp {
  const existingApp = getApps().find((app) => app.name === LINGFLOW_FIREBASE_APP_NAME);
  return existingApp ?? initializeApp(firebaseConfig, LINGFLOW_FIREBASE_APP_NAME);
}

export function initializeLingFlowAnalytics(
  app: FirebaseApp = getLingFlowFirebaseApp(),
): Promise<Analytics | null> {
  analyticsInitialization ??= (async () => {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      const { getAnalytics, isSupported } = await import('firebase/analytics');
      if (!(await isSupported())) {
        return null;
      }
      return getAnalytics(app);
    } catch (error) {
      console.warn('[LingFlow Firebase] Analytics is unavailable in this runtime', error);
      return null;
    }
  })();

  return analyticsInitialization;
}

export function initializeLingFlowFirebase(): FirebaseApp {
  const app = getLingFlowFirebaseApp();
  void initializeLingFlowAnalytics(app);
  return app;
}
