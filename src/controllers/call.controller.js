import { getDb } from '../db/sqlite.js';

export async function logCall(req, res) {
  try {
    const db = await getDb();
    const { callerId, receiverId, status, duration } = req.body;
    const currentUserId = req.user.id;

    if (!callerId || !receiverId || !status) {
      return res.status(400).json({ error: 'Missing required calling attributes' });
    }

    // Ensure the caller or receiver is the current authenticated user
    if (callerId !== currentUserId && receiverId !== currentUserId) {
      return res.status(403).json({ error: 'Unauthorized to log this call' });
    }

    const callId = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    const createdAt = Date.now();
    const callDuration = duration || 0;

    await db.run(`
      INSERT INTO calls (id, callerId, receiverId, status, duration, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [callId, callerId, receiverId, status, callDuration, createdAt]);

    const savedCall = await db.get(`
      SELECT c.*, 
             u1.displayName as callerName, u1.avatarUrl as callerAvatar,
             u2.displayName as receiverName, u2.avatarUrl as receiverAvatar
      FROM calls c
      JOIN users u1 ON c.callerId = u1.id
      JOIN users u2 ON c.receiverId = u2.id
      WHERE c.id = ?
    `, [callId]);

    res.status(201).json(savedCall);
  } catch (err) {
    console.error('Error logging call:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

export async function getCallHistory(req, res) {
  try {
    const db = await getDb();
    const currentUserId = req.user.id;

    const callLogs = await db.all(`
      SELECT c.*, 
             u1.displayName as callerName, u1.avatarUrl as callerAvatar,
             u2.displayName as receiverName, u2.avatarUrl as receiverAvatar
      FROM calls c
      JOIN users u1 ON c.callerId = u1.id
      JOIN users u2 ON c.receiverId = u2.id
      WHERE c.callerId = ? OR c.receiverId = ?
      ORDER BY c.createdAt DESC
    `, [currentUserId, currentUserId]);

    res.status(200).json(callLogs);
  } catch (err) {
    console.error('Error fetching call history:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

export async function clearCallHistory(req, res) {
  try {
    const db = await getDb();
    const currentUserId = req.user.id;

    await db.run(`
      DELETE FROM calls
      WHERE callerId = ? OR receiverId = ?
    `, [currentUserId, currentUserId]);

    res.status(200).json({ message: 'Call history cleared successfully' });
  } catch (err) {
    console.error('Error clearing call history:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
