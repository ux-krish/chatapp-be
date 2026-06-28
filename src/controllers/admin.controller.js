import fs from 'fs';
import { getDb } from '../db/sqlite.js';
import { DB_PATH } from '../config/config.js';
import { emitToUser, emitToRoom, disconnectUserSockets, broadcastSystemEvent } from '../socket/socket.handler.js';

// Get comprehensive system stats and analytics
export async function getSystemStats(req, res) {
  try {
    const db = await getDb();
    const now = Date.now();

    const totalUsers = await db.get('SELECT COUNT(*) AS count FROM users');
    const onlineUsers = await db.get("SELECT COUNT(*) AS count FROM users WHERE status = 'online'");
    const totalMessages = await db.get('SELECT COUNT(*) AS count FROM messages');
    const totalGroups = await db.get('SELECT COUNT(*) AS count FROM groups');
    const activeStories = await db.get('SELECT COUNT(*) AS count FROM stories WHERE expiresAt > ?', [now]);

    // Role distribution
    const adminCount = await db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
    const userCount = totalUsers.count - adminCount.count;

    // Message type distribution
    const msgTypeCounts = await db.all("SELECT type, COUNT(*) AS count FROM messages GROUP BY type");
    const messageTypes = { text: 0, image: 0, video: 0, audio: 0, file: 0 };
    msgTypeCounts.forEach(row => {
      if (messageTypes[row.type] !== undefined) {
        messageTypes[row.type] = row.count;
      }
    });

    // Banned distribution
    const bannedCount = await db.get("SELECT COUNT(*) AS count FROM users WHERE isBanned = 1");

    // DB File details
    let dbSize = 0;
    try {
      if (fs.existsSync(DB_PATH)) {
        dbSize = fs.statSync(DB_PATH).size;
      }
    } catch (e) {}

    // Memory usage
    const memUsage = process.memoryUsage();

    return res.status(200).json({
      totalUsers: totalUsers.count,
      onlineUsers: onlineUsers.count,
      totalMessages: totalMessages.count,
      totalGroups: totalGroups.count,
      activeStories: activeStories.count,
      serverUptime: process.uptime(),
      dbConnected: true,
      analytics: {
        roles: { admin: adminCount.count, user: userCount },
        messageTypes,
        banned: bannedCount.count,
        dbSize,
        system: {
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          heapUsed: memUsage.heapUsed,
          rss: memUsage.rss
        }
      }
    });
  } catch (err) {
    console.error('Error fetching admin system stats:', err);
    return res.status(500).json({ error: 'Failed to retrieve system statistics.' });
  }
}

// Retrieve all users in the system
export async function getAllUsers(req, res) {
  try {
    const db = await getDb();
    const users = await db.all(`
      SELECT id, email, displayName, avatarUrl, bio, status, lastSeen, role, isBanned, createdAt 
      FROM users 
      ORDER BY role DESC, displayName ASC
    `);
    return res.status(200).json(users);
  } catch (err) {
    console.error('Error fetching all users for admin:', err);
    return res.status(500).json({ error: 'Failed to retrieve user accounts.' });
  }
}

// Promote or demote a user's administrative role
export async function updateUserRole(req, res) {
  const { userId } = req.params;
  const { role } = req.body; // 'admin' | 'user'

  if (!role || !['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role specified. Use "admin" or "user".' });
  }

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot demote or promote your own account.' });
  }

  try {
    const db = await getDb();
    
    // Check if target user exists
    const user = await db.get('SELECT displayName FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'Target user account not found.' });
    }

    await db.run('UPDATE users SET role = ? WHERE id = ?', [role, userId]);

    return res.status(200).json({ 
      message: `User "${user.displayName}" role updated to ${role} successfully.`,
      userId,
      role
    });
  } catch (err) {
    console.error('Error updating user role:', err);
    return res.status(500).json({ error: 'Failed to update user role.' });
  }
}

