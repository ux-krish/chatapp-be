import admin from 'firebase-admin';

console.log('--- DEBUGGING FIREBASE-ADMIN IMPORT ---');
console.log('Type of admin:', typeof admin);
console.log('Is admin null?', admin === null);
console.log('Keys of admin:', Object.keys(admin || {}));

if (admin) {
  console.log('admin.credential:', admin.credential);
  console.log('admin.default:', admin.default ? 'exists' : 'undefined');
  if (admin.default) {
    console.log('Keys of admin.default:', Object.keys(admin.default));
    console.log('admin.default.credential:', admin.default.credential);
  }
}
