import dns from 'dns';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/sqlite.js';
import { otpService } from '../services/otp.service.js';
import { jwtService } from '../services/jwt.service.js';
import { JWT_REFRESH_EXPIRY, NODE_ENV } from '../config/config.js';
import { admin, isInitialized } from '../db/firebase.js';

// Helper to serialize user objects safely without exposing credentials
const serializeUser = (user) => {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    status: user.status,
    lastSeen: user.lastSeen,
    role: user.role || 'user',
    isBanned: user.isBanned || 0,
    twoFactorEnabled: !!user.twoFactorEnabled,
    hasPassword: !!user.password,
    themeColor: user.themeColor || 'green',
    fontSize: user.fontSize || 'medium',
    theme: user.theme || 'dark',
    createdAt: user.createdAt
  };
};

// Convert helper like '7d' to milliseconds
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// Validate if email domain has MX or A records (exists and can receive mail)
function checkDomainDns(domain) {
  if (NODE_ENV === 'development' || global.firebase_mock_override) {
    console.log(`🌐 Bypassing DNS check for domain "${domain}" in development/test mode.`);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        return resolve(true);
      }
      // Fallback to A record check in case domain routes mail through A records directly
      dns.resolve4(domain, (err4, addresses4) => {
        if (!err4 && addresses4 && addresses4.length > 0) {
          return resolve(true);
        }
        resolve(false);
      });
    });
  });
}

export async function requestOtp(req, res) {
  const { email, mode } = req.body; // mode: 'login' | 'register'
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const cleanEmail = email.toLowerCase().trim();
    const domain = cleanEmail.split('@')[1];

    if (!domain) {
      return res.status(400).json({ error: 'Invalid email domain structure.' });
    }

    // Verify domain is real and has active mail routing records
    const isRealDomain = await checkDomainDns(domain);
    if (!isRealDomain) {
      return res.status(400).json({ error: 'The email domain does not exist or cannot receive mail. Please use a real email address.' });
    }

    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [cleanEmail]);

    if (mode === 'login' && !user) {
      return res.status(404).json({ error: 'This email is not registered. Please register first.' });
    }

    if (mode === 'register' && user) {
      return res.status(400).json({ error: 'This email is already registered. Please sign in.' });
    }

    // Bypass OTP verification entirely for administrators
    if (mode === 'login' && user && user.role === 'admin') {
      await db.run("UPDATE users SET status = 'online', lastSeen = ? WHERE id = ?", [Date.now(), user.id]);
      user.status = 'online';

      const payload = { id: user.id, email: user.email };
      const accessToken = jwtService.generateAccessToken(payload);
      const refreshToken = jwtService.generateRefreshToken(payload);

      res.cookie('accessToken', accessToken, {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000 // 15 mins
      });

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: REFRESH_COOKIE_MAX_AGE
      });

      return res.status(200).json({
        status: 'admin_auto_login',
        message: 'Admin authenticated without verification code.',
        user: serializeUser(user),
        accessToken,
        refreshToken
      });
    }

    const otp = await otpService.generateOtp(cleanEmail);

    // In development mode, return the OTP in the response for ease of testing
    const responseData = { message: 'OTP sent successfully.' };
    if (NODE_ENV === 'development') {
      responseData.otp = otp; // Frontend can auto-fill or print in console
    }

    return res.status(200).json(responseData);
  } catch (err) {
    console.error('Error requesting OTP:', err);
    return res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
  }
}

export async function verifyOtp(req, res) {
  const { email, otp, displayName, bio } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required.' });
  }

  try {
    const cleanEmail = email.toLowerCase().trim();
    const verification = await otpService.verifyOtp(cleanEmail, otp);

    if (!verification.valid) {
      return res.status(400).json({ error: verification.message });
    }

    // OTP is valid. Get or Create User
    const db = await getDb();
    let user = await db.get('SELECT * FROM users WHERE email = ?', [cleanEmail]);
    let isNewUser = false;

    if (!user) {
      // Block registration if display name was not provided (e.g. they tried to skip registration)
      if (!displayName) {
        return res.status(400).json({ error: 'Account not found. Please register first.' });
      }

      isNewUser = true;
      const userId = 'usr_' + Date.now() + Math.random().toString(36).substr(2, 9);
      const cleanDisplayName = displayName.trim();
      const avatarUrl = null; // Client will generate styled letter avatar or user can upload
      const cleanBio = bio ? bio.trim() : 'Hey there! I am using Talkzen.';
      const createdAt = Date.now();

      // Check if this is the first user in the system to assign admin role
      const usersCount = await db.get('SELECT COUNT(*) AS count FROM users');
      const role = usersCount.count === 0 ? 'admin' : 'user';

      await db.run(`
        INSERT INTO users (id, email, displayName, avatarUrl, bio, status, lastSeen, role, createdAt)
        VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?)
      `, [userId, cleanEmail, cleanDisplayName, avatarUrl, cleanBio, createdAt, role, createdAt]);

      user = { id: userId, email: cleanEmail, displayName: cleanDisplayName, avatarUrl, bio: cleanBio, status: 'online', role, lastSeen: createdAt, createdAt };
    } else {
      // Mark user online
      await db.run("UPDATE users SET status = 'online', lastSeen = ? WHERE id = ?", [Date.now(), user.id]);
      user.status = 'online';
    }

    // Generate Tokens
    const payload = { id: user.id, email: user.email };
    const accessToken = jwtService.generateAccessToken(payload);
    const refreshToken = jwtService.generateRefreshToken(payload);

    // Set cookies
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000 // 15 mins
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_COOKIE_MAX_AGE
    });

    return res.status(200).json({
      message: isNewUser ? 'Account created successfully.' : 'Logged in successfully.',
      user: serializeUser(user),
      accessToken,
      refreshToken
    });
  } catch (err) {
    console.error('Error verifying OTP:', err);
    return res.status(500).json({ error: 'Failed to verify OTP. Please try again.' });
  }
}

