const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const Device = require("../models/Device");

// ── GET /api/devices ──────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { online, limit = 100, skip = 0 } = req.query;
    const query = {};
    if (online !== undefined) query.online = online === "true";

    const devices = await Device.find(query, { pendingCommands: 0 })
      .sort({ lastSeen: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    res.json(devices);   // plain array — matches what the dashboard expects
  } catch (err) {
    console.error("Error fetching devices:", err);
    res.status(500).json({ error: "Failed to fetch devices" });
  }
});

// ── GET /api/devices/:deviceId ────────────────────────────────────────────────
router.get("/:deviceId", async (req, res) => {
  try {
    const device = await Device.findOne(
      { deviceId: req.params.deviceId },
      { pendingCommands: 0 }
    );
    if (!device) return res.status(404).json({ error: "Device not found" });
    res.json(device);
  } catch (err) {
    console.error("Error fetching device:", err);
    res.status(500).json({ error: "Failed to fetch device" });
  }
});

// ── POST /api/devices/register  (called by ESP32 on boot) ────────────────────
router.post("/register", async (req, res) => {
  try {
    const { mac, name, chipModel, firmwareVersion, relayCount, ip } = req.body;

    if (!mac) return res.status(400).json({ error: "MAC address is required" });

    const deviceId = mac.replace(/:/g, "").toLowerCase();
    const isNew = !(await Device.exists({ deviceId }));
    let device = await Device.findOne({ deviceId });

    if (!device) {
      // First registration
      const relayArr = Array.from({ length: relayCount || 4 }, (_, i) => ({
        index: i,
        name:  `Relay ${i + 1}`,
        state: false,
        type:  "digital",
      }));
      device = new Device({
        deviceId,
        name:       name || `ESP32-${mac.slice(-5).replace(":", "")}`,
        type:       chipModel || "ESP32",
        firmware:   { version: firmwareVersion, lastUpdate: new Date() },
        ipAddress:  ip,
        macAddress: mac,
        online:     true,
        lastSeen:   new Date(),
        relays:     relayArr,
      });
    } else {
      // Re-registration (reboot / reconnect)
      device.online   = true;
      device.lastSeen = new Date();
      if (name)            device.name              = name;
      if (chipModel)       device.type              = chipModel;
      if (firmwareVersion) device.firmware          = { version: firmwareVersion, lastUpdate: new Date() };
      if (ip)              device.ipAddress         = ip;
      if (mac)      device.macAddress        = mac;

      // Sync relay count if it changed
      if (relayCount && device.relays.length !== relayCount) {
        const existing = device.relays;
        device.relays = Array.from({ length: relayCount }, (_, i) =>
          existing.find((r) => r.index === i) || {
            index: i, name: `Relay ${i + 1}`, state: false, type: "digital",
          }
        );
      }
    }

    await device.save();

    const io = req.app.get("io");
    const deviceObj = device.toObject();
    delete deviceObj.pendingCommands;
    io.emit("device:update", deviceObj);

    console.log(`[REG] ${isNew ? "New" : "Reconnected"} device: ${deviceId}`);

    res.json({
      deviceId: device.deviceId,
      relays:   device.relays.map((r) => ({ index: r.index, state: r.state })),
      serverTime: Date.now(),
    });
  } catch (err) {
    console.error("Error registering device:", err);
    res.status(500).json({ error: "Failed to register device" });
  }
});

// ── POST /api/devices/:deviceId/heartbeat  (called by ESP32 every ~10s) ──────
router.post("/:deviceId/heartbeat", async (req, res) => {
  try {
    const { rssi, freeHeap, uptime, cpuTemp, ip } = req.body;
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });

    device.online   = true;
    device.lastSeen = new Date();
    if (ip) device.ipAddress = ip;

    // Update sensors
    const updates = [
      { type: "rssi",        name: "WiFi RSSI",        value: rssi,     unit: "dBm" },
      { type: "heap",        name: "Free Heap",         value: freeHeap, unit: "bytes" },
      { type: "uptime",      name: "Uptime",            value: uptime,   unit: "seconds" },
      { type: "temperature", name: "CPU Temperature",   value: cpuTemp,  unit: "°C" },
    ];

    updates.forEach((u) => {
      if (u.value === undefined) return;
      const existing = device.sensors.find((s) => s.type === u.type);
      if (existing) {
        existing.value = u.value;
        existing.lastUpdated = new Date();
      } else {
        device.sensors.push({ ...u, lastUpdated: new Date() });
      }
    });

    // Drain pending commands — send them all, then clear
    const commands = device.pendingCommands.filter(
      (c) => c.status === "pending" && c.attempts < c.maxAttempts
    );
    device.pendingCommands = [];   // clear after draining

    await device.save();

    const io = req.app.get("io");
    const deviceObj = device.toObject();
    delete deviceObj.pendingCommands;
    io.emit("device:update", deviceObj);

    res.json({
      commands:   commands.map((c) => ({ commandId: c.commandId, type: c.type, payload: c.payload })),
      serverTime: Date.now(),
    });
  } catch (err) {
    console.error("Error in heartbeat:", err);
    res.status(500).json({ error: "Failed to process heartbeat" });
  }
});

