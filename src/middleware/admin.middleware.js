import { getDb } from '../db/sqlite.js';

export async function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access denied. User not authenticated.' });
  }

  try {
    const db = await getDb();
    const user = await db.get('SELECT role, isBanned FROM users WHERE id = ?', [req.user.id]);

    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    if (user.isBanned === 1) {
      return res.status(403).json({ error: 'Your account has been suspended by an administrator.' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Administrative privileges required.' });
    }

    // Attach role to req.user for down-stream logging
    req.user.role = user.role;
    next();
  } catch (err) {
    console.error('Error in requireAdmin middleware:', err);
    return res.status(500).json({ error: 'Internal server authorization check failed.' });
  }
}
