require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const helmet = require("helmet");

const deviceRoutes = require("./routes/devices");
const Device = require("./models/Device");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: process.env.NODE_ENV === 'production' 
      ? process.env.ALLOWED_ORIGINS?.split(',') || ['https://yourdomain.com']
      : "*", 
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  },
});

// ── Environment Variables Validation ─────────────────────────────────────────
const requiredEnvVars = ['MONGO_URI'];
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.warn(`⚠️  Warning: ${varName} not set in .env file, using default value`);
  }
});

// ── Security & Utility Middleware ───────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.ALLOWED_ORIGINS?.split(',') || ['https://yourdomain.com']
    : "*",
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/", apiLimiter);

// Static files - serve before routes
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0
}));

// Share io instance with routes
app.set("io", io);

// ── API Routes ────────────────────────────────────────────────────────────────
app.use("/api/devices", deviceRoutes);

// ── Health check endpoint ─────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  const healthData = {
    status: "ok",
    time: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  };
  res.json(healthData);
});

// ── Metrics endpoint ──────────────────────────────────────────────────────────
app.get("/api/metrics", async (req, res) => {
  try {
    const [totalDevices, onlineDevices] = await Promise.all([
      Device.countDocuments(),
      Device.countDocuments({ online: true })
    ]);
    
    const metrics = {
      devices: { 
        total: totalDevices, 
        online: onlineDevices,
        offline: totalDevices - onlineDevices
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "1.0.0"
    };
    
    res.json(metrics);
  } catch (err) {
    console.error("Metrics error:", err);
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

// ── Serve dashboard for root route ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── 404 Handler - Catch all unmatched routes ─────────────────────────────────
app.use((req, res) => {
  // If it's an API request, return JSON
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: "API endpoint not found" });
  }
  // For web requests, return HTML 404 page
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Error Handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ 
    error: "Internal server error",
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ── Socket.io Event Handlers ──────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send all devices on initial connection
  Device.find({}, { pendingCommands: 0 })
    .sort({ lastSeen: -1 })
    .then((devices) => {
      socket.emit("devices:init", devices);
    })
    .catch((err) => {
      console.error("[WS] Error fetching devices:", err);
      socket.emit("error", { message: "Failed to fetch devices" });
    });

  // Handle relay control from dashboard
  socket.on("relay:set", async ({ deviceId, relayIndex, state }) => {
    try {
      // Input validation
      if (!deviceId) {
        return socket.emit("error", { message: "Device ID is required" });
      }
      
      if (typeof relayIndex !== 'number' || relayIndex < 0) {
        return socket.emit("error", { message: "Invalid relay index" });
      }
      
      if (typeof state !== 'boolean') {
        return socket.emit("error", { message: "State must be a boolean" });
      }

      const device = await Device.findOne({ deviceId });
      if (!device) {
        return socket.emit("error", { message: "Device not found" });
      }

      const relay = device.relays.find((r) => r.index === relayIndex);
      if (!relay) {
        return socket.emit("error", { message: "Relay not found" });
      }

      // Update relay state
      relay.state = state;
      relay.lastUpdated = new Date();
      
      // Add command to queue
      device.pendingCommands.push({
        commandId: uuidv4(),
        type: "relay",
        payload: { relayIndex, state },
        createdAt: new Date(),
        attempts: 0,
        maxAttempts: 5,
        status: 'pending'
      });
      
      await device.save();
      
      // Broadcast update to all connected clients
      const deviceObj = device.toObject();
      delete deviceObj.pendingCommands; // Don't send command queue to clients
      io.emit("device:update", deviceObj);
      
      console.log(`[WS] Relay ${relayIndex} of device ${deviceId} set to ${state}`);
      
    } catch (err) {
      console.error("[WS] Relay set error:", err);
      socket.emit("error", { message: "Failed to set relay state" });
    }
  });

  // Handle device heartbeat/status updates
  socket.on("device:heartbeat", async ({ deviceId, relays, sensors, ipAddress }) => {
    try {
      if (!deviceId) return;
      
      const updateData = {
        lastSeen: new Date(),
        online: true
      };
      
      if (relays) updateData.relays = relays;
      if (sensors) updateData.sensors = sensors;
      if (ipAddress) updateData.ipAddress = ipAddress;
      
      let device = await Device.findOne({ deviceId });
      
      if (!device) {
        // Create new device if it doesn't exist
        device = new Device({
          deviceId,
          name: deviceId,
          ...updateData
        });
      } else {
        // Update existing device
        Object.assign(device, updateData);
      }
      
      await device.save();
      
      // Check for pending commands
      if (device.pendingCommands && device.pendingCommands.length > 0) {
        socket.emit("commands:pending", device.pendingCommands);
      }
      
      const deviceObj = device.toObject();
      delete deviceObj.pendingCommands;
      io.emit("device:update", deviceObj);
      
    } catch (err) {
      console.error("[WS] Heartbeat error:", err);
    }
  });

  // Handle command acknowledgment from device
  socket.on("command:ack", async ({ deviceId, commandId, success, error }) => {
    try {
      const device = await Device.findOne({ deviceId });
      if (!device) return;
      
      // Update command status or remove it
      const command = device.pendingCommands.find(cmd => cmd.commandId === commandId);
      if (command) {
        if (success) {
          command.status = 'acknowledged';
        } else {
          command.status = 'failed';
          command.error = error;
        }
      }
      
      // Remove acknowledged/successful commands
      device.pendingCommands = device.pendingCommands.filter(
        cmd => !(cmd.commandId === commandId && success)
      );
      
      await device.save();
      
      if (!success) {
        console.error(`[WS] Command ${commandId} failed for device ${deviceId}:`, error);
      }
      
    } catch (err) {
      console.error("[WS] Command ack error:", err);
    }
  });

  // Handle device registration
  socket.on("device:register", async ({ deviceId, name, type, metadata }) => {
    try {
      if (!deviceId) return;
      
      let device = await Device.findOne({ deviceId });
      
      if (device) {
        // Update existing device
        device.name = name || device.name;
        device.type = type || device.type;
        device.metadata = metadata || {};
        device.lastSeen = new Date();
        device.online = true;
      } else {
        // Create new device
        device = new Device({
          deviceId,
          name: name || deviceId,
          type: type || 'ESP32',
          metadata: metadata || {},
          online: true,
          lastSeen: new Date()
        });
      }
      
      await device.save();
      
      console.log(`[WS] Device registered: ${deviceId}`);
      const deviceObj = device.toObject();
      delete deviceObj.pendingCommands;
      io.emit("device:update", deviceObj);
      
    } catch (err) {
      console.error("[WS] Device registration error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

// ── Offline Device Detection ──────────────────────────────────────────────────
setInterval(async () => {
  try {
    const threshold = new Date(Date.now() - 30000); // 30 seconds
    
    const offlineDevices = await Device.find({ 
      online: true, 
      lastSeen: { $lt: threshold } 
    });
    
    for (const device of offlineDevices) {
      device.online = false;
      device.lastStatusChange = new Date();
      await device.save();
      
      const deviceObj = device.toObject();
      delete deviceObj.pendingCommands;
      io.emit("device:update", deviceObj);
    }
    
    if (offlineDevices.length > 0) {
      console.log(`[~] Marked ${offlineDevices.length} device(s) offline`);
    }
  } catch (err) {
    console.error("[~] Offline detection error:", err);
  }
}, 10000); // Check every 10 seconds

// ── Cleanup Old Commands ──────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const threshold = new Date(Date.now() - 3600000); // 1 hour
    
    const result = await Device.updateMany(
      { "pendingCommands.createdAt": { $lt: threshold } },
      { $pull: { pendingCommands: { createdAt: { $lt: threshold } } } }
    );
    
    if (result.modifiedCount > 0) {
      console.log(`[~] Cleaned up old commands from ${result.modifiedCount} devices`);
    }
  } catch (err) {
    console.error("[~] Command cleanup error:", err);
  }
}, 1800000); // Run every 30 minutes

// ── MongoDB Connection & Server Start ─────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/esp32iot";
const PORT = process.env.PORT || 3000;

// MongoDB connection options
const mongooseOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  family: 4
};

mongoose
  .connect(MONGO_URI, mongooseOptions)
  .then(() => {
    console.log(`✅ [DB] MongoDB connected: ${MONGO_URI}`);
    
    server.listen(PORT, () => {
      console.log(`\n🚀 Server Information:`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📡 Server:     http://localhost:${PORT}`);
      console.log(`📊 Dashboard:  http://localhost:${PORT}`);
      console.log(`🔌 API:        http://localhost:${PORT}/api/devices`);
      console.log(`💚 Health:     http://localhost:${PORT}/api/health`);
      console.log(`📈 Metrics:    http://localhost:${PORT}/api/metrics`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    });
  })
  .catch((err) => {
    console.error("❌ [DB] Connection failed:", err.message);
    process.exit(1);
  });

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  console.log(`\n⚠️  ${signal} received. Starting graceful shutdown...`);
  
  // Close Socket.io connections
  io.close(() => {
    console.log("🔌 Socket.io server closed");
  });
  
  // Close HTTP server
  server.close(async () => {
    console.log("📡 HTTP server closed");
    
    try {
      // Close MongoDB connection
      await mongoose.connection.close();
      console.log("💾 MongoDB connection closed");
      
      console.log("✅ Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      console.error("❌ Error during shutdown:", err);
      process.exit(1);
    }
  });
  
  // Force shutdown after timeout
  setTimeout(() => {
    console.error("⚠️  Could not close connections in time, forcefully shutting down");
    process.exit(1);
  }, 10000);
};

// Listen for shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// ── Export for testing ────────────────────────────────────────────────────────
module.exports = { app, server, io };