// ── PATCH /api/devices/:deviceId  (rename device) ────────────────────────────
router.patch("/:deviceId", async (req, res) => {
  try {
    const { name } = req.body;
    const device = await Device.findOneAndUpdate(
      { deviceId: req.params.deviceId },
      { name },
      { new: true, select: "-pendingCommands" }
    );
    if (!device) return res.status(404).json({ error: "Device not found" });

    const io = req.app.get("io");
    io.emit("device:update", device.toObject());

    res.json(device);
  } catch (err) {
    res.status(500).json({ error: "Failed to update device" });
  }
});

// ── DELETE /api/devices/:deviceId ─────────────────────────────────────────────
router.delete("/:deviceId", async (req, res) => {
  try {
    await Device.deleteOne({ deviceId: req.params.deviceId });

    const io = req.app.get("io");
    io.emit("device:removed", req.params.deviceId);

    res.json({ message: "Device removed" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete device" });
  }
});

// ── POST /api/devices/:deviceId/relay  (dashboard relay toggle) ───────────────
// Body: { relayIndex: Number, state: Boolean }
router.post("/:deviceId/relay", async (req, res) => {
  try {
    const { relayIndex, state } = req.body;

    if (typeof relayIndex !== "number" || typeof state !== "boolean") {
      return res.status(400).json({ error: "relayIndex (number) and state (boolean) required" });
    }

    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });

    const relay = device.relays.find((r) => r.index === relayIndex);
    if (!relay) return res.status(404).json({ error: "Relay not found" });

    // Optimistically update state so dashboard reflects it immediately
    relay.state = state;
    relay.lastUpdated = new Date();

    const commandId = uuidv4();
    device.pendingCommands.push({
      commandId,
      type:        "relay",
      payload:     { relayIndex, state },
      createdAt:   new Date(),
      attempts:    0,
      maxAttempts: 5,
      status:      "pending",
    });

    await device.save();

    const io = req.app.get("io");
    const deviceObj = device.toObject();
    delete deviceObj.pendingCommands;
    io.emit("device:update", deviceObj);

    res.json({ queued: true, commandId, relayIndex, state });
  } catch (err) {
    console.error("Error controlling relay:", err);
    res.status(500).json({ error: "Failed to control relay" });
  }
});

// ── PATCH /api/devices/:deviceId/relay/:relayIndex/name  (rename relay) ───────
router.patch("/:deviceId/relay/:relayIndex/name", async (req, res) => {
  try {
    const { name } = req.body;
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });

    const relay = device.relays.find((r) => r.index === parseInt(req.params.relayIndex));
    if (!relay) return res.status(404).json({ error: "Relay not found" });

    relay.name = name;
    await device.save();

    const io = req.app.get("io");
    const deviceObj = device.toObject();
    delete deviceObj.pendingCommands;
    io.emit("device:update", deviceObj);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to rename relay" });
  }
});

// ── GET /api/devices/:deviceId/commands  (list pending commands) ──────────────
router.get("/:deviceId/commands", async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });
    res.json(device.pendingCommands);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch commands" });
  }
});

// ── DELETE /api/devices/:deviceId/commands  (clear all pending commands) ──────
router.delete("/:deviceId/commands", async (req, res) => {
  try {
    await Device.updateOne(
      { deviceId: req.params.deviceId },
      { $set: { pendingCommands: [] } }
    );
    res.json({ message: "Commands cleared" });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear commands" });
  }
});

module.exports = router;