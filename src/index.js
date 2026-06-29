import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';

import { PORT, UPLOADS_DIR, NODE_ENV } from './config/config.js';
import { getDb } from './db/sqlite.js';
import { authenticateToken } from './middleware/auth.middleware.js';
import { requireAdmin } from './middleware/admin.middleware.js';
import { uploadAvatar, uploadMedia } from './services/storage.service.js';
import { setupSocketHandler } from './socket/socket.handler.js';
import { isInitialized } from './db/firebase.js';

// Controller imports
import {
  requestOtp,
  verifyOtp,
  refreshToken,
  logout,
  googleAuth,
  registerWithPassword,
  loginWithPassword,
  verify2fa,
  updateSecuritySettings
} from './controllers/auth.controller.js';

import {
  getProfile,
  updateProfile,
  searchUsers,
  getFriends,
  sendFriendRequest,
  respondFriendRequest,
  removeFriend,
  deleteSelf,
  blockUser,
  unblockUser,
  pinChat,
  unpinChat,
  hideChat,
  unhideChat,
  syncFirebaseUsers
} from './controllers/user.controller.js';

import {
  getChatHistory,
  uploadMediaAttachment,
  createGroup,
  getGroups,
  getGroupInfo,
  addGroupMembers,
  leaveGroup,
  downloadFileProxy
} from './controllers/chat.controller.js';

import {
  createStory,
  getStories,
  viewStory,
  getStoryViewers
} from './controllers/story.controller.js';

import {
  getSystemStats,
  getAllUsers,
  updateUserRole,
  banUser,
  deleteUser,
  getAllChats,
  deleteGroup,
  deleteMessage,
  runDbMaintenance,
  broadcastSystemMessage
} from './controllers/admin.controller.js';

import {
  logCall,
  getCallHistory,
  clearCallHistory
} from './controllers/call.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy headers so express-rate-limit sees real client IPs behind Render/Vercel/etc.
app.set('trust proxy', 1);

const httpServer = createServer(app);

// Configure allowed origins dynamically to support local dev, vercel previews, and production domains
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.CLIENT_URL
].filter(Boolean);

const corsOrigin = (origin, callback) => {
  if (!origin) return callback(null, true);
  const isAllowed = allowedOrigins.includes(origin) ||
    origin.endsWith('.vercel.app') ||
    origin.endsWith('.netlify.app') ||
    origin.endsWith('.web.app') ||
    origin.endsWith('.github.io') ||
    origin.endsWith('.onrender.com') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1');
  if (isAllowed) {
    callback(null, true);
  } else {
    callback(null, false); // Block origin but do not crash Node process with uncaught Exception
  }
};

// Socket.IO configuration with CORS matching frontend
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// --- Security Protection Middlewares ---

// Secure HTTP Headers (configured to allow cross-origin image loading for static uploads and Google Auth popups)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));

// General API Rate Limiting (100 requests per 15 minutes)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  limit: 150, // Limit each IP to 150 requests per windowMs
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP address. Please try again in 15 minutes.' }
});

// Strict Authentication/OTP Rate Limiting (10 requests per hour to prevent brute force/spam)
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 12, // Limit each IP to 12 OTP requests/verifications per hour
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again in an hour.' }
});

// Middlewares
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static file serving for uploads (avatars, attachments, stories)
app.use('/uploads', express.static(UPLOADS_DIR));

// Health Check — placed BEFORE rate limiters so it is never throttled
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: Date.now(),
    version: '1.0.1',
    firebaseInitialized: isInitialized
  });
});

// Apply rate limiting AFTER health check
app.use('/api', generalLimiter);
app.use('/api/auth/otp', authLimiter);

// --- API Routes ---

// Authentication
app.post('/api/auth/otp/request', requestOtp);
app.post('/api/auth/otp/verify', verifyOtp);
app.post('/api/auth/token/refresh', refreshToken);
app.post('/api/auth/logout', logout);
app.post('/api/auth/google', googleAuth);
app.post('/api/auth/register', registerWithPassword);
app.post('/api/auth/login', loginWithPassword);
app.post('/api/auth/verify-2fa', verify2fa);