export async function refreshToken(req, res) {
  let token = null;

  // Try reading from Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // Try reading from cookies
  if (!token && req.cookies) {
    token = req.cookies.refreshToken;
  }

  if (!token) {
    return res.status(401).json({ error: 'Refresh token not found.' });
  }

  try {
    const decoded = jwtService.verifyRefreshToken(token);
    if (!decoded) {
      return res.status(403).json({ error: 'Invalid or expired refresh token.' });
    }

    // Get active user data
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const payload = { id: user.id, email: user.email };
    const newAccessToken = jwtService.generateAccessToken(payload);

    res.cookie('accessToken', newAccessToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000
    });

    return res.status(200).json({
      accessToken: newAccessToken,
      user: serializeUser(user)
    });
  } catch (err) {
    console.error('Error refreshing token:', err);
    return res.status(500).json({ error: 'Failed to refresh token.' });
  }
}

export async function logout(req, res) {
  try {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
    if (!token && req.cookies) {
      token = req.cookies.accessToken;
    }

    // If authenticated, set them offline in the database
    if (token) {
      const decoded = jwtService.verifyAccessToken(token);
      if (decoded) {
        const db = await getDb();
        await db.run("UPDATE users SET status = 'offline', lastSeen = ? WHERE id = ?", [Date.now(), decoded.id]);
      }
    }

    // Clear cookies
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');

    return res.status(200).json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.error('Error logging out:', err);
    return res.status(500).json({ error: 'Failed to logout.' });
  }
}

