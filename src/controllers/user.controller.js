import fs from 'fs';
import path from 'path';
import { UPLOADS_DIR } from '../config/config.js';
import { getDb } from '../db/sqlite.js';
import { emitToUser } from '../socket/socket.handler.js';

// Get current user profile
export async function getProfile(req, res) {
  try {
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    return res.status(200).json(user);
  } catch (err) {
    console.error('Error getting profile:', err);
    return res.status(500).json({ error: 'Failed to retrieve profile.' });
  }
}

// Update current user profile
export async function updateProfile(req, res) {
  const { displayName, bio, themeColor, fontSize, theme } = req.body;
  const db = await getDb();

  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    let avatarUrl = user.avatarUrl;
    if (req.file) {
      const localFilePath = req.file.path;
      const filename = req.file.filename;
      let newAvatarUrl = `/uploads/avatars/${filename}`;

      // Check if Firebase Admin is configured and initialized
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
          console.log(`☁️ Uploading avatar ${filename} to Firebase Storage...`);
          newAvatarUrl = await uploadFileToFirebase(localFilePath, filename);
          console.log(`☁️ Uploaded successfully to Firebase Storage: ${newAvatarUrl}`);

          // Delete the temporary file on local disk
          if (fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
          }
        } catch (fbUploadErr) {
          console.error('Failed to upload to Firebase Storage, falling back to local storage:', fbUploadErr);
        }
      }

      // Delete old avatar if it exists and is different from the new one
      if (user.avatarUrl && user.avatarUrl !== newAvatarUrl) {
        try {
          if (user.avatarUrl.startsWith('/uploads')) {
            const oldRelativePath = user.avatarUrl.replace('/uploads', '');
            const oldAbsolutePath = path.join(UPLOADS_DIR, oldRelativePath);
            if (fs.existsSync(oldAbsolutePath)) {
              fs.unlinkSync(oldAbsolutePath);
              console.log(`🧹 Deleted old avatar file from disk: ${oldAbsolutePath}`);
            }
          } else if (isFbInit && adminSdk && (user.avatarUrl.includes('storage.googleapis.com') || user.avatarUrl.includes('firebasestorage.googleapis.com'))) {
            try {
              const bucket = adminSdk.storage().bucket();
              const gcsPrefix = `https://storage.googleapis.com/${bucket.name}/`;
              const fbPrefix = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/`;
              
              let firebaseFilePath = null;
              if (user.avatarUrl.startsWith(gcsPrefix)) {
                firebaseFilePath = user.avatarUrl.replace(gcsPrefix, '');
              } else if (user.avatarUrl.startsWith(fbPrefix)) {
                const urlWithoutParams = user.avatarUrl.split('?')[0];
                firebaseFilePath = decodeURIComponent(urlWithoutParams.replace(fbPrefix, ''));
              }

              if (firebaseFilePath) {
                const fileRef = bucket.file(firebaseFilePath);
                await fileRef.delete();
                console.log(`🧹 Deleted old avatar from Firebase Storage: ${firebaseFilePath}`);
              }
            } catch (fbDelErr) {
              console.warn('Failed to delete old avatar from Firebase Storage:', fbDelErr.message);
            }
          }
        } catch (unlinkErr) {
          console.error('Failed to clean up old avatar file:', unlinkErr);
        }
      }
      
      avatarUrl = newAvatarUrl;
    }

    const newDisplayName = displayName !== undefined ? displayName.trim() : user.displayName;
    const newBio = bio !== undefined ? bio.trim() : user.bio;
    const newThemeColor = themeColor !== undefined ? themeColor.trim() : (user.themeColor || 'green');
    const newFontSize = fontSize !== undefined ? fontSize.trim() : (user.fontSize || 'medium');
    const newTheme = theme !== undefined ? theme.trim() : (user.theme || 'dark');

    await db.run(`
      UPDATE users 
      SET displayName = ?, bio = ?, avatarUrl = ?, themeColor = ?, fontSize = ?, theme = ? 
      WHERE id = ?
    `, [newDisplayName, newBio, avatarUrl, newThemeColor, newFontSize, newTheme, req.user.id]);

    const updatedUser = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    return res.status(200).json({
      message: 'Profile updated successfully.',
      user: {
        ...updatedUser,
        themeColor: updatedUser.themeColor || 'green',
        fontSize: updatedUser.fontSize || 'medium',
        theme: updatedUser.theme || 'dark'
      }
    });
  } catch (err) {
    console.error('Error updating profile:', err);
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
}

// Permanently delete own user account
export async function deleteSelf(req, res) {
  try {
    const db = await getDb();
    
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Security check: Admins cannot delete their own profiles
    if (user.role === 'admin') {
      return res.status(400).json({ error: 'Admins cannot delete their own profiles.' });
    }

    // Delete user (ON DELETE CASCADE handles all related records automatically)
    await db.run('DELETE FROM users WHERE id = ?', [req.user.id]);

    return res.status(200).json({
      message: 'Your profile and all associated data have been permanently deleted.'
    });
  } catch (err) {
    console.error('Error deleting own profile:', err);
    return res.status(500).json({ error: 'Failed to delete your profile account.' });
  }
}

// Search users to add as friends
export async function searchUsers(req, res) {
  const { query } = req.query;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters long.' });
  }

  try {
    const db = await getDb();
    const cleanQuery = `%${query.trim().toLowerCase()}%`;

    // Search users by email or display name, excluding the current user
    const users = await db.all(`
      SELECT id, email, displayName, avatarUrl, bio, status, lastSeen
      FROM users
      WHERE (LOWER(email) LIKE ? OR LOWER(displayName) LIKE ?)
        AND id != ?
      LIMIT 15
    `, [cleanQuery, cleanQuery, req.user.id]);

    // For each user found, check friendship status with current user
    const userIds = users.map(u => u.id);
    if (userIds.length === 0) {
      return res.status(200).json([]);
    }

    const friendships = await db.all(`
      SELECT friendId, status 
      FROM friends 
      WHERE userId = ? AND friendId IN (${userIds.map(() => '?').join(',')})
    `, [req.user.id, ...userIds]);

    const friendshipMap = {};
    friendships.forEach(f => {
      friendshipMap[f.friendId] = f.status;
    });

    const result = users.map(u => ({
      ...u,
      friendshipStatus: friendshipMap[u.id] || 'none' // 'none', 'pending_sent', 'pending_received', 'accepted'
    }));

    return res.status(200).json(result);
  } catch (err) {
    console.error('Error searching users:', err);
    return res.status(500).json({ error: 'Failed to search users.' });
  }
}

// List all friends (accepted and pending)
export async function getFriends(req, res) {
  try {
    const db = await getDb();
    
    // Get all friendships for this user, joining user details of the friend
    const friends = await db.all(`
      SELECT u.id, u.email, u.displayName, u.avatarUrl, u.bio, u.status, u.lastSeen, f.status AS friendshipStatus, f.createdAt
      FROM friends f
      JOIN users u ON f.friendId = u.id
      WHERE f.userId = ?
      ORDER BY f.status ASC, u.displayName ASC
    `, [req.user.id]);

    // Fetch all pinned, blocked, and hidden entries for this user in one go
    const pinnedRows = await db.all('SELECT friendId FROM pinned_chats WHERE userId = ?', [req.user.id]);
    const blockedRows = await db.all('SELECT blockedId FROM blocked_users WHERE userId = ?', [req.user.id]);
    const hiddenRows = await db.all('SELECT friendId FROM hidden_chats WHERE userId = ?', [req.user.id]);

    const pinnedSet = new Set(pinnedRows.map(r => r.friendId));
    const blockedSet = new Set(blockedRows.map(r => r.blockedId));
    const hiddenSet = new Set(hiddenRows.map(r => r.friendId));

    const result = [];
    for (const friend of friends) {
      const chatId = [req.user.id, friend.id].sort().join('_');
      
      const lastMessage = await db.get(`
        SELECT m.*, u.displayName AS senderName
        FROM messages m
        JOIN users u ON m.senderId = u.id
        WHERE m.chatId = ?
        ORDER BY m.createdAt DESC
        LIMIT 1
      `, [chatId]);

      const unreadCountRow = await db.get(`
        SELECT COUNT(*) AS count 
        FROM messages 
        WHERE chatId = ? AND senderId = ? AND status != 'read'
      `, [chatId, friend.id]);

      result.push({
        ...friend,
        lastMessage: lastMessage || null,
        unreadCount: unreadCountRow ? unreadCountRow.count : 0,
        isPinned: pinnedSet.has(friend.id),
        isBlocked: blockedSet.has(friend.id),
        isHidden: hiddenSet.has(friend.id)
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Error getting friends:', err);
    return res.status(500).json({ error: 'Failed to retrieve friends list.' });
  }
}

// Send a friend request
export async function sendFriendRequest(req, res) {
  const { friendId } = req.body;
  if (!friendId) {
    return res.status(400).json({ error: 'Friend ID is required.' });
  }
  if (friendId === req.user.id) {
    return res.status(400).json({ error: 'You cannot send a friend request to yourself.' });
  }

  try {
    const db = await getDb();
    
    // Check if target user exists
    const friendUser = await db.get('SELECT * FROM users WHERE id = ?', [friendId]);
    if (!friendUser) {
      return res.status(404).json({ error: 'Target user not found.' });
    }

    // Check if already friends/pending
    const existing = await db.get(`
      SELECT * FROM friends 
      WHERE userId = ? AND friendId = ?
    `, [req.user.id, friendId]);

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({ error: 'You are already friends with this user.' });
      } else if (existing.status === 'pending_sent') {
        return res.status(400).json({ error: 'Friend request already sent.' });
      } else if (existing.status === 'pending_received') {
        // Automatically accept since they sent one to us already!
        return respondFriendRequest(req, res); // Forward to accept
      }
    }

    const now = Date.now();
    
    // Create double-linked friendship rows for quick bidirectional querying
    await db.run('BEGIN TRANSACTION');
    
    await db.run(`
      INSERT INTO friends (userId, friendId, status, createdAt)
      VALUES (?, ?, 'pending_sent', ?)
    `, [req.user.id, friendId, now]);

    await db.run(`
      INSERT INTO friends (userId, friendId, status, createdAt)
      VALUES (?, ?, 'pending_received', ?)
    `, [friendId, req.user.id, now]);

    await db.run('COMMIT');

    // Emit real-time socket notification to the recipient
    const currentUser = await db.get(`
      SELECT id, email, displayName, avatarUrl, bio, status, lastSeen 
      FROM users WHERE id = ?
    `, [req.user.id]);
    emitToUser(friendId, 'friend_request', { sender: currentUser });

    return res.status(200).json({ 
      message: 'Friend request sent successfully.',
      friendshipStatus: 'pending_sent'
    });
  } catch (err) {
    console.error('Error sending friend request:', err);
    try {
      const db = await getDb();
      await db.run('ROLLBACK');
    } catch (rerr) {}
    return res.status(500).json({ error: 'Failed to send friend request.' });
  }
}

// Accept or Reject a friend request
export async function respondFriendRequest(req, res) {
  const { friendId, accept } = req.body; // accept is a boolean
  if (!friendId || accept === undefined) {
    return res.status(400).json({ error: 'Friend ID and response status (accept) are required.' });
  }

  try {
    const db = await getDb();
    
    // Check if request exists
    const request = await db.get(`
      SELECT * FROM friends 
      WHERE userId = ? AND friendId = ? AND status = 'pending_received'
    `, [req.user.id, friendId]);

    if (!request) {
      return res.status(404).json({ error: 'No pending friend request found from this user.' });
    }

    await db.run('BEGIN TRANSACTION');

    if (accept) {
      // Update both rows to accepted
      await db.run(`
        UPDATE friends SET status = 'accepted' 
        WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)
      `, [req.user.id, friendId, friendId, req.user.id]);
      
      await db.run('COMMIT');

      // Emit real-time socket notification to the sender
      const currentUser = await db.get(`
        SELECT id, email, displayName, avatarUrl, bio, status, lastSeen 
        FROM users WHERE id = ?
      `, [req.user.id]);
      emitToUser(friendId, 'friend_accept', { friend: currentUser });

      return res.status(200).json({ 
        message: 'Friend request accepted.',
        friendshipStatus: 'accepted'
      });
    } else {
      // Delete both rows
      await db.run(`
        DELETE FROM friends 
        WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)
      `, [req.user.id, friendId, friendId, req.user.id]);

      await db.run('COMMIT');

      // Emit real-time socket notification to the sender
      emitToUser(friendId, 'friend_decline', { friendId: req.user.id });

      return res.status(200).json({ 
        message: 'Friend request declined.',
        friendshipStatus: 'none'
      });
    }
  } catch (err) {
    console.error('Error responding to friend request:', err);
    try {
      const db = await getDb();
      await db.run('ROLLBACK');
    } catch (rerr) {}
    return res.status(500).json({ error: 'Failed to process friend request response.' });
  }
}

// Remove a friend
export async function removeFriend(req, res) {
  const { friendId } = req.body;
  if (!friendId) {
    return res.status(400).json({ error: 'Friend ID is required.' });
  }

  try {
    const db = await getDb();
    
    const friendship = await db.get(`
      SELECT * FROM friends 
      WHERE userId = ? AND friendId = ? AND status = 'accepted'
    `, [req.user.id, friendId]);

    if (!friendship) {
      return res.status(404).json({ error: 'Friendship not found.' });
    }

    await db.run('BEGIN TRANSACTION');
    
    // Delete both friendship rows
    await db.run(`
      DELETE FROM friends 
      WHERE (userId = ? AND friendId = ?) OR (userId = ? AND friendId = ?)
    `, [req.user.id, friendId, friendId, req.user.id]);

    // Delete messages between the two users (optional, but keeps DB clean. Let's keep messages for history or delete? The WhatsApp standard keeps them, but let's keep them and just delete friendship).
    
    await db.run('COMMIT');
    return res.status(200).json({ message: 'Friend removed successfully.' });
  } catch (err) {
    console.error('Error removing friend:', err);
    try {
      const db = await getDb();
      await db.run('ROLLBACK');
    } catch (rerr) {}
    return res.status(500).json({ error: 'Failed to remove friend.' });
  }
}

// Block a user
export async function blockUser(req, res) {
  const { blockedId } = req.body;
  if (!blockedId) return res.status(400).json({ error: 'User ID to block is required.' });

  try {
    const db = await getDb();
    await db.run(
      'INSERT OR IGNORE INTO blocked_users (userId, blockedId, createdAt) VALUES (?, ?, ?)',
      [req.user.id, blockedId, Date.now()]
    );
    return res.status(200).json({ message: 'User blocked successfully.' });
  } catch (err) {
    console.error('Error blocking user:', err);
    return res.status(500).json({ error: 'Failed to block user.' });
  }
}

// Unblock a user
export async function unblockUser(req, res) {
  const { blockedId } = req.body;
  if (!blockedId) return res.status(400).json({ error: 'User ID to unblock is required.' });

  try {
    const db = await getDb();
    await db.run(
      'DELETE FROM blocked_users WHERE userId = ? AND blockedId = ?',
      [req.user.id, blockedId]
    );
    return res.status(200).json({ message: 'User unblocked successfully.' });
  } catch (err) {
    console.error('Error unblocking user:', err);
    return res.status(500).json({ error: 'Failed to unblock user.' });
  }
}

// Pin a chat
export async function pinChat(req, res) {
  const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'Friend ID is required.' });

  try {
    const db = await getDb();
    const chatId = [req.user.id, friendId].sort().join('_');
    await db.run(
      'INSERT OR IGNORE INTO pinned_chats (userId, chatId, friendId, createdAt) VALUES (?, ?, ?, ?)',
      [req.user.id, chatId, friendId, Date.now()]
    );
    return res.status(200).json({ message: 'Chat pinned successfully.' });
  } catch (err) {
    console.error('Error pinning chat:', err);
    return res.status(500).json({ error: 'Failed to pin chat.' });
  }
}

// Unpin a chat
export async function unpinChat(req, res) {
  const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'Friend ID is required.' });

  try {
    const db = await getDb();
    await db.run(
      'DELETE FROM pinned_chats WHERE userId = ? AND friendId = ?',
      [req.user.id, friendId]
    );
    return res.status(200).json({ message: 'Chat unpinned successfully.' });
  } catch (err) {
    console.error('Error unpinning chat:', err);
    return res.status(500).json({ error: 'Failed to unpin chat.' });
  }
}

// Hide a chat (remove from sidebar without deleting friendship)
export async function hideChat(req, res) {
  const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'Friend ID is required.' });

  try {
    const db = await getDb();
    await db.run(
      'INSERT OR IGNORE INTO hidden_chats (userId, friendId, createdAt) VALUES (?, ?, ?)',
      [req.user.id, friendId, Date.now()]
    );
    // Also unpin if pinned
    await db.run(
      'DELETE FROM pinned_chats WHERE userId = ? AND friendId = ?',
      [req.user.id, friendId]
    );
    return res.status(200).json({ message: 'Chat hidden successfully.' });
  } catch (err) {
    console.error('Error hiding chat:', err);
    return res.status(500).json({ error: 'Failed to hide chat.' });
  }
}

// Unhide a chat (restore to sidebar when user messages again)
export async function unhideChat(req, res) {
  const { friendId } = req.body;
  if (!friendId) return res.status(400).json({ error: 'Friend ID is required.' });

  try {
    const db = await getDb();
    await db.run(
      'DELETE FROM hidden_chats WHERE userId = ? AND friendId = ?',
      [req.user.id, friendId]
    );
    return res.status(200).json({ message: 'Chat restored successfully.' });
  } catch (err) {
    console.error('Error unhiding chat:', err);
    return res.status(500).json({ error: 'Failed to restore chat.' });
  }
}