// Users & Profiles
app.get('/api/users/profile', authenticateToken, getProfile);
app.put('/api/users/profile', authenticateToken, uploadAvatar, updateProfile);
app.put('/api/users/profile/security', authenticateToken, updateSecuritySettings);
app.delete('/api/users/profile', authenticateToken, deleteSelf);
app.get('/api/users/search', authenticateToken, searchUsers);
app.post('/api/users/sync-from-firebase', authenticateToken, requireAdmin, syncFirebaseUsers);

// Friend System
app.get('/api/users/friends', authenticateToken, getFriends);
app.post('/api/users/friends/request', authenticateToken, sendFriendRequest);
app.post('/api/users/friends/respond', authenticateToken, respondFriendRequest);
app.delete('/api/users/friends/remove', authenticateToken, removeFriend);

// Block / Unblock
app.post('/api/users/block', authenticateToken, blockUser);
app.post('/api/users/unblock', authenticateToken, unblockUser);

// Pin / Unpin Chat
app.post('/api/users/chat/pin', authenticateToken, pinChat);
app.post('/api/users/chat/unpin', authenticateToken, unpinChat);

// Hide / Unhide Chat
app.post('/api/users/chat/hide', authenticateToken, hideChat);
app.post('/api/users/chat/unhide', authenticateToken, unhideChat);

// Chat & History
app.get('/api/chat/history/:chatId', authenticateToken, getChatHistory);
app.post('/api/chat/media/upload', authenticateToken, uploadMedia, uploadMediaAttachment);
app.get('/api/chat/download', authenticateToken, downloadFileProxy);

// Group Chats
app.post('/api/chat/groups', authenticateToken, uploadAvatar, createGroup);
app.get('/api/chat/groups', authenticateToken, getGroups);
app.get('/api/chat/groups/:groupId', authenticateToken, getGroupInfo);
app.post('/api/chat/groups/:groupId/members', authenticateToken, addGroupMembers);
app.post('/api/chat/groups/:groupId/leave', authenticateToken, leaveGroup);

// Status / Story
app.post('/api/stories', authenticateToken, uploadMedia, createStory);
app.get('/api/stories', authenticateToken, getStories);
app.post('/api/stories/:storyId/view', authenticateToken, viewStory);
app.get('/api/stories/:storyId/viewers', authenticateToken, getStoryViewers);

// Call History
app.post('/api/calls', authenticateToken, logCall);
app.get('/api/calls', authenticateToken, getCallHistory);
app.delete('/api/calls', authenticateToken, clearCallHistory);

// Admin Dashboard
app.get('/api/admin/stats', authenticateToken, requireAdmin, getSystemStats);
app.get('/api/admin/users', authenticateToken, requireAdmin, getAllUsers);
app.put('/api/admin/users/:userId/role', authenticateToken, requireAdmin, updateUserRole);
app.put('/api/admin/users/:userId/ban', authenticateToken, requireAdmin, banUser);
app.delete('/api/admin/users/:userId', authenticateToken, requireAdmin, deleteUser);
app.get('/api/admin/chats', authenticateToken, requireAdmin, getAllChats);
app.delete('/api/admin/chats/groups/:groupId', authenticateToken, requireAdmin, deleteGroup);
app.delete('/api/admin/messages/:messageId', authenticateToken, requireAdmin, deleteMessage);
app.post('/api/admin/maintenance', authenticateToken, requireAdmin, runDbMaintenance);
app.post('/api/admin/broadcast', authenticateToken, requireAdmin, uploadMedia, broadcastSystemMessage);

