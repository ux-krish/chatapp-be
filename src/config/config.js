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
export const UPLOADS_DIR = path.join(ROOT_DIR, 'public/uploads');
export const DB_PATH = path.join(ROOT_DIR, 'database.sqlite');

export const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
export const OTP_MAX_ATTEMPTS = 5;

export const NODE_ENV = process.env.NODE_ENV || 'development';
