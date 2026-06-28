import fs from 'fs';
import path from 'path';
import { UPLOADS_DIR } from '../config/config.js';
import { getDb } from '../db/sqlite.js';

// Post a status/story
export async function createStory(req, res) {
  const { caption } = req.body;
  if (!req.file) {
    return res.status(400).json({ error: 'A media file (image or video) is required.' });
  }

  try {
    const db = await getDb();
    const storyId = 'sty_' + Date.now() + Math.random().toString(36).substr(2, 9);
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours from now

    // Determine media type
    const mime = req.file.mimetype;
    const mediaType = mime.startsWith('video/') ? 'video' : 'image';
    
    const localFilePath = req.file.path;
    const filename = req.file.filename;
    let mediaUrl = `/uploads/media/${filename}`;

    // Check if Firebase Admin is configured and initialized
    let isFbInit = false;
    let adminSdk = null;
    try {
      const fbModule = await import('../db/firebase.js');
      isFbInit = fbModule.isInitialized;
      adminSdk = fbModule.admin;
    } catch (fbImportErr) {
      console.warn('Firebase module import failed:', fbImportErr.message);
    }

    if (isFbInit && adminSdk) {
      try {
        const { uploadFileToFirebase } = await import('../services/storage.service.js');
        console.log(`☁️ Uploading story media ${filename} to Firebase Storage...`);
        mediaUrl = await uploadFileToFirebase(localFilePath, filename, 'media');
        console.log(`☁️ Uploaded successfully to Firebase Storage: ${mediaUrl}`);

        // Delete the temporary file on local disk
        if (fs.existsSync(localFilePath)) {
          fs.unlinkSync(localFilePath);
        }
      } catch (fbUploadErr) {
        console.error('Failed to upload to Firebase Storage, falling back to local storage:', fbUploadErr);
      }
    }

    await db.run(`
      INSERT INTO stories (id, userId, mediaUrl, mediaType, caption, expiresAt, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [storyId, req.user.id, mediaUrl, mediaType, caption ? caption.trim() : null, expiresAt, now]);

    const story = await db.get('SELECT * FROM stories WHERE id = ?', [storyId]);
    return res.status(201).json({
      message: 'Status posted successfully.',
      story
    });
  } catch (err) {
    console.error('Error creating story:', err);
    return res.status(500).json({ error: 'Failed to post status.' });
  }
}

// Get active stories of friends and oneself
export async function getStories(req, res) {
  try {
    const db = await getDb();
    const now = Date.now();

    // Retrieve active stories from friends (accepted), the user themselves, and admin accounts
    const stories = await db.all(`
      SELECT s.*, u.displayName, u.avatarUrl
      FROM stories s
      JOIN users u ON s.userId = u.id
      WHERE s.expiresAt > ?
        AND (
          s.userId = ? 
          OR u.role = 'admin'
          OR s.userId IN (
            SELECT friendId FROM friends WHERE userId = ? AND status = 'accepted'
          )
        )
      ORDER BY s.createdAt ASC
    `, [now, req.user.id, req.user.id]);

    // Group stories by userId for a cohesive feeds interface
    const groupedStories = {};
    for (const story of stories) {
      if (!groupedStories[story.userId]) {
        groupedStories[story.userId] = {
          userId: story.userId,
          displayName: story.displayName,
          avatarUrl: story.avatarUrl,
          stories: []
        };
      }

      // Check if current user has viewed this story
      const viewed = await db.get(`
        SELECT 1 FROM story_views 
        WHERE storyId = ? AND userId = ?
      `, [story.id, req.user.id]);

      groupedStories[story.userId].stories.push({
        id: story.id,
        mediaUrl: story.mediaUrl,
        mediaType: story.mediaType,
        caption: story.caption,
        createdAt: story.createdAt,
        expiresAt: story.expiresAt,
        viewed: !!viewed
      });
    }

    // Separate my stories from friends' stories
    const myStories = groupedStories[req.user.id] || null;
    const friendsStories = Object.values(groupedStories).filter(g => g.userId !== req.user.id);

    return res.status(200).json({
      myStories,
      friendsStories
    });
  } catch (err) {
    console.error('Error getting stories:', err);
    return res.status(500).json({ error: 'Failed to load status updates.' });
  }
}

// Record a view on a story
export async function viewStory(req, res) {
  const { storyId } = req.params;

  try {
    const db = await getDb();

    // Check if story exists and is not expired
    const story = await db.get('SELECT * FROM stories WHERE id = ? AND expiresAt > ?', [storyId, Date.now()]);
    if (!story) {
      return res.status(404).json({ error: 'Status not found or has expired.' });
    }

    // Don't record a view if it's the user's own story
    if (story.userId === req.user.id) {
      return res.status(200).json({ message: 'Viewing own status.' });
    }

    // Insert view record
    await db.run(`
      INSERT OR IGNORE INTO story_views (storyId, userId, viewedAt)
      VALUES (?, ?, ?)
    `, [storyId, req.user.id, Date.now()]);

    return res.status(200).json({ message: 'Status marked as viewed.' });
  } catch (err) {
    console.error('Error viewing story:', err);
    return res.status(500).json({ error: 'Failed to record status view.' });
  }
}

// Retrieve viewers of a story (only creator can see)
export async function getStoryViewers(req, res) {
  const { storyId } = req.params;

  try {
    const db = await getDb();

    // Check if story exists and is created by the user
    const story = await db.get('SELECT * FROM stories WHERE id = ?', [storyId]);
    if (!story) {
      return res.status(404).json({ error: 'Status not found.' });
    }

    if (story.userId !== req.user.id) {
      return res.status(403).json({ error: 'Access denied. You can only view list of viewers for your own status.' });
    }

    // Retrieve viewer profiles
    const viewers = await db.all(`
      SELECT u.id, u.displayName, u.avatarUrl, sv.viewedAt
      FROM story_views sv
      JOIN users u ON sv.userId = u.id
      WHERE sv.storyId = ?
      ORDER BY sv.viewedAt DESC
    `, [storyId]);

    return res.status(200).json(viewers);
  } catch (err) {
    console.error('Error getting story viewers:', err);
    return res.status(500).json({ error: 'Failed to retrieve status viewers.' });
  }
}
