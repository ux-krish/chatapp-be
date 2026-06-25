// Mock Redis caching & pub/sub service
class CacheService {
  constructor() {
    this.store = new Map();
    this.timeouts = new Map();
    this.channels = new Map(); // For Pub/Sub
  }

  // Key-Value Store
  async get(key) {
    return this.store.get(key) || null;
  }

  async set(key, value, expiryMs = null) {
    // Clear any existing timeout for this key
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key));
      this.timeouts.delete(key);
    }

    this.store.set(key, value);

    if (expiryMs) {
      const timeout = setTimeout(() => {
        this.store.delete(key);
        this.timeouts.delete(key);
      }, expiryMs);
      this.timeouts.set(key, timeout);
    }

    return 'OK';
  }

  async del(key) {
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key));
      this.timeouts.delete(key);
    }
    return this.store.delete(key);
  }

  // Pub/Sub
  async publish(channel, message) {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return 0;
    
    // Parse message if it's a string, or send as-is
    const parsedMessage = typeof message === 'string' ? message : JSON.stringify(message);
    
    subscribers.forEach(callback => {
      try {
        callback(parsedMessage);
      } catch (err) {
        console.error(`Error in pub/sub callback for channel ${channel}:`, err);
      }
    });

    return subscribers.size;
  }

  async subscribe(channel, callback) {
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel).add(callback);
    return true;
  }

  async unsubscribe(channel, callback) {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return false;
    
    const result = subscribers.delete(callback);
    if (subscribers.size === 0) {
      this.channels.delete(channel);
    }
    return result;
  }
}

export const cacheService = new CacheService();
