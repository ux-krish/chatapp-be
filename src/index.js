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
  unhideChat
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
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
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
      console.log(`\n🚀 LYNQ SERVER RUNNING ON: http://localhost:${PORT}\n`);
    });
  } catch (err) {
    console.error('Critical failure: Could not start application server.', err);
    process.exit(1);
  }
}

startServer();
