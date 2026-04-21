require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const WebSocket = require("ws");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const cors = require("cors");
const path = require("path");

const authRoutes   = require("./routes/auth");
const deviceRoutes = require("./routes/devices");
const espRoutes    = require("./routes/esp");
const Device       = require("./models/Device");

const requiredEnvVars = ["JWT_SECRET", "MONGODB_URI"];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`FATAL: Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const app    = express();
const server = http.createServer(app);

// ── Socket.IO for web dashboard clients ────────────────────────────────────
const io = new Server(server, {
  cors: { origin: process.env.BASE_URL || "http://localhost:3000", credentials: true },
});

// ✅ FIX: Verify JWT on Socket.IO connection so only authenticated dashboard
// users receive device:update events.
io.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.split(" ")[1];
    if (!token) return next(new Error("Authentication required"));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId   = decoded.id;
    socket.userRole = decoded.role;
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
});

// ── WebSocket server for ESP32 devices ────────────────────────────────────
const wss = new WebSocket.Server({ server, path: "/esp-ws" });
const espConnections = new Map(); // deviceId → ws

wss.on("connection", ws => {
  let deviceId = null;

  ws.on("message", async data => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === "register") {
        deviceId = msg.deviceId;
        espConnections.set(deviceId, ws);
        console.log(`[WS] ESP32 registered: ${deviceId}`);
        // Flush pending commands immediately
        const device = await Device.findOne({ deviceId });
        if (device) {
          const pending = device.pendingCommands.filter(
            c => c.status === "pending" && c.attempts < c.maxAttempts
          );
          for (const cmd of pending) {
            ws.send(JSON.stringify({ type: "command", commandId: cmd.commandId, payload: cmd.payload }));
            cmd.status   = "sent";
            cmd.attempts += 1;
          }
          if (pending.length) await device.save();
        }
      }

      if (msg.type === "ack") {
        const { commandId, success, error } = msg;
        const device = await Device.findOne({ deviceId });
        if (device) {
          const cmd = device.pendingCommands.find(c => c.commandId === commandId);
          if (cmd) {
            cmd.status = success ? "acknowledged" : "failed";
            if (error) cmd.error = error;
            if (!success && cmd.type === "relay") {
              const relay = device.relays.find(r => r.index === cmd.payload.relayIndex);
              if (relay) { relay.state = !cmd.payload.state; relay.lastUpdated = new Date(); }
            }
            await device.save();
            const obj = device.toObject(); delete obj.pendingCommands;
            io.emit("device:update", obj);
          }
        }
      }
    } catch (err) {
      console.error("[WS] Message error:", err.message);
    }
  });

  ws.on("close", () => {
    if (deviceId) {
      espConnections.delete(deviceId);
      console.log(`[WS] ESP32 disconnected: ${deviceId}`);
    }
  });

  ws.on("error", err => console.error("[WS] Error:", err.message));
});

async function sendCommandToESP(deviceId, command) {
  const ws = espConnections.get(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "command", commandId: command.commandId, payload: command.payload }));
    return true;
  }
  return false;
}

app.set("trust proxy", 1);
app.set("io", io);
app.set("sendCommandToESP", sendCommandToESP);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.BASE_URL || "http://localhost:3000", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Rate limiting — raised to 300 to handle 1 s heartbeats from many devices
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use("/api/auth/register", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use("/api/auth/login",    rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));

// ── Static & routes ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));

app.use("/api/esp",     espRoutes);
app.use("/api/auth",    authRoutes);
app.use("/api/devices", deviceRoutes);

app.get("/health", (req, res) => res.json({ status: "OK", timestamp: new Date().toISOString() }));

app.use((req, res)        => res.status(404).json({ error: "Endpoint not found" }));
app.use((err, req, res, next) => {
  console.error("Server error:", err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});

// ── MongoDB ────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected");

    // ✅ FIX: Offline detection — runs every 15 s, marks any device that
    // has not sent a heartbeat in the last 35 s as offline, then pushes a
    // device:update via Socket.IO so the dashboard turns the card grey
    // immediately without requiring a page refresh.
    //
    // Previously devices stayed "ONLINE" forever once set, because nothing
    // ever flipped online=false except a restart.
    const OFFLINE_THRESHOLD_MS = 35_000;
    setInterval(async () => {
      try {
        const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
        const stale  = await Device.find({ online: true, lastSeen: { $lt: cutoff } });
        for (const device of stale) {
          device.online           = false;
          device.lastStatusChange = new Date();
          await device.save();
          const obj = device.toObject(); delete obj.pendingCommands;
          io.emit("device:update", obj);
          console.log(`[OFFLINE] ${device.deviceId} (silent for ${Math.round((Date.now() - device.lastSeen) / 1000)}s)`);
        }
      } catch (err) {
        console.error("[OFFLINE CHECK]", err.message);
      }
    }, 15_000);
  })
  .catch(err => { console.error("❌ MongoDB:", err.message); process.exit(1); });

// ── Socket.IO connection ───────────────────────────────────────────────────
io.on("connection", socket => {
  console.log(`🔌 Dashboard: ${socket.id} (user:${socket.userId})`);
  socket.on("disconnect", r => console.log(`🔌 Dashboard left: ${socket.id} (${r})`));
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`🌐 ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});

process.on("SIGINT", async () => {
  wss.close();
  await mongoose.connection.close();
  server.close(() => process.exit(0));
});

process.on("uncaughtException",  err => console.error("💥 UNCAUGHT:", err));
process.on("unhandledRejection", err => console.error("⚠️  REJECTION:", err));