const jwt = require("jsonwebtoken");
const User = require("../models/User");

if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is required");
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

const authenticate = (options = { requireAdmin: false }) => async (req, res, next) => {
  try {
    let token;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    if (!user.isVerified) {
      return res.status(403).json({ error: "Email not verified" });
    }

    if (options.requireAdmin && user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    console.error("Auth middleware error:", err);
    return res.status(500).json({ error: "Authentication failed" });
  }
};

const requireAuth = authenticate();
const requireAdmin = authenticate({ requireAdmin: true });

module.exports = { requireAuth, requireAdmin, JWT_SECRET };