app.get('/mobile-login-gateway', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Talkzen Authentication</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      background-color: #09090b;
      color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: rgba(24, 24, 27, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 24px;
      padding: 32px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(20px);
    }
    .spinner {
      height: 48px;
      width: 48px;
      border: 4px solid rgba(16, 185, 129, 0.1);
      border-top-color: #10b981;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #ffffff;
    }
    p {
      color: #a1a1aa;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 24px;
    }
    .btn {
      background-color: #10b981;
      color: #09090b;
      border: none;
      padding: 12px 24px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: background-color 0.2s;
      width: 100%;
      display: inline-block;
      text-decoration: none;
      text-align: center;
    }
    .btn:hover {
      background-color: #34d399;
    }
    .error {
      color: #ef4444;
      font-size: 13px;
      margin-top: 16px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="spinner" class="spinner"></div>
    <h1 id="status">Connecting...</h1>
    <p id="description">Initializing secure authentication gateway...</p>
    <div id="action-container"></div>
  </div>

  <!-- Firebase App & Auth from CDN -->
  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
    import { getAuth, signInWithPopup, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

    // Parse config from query params
    const params = new URLSearchParams(window.location.search);
    const isMock = params.get('isMock') === 'true';
    const firebaseConfig = {
      apiKey: params.get('apiKey'),
      authDomain: params.get('authDomain'),
      projectId: params.get('projectId'),
      appId: params.get('appId')
    };

    const statusEl = document.getElementById('status');
    const descEl = document.getElementById('description');
    const actionEl = document.getElementById('action-container');

    const showError = (msg) => {
      statusEl.textContent = "Authentication Failed";
      descEl.innerHTML = '<span class="error">' + msg + '</span>';
      document.getElementById('spinner').style.display = 'none';
      actionEl.innerHTML = '<button onclick="window.location.reload()" class="btn">Retry Sign-In</button>';
    };

    if (isMock) {
      statusEl.textContent = "Processing Mock Sign-In...";
      descEl.textContent = "Exchanging mock developer credentials...";
      setTimeout(async () => {
        try {
          const response = await fetch('/api/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: 'mock_google_id_token' })
          });
          if (!response.ok) {
            throw new Error("Backend verification failed: " + response.statusText);
          }
          const data = await response.json();
          statusEl.textContent = "Authenticated!";
          descEl.textContent = "Redirecting you back to the Talkzen app...";
          document.getElementById('spinner').style.display = 'none';

          const deepLink = 'Talkzen://auth-success?accessToken=' + encodeURIComponent(data.accessToken) + '&refreshToken=' + encodeURIComponent(data.refreshToken);
          window.location.href = deepLink;
          actionEl.innerHTML = '<a href="' + deepLink + '" class="btn">Return to Talkzen App</a>';
        } catch (err) {
          showError(err.message);
        }
      }, 1200);
    } else {
      if (!firebaseConfig.apiKey || !firebaseConfig.authDomain) {
        showError("Missing Firebase configuration parameters in URL.");
      } else {
        try {
          const app = initializeApp(firebaseConfig);
          const auth = getAuth(app);
          const provider = new GoogleAuthProvider();
          provider.addScope('email');
          provider.addScope('profile');

          statusEl.textContent = "Google Sign-In Active";
          descEl.textContent = "Please complete the authentication popup to log into Talkzen.";

          signInWithPopup(auth, provider).then(async (result) => {
            statusEl.textContent = "Verifying Sign-In...";
            descEl.textContent = "Exchanging credentials with Talkzen Secure Servers...";
            const idToken = await result.user.getIdToken();

            const response = await fetch('/api/auth/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ idToken })
            });

            if (!response.ok) {
              throw new Error("Backend verification failed: " + response.statusText);
            }

            const data = await response.json();
            statusEl.textContent = "Authenticated!";
            descEl.textContent = "Redirecting you back to the Talkzen app...";
            document.getElementById('spinner').style.display = 'none';

            // Deep link redirect
            const deepLink = 'Talkzen://auth-success?accessToken=' + encodeURIComponent(data.accessToken) + '&refreshToken=' + encodeURIComponent(data.refreshToken);
            window.location.href = deepLink;

            actionEl.innerHTML = '<a href="' + deepLink + '" class="btn">Return to Talkzen App</a>' +
              '<p style="margin-top: 16px; font-size: 12px; color: #71717a;">If you are not redirected automatically, click the button above.</p>';
          }).catch((err) => {
            console.error(err);
            showError(err.message);
          });
        } catch (err) {
          console.error(err);
          showError(err.message);
        }
      }
    }
  </script>
</body>
</html>`);
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Initialize Socket.IO Handler
setupSocketHandler(io);

// Initialize DB and Listen
async function startServer() {
  try {
    console.log('Connecting to SQLite database...');
    await getDb();
    console.log('Database connected and schemas synchronized successfully.');

    httpServer.listen(PORT, () => {
      console.log(`\n🚀 Talkzen SERVER STATUS: ONLINE (LOCAL MODE)\n`);
    });
  } catch (err) {
    console.error('Critical failure: Could not start application server.', err);
    process.exit(1);
  }
}

startServer();