export async function googleAuth(req, res) {
  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ error: 'Google ID Token is required.' });
  }

  // Allow mock token in development or test environment
  const isDevOrTest = NODE_ENV === 'development' || global.firebase_mock_override;
  const isMockToken = idToken === 'mock_google_id_token' || idToken.startsWith('mock_');

  if (!isInitialized && !isDevOrTest) {
    return res.status(500).json({ error: 'Firebase Auth is currently not configured on this server.' });
  }

  try {
    let decodedToken;
    if (isDevOrTest && isMockToken) {
      console.log('🔄 Bypassing real Firebase verification for mock token in development/test...');
      if (typeof admin.auth === 'function') {
        try {
          decodedToken = await admin.auth().verifyIdToken(idToken);
        } catch (e) {
          // Fallback if call fails (e.g. uninitialized real SDK in local dev)
        }
      }
      if (!decodedToken) {
        decodedToken = {
          email: 'mockuser@example.com',
          name: 'Mock Developer',
          picture: 'https://lh3.googleusercontent.com/a/mock-avatar-url'
        };
      }
    } else {
      try {
        if (!isInitialized) {
          throw new Error('Firebase Admin SDK is not initialized on this server.');
        }
        // 1. Verify Google ID Token via Firebase Admin SDK
        decodedToken = await admin.auth().verifyIdToken(idToken);
      } catch (err) {
        // In development/test mode, fall back to decoding the token without signature verification
        if (isDevOrTest) {
          console.warn('⚠️ Firebase token verification failed. Falling back to decoding in development/test:', err.message);
          decodedToken = jwt.decode(idToken);
          if (!decodedToken) {
            throw err; // rethrow if it wasn't even a valid JWT
          }
        } else {
          throw err;
        }
      }
    }
    const { email, name, picture } = decodedToken;

    if (!email) {
      return res.status(400).json({ error: 'Email permission is required for Google Sign-In.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // 2. Get or Create User in SQLite
    const db = await getDb();
    let user = await db.get('SELECT * FROM users WHERE email = ?', [cleanEmail]);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const userId = 'usr_' + Date.now() + Math.random().toString(36).substr(2, 9);
      const displayName = name || cleanEmail.split('@')[0];
      const avatarUrl = picture || null;
      const bio = 'Hey there! I am using Talkzen.';
      const createdAt = Date.now();

      // Check if this is the first user in the system to assign admin role
      const usersCount = await db.get('SELECT COUNT(*) AS count FROM users');
      let role = usersCount.count === 0 ? 'admin' : 'user';

      // Always grant admin privileges to the Mock Developer account in development/test
      if (isDevOrTest && isMockToken && cleanEmail === 'mockuser@example.com') {
        role = 'admin';
      }

      await db.run(`
        INSERT INTO users (id, email, displayName, avatarUrl, bio, status, lastSeen, role, createdAt)
        VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?)
      `, [userId, cleanEmail, displayName, avatarUrl, bio, createdAt, role, createdAt]);

      user = { id: userId, email: cleanEmail, displayName, avatarUrl, bio, status: 'online', role, lastSeen: createdAt, createdAt };
    } else {
      // Mark user online, and sync their avatar from Google if they have one
      const avatarUrl = user.avatarUrl || picture || null;

      // Ensure the Mock Developer is updated to admin role if they login again in development/test
      let role = user.role;
      if (isDevOrTest && isMockToken && cleanEmail === 'mockuser@example.com') {
        role = 'admin';
      }

      await db.run(`
        UPDATE users 
        SET status = 'online', lastSeen = ?, avatarUrl = ?, role = ? 
        WHERE id = ?
      `, [Date.now(), avatarUrl, role, user.id]);
      user.status = 'online';
      user.avatarUrl = avatarUrl;
      user.role = role;
    }

    // 3. Generate Session JWTs
    const payload = { id: user.id, email: user.email };
    const accessToken = jwtService.generateAccessToken(payload);
    const refreshToken = jwtService.generateRefreshToken(payload);

    // 4. Set secure HTTP-only cookies
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000 // 15 mins
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_COOKIE_MAX_AGE
    });

    return res.status(200).json({
      message: isNewUser ? 'Account created successfully via Google.' : 'Logged in successfully via Google.',
      user: serializeUser(user),
      accessToken,
      refreshToken
    });
  } catch (err) {
    console.error('Error in Google auth:', err.message || err);

    // Provide specific error messages based on failure reason
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Google sign-in session expired. Please try signing in again.' });
    }
    if (err.code === 'auth/argument-error' || err.code === 'auth/invalid-credential') {
      return res.status(500).json({ error: 'Firebase Admin SDK credentials are misconfigured on the server. Please contact the administrator.' });
    }
    if (err.message && err.message.includes('Firebase Admin SDK is not initialized')) {
      return res.status(500).json({ error: 'Google Sign-In is not available. Firebase is not configured on this server.' });
    }

    return res.status(401).json({ error: 'Google sign-in failed. Please try again or use another sign-in method.' });
  }
}

