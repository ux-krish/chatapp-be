import admin from 'firebase-admin';
import { getAuth } from 'firebase-admin/auth';

console.log('--- DEBUGGING FIREBASE-ADMIN AUTH ---');
console.log('admin.auth:', admin.auth); // Is it undefined?
console.log('Type of getAuth:', typeof getAuth); // Should be 'function'

try {
  // If getAuth exists, we can get an auth instance
  const authInstance = getAuth();
  console.log('getAuth() returned:', typeof authInstance);
  console.log('Keys of authInstance:', Object.keys(authInstance || {}));
} catch (err) {
  console.log('Error calling getAuth():', err.message);
}
