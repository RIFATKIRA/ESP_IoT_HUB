require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const deviceRoutes = require("./routes/devices");
const Device = require("./models/Device");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] },
});

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.set("io", io);

app.use("/api/devices", deviceRoutes);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

app.get("/api/metrics", async (req, res) => {
  try {
    const [total, online] = await Promise.all([
      Device.countDocuments(),
      Device.countDocuments({ online: true }),
    ]);
    res.json({
      devices: { total, online, offline: total - online },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/esp32iot";
const PORT = process.env.PORT || 3000;

mongoose
  .connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    family: 4,
  })
  .then(() => {
    console.log(`[DB] MongoDB connected: ${MONGO_URI}`);

    server.listen(PORT, () => {
      console.log(`\n[SERVER] Running on http://localhost:${PORT}`);
      console.log(`[API]    http://localhost:${PORT}/api/devices`);
      console.log(`[HEALTH] http://localhost:${PORT}/api/health\n`);
    });

    // Socket.io — inside .then() so Device is ready
    io.on("connection", (socket) => {
      console.log(`[WS] Client connected: ${socket.id}`);

      Device.find({}, { pendingCommands: 0 })
        .sort({ lastSeen: -1 })
        .then((devices) => socket.emit("devices:init", devices))
        .catch((err) => console.error("[WS] Error fetching devices:", err));

      socket.on("relay:set", async ({ deviceId, relayIndex, state }) => {
        try {
          if (!deviceId || typeof relayIndex !== "number" || typeof state !== "boolean") {
            return socket.emit("error", { message: "Invalid parameters" });
          }
          const device = await Device.findOne({ deviceId });
          if (!device) return socket.emit("error", { message: "Device not found" });

          const relay = device.relays.find((r) => r.index === relayIndex);
          if (!relay) return socket.emit("error", { message: "Relay not found" });

          relay.state = state;
          device.pendingCommands.push({
            commandId: uuidv4(),
            type: "relay",
            payload: { relayIndex, state },
            createdAt: new Date(),
          });
          await device.save();

          const deviceObj = device.toObject();
          delete deviceObj.pendingCommands;
          io.emit("device:update", deviceObj);
        } catch (err) {
          console.error("[WS] relay:set error:", err);
          socket.emit("error", { message: "Failed to set relay" });
        }
      });

      socket.on("disconnect", () => {
        console.log(`[WS] Client disconnected: ${socket.id}`);
      });
    });

    // Offline detection — inside .then() so Device is ready
    setInterval(async () => {
      try {
        const threshold = new Date(Date.now() - 30000);
        const offlineDevices = await Device.find({
          online: true,
          lastSeen: { $lt: threshold },
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
    }, 10000);

    // Stale command cleanup — inside .then() so Device is ready
    setInterval(async () => {
      try {
        const threshold = new Date(Date.now() - 3600000);
        const result = await Device.updateMany(
          { "pendingCommands.createdAt": { $lt: threshold } },
          { $pull: { pendingCommands: { createdAt: { $lt: threshold } } } }
        );
        if (result.modifiedCount > 0) {
          console.log(`[~] Cleaned stale commands from ${result.modifiedCount} device(s)`);
        }
      } catch (err) {
        console.error("[~] Command cleanup error:", err);
      }
    }, 1800000);
  })
  .catch((err) => {
    console.error("[DB] Connection failed:", err.message);
    process.exit(1);
  });

const shutdown = async (signal) => {
  console.log(`\n[SHUTDOWN] ${signal} received...`);
  io.close();
  server.close(async () => {
    await mongoose.connection.close();
    console.log("[SHUTDOWN] Complete");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  shutdown("UNCAUGHT_EXCEPTION");
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

module.exports = { app, server, io };