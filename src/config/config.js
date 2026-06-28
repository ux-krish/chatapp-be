import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = process.env.PORT || 5001;
export const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'secure-chat-app-access-secret-key-2026';
export const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'secure-chat-app-refresh-secret-key-2026';

export const JWT_ACCESS_EXPIRY = '15m';
export const JWT_REFRESH_EXPIRY = '7d';

// Root-relative paths
export const ROOT_DIR = path.resolve(__dirname, '../../');

// Render persistent disk auto-detection
let defaultDbPath = path.join(ROOT_DIR, 'database.sqlite');
let defaultUploadsDir = path.join(ROOT_DIR, 'public/uploads');

if (process.env.RENDER) {
  // Standard Render persistent path is /var/data
  if (fs.existsSync('/var/data')) {
    defaultDbPath = '/var/data/database.sqlite';
    defaultUploadsDir = '/var/data/uploads';
    // Ensure the uploads directory exists on the persistent volume
    if (!fs.existsSync(defaultUploadsDir)) {
      fs.mkdirSync(defaultUploadsDir, { recursive: true });
    }
  }
}

export const UPLOADS_DIR = process.env.UPLOADS_DIR || defaultUploadsDir;
export const DB_PATH = process.env.DB_PATH || defaultDbPath;

export const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
export const OTP_MAX_ATTEMPTS = 5;

// Automatically default NODE_ENV to production if running on Render
export const NODE_ENV = process.env.NODE_ENV || (process.env.RENDER ? 'production' : 'development');
