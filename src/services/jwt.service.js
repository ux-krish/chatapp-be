import jwt from 'jsonwebtoken';
import {
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRY,
  JWT_REFRESH_EXPIRY
} from '../config/config.js';

class JwtService {
  generateAccessToken(payload) {
    return jwt.sign(payload, JWT_ACCESS_SECRET, { expiresIn: JWT_ACCESS_EXPIRY });
  }

  generateRefreshToken(payload) {
    return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRY });
  }

  verifyAccessToken(token) {
    try {
      return jwt.verify(token, JWT_ACCESS_SECRET);
    } catch (err) {
      return null;
    }
  }

  verifyRefreshToken(token) {
    try {
      return jwt.verify(token, JWT_REFRESH_SECRET);
    } catch (err) {
      return null;
    }
  }
}

export const jwtService = new JwtService();