// Ban or unban a user
export async function banUser(req, res) {
  const { userId } = req.params;
  const { ban } = req.body; // boolean

  if (ban === undefined) {
    return res.status(400).json({ error: 'Ban state is required (true to ban, false to unban).' });
  }

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot ban or suspend your own account.' });
  }

  try {
    const db = await getDb();
    
    // Check if target user exists
    const user = await db.get('SELECT displayName FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'Target user account not found.' });
    }

    const banVal = ban ? 1 : 0;
    await db.run('UPDATE users SET isBanned = ? WHERE id = ?', [banVal, userId]);

    // If banned, force them offline in database
    if (ban) {
      await db.run("UPDATE users SET status = 'offline' WHERE id = ?", [userId]);
      // Notify user and terminate active socket connections
      emitToUser(userId, 'user_banned', { reason: 'Your account has been suspended by an administrator.' });
      setTimeout(() => {
        disconnectUserSockets(userId);
      }, 200);
    }

    return res.status(200).json({ 
      message: `User "${user.displayName}" has been ${ban ? 'suspended' : 'reinstated'} successfully.`,
      userId,
      isBanned: banVal
    });
  } catch (err) {
    console.error('Error toggling user ban status:', err);
    return res.status(500).json({ error: 'Failed to update suspension status.' });
  }
}

// Permanently delete a user account
export async function deleteUser(req, res) {
  const { userId } = req.params;

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account from the dashboard.' });
  }

  try {
    const db = await getDb();
    
    // Check if target user exists
    const user = await db.get('SELECT displayName FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    // Begin transaction for complete removal
    await db.run('BEGIN TRANSACTION');
    
    // Delete user (cascades automatically delete messages, friends, group memberships, stories, etc.)
    await db.run('DELETE FROM users WHERE id = ?', [userId]);
    
    await db.run('COMMIT');

    return res.status(200).json({ 
      message: `User account "${user.displayName}" and all associated data deleted permanently.`,
      userId 
    });
  } catch (err) {
    console.error('Error deleting user account:', err);
    try {
      const db = await getDb();
      await db.run('ROLLBACK');
    } catch (rerr) {}
    return res.status(500).json({ error: 'Failed to delete user account.' });
  }
}

// Get listing of all chats (direct friendship rooms and groups)
export async function getAllChats(req, res) {
  try {
    const db = await getDb();
    
    // 1. Get all Groups
    const groups = await db.all(`
      SELECT g.id, g.name, g.description, g.avatarUrl, g.createdAt, u.displayName AS creatorName,
             (SELECT COUNT(*) FROM group_members WHERE groupId = g.id) AS memberCount
      FROM groups g
      LEFT JOIN users u ON g.createdBy = u.id
      ORDER BY g.createdAt DESC
    `);

    // 2. Get all Direct active chat rooms
    // We group by chatId to see the active conversations
    const directChats = await db.all(`
      SELECT m.chatId, MAX(m.createdAt) as lastActive, COUNT(m.id) as messageCount
      FROM messages m
      WHERE m.groupId IS NULL
      GROUP BY m.chatId
      ORDER BY lastActive DESC
    `);

    // For each direct chat, populate participant names
    const resolvedDirects = [];
    for (const chat of directChats) {
      const userIds = chat.chatId.split('_');
      if (userIds.length >= 2) {
        const userA = await db.get('SELECT displayName, email FROM users WHERE id = ?', [userIds[0]]);
        const userB = await db.get('SELECT displayName, email FROM users WHERE id = ?', [userIds[1]]);
        
        resolvedDirects.push({
          chatId: chat.chatId,
          userAName: userA ? userA.displayName : 'Unknown User',
          userBName: userB ? userB.displayName : 'Unknown User',
          messageCount: chat.messageCount,
          lastActive: chat.lastActive
        });
      }
    }

    return res.status(200).json({
      groups,
      directChats: resolvedDirects
    });
  } catch (err) {
    console.error('Error fetching admin chats list:', err);
    return res.status(500).json({ error: 'Failed to retrieve active chat directories.' });
  }
}

// Delete an entire group
export async function deleteGroup(req, res) {
  const { groupId } = req.params;

  try {
    const db = await getDb();
    const group = await db.get('SELECT name FROM groups WHERE id = ?', [groupId]);
    if (!group) {
      return res.status(404).json({ error: 'Group channel not found.' });
    }

    await db.run('DELETE FROM groups WHERE id = ?', [groupId]);

    // Broadcast group deletion to members
    emitToRoom(groupId, 'group_deleted', { groupId });

    return res.status(200).json({ 
      message: `Group channel "${group.name}" deleted successfully.`,
      groupId
    });
  } catch (err) {
    console.error('Error deleting group:', err);
    return res.status(500).json({ error: 'Failed to delete group channel.' });
  }
}

