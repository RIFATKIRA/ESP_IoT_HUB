const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const User = require("../models/User");
const { JWT_SECRET } = require("../middleware/auth");

const DEV_MODE = process.env.NODE_ENV !== "production";

function createTransporter() {
  const service = (process.env.EMAIL_SERVICE || "gmail").toLowerCase();
  if (["outlook", "hotmail", "live"].includes(service)) {
    return nodemailer.createTransport({
      host: "smtp-mail.outlook.com",
      port: 587,
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { ciphers: "SSLv3" },
    });
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

async function sendConfirmEmail(email, token) {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const link = `${baseUrl}/api/auth/confirm/${token}`;
  console.log(`\n[CONFIRM] ${email}\n${link}\n`);

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn("Email credentials missing – confirmation email not sent.");
    return;
  }

  const transporter = createTransporter();
  await transporter.sendMail({
    from: `"ESP32 IoT Hub" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Confirm your ESP32 IoT Hub account",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0f1218;color:#c8d8e8;border-radius:8px;">
        <h2 style="color:#00d4ff;">ESP32 · IoT Hub</h2>
        <p>Click below to confirm your email. Expires in 24 hours.</p>
        <a href="${link}" style="display:inline-block;margin:24px 0;padding:12px 28px;background:#00d4ff;color:#0a0c10;border-radius:6px;font-weight:bold;text-decoration:none;">Confirm Email</a>
        <p style="font-size:12px;color:#3a5a78;">Or copy: ${link}</p>
      </div>`,
  });
}

router.post("/register", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    let user = await User.findOne({ email });
    if (user?.isVerified) return res.status(409).json({ error: "Email already registered" });

    if (!user) user = new User({ email, password });
    else user.password = password;

    const token = user.generateConfirmToken();
    await user.save();

    sendConfirmEmail(email, token).catch(err => console.error("Email error:", err));

    res.json({
      message: DEV_MODE
        ? "Registered! Copy the confirmation link from the console."
        : "Registered! Check your email to confirm your account.",
    });
  } catch (err) {
    next(err);
  }
});

router.get("/confirm/:token", async (req, res, next) => {
  try {
    const token = req.params.token;
    const user = await User.findOne({
      confirmToken: token,
      confirmTokenExpiry: { $gt: new Date() },
    });

    if (!user) {
      const expiredUser = await User.findOne({ confirmToken: token });
      if (expiredUser) return res.redirect('/login.html?error=expired');
      return res.redirect('/login.html?error=invalid');
    }

    if (user.isVerified) return res.redirect('/login.html?info=already_verified');

    user.isVerified = true;
    user.confirmToken = null;
    user.confirmTokenExpiry = null;
    await user.save();

    console.log(`[AUTH] Email confirmed: ${user.email} (role: ${user.role})`);
    res.redirect('/login.html?confirmed=1');
  } catch (err) {
    next(err);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const match = await user.comparePassword(password);
    if (!match) return res.status(401).json({ error: "Invalid email or password" });

    if (!user.isVerified) {
      return res.status(403).json({
        error: DEV_MODE
          ? "Email not verified. Copy confirmation link from console."
          : "Please confirm your email before logging in.",
      });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ token, email: user.email, role: user.role });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logged out" });
});

router.get("/me", async (req, res, next) => {
  try {
    const token = req.cookies?.token || req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Not authenticated" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password -confirmToken -resetToken");
    if (!user) return res.status(401).json({ error: "User not found" });

    res.json(user);
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    next(err);
  }
});

module.exports = router;