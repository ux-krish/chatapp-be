import { jwtService } from '../services/jwt.service.js';
import { getDb } from '../db/sqlite.js';

// Map of userId -> Set of socketIds (supports multi-device login!)
const activeConnections = new Map();
let ioInstance = null;

export function emitToUser(userId, event, data) {
  if (ioInstance) {
    ioInstance.to(userId).emit(event, data);
    return true;
  }
  return false;
}

export function disconnectUserSockets(userId) {
  if (ioInstance) {
    ioInstance.in(userId).disconnectSockets(true);
    return true;
  }
  return false;
}

export function emitToRoom(room, event, data) {
  if (ioInstance) {
    ioInstance.to(room).emit(event, data);
    return true;
  }
  return false;
}

export function makeUserJoinRoom(userId, room) {
  if (ioInstance) {
    ioInstance.in(userId).socketsJoin(room);
    return true;
  }
  return false;
}

export function broadcastSystemEvent(event, data) {
  if (ioInstance) {
    ioInstance.emit(event, data);
    return true;
  }
  return false;
}


export function setupSocketHandler(io) {
  ioInstance = io;
  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    if (!token) {
      return next(new Error('Authentication error. No token provided.'));
    }

    const decoded = jwtService.verifyAccessToken(token);
    if (!decoded) {
      return next(new Error('Authentication error. Invalid token.'));
    }

    socket.user = decoded;
    next();
  });

  io.on('connection', async (socket) => {
    const userId = socket.user.id;
    
    // Track connection
    if (!activeConnections.has(userId)) {
      activeConnections.set(userId, new Set());
    }
    activeConnections.get(userId).add(socket.id);

    // Join personal room for 1-to-1 routing
    socket.join(userId);

    console.log(`User connected: ${socket.user.email} (Socket: ${socket.id})`);

    const db = await getDb();
    
    // 1. Mark user online and notify friends
    try {
      await db.run("UPDATE users SET status = 'online' WHERE id = ?", [userId]);
      
      // Get list of friends to notify them
      const friends = await db.all(`
        SELECT friendId FROM friends WHERE userId = ? AND status = 'accepted'
      `, [userId]);
      
      friends.forEach(f => {
        io.to(f.friendId).emit('user_status_change', {
          userId,
          status: 'online',
          lastSeen: Date.now()
        });
      });
    } catch (err) {
      console.error('Error marking user online:', err);
    }

    // 2. Join all group rooms the user is in
    try {
      const groups = await db.all(`
        SELECT groupId FROM group_members WHERE userId = ?
      `, [userId]);
      
      groups.forEach(g => {
        socket.join(g.groupId);
      });
    } catch (err) {
      console.error('Error joining group rooms:', err);
    }

    // 3. Handle sending a message
    socket.on('send_message', async (messageData, ack) => {
      const { id, chatId, receiverId, groupId, content, type, parentMessageId } = messageData;
      const now = Date.now();
      const msgId = id || 'msg_' + Date.now() + Math.random().toString(36).substr(2, 9);
      
      try {
        // Build message record
        const message = {
          id: msgId,
          chatId,
          senderId: userId,
          receiverId: receiverId || null,
          groupId: groupId || null,
          content,
          type: type || 'text',
          status: 'sent',
          parentMessageId: parentMessageId || null,
          isPinned: 0,
          isEdited: 0,
          createdAt: now
        };

        // Determine initial status based on recipient online status
        let isDelivered = false;
        if (receiverId) {
          const recipientSockets = activeConnections.get(receiverId);
          if (recipientSockets && recipientSockets.size > 0) {
            isDelivered = true;
            message.status = 'delivered';
          }
        }

        // Save message to database
        await db.run(`
          INSERT INTO messages (id, chatId, senderId, receiverId, groupId, content, type, status, parentMessageId, isPinned, isEdited, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
        `, [
          message.id,
          message.chatId,
          message.senderId,
          message.receiverId,
          message.groupId,
          message.content,
          message.type,
          message.status,
          message.parentMessageId,
          message.createdAt
        ]);

        // Fetch sender details for display
        const sender = await db.get('SELECT displayName, avatarUrl FROM users WHERE id = ?', [userId]);
        
        // Fetch parent details if replying to a specific message
        let parentDetails = {};
        if (parentMessageId) {
          const parentMsg = await db.get(`
            SELECT pm.content, pm.type, pm.senderId, u.displayName AS senderName
            FROM messages pm
            JOIN users u ON pm.senderId = u.id
            WHERE pm.id = ?
          `, [parentMessageId]);
          
          if (parentMsg) {
            parentDetails = {
              parentMessageContent: parentMsg.content,
              parentMessageType: parentMsg.type,
              parentMessageSenderId: parentMsg.senderId,
              parentMessageSenderName: parentMsg.senderName
            };
          }
        }

        const fullMessage = {
          ...message,
          senderName: sender.displayName,
          senderAvatar: sender.avatarUrl,
          ...parentDetails
        };

        // Send to recipient(s)
        if (groupId) {
          // Send to group members (Socket.IO handles broadcasting to all sockets in room)
          socket.to(groupId).emit('new_message', fullMessage);
        } else if (receiverId) {
          // Send to recipient's personal room
          socket.to(receiverId).emit('new_message', fullMessage);
        }

        // Acknowledge to sender and return the saved message
        if (ack) ack(fullMessage);
        
        // If delivered, notify sender via status update event
        if (isDelivered && receiverId) {
          io.to(userId).emit('message_status_update', {
            messageId: message.id,
            chatId,
            status: 'delivered'
          });
        }
      } catch (err) {
        console.error('Error handling send_message:', err);
        if (ack) ack({ error: 'Failed to send message.' });
      }
    });

    // 4. Handle typing indicators
    socket.on('typing', ({ chatId, receiverId, groupId, isTyping }) => {
      const payload = { chatId, userId, isTyping };
      if (groupId) {
        socket.to(groupId).emit('user_typing', payload);
      } else if (receiverId) {
        socket.to(receiverId).emit('user_typing', payload);
      }
    });

    // 5. Handle message status updates (e.g. read receipts)
    socket.on('mark_as_read', async ({ chatId, senderId }) => {
      try {
        // Update all unread messages from this sender in this chat to 'read'
        await db.run(`
          UPDATE messages 
          SET status = 'read' 
          WHERE chatId = ? AND senderId = ? AND status != 'read'
        `, [chatId, senderId]);

        // Notify the original sender
        io.to(senderId).emit('messages_read', {
          chatId,
          readerId: userId
        });
      } catch (err) {
        console.error('Error marking messages as read:', err);
      }
    });

    // 5.5 Handle modifying / editing a message
    socket.on('edit_message', async ({ messageId, chatId, content }, ack) => {
      try {
        // Validate sender
        const message = await db.get('SELECT senderId, groupId, receiverId FROM messages WHERE id = ?', [messageId]);
        if (!message) {
          if (ack) ack({ error: 'Message not found.' });
          return;
        }
        if (message.senderId !== userId) {
          if (ack) ack({ error: 'Unauthorized. You can only edit your own messages.' });
          return;
        }

        // Update database
        await db.run('UPDATE messages SET content = ?, isEdited = 1 WHERE id = ?', [content.trim(), messageId]);

        const updatedPayload = { messageId, chatId, content: content.trim(), isEdited: 1 };

        // Broadcast to recipient(s)
        if (message.groupId) {
          socket.to(message.groupId).emit('message_edited', updatedPayload);
        } else if (message.receiverId) {
          socket.to(message.receiverId).emit('message_edited', updatedPayload);
        }

        if (ack) ack({ status: 'ok', messageId, content: content.trim() });
      } catch (err) {
        console.error('Error editing message:', err);
        if (ack) ack({ error: 'Failed to edit message.' });
      }
    });

    // 5.6 Handle soft-deleting a message
    socket.on('delete_message', async ({ messageId, chatId }, ack) => {
      try {
        // Validate sender
        const message = await db.get('SELECT senderId, groupId, receiverId FROM messages WHERE id = ?', [messageId]);
        if (!message) {
          if (ack) ack({ error: 'Message not found.' });
          return;
        }
        if (message.senderId !== userId) {
          if (ack) ack({ error: 'Unauthorized. You can only delete your own messages.' });
          return;
        }

        // Soft delete message in database
        const deletedContent = 'This message was deleted';
        await db.run("UPDATE messages SET content = ?, type = 'deleted' WHERE id = ?", [deletedContent, messageId]);

        const deletedPayload = { messageId, chatId, content: deletedContent, type: 'deleted' };

        // Broadcast to recipient(s)
        if (message.groupId) {
          socket.to(message.groupId).emit('message_deleted', deletedPayload);
        } else if (message.receiverId) {
          socket.to(message.receiverId).emit('message_deleted', deletedPayload);
        }

        if (ack) ack({ status: 'ok', messageId, content: deletedContent, type: 'deleted' });
      } catch (err) {
        console.error('Error deleting message:', err);
        if (ack) ack({ error: 'Failed to delete message.' });
      }
    });

    // 5.7 Handle pinning a message
    socket.on('pin_message', async ({ messageId, chatId, isPinned }, ack) => {
      try {
        // Check if message exists
        const message = await db.get('SELECT groupId, receiverId FROM messages WHERE id = ?', [messageId]);
        if (!message) {
          if (ack) ack({ error: 'Message not found.' });
          return;
        }

        const pinVal = isPinned ? 1 : 0;
        await db.run('UPDATE messages SET isPinned = ? WHERE id = ?', [pinVal, messageId]);

        const pinnedPayload = { messageId, chatId, isPinned: pinVal };

        // Broadcast to recipient(s)
        if (message.groupId) {
          socket.to(message.groupId).emit('message_pinned', pinnedPayload);
        } else if (message.receiverId) {
          socket.to(message.receiverId).emit('message_pinned', pinnedPayload);
        }

        if (ack) ack({ status: 'ok', messageId, isPinned: pinVal });
      } catch (err) {
        console.error('Error pinning message:', err);
        if (ack) ack({ error: 'Failed to pin message.' });
      }
    });

    // 5.8 Handle reacting to a message with an emoji
    socket.on('react_message', async ({ messageId, chatId, reaction }, ack) => {
      try {
        // Check if message exists
        const message = await db.get('SELECT groupId, receiverId FROM messages WHERE id = ?', [messageId]);
        if (!message) {
          if (ack) ack({ error: 'Message not found.' });
          return;
        }

        await db.run('UPDATE messages SET reaction = ? WHERE id = ?', [reaction, messageId]);

        const reactionPayload = { messageId, chatId, reaction };

        // Broadcast to recipient(s)
        if (message.groupId) {
          socket.to(message.groupId).emit('message_reacted', reactionPayload);
        } else if (message.receiverId) {
          socket.to(message.receiverId).emit('message_reacted', reactionPayload);
        }

        if (ack) ack({ status: 'ok', messageId, reaction });
      } catch (err) {
        console.error('Error reacting to message:', err);
        if (ack) ack({ error: 'Failed to react to message.' });
      }
    });

    // 6. Handle manual status check
    socket.on('get_active_users', (ack) => {
      if (ack) {
        ack(Array.from(activeConnections.keys()));
      }
    });

    // 7. Disconnect
    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${socket.user.email} (Socket: ${socket.id})`);
      
      const userSockets = activeConnections.get(userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        
        // If no more active sockets for this user, they are officially offline
        if (userSockets.size === 0) {
          activeConnections.delete(userId);
          const offlineTime = Date.now();
          
          try {
            await db.run("UPDATE users SET status = 'offline', lastSeen = ? WHERE id = ?", [offlineTime, userId]);
            
            // Get friends to notify them
            const friends = await db.all(`
              SELECT friendId FROM friends WHERE userId = ? AND status = 'accepted'
            `, [userId]);
            
            friends.forEach(f => {
              io.to(f.friendId).emit('user_status_change', {
                userId,
                status: 'offline',
                lastSeen: offlineTime
              });
            });
          } catch (err) {
            console.error('Error marking user offline:', err);
          }
        }
      }
    });
  });
}
