require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const WebSocket = require("ws");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/auth");
const deviceRoutes = require("./routes/devices");
const espRoutes = require("./routes/esp");
const Device = require("./models/Device");

// Validate required environment variables
const requiredEnvVars = ["JWT_SECRET", "MONGODB_URI"];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`FATAL: Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Socket.IO for web clients
const io = new Server(server, {
  cors: {
    origin: process.env.BASE_URL || "http://localhost:3000",
    credentials: true
  }
});

// WebSocket server for ESP32 devices (no ping interval - stable)
const wss = new WebSocket.Server({ server, path: '/esp-ws' });
const espConnections = new Map();

wss.on('connection', (ws, req) => {
  console.log('[WS] ESP32 client connected');
  let deviceId = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'register') {
        deviceId = msg.deviceId;
        espConnections.set(deviceId, ws);
        console.log(`[WS] ESP32 registered: ${deviceId}`);
        
        // Send any pending commands immediately
        const device = await Device.findOne({ deviceId });
        if (device) {
          const pending = device.pendingCommands.filter(c => 
            c.status === 'pending' && c.attempts < c.maxAttempts
          );
          for (const cmd of pending) {
            ws.send(JSON.stringify({
              type: 'command',
              commandId: cmd.commandId,
              payload: cmd.payload
            }));
            cmd.status = 'sent';
            cmd.attempts += 1;
          }
          await device.save();
        }
      }
      
      if (msg.type === 'ack') {
        const { commandId, success, error } = msg;
        const device = await Device.findOne({ deviceId });
        if (device) {
          const cmd = device.pendingCommands.find(c => c.commandId === commandId);
          if (cmd) {
            cmd.status = success ? 'acknowledged' : 'failed';
            if (error) cmd.error = error;
            
            if (!success && cmd.type === 'relay') {
              const relay = device.relays.find(r => r.index === cmd.payload.relayIndex);
              if (relay) {
                relay.state = !cmd.payload.state;
                relay.lastUpdated = new Date();
              }
            }
            await device.save();
            
            const deviceObj = device.toObject();
            delete deviceObj.pendingCommands;
            io.emit('device:update', deviceObj);
          }
        }
      }
    } catch (err) {
      console.error('[WS] Message error:', err);
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      espConnections.delete(deviceId);
      console.log(`[WS] ESP32 disconnected: ${deviceId}`);
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err);
  });
});

// Helper to send command via WebSocket
async function sendCommandToESP(deviceId, command) {
  const ws = espConnections.get(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'command',
      commandId: command.commandId,
      payload: command.payload
    }));
    return true;
  }
  return false;
}

app.set("trust proxy", 1);
app.set("io", io);
app.set("sendCommandToESP", sendCommandToESP);

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.BASE_URL || "http://localhost:3000",
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
});
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/login", authLimiter);

// Static files
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// API routes
app.use("/api/esp", espRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/devices", deviceRoutes);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err.stack);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === "production"
    ? "Internal server error"
    : err.message;
  res.status(status).json({ error: message });
});

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  });

// Socket.io events
io.on("connection", (socket) => {
  console.log(`🔌 Web client connected: ${socket.id}`);
  socket.on("disconnect", (reason) => {
    console.log(`🔌 Web client disconnected: ${socket.id} (${reason})`);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Static files: ${path.join(__dirname, "public")}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/esp-ws`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  wss.close();
  await mongoose.connection.close();
  server.close(() => process.exit(0));
});