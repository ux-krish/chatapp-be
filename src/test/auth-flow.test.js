import { getDb } from '../db/sqlite.js';
import { otpService } from '../services/otp.service.js';
import { jwtService } from '../services/jwt.service.js';

async function runTests() {
  console.log('🧪 STARTING PROGRAMMATIC BACKEND INTEGRATION TEST...\n');

  try {
    // 1. Initialize Database
    console.log('🔄 Step 1: Connecting and initializing database...');
    const db = await getDb();
    console.log('✅ Database connected.\n');

    // Clean up any old test data
    const testEmail = 'testuser@example.com';
    await db.run('DELETE FROM users WHERE email = ?', [testEmail]);
    await db.run('DELETE FROM otps WHERE email = ?', [testEmail]);

    // 2. Generate OTP
    console.log(`🔄 Step 2: Generating OTP for "${testEmail}"...`);
    const generatedOtp = await otpService.generateOtp(testEmail);
    console.log(`✅ OTP generated and logged. Code length: ${generatedOtp.length}.`);
    
    // Check if stored in DB
    const otpRecord = await db.get('SELECT * FROM otps WHERE email = ?', [testEmail]);
    if (!otpRecord) {
      throw new Error('❌ Failed: OTP record was not written to the database.');
    }
    console.log('✅ OTP record successfully stored in database.\n');

    // 3. Verify incorrect OTP
    console.log('🔄 Step 3: Verifying invalid OTP...');
    const invalidResult = await otpService.verifyOtp(testEmail, '999999');
    if (invalidResult.valid) {
      throw new Error('❌ Failed: Invalid OTP was incorrectly verified as valid.');
    }
    console.log('✅ Invalid OTP rejected correctly.\n');

    // 4. Verify correct OTP
    console.log('🔄 Step 4: Verifying valid OTP...');
    const validResult = await otpService.verifyOtp(testEmail, generatedOtp);
    if (!validResult.valid) {
      throw new Error(`❌ Failed: Valid OTP verification failed with error: ${validResult.message}`);
    }
    console.log('✅ Valid OTP accepted correctly.\n');

    // 5. Test user generation
    console.log('🔄 Step 5: Validating user sign-up flow...');
    // Simulate what verifyOtp controller does
    const userId = 'usr_test_' + Date.now();
    const displayName = 'Test User';
    const now = Date.now();
    
    await db.run(`
      INSERT INTO users (id, email, displayName, bio, status, lastSeen, createdAt)
      VALUES (?, ?, ?, 'Test account bio', 'online', ?, ?)
    `, [userId, testEmail, displayName, now, now]);

    const createdUser = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!createdUser || createdUser.displayName !== displayName) {
      throw new Error('❌ Failed: User profile was not created correctly in database.');
    }
    console.log(`✅ User profile verified. ID: ${createdUser.id}, Name: ${createdUser.displayName}.\n`);

    // 6. Test JWT token operations
    console.log('🔄 Step 6: Testing JWT Sign and Verify flows...');
    const payload = { id: createdUser.id, email: createdUser.email };
    const accessToken = jwtService.generateAccessToken(payload);
    const refreshToken = jwtService.generateRefreshToken(payload);

    console.log('🔑 Access Token generated:', accessToken.substring(0, 20) + '...');
    console.log('🔑 Refresh Token generated:', refreshToken.substring(0, 20) + '...');

    const decodedAccess = jwtService.verifyAccessToken(accessToken);
    if (!decodedAccess || decodedAccess.id !== createdUser.id) {
      throw new Error('❌ Failed: Access token signature verification failed or payload mismatch.');
    }

    const decodedRefresh = jwtService.verifyRefreshToken(refreshToken);
    if (!decodedRefresh || decodedRefresh.id !== createdUser.id) {
      throw new Error('❌ Failed: Refresh token signature verification failed or payload mismatch.');
    }
    console.log('✅ JWT signature and payloads verified successfully.\n');

    // 7. Cleanup
    console.log('🔄 Step 7: Cleaning up test user records...');
    await db.run('DELETE FROM users WHERE id = ?', [userId]);
    const afterCleanup = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (afterCleanup) {
      throw new Error('❌ Failed: Test records were not cleaned up.');
    }
    console.log('✅ Cleanup finished.\n');

    console.log('🎉 ALL INTEGRATION TESTS PASSED MATCHING THE SPECIFICATION! 🚀\n');
    process.exit(0);

  } catch (err) {
    console.error('\n💥 TEST RUN ENCOUNTERED CRITICAL ERROR:\n', err.message || err);
    process.exit(1);
  }
}

runTests();