// Delete a single chat message
export async function deleteMessage(req, res) {
  const { messageId } = req.params;

  try {
    const db = await getDb();
    const message = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!message) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    await db.run('DELETE FROM messages WHERE id = ?', [messageId]);

    // Broadcast message deletion to participants in real-time
    if (message.groupId) {
      emitToRoom(message.groupId, 'message_deleted', { messageId, groupId: message.groupId });
    } else {
      emitToUser(message.senderId, 'message_deleted', { messageId, chatId: message.chatId });
      if (message.receiverId) {
        emitToUser(message.receiverId, 'message_deleted', { messageId, chatId: message.chatId });
      }
    }

    return res.status(200).json({ 
      message: 'Message deleted successfully from database archive.',
      messageId
    });
  } catch (err) {
    console.error('Error deleting message:', err);
    return res.status(500).json({ error: 'Failed to delete message.' });
  }
}

// Run database maintenance commands (integrity check or vacuum)
export async function runDbMaintenance(req, res) {
  const { action } = req.body; // 'integrity_check' | 'vacuum'
  
  if (action !== 'integrity_check' && action !== 'vacuum') {
    return res.status(400).json({ error: 'Invalid maintenance action.' });
  }

  try {
    const db = await getDb();
    if (action === 'integrity_check') {
      const result = await db.get('PRAGMA integrity_check;');
      return res.status(200).json({ 
        message: 'Integrity check completed.', 
        result: result.integrity_check 
      });
    } else {
      await db.run('VACUUM;');
      
      // Get new db file size
      let dbSize = 0;
      try {
        if (fs.existsSync(DB_PATH)) {
          dbSize = fs.statSync(DB_PATH).size;
        }
      } catch (e) {}

      return res.status(200).json({ 
        message: 'Database vacuumed and compressed successfully.', 
        dbSize 
      });
    }
  } catch (err) {
    console.error('Error in DB maintenance:', err);
    return res.status(500).json({ error: 'Failed to complete maintenance operation.' });
  }
}

// Send system broadcast to all active connections
export async function broadcastSystemMessage(req, res) {
  const { message, severity } = req.body; // severity: 'info' | 'warning' | 'danger'
  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: 'Broadcast message content is required.' });
  }

  try {
    let mediaUrl = null;
    let mediaType = null;

    if (req.file) {
      const localFilePath = req.file.path;
      const filename = req.file.filename;
      mediaUrl = `/uploads/media/${filename}`;
      mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';

      // Check if Firebase is initialized
      let isFbInit = false;
      let adminSdk = null;
      try {
        const fbModule = await import('../db/firebase.js');
        isFbInit = fbModule.isInitialized;
        adminSdk = fbModule.admin;
      } catch (fbImportErr) {
        console.warn('Firebase module import failed:', fbImportErr.message);
      }

      if (isFbInit && adminSdk) {
        try {
          const { uploadFileToFirebase } = await import('../services/storage.service.js');
          console.log(`☁️ Uploading broadcast media ${filename} to Firebase Storage...`);
          mediaUrl = await uploadFileToFirebase(localFilePath, filename, 'media');
          console.log(`☁️ Uploaded successfully to Firebase Storage: ${mediaUrl}`);

          // Delete local temp file
          if (fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
          }
        } catch (fbUploadErr) {
          console.error('Failed to upload broadcast media to Firebase Storage:', fbUploadErr);
        }
      }
    }

    const db = await getDb();
    const now = Date.now();

    // If an image/media was uploaded, also store this broadcast as a status/story posted by the admin
    if (mediaUrl) {
      const storyId = 'sty_' + Date.now() + Math.random().toString(36).substr(2, 9);
      const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours expiry
      await db.run(`
        INSERT INTO stories (id, userId, mediaUrl, mediaType, caption, expiresAt, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [storyId, req.user.id, mediaUrl, mediaType || 'image', message.trim(), expiresAt, now]);
      console.log(`📢 Broadcast story published in database: ${storyId}`);
    }

    const success = broadcastSystemEvent('system_broadcast', {
      id: 'sys_' + Date.now(),
      message: message.trim(),
      severity: severity || 'info',
      mediaUrl,
      mediaType,
      timestamp: now
    });

    if (success) {
      return res.status(200).json({ 
        message: 'Broadcast alert and status story published successfully.',
        mediaUrl
      });
    } else {
      return res.status(500).json({ error: 'Socket server instance not active.' });
    }
  } catch (err) {
    console.error('Error broadcasting system alert:', err);
    return res.status(500).json({ error: 'Failed to broadcast message.' });
  }
}
