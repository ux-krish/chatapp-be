import { jwtService } from '../services/jwt.service.js';
import { getDb } from '../db/sqlite.js';

export async function authenticateToken(req, reqRes, next) {
  let token = null;
  
  // Try reading from Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
  
  // Try reading from cookies if not found in headers
  if (!token && req.cookies) {
    token = req.cookies.accessToken;
  }

  // Try reading from query parameters (useful for media downloads)
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return reqRes.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const decoded = jwtService.verifyAccessToken(token);
  if (!decoded) {
    return reqRes.status(403).json({ error: 'Invalid or expired token.' });
  }

  try {
    const db = await getDb();
    const user = await db.get('SELECT isBanned FROM users WHERE id = ?', [decoded.id]);
    
    if (user && user.isBanned === 1) {
      return reqRes.status(403).json({ error: 'Your account has been suspended by an administrator.' });
    }

    req.user = decoded;
    next();
  } catch (err) {
    console.error('Auth token validation database error:', err);
    return reqRes.status(500).json({ error: 'Internal security check failed.' });
  }
}