// 1. Register with password
export async function registerWithPassword(req, res) {
  const { email, password, displayName, bio, otp } = req.body;
  if (!email || !password || !displayName || !otp || password.trim().length === 0 || displayName.trim().length === 0) {
    return res.status(400).json({ error: 'Email, password, display name, and verification code are required.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const domain = cleanEmail.split('@')[1];

  if (!domain) {
    return res.status(400).json({ error: 'Invalid email domain structure.' });
  }

  try {
    // Verify OTP first
    const verification = await otpService.verifyOtp(cleanEmail, otp);
    if (!verification.valid) {
      return res.status(400).json({ error: verification.message });
    }

    // Verify domain DNS records (real domain check)
    const isRealDomain = await checkDomainDns(domain);
    if (!isRealDomain) {
      return res.status(400).json({ error: 'The email domain does not exist or cannot receive mail.' });
    }

    const db = await getDb();

    // Check if user already exists
    const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [cleanEmail]);
    if (existingUser) {
      return res.status(400).json({ error: 'This email is already registered. Please sign in.' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = 'usr_' + Date.now() + Math.random().toString(36).substr(2, 9);
    const cleanDisplayName = displayName.trim();
    const cleanBio = bio ? bio.trim() : 'Hey there! I am using Talkzen.';
    const createdAt = Date.now();

    // Check if this is the first user in the system to assign admin role
    const usersCount = await db.get('SELECT COUNT(*) AS count FROM users');
    const role = usersCount.count === 0 ? 'admin' : 'user';

    // Save to DB
    await db.run(`
      INSERT INTO users (id, email, displayName, avatarUrl, bio, status, lastSeen, role, password, twoFactorEnabled, createdAt)
      VALUES (?, ?, ?, NULL, ?, 'online', ?, ?, ?, 0, ?)
    `, [userId, cleanEmail, cleanDisplayName, cleanBio, createdAt, role, hashedPassword, createdAt]);

    // Retrieve inserted user details
    const newUser = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

    // Generate Session Tokens
    const payload = { id: userId, email: cleanEmail };
    const accessToken = jwtService.generateAccessToken(payload);
    const refreshToken = jwtService.generateRefreshToken(payload);

    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_COOKIE_MAX_AGE
    });

    return res.status(201).json({
      message: 'Account created successfully.',
      user: serializeUser(newUser),
      accessToken,
      refreshToken
    });
  } catch (err) {
    console.error('Error in registerWithPassword:', err);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
}

// 2. Login with password (checks 2FA)
export async function loginWithPassword(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [cleanEmail]);

    if (!user) {
      return res.status(404).json({ error: 'This email is not registered. Please register first.' });
    }

    if (user.isBanned === 1) {
      return res.status(403).json({ error: 'This account has been suspended by administration.' });
    }

    // Verify password is set
    if (!user.password) {
      return res.status(400).json({ error: 'This account does not have a password configured. Please sign in via verification code or Google.' });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    // Check if Two-Factor Authentication (2FA) is enabled
    if (user.twoFactorEnabled === 1) {
      // Generate OTP and send to email
      const otp = await otpService.generateOtp(cleanEmail);

      const responseData = {
        status: '2fa_required',
        email: cleanEmail,
        message: 'Two-factor authentication code sent to email.'
      };

      if (NODE_ENV === 'development') {
        responseData.otp = otp;
      }

      return res.status(200).json(responseData);
    }

    // Standard Login
    await db.run("UPDATE users SET status = 'online', lastSeen = ? WHERE id = ?", [Date.now(), user.id]);

    const payload = { id: user.id, email: user.email };
    const accessToken = jwtService.generateAccessToken(payload);
    const refreshToken = jwtService.generateRefreshToken(payload);

    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_COOKIE_MAX_AGE
    });

    return res.status(200).json({
      message: 'Logged in successfully.',
      user: serializeUser(user),
      accessToken,
      refreshToken
    });
  } catch (err) {
    console.error('Error in loginWithPassword:', err);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
}

// 3. Verify 2FA OTP
export async function verify2fa(req, res) {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required.' });
  }

  try {
    const cleanEmail = email.toLowerCase().trim();
    const verification = await otpService.verifyOtp(cleanEmail, otp);

    if (!verification.valid) {
      return res.status(400).json({ error: verification.message });
    }

    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [cleanEmail]);

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.isBanned === 1) {
      return res.status(403).json({ error: 'This account has been suspended by administration.' });
    }

    // Set online
    await db.run("UPDATE users SET status = 'online', lastSeen = ? WHERE id = ?", [Date.now(), user.id]);

    const payload = { id: user.id, email: user.email };
    const accessToken = jwtService.generateAccessToken(payload);
    const refreshToken = jwtService.generateRefreshToken(payload);

    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000
    });

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_COOKIE_MAX_AGE
    });

    return res.status(200).json({
      message: 'Two-factor authentication verified successfully.',
      user: serializeUser(user),
      accessToken,
      refreshToken
    });
  } catch (err) {
    console.error('Error verifying 2FA OTP:', err);
    return res.status(500).json({ error: 'Failed to verify 2FA. Please try again.' });
  }
}

// 4. Update credentials & 2FA settings from profile/settings page
export async function updateSecuritySettings(req, res) {
  const { password, twoFactorEnabled } = req.body;
  const userId = req.user.id;

  try {
    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    let queryParts = [];
    let queryParams = [];

    // If password is provided, hash and update it
    if (password !== undefined) {
      if (password.trim().length === 0) {
        return res.status(400).json({ error: 'Password cannot be empty.' });
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      queryParts.push('password = ?');
      queryParams.push(hashedPassword);
    }

    // If twoFactorEnabled is provided, toggle it
    if (twoFactorEnabled !== undefined) {
      const val = twoFactorEnabled ? 1 : 0;
      queryParts.push('twoFactorEnabled = ?');
      queryParams.push(val);
    }

    if (queryParts.length > 0) {
      queryParams.push(userId);
      const query = `UPDATE users SET ${queryParts.join(', ')} WHERE id = ?`;
      await db.run(query, queryParams);
    }

    // Retrieve updated user details
    const updatedUser = await db.get('SELECT * FROM users WHERE id = ?', [userId]);

    return res.status(200).json({
      message: 'Security settings updated successfully.',
      user: serializeUser(updatedUser)
    });
  } catch (err) {
    console.error('Error in updateSecuritySettings:', err);
    return res.status(500).json({ error: 'Failed to update security settings.' });
  }
}
