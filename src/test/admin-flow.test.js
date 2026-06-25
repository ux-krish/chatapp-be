import { getDb } from '../db/sqlite.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import {
  getSystemStats,
  getAllUsers,
  updateUserRole,
  banUser,
  deleteUser
} from '../controllers/admin.controller.js';

// Simple mock response generator
function mockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status: function (code) {
      this.statusCode = code;
      return this;
    },
    json: function (data) {
      this.body = data;
      return this;
    }
  };
  return res;
}

async function runAdminTests() {
  console.log('🧪 STARTING PROGRAMMATIC ADMIN PORTAL INTEGRATION TESTS...\n');

  try {
    const db = await getDb();
    console.log('✅ Database connection verified.');

    // 1. Verify schema upgrades
    console.log('🔄 Step 1: Checking SQLite user schema upgrades...');
    const tableInfo = await db.all("PRAGMA table_info(users)");
    const columns = tableInfo.map(c => c.name);
    
    if (!columns.includes('role')) {
      throw new Error('❌ Failed: "role" column missing from "users" table.');
    }
    if (!columns.includes('isBanned')) {
      throw new Error('❌ Failed: "isBanned" column missing from "users" table.');
    }
    console.log('✅ SQLite schema contains "role" and "isBanned" columns.\n');

    // Setup test users
    const adminId = 'usr_test_admin_' + Date.now();
    const standardId = 'usr_test_std_' + Date.now();
    const bannedId = 'usr_test_banned_' + Date.now();

    // Insert test users
    await db.run(`
      INSERT INTO users (id, email, displayName, role, isBanned, createdAt)
      VALUES (?, 'admin@test.com', 'Admin User', 'admin', 0, ?)
    `, [adminId, Date.now()]);

    await db.run(`
      INSERT INTO users (id, email, displayName, role, isBanned, createdAt)
      VALUES (?, 'std@test.com', 'Standard User', 'user', 0, ?)
    `, [standardId, Date.now()]);

    await db.run(`
      INSERT INTO users (id, email, displayName, role, isBanned, createdAt)
      VALUES (?, 'banned@test.com', 'Banned User', 'user', 1, ?)
    `, [bannedId, Date.now()]);

    console.log('✅ Test accounts created in SQLite database.\n');

    // 2. Test requireAdmin middleware
    console.log('🔄 Step 2: Validating requireAdmin security middleware...');

    // Case A: No authenticated user
    const reqA = {};
    const resA = mockResponse();
    await requireAdmin(reqA, resA, () => {});
    if (resA.statusCode !== 401) {
      throw new Error(`❌ Failed: Middleware allowed unauthenticated request. Status: ${resA.statusCode}`);
    }
    console.log('✅ Unauthenticated requests blocked correctly (401).');

    // Case B: Standard user
    const reqB = { user: { id: standardId } };
    const resB = mockResponse();
    await requireAdmin(reqB, resB, () => {});
    if (resB.statusCode !== 403) {
      throw new Error(`❌ Failed: Middleware allowed standard user. Status: ${resB.statusCode}`);
    }
    console.log('✅ Standard users blocked correctly from admin access (403).');

    // Case C: Banned user
    const reqC = { user: { id: bannedId } };
    const resC = mockResponse();
    await requireAdmin(reqC, resC, () => {});
    if (resC.statusCode !== 403) {
      throw new Error(`❌ Failed: Middleware allowed banned user. Status: ${resC.statusCode}`);
    }
    console.log('✅ Banned users blocked correctly from admin access (403).');

    // Case D: Admin user
    const reqD = { user: { id: adminId } };
    const resD = mockResponse();
    let nextCalled = false;
    await requireAdmin(reqD, resD, () => { nextCalled = true; });
    if (!nextCalled) {
      throw new Error('❌ Failed: Middleware blocked legitimate administrator.');
    }
    console.log('✅ Legitimate administrators authorized successfully.\n');

    // 3. Test Controller Actions
    console.log('🔄 Step 3: Validating Admin controller actions...');

    // A. getSystemStats
    const reqStats = {};
    const resStats = mockResponse();
    await getSystemStats(reqStats, resStats);
    if (resStats.statusCode !== 200 || !resStats.body.dbConnected) {
      throw new Error('❌ Failed: getSystemStats returned erroneous payload.');
    }
    console.log(`✅ System analytics fetched. Total Users in DB count: ${resStats.body.totalUsers}`);

    // B. banUser (Ban a standard user)
    const reqBan = {
      user: { id: adminId },
      params: { userId: standardId },
      body: { ban: true }
    };
    const resBan = mockResponse();
    await banUser(reqBan, resBan);
    if (resBan.statusCode !== 200) {
      throw new Error(`❌ Failed: banUser action failed. Status: ${resBan.statusCode}`);
    }
    
    // Verify in DB
    const bannedCheck = await db.get('SELECT isBanned FROM users WHERE id = ?', [standardId]);
    if (bannedCheck.isBanned !== 1) {
      throw new Error('❌ Failed: User ban state was not updated in database.');
    }
    console.log('✅ banUser action successfully suspended user in SQLite.');

    // C. updateUserRole (Promote standard user to admin)
    const reqRole = {
      user: { id: adminId },
      params: { userId: standardId },
      body: { role: 'admin' }
    };
    const resRole = mockResponse();
    await updateUserRole(reqRole, resRole);
    if (resRole.statusCode !== 200) {
      throw new Error(`❌ Failed: updateUserRole promotion failed. Status: ${resRole.statusCode}`);
    }
    
    // Verify in DB
    const roleCheck = await db.get('SELECT role FROM users WHERE id = ?', [standardId]);
    if (roleCheck.role !== 'admin') {
      throw new Error('❌ Failed: User role was not updated in database.');
    }
    console.log('✅ updateUserRole action successfully promoted user to admin.');

    // D. deleteUser (Delete banned user)
    const reqDelete = {
      user: { id: adminId },
      params: { userId: bannedId }
    };
    const resDelete = mockResponse();
    await deleteUser(reqDelete, resDelete);
    if (resDelete.statusCode !== 200) {
      throw new Error(`❌ Failed: deleteUser purge failed. Status: ${resDelete.statusCode}`);
    }

    // Verify in DB
    const deletedCheck = await db.get('SELECT * FROM users WHERE id = ?', [bannedId]);
    if (deletedCheck) {
      throw new Error('❌ Failed: User account was not deleted from database.');
    }
    console.log('✅ deleteUser action successfully purged account from SQLite.\n');

    // 4. Cleanup remaining test users
    console.log('🔄 Step 4: Cleaning up remaining test artifacts...');
    await db.run('DELETE FROM users WHERE id = ?', [adminId]);
    await db.run('DELETE FROM users WHERE id = ?', [standardId]);
    
    const adminCheck = await db.get('SELECT * FROM users WHERE id = ?', [adminId]);
    const stdCheck = await db.get('SELECT * FROM users WHERE id = ?', [standardId]);
    if (adminCheck || stdCheck) {
      throw new Error('❌ Failed: Database cleanup did not delete all test users.');
    }
    console.log('✅ Cleanup completed successfully.\n');

    console.log('🎉 ALL ADMIN INTEGRATION TESTS PASSED MATCHING THE SPECIFICATION! 🚀\n');
    process.exit(0);

  } catch (err) {
    console.error('\n💥 ADMIN FLOW TEST FAILURE:\n', err.message || err);
    process.exit(1);
  }
}

runAdminTests();
