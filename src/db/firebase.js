import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccountPath = path.join(__dirname, '../../serviceAccountKey.json');
let isInitialized = false;

// Handle ESM/CJS interop differences for firebase-admin
const firebaseAdmin = admin.default || admin;

// Attempt to initialize Firebase Admin SDK
try {
  if (fs.existsSync(serviceAccountPath)) {
    // --- Method 1: serviceAccountKey.json file in backend root ---
    console.log('🔑 Initializing Firebase Admin SDK via serviceAccountKey.json...');
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    const projectId = serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID;
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || (projectId ? `${projectId}.appspot.com` : undefined)
    });
    isInitialized = true;
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    // --- Method 2: Base64-encoded service account JSON (recommended for Render/Railway/Fly) ---
    // This avoids all multiline private key formatting issues.
    // Generate with: cat serviceAccountKey.json | base64 | tr -d '\n'
    console.log('🔑 Initializing Firebase Admin SDK via FIREBASE_SERVICE_ACCOUNT_BASE64...');
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(decoded);
    const projectId = serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID;
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || (projectId ? `${projectId}.appspot.com` : undefined)
    });
    isInitialized = true;
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    // --- Method 3: Individual environment variables ---
    console.log('🔑 Initializing Firebase Admin SDK via Environment Variables...');
    
    let projectId = process.env.FIREBASE_PROJECT_ID.trim();
    if (projectId.startsWith('"') && projectId.endsWith('"')) projectId = projectId.slice(1, -1);
    if (projectId.startsWith("'") && projectId.endsWith("'")) projectId = projectId.slice(1, -1);

    let clientEmail = process.env.FIREBASE_CLIENT_EMAIL.trim();
    if (clientEmail.startsWith('"') && clientEmail.endsWith('"')) clientEmail = clientEmail.slice(1, -1);
    if (clientEmail.startsWith("'") && clientEmail.endsWith("'")) clientEmail = clientEmail.slice(1, -1);

    let privateKey = process.env.FIREBASE_PRIVATE_KEY.trim();
    if (privateKey.startsWith('"') && privateKey.endsWith('"')) privateKey = privateKey.slice(1, -1);
    if (privateKey.startsWith("'") && privateKey.endsWith("'")) privateKey = privateKey.slice(1, -1);
    privateKey = privateKey.replace(/\\n/g, '\n');
    
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert({
        projectId: projectId,
        clientEmail: clientEmail,
        privateKey: privateKey
      }),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`
    });
    isInitialized = true;
  } else {
    console.warn('\n⚠️ WARNING: Firebase Admin SDK credentials not configured.');
    console.warn('Google Sign-In will NOT work until one of these methods is configured:');
    console.warn('  1. Place "serviceAccountKey.json" in the backend root directory');
    console.warn('  2. Set FIREBASE_SERVICE_ACCOUNT_BASE64 env var (recommended for cloud hosting)');
    console.warn('  3. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY env vars\n');
  }

  if (isInitialized) {
    console.log('✅ Firebase Admin SDK initialized successfully.');
  }
} catch (err) {
  console.error('💥 Critical Error: Failed to initialize Firebase Admin SDK:', err.message);
  console.error('   Google Sign-In will be unavailable. Check your Firebase credentials configuration.');
}

export { firebaseAdmin as admin, isInitialized };
