import fs from 'fs';
import path from 'path';
import { UPLOADS_DIR } from '../config/config.js';
import { getDb } from '../db/sqlite.js';
import { emitToUser, emitToRoom, makeUserJoinRoom } from '../socket/socket.handler.js';


// Retrieve chat history (direct messages or group)
export async function getChatHistory(req, res) {
  const { chatId } = req.params;
  const { limit = 50, before = null } = req.query;

  if (!chatId) {
    return res.status(400).json({ error: 'Chat ID is required.' });
  }

  try {
    const db = await getDb();
    
    // Check if user is authorized to view this chat
    // If it's a 1-to-1 chat, the chatId contains the user's ID
    const isOneToOne = chatId.startsWith('usr_');
    if (isOneToOne) {
      const userIds = chatId.split('_');
      // Verify current user is one of the participants
      // Format is usr_[time][rand]_usr_[time][rand] (which splits into ['usr', '[time][rand]', 'usr', '[time][rand]'] or similar, or we just check if it contains req.user.id)
      if (!chatId.includes(req.user.id)) {
        return res.status(403).json({ error: 'Access denied. You are not a participant in this chat.' });
      }
    } else {
      // It's a group chat. Verify user is a member of the group
      const membership = await db.get(`
        SELECT * FROM group_members 
        WHERE groupId = ? AND userId = ?
      `, [chatId, req.user.id]);

      if (!membership) {
        return res.status(403).json({ error: 'Access denied. You are not a member of this group.' });
      }
    }

    // Load messages with parent message details for replies
    let query = `
      SELECT 
        m.*, 
        u.displayName AS senderName, 
        u.avatarUrl AS senderAvatar,
        pm.content AS parentMessageContent,
        pm.type AS parentMessageType,
        pm.senderId AS parentMessageSenderId,
        pmu.displayName AS parentMessageSenderName
      FROM messages m
      JOIN users u ON m.senderId = u.id
      LEFT JOIN messages pm ON m.parentMessageId = pm.id
      LEFT JOIN users pmu ON pm.senderId = pmu.id
      WHERE m.chatId = ? AND (m.clearedForUsers IS NULL OR m.clearedForUsers NOT LIKE ?)
    `;
    const params = [chatId, '%,' + req.user.id + ',%'];

    if (before) {
      query += ` AND m.createdAt < ?`;
      params.push(parseInt(before));
    }

    query += ` ORDER BY m.createdAt DESC LIMIT ?`;
    params.push(parseInt(limit));

    const messages = await db.all(query, params);
    
    // Return messages in chronological order for the client
    return res.status(200).json(messages.reverse());
  } catch (err) {
    console.error('Error getting chat history:', err);
    return res.status(500).json({ error: 'Failed to load chat history.' });
  }
}

// Upload a media attachment
export async function uploadMediaAttachment(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No media file provided.' });
    }

    // Determine type from mimetype
    const mime = req.file.mimetype;
    let type = 'file';
    if (mime.startsWith('image/')) type = 'image';
    else if (mime.startsWith('video/')) type = 'video';
    else if (mime.startsWith('audio/')) type = 'audio';

    const localFilePath = req.file.path;
    const filename = req.file.filename;
    let mediaUrl = `/uploads/media/${filename}`;

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
        console.log(`☁️ Uploading media attachment ${filename} to Firebase Storage...`);
        mediaUrl = await uploadFileToFirebase(localFilePath, filename, 'media');
        console.log(`☁️ Uploaded successfully to Firebase Storage: ${mediaUrl}`);

        // Delete the temporary file on local disk
        if (fs.existsSync(localFilePath)) {
          fs.unlinkSync(localFilePath);
        }
      } catch (fbUploadErr) {
        console.error('Failed to upload to Firebase Storage, falling back to local storage:', fbUploadErr);
      }
    }

    return res.status(200).json({
      mediaUrl,
      type,
      filename: req.file.originalname,
      size: req.file.size
    });
  } catch (err) {
    console.error('Error uploading media:', err);
    return res.status(500).json({ error: 'Failed to upload media file.' });
  }
}

