import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { UPLOADS_DIR } from '../config/config.js';

// Setup disk storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = UPLOADS_DIR;
    
    if (file.fieldname === 'avatar') {
      folder = path.join(UPLOADS_DIR, 'avatars');
    } else {
      folder = path.join(UPLOADS_DIR, 'media');
    }
    
    // Ensure directory exists
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
    
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    // Generate secure, unique filename: timestamp + random + original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

// File filter for security
const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    // Videos
    'video/mp4', 'video/webm', 'video/quicktime',
    // Audio
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a', 'audio/webm',
    // Documents
    'application/pdf', 'application/msword', 
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip', 'text/plain'
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Upload rejected.'), false);
  }
};

// Limits
const limits = {
  fileSize: 50 * 1024 * 1024 // 50MB max file size
};

export const upload = multer({
  storage,
  fileFilter,
  limits
});

// Specific upload middlewares
export const uploadAvatar = upload.single('avatar');
export const uploadMedia = upload.single('media');
