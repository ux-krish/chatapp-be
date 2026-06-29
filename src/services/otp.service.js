import bcrypt from 'bcryptjs';
import { getDb } from '../db/sqlite.js';
import { OTP_EXPIRY_MS, OTP_MAX_ATTEMPTS, NODE_ENV } from '../config/config.js';
import { emailService } from './email.service.js';

class OtpService {
  async generateOtp(email) {
    const db = await getDb();

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + OTP_EXPIRY_MS;

    // Hash OTP for secure database storage
    const salt = await bcrypt.genSalt(10);
    const hashedOtp = await bcrypt.hash(otp, salt);

    // Upsert OTP
    await db.run(`
      INSERT INTO otps (email, otp, expiresAt, attempts)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(email) DO UPDATE SET
      	otp = excluded.otp,
      	expiresAt = excluded.expiresAt,
      	attempts = 0;
    `, [email, hashedOtp, expiresAt]);

    // Send via real email if configured
    const emailSent = await emailService.sendOtpEmail(email, otp);

    // Fall back to terminal logs if email delivery is disabled, or in dev mode for easy developer access
    if (!emailSent || NODE_ENV === 'development') {
      console.log('\n┌────────────────────────────────────────┐');
      console.log('│                                        │');
      console.log(`│    Talkzen OTP FOR ${email.toUpperCase().padEnd(23)}│`);
      console.log('│                                        │');
      console.log(`│    OTP CODE: \x1b[32m\x1b[1m${otp}\x1b[0m                       │`);
      console.log('│    EXPIRES IN: 5 MINUTES               │');
      console.log('│                                        │');
      console.log('└────────────────────────────────────────┘\n');
    }

    return otp;
  }

  async verifyOtp(email, otpCode) {
    const db = await getDb();

    const record = await db.get('SELECT * FROM otps WHERE email = ?', [email]);
    if (!record) {
      return { valid: false, message: 'OTP not found. Request a new one.' };
    }

    // Check expiry
    if (Date.now() > record.expiresAt) {
      await db.run('DELETE FROM otps WHERE email = ?', [email]);
      return { valid: false, message: 'OTP has expired. Request a new one.' };
    }

    // Check attempts limit
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await db.run('DELETE FROM otps WHERE email = ?', [email]);
      return { valid: false, message: 'Too many failed attempts. Request a new OTP.' };
    }

    // Verify code
    const isValid = await bcrypt.compare(otpCode, record.otp);
    if (!isValid) {
      // Increment attempts
      await db.run('UPDATE otps SET attempts = attempts + 1 WHERE email = ?', [email]);
      return {
        valid: false,
        message: `Incorrect OTP. ${OTP_MAX_ATTEMPTS - (record.attempts + 1)} attempts remaining.`
      };
    }

    // OTP is valid, clean up
    await db.run('DELETE FROM otps WHERE email = ?', [email]);
    return { valid: true };
  }
}

export const otpService = new OtpService();
