import fs from 'fs';
import path from 'path';
import { UPLOADS_DIR } from '../config/config.js';
import { getDb } from '../db/sqlite.js';
import { emitToUser } from '../socket/socket.handler.js';
import { admin as firebaseAdmin, isInitialized as firebaseInitialized } from '../db/firebase.js';

const ONLINE_API_URL = process.env.ONLINE_API_URL || 'https://mychatapp-be-z1nx.onrender.com';

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
  const { displayName, bio, themeColor, fontSize, theme, chatBgPattern } = req.body;
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
    const newChatBgPattern = chatBgPattern !== undefined ? chatBgPattern.trim() : (user.chatBgPattern || 'dots');

    await db.run(`
      UPDATE users 
      SET displayName = ?, bio = ?, avatarUrl = ?, themeColor = ?, fontSize = ?, theme = ?, chatBgPattern = ? 
      WHERE id = ?
    `, [newDisplayName, newBio, avatarUrl, newThemeColor, newFontSize, newTheme, newChatBgPattern, req.user.id]);

    const updatedUser = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    return res.status(200).json({
      message: 'Profile updated successfully.',
      user: {
        ...updatedUser,
        themeColor: updatedUser.themeColor || 'green',
        fontSize: updatedUser.fontSize || 'medium',
        theme: updatedUser.theme || 'dark',
        chatBgPattern: updatedUser.chatBgPattern || 'dots'
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
    const lowered = query.trim().toLowerCase();

    // 1. Primary source — local SQLite `users` table
    const users = await db.all(`
      SELECT id, email, displayName, avatarUrl, bio, status, lastSeen
      FROM users
      WHERE (LOWER(email) LIKE ? OR LOWER(displayName) LIKE ?)
        AND id != ?
      LIMIT 15
    `, [cleanQuery, cleanQuery, req.user.id]);

    // 2. Secondary source — Firebase Authentication user list.
    //    Users registered via Google on another deployment (live backend, another
    //    machine, etc.) only exist in Firebase Auth, not in this SQLite file.
    //    When Firebase Admin is configured we look them up by email/name and
    //    auto-provision them into the local `users` table so they become
    //    permanently searchable from this backend going forward.
    if (firebaseInitialized && users.length < 10) {
      try {
        const fbUsers = await fetchFirebaseAuthUsers(lowered);
        if (fbUsers.length > 0) {
          const now = Date.now();
          for (const fbUser of fbUsers) {
            // Skip self
            if (fbUser.email && fbUser.email.toLowerCase() === req.user.email?.toLowerCase()) continue;
            // Skip if we already have a row with this email
            const existing = await db.get('SELECT id FROM users WHERE email = ?', [fbUser.email]);
            if (existing) continue;

            const userId = 'usr_fb_' + (fbUser.uid || Date.now().toString(36)) + '_' + Math.random().toString(36).substr(2, 6);
            await db.run(`
              INSERT INTO users (id, email, displayName, avatarUrl, bio, status, lastSeen, role, createdAt)
              VALUES (?, ?, ?, ?, ?, 'offline', ?, 'user', ?)
            `, [
              userId,
              fbUser.email,
              fbUser.displayName || fbUser.email.split('@')[0],
              fbUser.avatarUrl || null,
              'Hey there! I am using Talkzen.',
              now,
              now
            ]);
          }
          // Re-run the SQLite search now that Firebase users have been provisioned
          const refreshed = await db.all(`
            SELECT id, email, displayName, avatarUrl, bio, status, lastSeen
            FROM users
            WHERE (LOWER(email) LIKE ? OR LOWER(displayName) LIKE ?)
              AND id != ?
            LIMIT 15
          `, [cleanQuery, cleanQuery, req.user.id]);
          users.splice(0, users.length, ...refreshed);
        }
      } catch (fbErr) {
        console.warn('Firebase Auth fallback during search failed (non-fatal):', fbErr.message);
      }
    }

    // 3. Server-side fallback: if we still have few results and this is a local
    //    backend (no Firebase creds), try the online backend as a last resort.
    //    This helps when users registered on the live deployment but the local
    //    backend has no Firebase Admin SDK configured.
    if (users.length < 5 && !firebaseInitialized) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const altRes = await fetch(`${ONLINE_API_URL}/api/users/search?query=${encodeURIComponent(query.trim())}`, {
          method: 'GET',
          signal: controller.signal,
          headers: { 'Authorization': req.headers.authorization || '' },
        });
        clearTimeout(timer);
        if (altRes.ok) {
          const altData = await altRes.json();
          if (Array.isArray(altData)) {
            const seen = new Set(users.map(u => u.id));
            for (const u of altData) {
              if (!seen.has(u.id) && u.id !== req.user.id) {
                users.push(u);
                seen.add(u.id);
              }
            }
          }
        }
      } catch (_) {
        // Online backend unreachable — ignore
      }
    }

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

// Lookup users in Firebase Auth by email or display name.
// Returns a list of normalized user records: { uid, email, displayName, avatarUrl }.
async function fetchFirebaseAuthUsers(query) {
  if (!firebaseInitialized || typeof firebaseAdmin.auth !== 'function') return [];

  const results = [];
  const seen = new Set();
  const lowerQ = query.toLowerCase();

  try {
    // 2a. Try exact / prefix email lookup first (most reliable)
    const candidates = [];
    if (lowerQ.includes('@')) {
      candidates.push(query.trim());
      candidates.push(query.trim().toLowerCase());
    } else {
      // Try a few common email patterns from the typed name
      candidates.push(`${lowerQ}@gmail.com`);
      candidates.push(`${lowerQ}@yahoo.com`);
      candidates.push(`${lowerQ}@outlook.com`);
      candidates.push(`${lowerQ}@hotmail.com`);
      candidates.push(`${lowerQ}@icloud.com`);
      candidates.push(`${lowerQ}@protonmail.com`);
    }

    for (const email of candidates) {
      try {
        const fbUser = await firebaseAdmin.auth().getUserByEmail(email);
        if (fbUser && fbUser.email && !seen.has(fbUser.email.toLowerCase())) {
          seen.add(fbUser.email.toLowerCase());
          results.push({
            uid: fbUser.uid,
            email: fbUser.email,
            displayName: fbUser.displayName || (fbUser.email ? fbUser.email.split('@')[0] : 'User'),
            avatarUrl: fbUser.photoURL || null
          });
        }
      } catch (_) {
        // Email not found in Firebase — try the next candidate
      }
    }

    // 2b. Scan a page of Firebase Auth users and filter by name/email match.
    //     This catches users that exist in Firebase Auth but signed up on a
    //     different deployment with an unusual email pattern.
    if (results.length === 0 || query.length >= 3) {
      let nextPageToken = undefined;
      let pagesScanned = 0;
      while (pagesScanned < 5 && results.length < 15) {
        const listResult = await firebaseAdmin.auth().listUsers(100, nextPageToken);
        for (const fbUser of listResult.users) {
          const emailLower = (fbUser.email || '').toLowerCase();
          const nameLower = (fbUser.displayName || '').toLowerCase();
          if (!emailLower && !nameLower) continue;
          const match =
            (lowerQ.includes('@') && emailLower.includes(lowerQ)) ||
            (!lowerQ.includes('@') && (nameLower.includes(lowerQ) || emailLower.split('@')[0].includes(lowerQ)));
          if (match && !seen.has(emailLower)) {
            seen.add(emailLower);
            results.push({
              uid: fbUser.uid,
              email: fbUser.email,
              displayName: fbUser.displayName || (fbUser.email ? fbUser.email.split('@')[0] : 'User'),
              avatarUrl: fbUser.photoURL || null
            });
            if (results.length >= 15) break;
          }
        }
        nextPageToken = listResult.pageToken;
        pagesScanned += 1;
        if (!nextPageToken) break;
      }
    }
  } catch (err) {
    console.warn('fetchFirebaseAuthUsers encountered an error:', err.message);
  }

  return results;
}

// Admin-only utility: synchronise ALL Firebase Auth users into the local SQLite
// `users` table. Useful when first bringing up a fresh local backend that
// needs to be aware of users who originally registered via the live backend.
export async function syncFirebaseUsers(req, res) {
  try {
    const db = await getDb();
    if (!firebaseInitialized || typeof firebaseAdmin.auth !== 'function') {
      return res.status(503).json({ error: 'Firebase Admin SDK is not initialized on this backend.' });
    }

    let nextPageToken = undefined;
    let totalScanned = 0;
    let totalInserted = 0;
    let totalUpdated = 0;
    const now = Date.now();

    do {
      const listResult = await firebaseAdmin.auth().listUsers(200, nextPageToken);
      for (const fbUser of listResult.users) {
        totalScanned += 1;
        if (!fbUser.email) continue;

        const cleanEmail = fbUser.email.toLowerCase().trim();
        const existing = await db.get('SELECT id FROM users WHERE email = ?', [cleanEmail]);
        if (existing) {
          // Refresh avatar / displayName from Firebase if our local row is missing them
          await db.run(`
            UPDATE users SET displayName = COALESCE(NULLIF(?, ''), displayName),
                             avatarUrl = COALESCE(NULLIF(?, ''), avatarUrl)
            WHERE email = ?
          `, [fbUser.displayName || '', fbUser.photoURL || '', cleanEmail]);
          totalUpdated += 1;
          continue;
        }

        const userId = 'usr_fb_' + fbUser.uid + '_' + Math.random().toString(36).substr(2, 6);
        const displayName = fbUser.displayName || cleanEmail.split('@')[0];
        const avatarUrl = fbUser.photoURL || null;

        await db.run(`
          INSERT INTO users (id, email, displayName, avatarUrl, bio, status, lastSeen, role, createdAt)
          VALUES (?, ?, ?, ?, ?, 'offline', ?, 'user', ?)
        `, [userId, cleanEmail, displayName, avatarUrl, 'Hey there! I am using Talkzen.', now, now]);
        totalInserted += 1;
      }
      nextPageToken = listResult.pageToken;
    } while (nextPageToken);

    return res.status(200).json({
      message: 'Firebase Auth users synchronised into local database.',
      scanned: totalScanned,
      inserted: totalInserted,
      updated: totalUpdated
    });
  } catch (err) {
    console.error('Error syncing Firebase Auth users:', err);
    return res.status(500).json({ error: 'Failed to synchronise Firebase Auth users.' });
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
