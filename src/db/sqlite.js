import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { DB_PATH, UPLOADS_DIR } from '../config/config.js';

let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;
  
  // Ensure uploads directories exist
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  const avatarsDir = path.join(UPLOADS_DIR, 'avatars');
  const mediaDir = path.join(UPLOADS_DIR, 'media');
  if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
  }
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  // Ensure DB parent directory exists
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Open DB
  dbInstance = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // Enable foreign key support
  await dbInstance.run('PRAGMA foreign_keys = ON;');

  // Initialize Schema
  await initializeSchema(dbInstance);

  return dbInstance;
}

async function initializeSchema(db) {
  // 1. Users Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      displayName TEXT,
      avatarUrl TEXT,
      bio TEXT,
      status TEXT DEFAULT 'offline',
      lastSeen INTEGER,
      role TEXT DEFAULT 'user', -- 'admin', 'user'
      isBanned INTEGER DEFAULT 0, -- 0: active, 1: banned
      password TEXT,
      twoFactorEnabled INTEGER DEFAULT 0,
      themeColor TEXT DEFAULT 'green',
      fontSize TEXT DEFAULT 'medium',
      theme TEXT DEFAULT 'dark',
      chatBgPattern TEXT DEFAULT 'dots',
      createdAt INTEGER NOT NULL
    );
  `);

  // Non-destructive migrations for existing database files
  try {
    await db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE users ADD COLUMN isBanned INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE users ADD COLUMN password TEXT;");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE users ADD COLUMN twoFactorEnabled INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE users ADD COLUMN themeColor TEXT DEFAULT 'green';");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE users ADD COLUMN fontSize TEXT DEFAULT 'medium';");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'dark';");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE users ADD COLUMN chatBgPattern TEXT DEFAULT 'dots';");
  } catch (e) {}

  // 2. OTPs Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS otps (
      email TEXT PRIMARY KEY,
      otp TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0
    );
  `);

  // 3. Friends Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS friends (
      userId TEXT NOT NULL,
      friendId TEXT NOT NULL,
      status TEXT NOT NULL, -- 'pending_sent', 'pending_received', 'accepted'
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (userId, friendId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friendId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 4. Groups Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      avatarUrl TEXT,
      createdBy TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 5. Group Members Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS group_members (
      groupId TEXT NOT NULL,
      userId TEXT NOT NULL,
      role TEXT DEFAULT 'member', -- 'admin', 'member'
      joinedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, userId),
      FOREIGN KEY (groupId) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 6. Messages Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chatId TEXT NOT NULL, -- Sorted compound key for 1-to-1 chats, or groupId for group chats
      senderId TEXT NOT NULL,
      receiverId TEXT,
      groupId TEXT,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'text', -- 'text', 'image', 'video', 'audio', 'file'
      status TEXT DEFAULT 'sent', -- 'sent', 'delivered', 'read'
      parentMessageId TEXT, -- Reference to parent message for replies
      isPinned INTEGER DEFAULT 0, -- Pin flag (0: unpinned, 1: pinned)
      isEdited INTEGER DEFAULT 0, -- Edit flag (0: original, 1: edited)
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (senderId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiverId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (groupId) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (parentMessageId) REFERENCES messages(id) ON DELETE SET NULL
    );
  `);

  // Index on messages for fast chat history retrieval
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId, createdAt);
  `);

  // Non-destructive migrations for messages table
  try {
    await db.exec("ALTER TABLE messages ADD COLUMN parentMessageId TEXT;");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE messages ADD COLUMN isPinned INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE messages ADD COLUMN isEdited INTEGER DEFAULT 0;");
  } catch (e) {}
  try {
    await db.exec("ALTER TABLE messages ADD COLUMN reaction TEXT;");
  } catch (e) {}

  // 7. Stories Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      mediaUrl TEXT NOT NULL,
      mediaType TEXT DEFAULT 'image', -- 'image', 'video'
      caption TEXT,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 8. Story Views Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS story_views (
      storyId TEXT NOT NULL,
      userId TEXT NOT NULL,
      viewedAt INTEGER NOT NULL,
      PRIMARY KEY (storyId, userId),
      FOREIGN KEY (storyId) REFERENCES stories(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 9. Blocked Users Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      userId TEXT NOT NULL,
      blockedId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (userId, blockedId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (blockedId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 10. Pinned Chats Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pinned_chats (
      userId TEXT NOT NULL,
      chatId TEXT NOT NULL,
      friendId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (userId, friendId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friendId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 11. Hidden Chats Table (for "remove chat" without removing friendship)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS hidden_chats (
      userId TEXT NOT NULL,
      friendId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (userId, friendId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friendId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // 12. Call History Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      callerId TEXT NOT NULL,
      receiverId TEXT NOT NULL,
      status TEXT NOT NULL, -- 'missed', 'incoming', 'outgoing'
      callType TEXT DEFAULT 'audio', -- 'audio' or 'video'
      duration INTEGER DEFAULT 0, -- in seconds
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (callerId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiverId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migration: add callType column to existing calls table if missing
  try {
    const callsCols = await db.all("PRAGMA table_info(calls)");
    if (!callsCols.find(c => c.name === 'callType')) {
      await db.run("ALTER TABLE calls ADD COLUMN callType TEXT DEFAULT 'audio'");
      console.log('🔄 Migration: Added callType column to calls table.');
    }
  } catch (_) { /* column already exists */ }

  const superAdminEmail = 'admin@securechat.com';
  const existingAdmin = await db.get('SELECT * FROM users WHERE email = ?', [superAdminEmail]);
  if (!existingAdmin) {
    const adminId = 'usr_super_admin';
    const displayName = 'Super Admin';
    const bio = 'System Super Administrator';
    const role = 'admin';
    const createdAt = 1719586800000; // Constant timestamp (does not change or create random time)
    const hashedPassword = await bcrypt.hash('admin123', 10);

    await db.run(`
      INSERT INTO users (id, email, displayName, bio, status, lastSeen, role, password, twoFactorEnabled, themeColor, fontSize, theme, createdAt)
      VALUES (?, ?, ?, ?, 'offline', ?, ?, ?, 0, 'green', 'medium', 'dark', ?)
    `, [adminId, superAdminEmail, displayName, bio, createdAt, role, hashedPassword, createdAt]);

    console.log(`🛡️ Super Admin initialized: ${superAdminEmail} / admin123`);
  }
}
