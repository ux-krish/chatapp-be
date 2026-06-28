import nodemailer from 'nodemailer';

const cleanVal = (val) => {
  if (typeof val !== 'string') return val;
  return val.replace(/^['"]|['"]$/g, '').trim();
};

class EmailService {
  constructor() {
    this.transporter = null;
    
    const host = cleanVal(process.env.EMAIL_HOST);
    const port = cleanVal(process.env.EMAIL_PORT) || 587;
    const user = cleanVal(process.env.EMAIL_USER);
    const pass = cleanVal(process.env.EMAIL_PASS);

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port: parseInt(port),
        secure: parseInt(port) === 465, // true for 465, false for other ports
        auth: {
          user,
          pass,
        },
        tls: {
          rejectUnauthorized: false, // bypass certificate validation for development environments
        },
      });
      console.log(`✉️ Mail Transport initialized using SMTP server: ${host}`);
    } else {
      console.log('⚠️ SMTP Credentials missing in environment. Email delivery is disabled (falling back to terminal logs).');
    }
  }

  async sendOtpEmail(toEmail, otp) {
    if (!this.transporter) {
      return false;
    }

    const from = cleanVal(process.env.EMAIL_FROM || process.env.EMAIL_USER);
    
    const mailOptions = {
      from: `"Lynq" <${from}>`,
      to: toEmail,
      subject: '🔐 Your Verification Code',
      html: `
        <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e4e4e7; border-radius: 12px; background-color: #fafafa;">
          <div style="text-align: center; margin-bottom: 20px;">
            <span style="font-size: 24px;">💬</span>
            <h2 style="margin: 10px 0 0 0; color: #09090b; font-size: 20px; font-weight: 700;">Lynq Verification</h2>
          </div>
          <p style="color: #3f3f46; font-size: 14px; line-height: 1.5;">Hello,</p>
          <p style="color: #3f3f46; font-size: 14px; line-height: 1.5;">Your Lynq verification code is:</p>
          <div style="text-align: center; margin: 30px 0; padding: 15px; background-color: #10b981; border-radius: 12px;">
            <span style="font-size: 32px; font-weight: 800; letter-spacing: 0.15em; color: #ffffff;">${otp}</span>
          </div>
          <p style="color: #71717a; font-size: 12px; line-height: 1.5; margin-top: 30px;">
            This code expires in 5 minutes. If you did not request this code, please ignore this email.
          </p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`✉️ Verification code successfully sent to: ${toEmail}`);
      return true;
    } catch (err) {
      console.error(`❌ Failed to send email to ${toEmail}:`, err.message || err);
      return false;
    }
  }
}

export const emailService = new EmailService();

