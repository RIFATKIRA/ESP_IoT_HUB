const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const Device = require("../models/Device");

// ── POST /api/esp/register ─────────────────────────────────────────────────
router.post("/register", async (req, res, next) => {
  try {
    const { mac, name, chipModel, firmwareVersion, relayCount, ip } = req.body;
    if (!mac) return res.status(400).json({ error: "MAC address is required" });

    const deviceId = mac.replace(/:/g, "").toLowerCase();
    let device = await Device.findOne({ deviceId });
    const isNew = !device;

    if (!device) {
      const relays = Array.from({ length: relayCount || 4 }, (_, i) => ({
        index: i, name: `Relay ${i + 1}`, state: false, type: "digital",
      }));
      device = new Device({
        deviceId, macAddress: mac,
        name: name || `ESP32-${mac.slice(-5)}`,
        type: chipModel || "ESP32",
        firmware: { version: firmwareVersion, lastUpdate: new Date() },
        ipAddress: ip, online: true, lastSeen: new Date(), relays,
      });
    } else {
      device.online = true;
      device.lastSeen = new Date();
      device.lastStatusChange = new Date();
      if (name)            device.name = name;
      if (chipModel)       device.type = chipModel;
      if (firmwareVersion) device.firmware = { version: firmwareVersion, lastUpdate: new Date() };
      if (ip)              device.ipAddress = ip;
      if (mac)             device.macAddress = mac;

      if (relayCount && device.relays.length !== relayCount) {
        const existing = device.relays;
        device.relays = Array.from({ length: relayCount }, (_, i) =>
          existing.find(r => r.index === i) ||
          { index: i, name: `Relay ${i + 1}`, state: false, type: "digital" }
        );
      }
    }

    await device.save();

    const io = req.app.get("io");
    const obj = device.toObject(); delete obj.pendingCommands;
    io.emit("device:update", obj);

    console.log(`[ESP] ${isNew ? "New" : "Reconnected"}: ${deviceId} (fw:${firmwareVersion})`);
    res.json({
      deviceId: device.deviceId,
      relays:   device.relays.map(r => ({ index: r.index, state: r.state })),
      serverTime: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/:deviceId/heartbeat ─────────────────────────────────────
router.post("/:deviceId/heartbeat", async (req, res, next) => {
  try {
    const { rssi, freeHeap, uptime, cpuTemp, ip } = req.body;

    // ✅ FIX: Accept BOTH "dht22" (v4 firmware) AND "sensor" (configurator
    // generated firmware) keys so both firmware styles work with this server.
    const dht22 = req.body.dht22 || req.body.sensor || null;

    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });

    device.online   = true;
    device.lastSeen = new Date();
    if (ip) device.ipAddress = ip;

    // ── upsertSensor ──────────────────────────────────────────────────────
    // Stores or updates a sensor reading. Unlike the old version, this stores
    // null values too (so the dashboard can show an "ERR" state instead of
    // silently showing stale data). The "group" field lets the dashboard group
    // related readings (temp + humidity + heat index) under one sensor block.
    const upsertSensor = (type, name, value, unit, group = "") => {
      const existing = device.sensors.find(s => s.type === type && s.name === name);
      if (existing) {
        existing.value       = value ?? null;
        existing.unit        = unit;
        existing.group       = group;
        existing.lastUpdated = new Date();
      } else {
        device.sensors.push({ type, name, value: value ?? null, unit, group, lastUpdated: new Date() });
      }
    };

    // ── System metrics (group="" → shown in compact header row on dashboard) ─
    if (rssi     !== undefined) upsertSensor("rssi",   "WiFi RSSI", rssi,     "dBm");
    if (freeHeap !== undefined) upsertSensor("heap",   "Free Heap", freeHeap, "bytes");
    if (uptime   !== undefined) upsertSensor("uptime", "Uptime",    uptime,   "seconds");
    if (cpuTemp  !== undefined) upsertSensor("temperature", "CPU Temp", cpuTemp, "°C");

    // ── DHT22 / DHT11 data (group="DHT22" → shown as sensor block) ───────
    if (dht22 !== null) {
      const ok = !!dht22.ok;
      console.log(`[HB:${req.params.deviceId}] DHT ok=${ok} temp=${dht22.temperature} hum=${dht22.humidity}`);

      // Always store (even null on error) so the dashboard can display the
      // error state. The old code skipped nulls which hid sensor failures.
      upsertSensor(
        "temperature", "Ambient Temp",
        ok && dht22.temperature !== undefined ? parseFloat(dht22.temperature) : null,
        "°C", "DHT22"
      );
      upsertSensor(
        "humidity", "Humidity",
        ok && dht22.humidity !== undefined ? parseFloat(dht22.humidity) : null,
        "%", "DHT22"
      );
      upsertSensor(
        "heatIndex", "Heat Index",
        ok && dht22.heatIndex !== undefined ? parseFloat(dht22.heatIndex) : null,
        "°C", "DHT22"
      );
    }

    // ── Pending commands ──────────────────────────────────────────────────
    const commandsToSend = [];
    device.pendingCommands = device.pendingCommands.map(cmd => {
      if (cmd.status === "pending" && cmd.attempts < cmd.maxAttempts) {
        cmd.status   = "sent";
        cmd.attempts += 1;
        commandsToSend.push(cmd);
      }
      return cmd;
    });

    await device.save();

    const obj = device.toObject(); delete obj.pendingCommands;
    req.app.get("io").emit("device:update", obj);

    res.json({
      commands: commandsToSend.map(c => ({
        commandId: c.commandId,
        type:      c.type,
        payload:   c.payload,
      })),
      serverTime: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/esp/:deviceId/command/:commandId/ack ─────────────────────────
router.post("/:deviceId/command/:commandId/ack", async (req, res, next) => {
  try {
    const { success, error } = req.body;
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });

    const command = device.pendingCommands.find(c => c.commandId === req.params.commandId);
    if (!command) return res.status(404).json({ error: "Command not found" });

    command.status = success ? "acknowledged" : "failed";
    if (error) command.error = error;

    if (!success && command.type === "relay") {
      const relay = device.relays.find(r => r.index === command.payload.relayIndex);
      if (relay) { relay.state = !command.payload.state; relay.lastUpdated = new Date(); }
    }

    await device.save();
    const obj = device.toObject(); delete obj.pendingCommands;
    req.app.get("io").emit("device:update", obj);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;