// Proxy file download endpoint to avoid CORS issues and force local download folder save
export async function downloadFileProxy(req, res) {
  const { url, filename } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  try {
    // If it is a local upload, serve directly from disk
    if (url.startsWith('/uploads')) {
      const relativePath = url.replace('/uploads', '');
      const absolutePath = path.join(UPLOADS_DIR, relativePath);
      if (fs.existsSync(absolutePath)) {
        return res.download(absolutePath, filename || path.basename(absolutePath));
      }
      return res.status(404).json({ error: 'File not found.' });
    }

    // Otherwise, fetch the file from remote (e.g. Firebase Storage)
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch remote resource.' });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    
    const safeFilename = filename || url.split('/').pop().split('?')[0] || 'download';
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return res.send(buffer);
  } catch (err) {
    console.error('Error in download file proxy:', err);
    return res.status(500).json({ error: 'Failed to download file.' });
  }
}

// Create a group chat
export async function createGroup(req, res) {
  const { name, description, members } = req.body; // members is a JSON array or string
  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'Group name is required.' });
  }

  try {
    const db = await getDb();
    const groupId = 'grp_' + Date.now() + Math.random().toString(36).substr(2, 9);
    const now = Date.now();

    let avatarUrl = null;
    if (req.file) {
      avatarUrl = `/uploads/avatars/${req.file.filename}`;
    }

    // Parse member IDs
    let memberIds = [];
    if (members) {
      memberIds = typeof members === 'string' ? JSON.parse(members) : members;
    }
    // Ensure creator is in the members list
    if (!memberIds.includes(req.user.id)) {
      memberIds.push(req.user.id);
    }

    await db.run('BEGIN TRANSACTION');

    // 1. Insert Group record
    await db.run(`
      INSERT INTO groups (id, name, description, avatarUrl, createdBy, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [groupId, name.trim(), description ? description.trim() : '', avatarUrl, req.user.id, now]);

    // 2. Insert Group Members
    for (const memberId of memberIds) {
      const role = memberId === req.user.id ? 'admin' : 'member';
      await db.run(`
        INSERT INTO group_members (groupId, userId, role, joinedAt)
        VALUES (?, ?, ?, ?)
      `, [groupId, memberId, role, now]);
    }

    // 3. Create a system message in the chat
    const msgId = 'msg_' + Date.now() + Math.random().toString(36).substr(2, 9);
    await db.run(`
      INSERT INTO messages (id, chatId, senderId, receiverId, groupId, content, type, status, createdAt)
      VALUES (?, ?, ?, NULL, ?, ?, 'text', 'sent', ?)
    `, [msgId, groupId, req.user.id, groupId, `Group "${name.trim()}" created by you`, now]);

    await db.run('COMMIT');

    const groupDetails = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
    const groupMembers = await db.all(`
      SELECT u.id, u.displayName, u.avatarUrl, u.status, u.lastSeen, gm.role
      FROM group_members gm
      JOIN users u ON gm.userId = u.id
      WHERE gm.groupId = ?
    `, [groupId]);

    // Make all initially added members join the socket room and notify them in real-time
    groupMembers.forEach(member => {
      makeUserJoinRoom(member.id, groupId);
      
      // If this is another user, notify them about being added
      if (member.id !== req.user.id) {
        emitToUser(member.id, 'added_to_group', {
          ...groupDetails,
          groupId: groupDetails.id,
          members: groupMembers,
          memberCount: groupMembers.length,
          lastMessage: {
            id: msgId,
            chatId: groupId,
            senderId: req.user.id,
            receiverId: null,
            groupId: groupId,
            content: `Group "${name.trim()}" created by you`,
            type: 'text',
            status: 'sent',
            createdAt: now
          }
        });
      }
    });

    return res.status(201).json({
      message: 'Group created successfully.',
      group: {
        ...groupDetails,
        members: groupMembers
      }
    });
  } catch (err) {
    console.error('Error creating group:', err);
    try {
      const db = await getDb();
      await db.run('ROLLBACK');
    } catch (rerr) {}
    return res.status(500).json({ error: 'Failed to create group.' });
  }
}

// List all groups the user is part of
export async function getGroups(req, res) {
  try {
    const db = await getDb();
    
    // Retrieve all groups where the user is a member
    const groups = await db.all(`
      SELECT g.*, gm.role AS userRole,
             (SELECT COUNT(*) FROM group_members WHERE groupId = g.id) AS memberCount
      FROM groups g
      JOIN group_members gm ON g.id = gm.groupId
      WHERE gm.userId = ?
      ORDER BY g.createdAt DESC
    `, [req.user.id]);

    // For each group, get the last message for preview
    const result = [];
    for (const group of groups) {
      const lastMessage = await db.get(`
        SELECT m.*, u.displayName AS senderName
        FROM messages m
        JOIN users u ON m.senderId = u.id
        WHERE m.groupId = ? AND (m.clearedForUsers IS NULL OR m.clearedForUsers NOT LIKE ?)
        ORDER BY m.createdAt DESC
        LIMIT 1
      `, [group.id, '%,' + req.user.id + ',%']);

      result.push({
        ...group,
        lastMessage: lastMessage || null
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Error getting groups:', err);
    return res.status(500).json({ error: 'Failed to retrieve groups.' });
  }
}

// Get group info and member list
export async function getGroupInfo(req, res) {
  const { groupId } = req.params;

  try {
    const db = await getDb();
    const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }

    // Verify membership
    const membership = await db.get(`
      SELECT * FROM group_members 
      WHERE groupId = ? AND userId = ?
    `, [groupId, req.user.id]);

    if (!membership) {
      return res.status(403).json({ error: 'Access denied. You are not a member of this group.' });
    }

    const members = await db.all(`
      SELECT u.id, u.displayName, u.avatarUrl, u.bio, u.status, u.lastSeen, gm.role
      FROM group_members gm
      JOIN users u ON gm.userId = u.id
      WHERE gm.groupId = ?
      ORDER BY gm.role DESC, u.displayName ASC
    `, [groupId]);

    return res.status(200).json({
      ...group,
      members
    });
  } catch (err) {
    console.error('Error getting group info:', err);
    return res.status(500).json({ error: 'Failed to retrieve group info.' });
  }
}

// Add members to a group
export async function addGroupMembers(req, res) {
  const { groupId } = req.params;
  const { members } = req.body; // array of user IDs

  if (!members || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'List of member IDs to add is required.' });
  }

  try {
    const db = await getDb();
    
    // Check if group exists and if current user is admin
    const checkRole = await db.get(`
      SELECT role FROM group_members 
      WHERE groupId = ? AND userId = ?
    `, [groupId, req.user.id]);

    if (!checkRole) {
      return res.status(403).json({ error: 'Access denied. You are not a member of this group.' });
    }
    if (checkRole.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Only group admins can add members.' });
    }

    const now = Date.now();
    await db.run('BEGIN TRANSACTION');

    const newlyAddedIds = [];

    for (const memberId of members) {
      // Check if user is already a member
      const exists = await db.get(`
        SELECT * FROM group_members 
        WHERE groupId = ? AND userId = ?
      `, [groupId, memberId]);

      if (!exists) {
        await db.run(`
          INSERT INTO group_members (groupId, userId, role, joinedAt)
          VALUES (?, ?, 'member', ?)
        `, [groupId, memberId, now]);

        // Post system message
        const user = await db.get('SELECT displayName FROM users WHERE id = ?', [memberId]);
        const msgId = 'msg_' + Date.now() + Math.random().toString(36).substr(2, 9);
        await db.run(`
          INSERT INTO messages (id, chatId, senderId, receiverId, groupId, content, type, status, createdAt)
          VALUES (?, ?, ?, NULL, ?, ?, 'text', 'sent', ?)
        `, [msgId, groupId, req.user.id, groupId, `${user.displayName} was added to the group`, now]);

        newlyAddedIds.push({ memberId, msgId });
      }
    }

    await db.run('COMMIT');

    const updatedMembers = await db.all(`
      SELECT u.id, u.displayName, u.avatarUrl, u.status, u.lastSeen, gm.role
      FROM group_members gm
      JOIN users u ON gm.userId = u.id
      WHERE gm.groupId = ?
      ORDER BY gm.role DESC, u.displayName ASC
    `, [groupId]);

    const groupDetails = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);

    // Perform real-time socket updates for newly added members
    for (const item of newlyAddedIds) {
      const { memberId, msgId } = item;
      
      // Make their sockets join the room
      makeUserJoinRoom(memberId, groupId);

      // Fetch the full system message from DB to broadcast it
      const systemMsg = await db.get(`
        SELECT m.*, u.displayName AS senderName
        FROM messages m
        JOIN users u ON m.senderId = u.id
        WHERE m.id = ?
      `, [msgId]);

      if (systemMsg) {
        // Broadcast the system message to the room
        emitToRoom(groupId, 'new_message', systemMsg);
      }

      // Notify the added user so their sidebar populates in real-time
      emitToUser(memberId, 'added_to_group', {
        ...groupDetails,
        groupId: groupDetails.id,
        members: updatedMembers,
        memberCount: updatedMembers.length,
        lastMessage: systemMsg || null
      });
    }

    return res.status(200).json({
      message: 'Members added successfully.',
      members: updatedMembers
    });
  } catch (err) {
    console.error('Error adding group members:', err);
    try {
      const db = await getDb();
      await db.run('ROLLBACK');
    } catch (rerr) {}
    return res.status(500).json({ error: 'Failed to add members.' });
  }
}

// Leave a group
export async function leaveGroup(req, res) {
  const { groupId } = req.params;

  try {
    const db = await getDb();
    
    // Check if membership exists
    const membership = await db.get(`
      SELECT role FROM group_members 
      WHERE groupId = ? AND userId = ?
    `, [groupId, req.user.id]);

    if (!membership) {
      return res.status(404).json({ error: 'You are not a member of this group.' });
    }

    await db.run('BEGIN TRANSACTION');

    // Remove membership
    await db.run(`
      DELETE FROM group_members 
      WHERE groupId = ? AND userId = ?
    `, [groupId, req.user.id]);

    const user = await db.get('SELECT displayName FROM users WHERE id = ?', [req.user.id]);
    const now = Date.now();
    const msgId = 'msg_' + Date.now() + Math.random().toString(36).substr(2, 9);

    // Insert system message indicating user left
    await db.run(`
      INSERT INTO messages (id, chatId, senderId, receiverId, groupId, content, type, status, createdAt)
      VALUES (?, ?, ?, NULL, ?, ?, 'text', 'sent', ?)
    `, [msgId, groupId, req.user.id, groupId, `${user.displayName} left the group`, now]);

    // If no members are left in the group, delete the group entirely
    const remainingCount = await db.get(`
      SELECT COUNT(*) AS count FROM group_members WHERE groupId = ?
    `, [groupId]);

    if (remainingCount.count === 0) {
      await db.run('DELETE FROM groups WHERE id = ?', [groupId]);
    } else if (membership.role === 'admin') {
      // If the leaving user was admin, elect a new admin
      const oldestMember = await db.get(`
        SELECT userId FROM group_members 
        WHERE groupId = ? 
        ORDER BY joinedAt ASC 
        LIMIT 1
      `, [groupId]);

      if (oldestMember) {
        await db.run(`
          UPDATE group_members SET role = 'admin' 
          WHERE groupId = ? AND userId = ?
        `, [groupId, oldestMember.userId]);
      }
    }

    await db.run('COMMIT');
    return res.status(200).json({ message: 'You have left the group.' });
  } catch (err) {
    console.error('Error leaving group:', err);
    try {
      const db = await getDb();
      await db.run('ROLLBACK');
    } catch (rerr) {}
    return res.status(500).json({ error: 'Failed to leave group.' });
  }
}

// Delete chat history (clear all messages in a direct message or group chat)
export async function deleteChatHistory(req, res) {
  const { chatId } = req.params;

  if (!chatId) {
    return res.status(400).json({ error: 'Chat ID is required.' });
  }

  try {
    const db = await getDb();

    // Check if user is authorized to clear this chat
    const isOneToOne = chatId.startsWith('usr_');
    if (isOneToOne) {
      if (!chatId.includes(req.user.id)) {
        return res.status(403).json({ error: 'Access denied. You are not a participant in this chat.' });
      }
    } else {
      // It's a group chat. Verify user is a member of the group
      const membership = await db.get(`
        SELECT * FROM group_members 
        WHERE groupId = ? AND userId = ?
      `, [chatId, req.user.id]);

      if (!membership) {
        return res.status(403).json({ error: 'Access denied. You are not a member of this group.' });
      }
    }

    // Mark messages as cleared for this requesting user only
    const userTag = ',' + req.user.id + ',';
    const userAppend = req.user.id + ',';
    const userSearch = '%,' + req.user.id + ',%';
    await db.run(`
      UPDATE messages 
      SET clearedForUsers = CASE 
        WHEN clearedForUsers IS NULL OR clearedForUsers = '' THEN ? 
        ELSE clearedForUsers || ? 
      END 
      WHERE chatId = ? AND (clearedForUsers IS NULL OR clearedForUsers NOT LIKE ?)
    `, [userTag, userAppend, chatId, userSearch]);

    // Broadcast via socket to the sender user only (so their client app clears local state)
    emitToUser(req.user.id, 'chat_history_cleared', { chatId, clearedBy: req.user.id });

    return res.status(200).json({ message: 'Chat history cleared successfully.' });
  } catch (err) {
    console.error('Error clearing chat history:', err);
    return res.status(500).json({ error: 'Failed to clear chat history.' });
  }
}

