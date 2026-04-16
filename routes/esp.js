const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const Device = require("../models/Device");

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
        deviceId, macAddress: mac, name: name || `ESP32-${mac.slice(-5)}`,
        type: chipModel || "ESP32", firmware: { version: firmwareVersion, lastUpdate: new Date() },
        ipAddress: ip, online: true, lastSeen: new Date(), relays,
      });
    } else {
      device.online = true; device.lastSeen = new Date();
      if (name) device.name = name;
      if (chipModel) device.type = chipModel;
      if (firmwareVersion) device.firmware = { version: firmwareVersion, lastUpdate: new Date() };
      if (ip) device.ipAddress = ip;
      if (mac) device.macAddress = mac;

      if (relayCount && device.relays.length !== relayCount) {
        const existing = device.relays;
        device.relays = Array.from({ length: relayCount }, (_, i) =>
          existing.find(r => r.index === i) || { index: i, name: `Relay ${i + 1}`, state: false, type: "digital" }
        );
      }
    }

    await device.save();

    const io = req.app.get("io");
    const deviceObj = device.toObject(); delete deviceObj.pendingCommands;
    io.emit("device:update", deviceObj);

    console.log(`[ESP] ${isNew ? "New" : "Reconnected"}: ${deviceId}`);
    res.json({
      deviceId: device.deviceId,
      relays: device.relays.map(r => ({ index: r.index, state: r.state })),
      serverTime: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:deviceId/heartbeat", async (req, res, next) => {
  try {
    const { rssi, freeHeap, uptime, cpuTemp, ip, dht22 } = req.body;
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });

    device.online = true;
    device.lastSeen = new Date();
    if (ip) device.ipAddress = ip;

    // Helper to update or add a sensor
    const upsertSensor = (type, name, value, unit) => {
      if (value === undefined || value === null) return;
      const existing = device.sensors.find(s => s.type === type && s.name === name);
      if (existing) {
        existing.value = value;
        existing.lastUpdated = new Date();
      } else {
        device.sensors.push({ type, name, value, unit, lastUpdated: new Date() });
      }
    };

    // Standard metrics
    upsertSensor("rssi",   "WiFi RSSI", rssi,     "dBm");
    upsertSensor("heap",   "Free Heap", freeHeap, "bytes");
    upsertSensor("uptime", "Uptime",    uptime,   "seconds");
    if (cpuTemp !== undefined)
      upsertSensor("temperature", "CPU Temp", cpuTemp, "°C");

    // DHT22 sensor data
    if (dht22 && dht22.ok) {
      if (dht22.temperature !== undefined) {
        upsertSensor("temperature", "Ambient Temp", parseFloat(dht22.temperature), "°C");
      }
      if (dht22.humidity !== undefined) {
        upsertSensor("humidity", "Humidity", parseFloat(dht22.humidity), "%");
      }
      if (dht22.heatIndex !== undefined) {
        upsertSensor("heatIndex", "Heat Index", parseFloat(dht22.heatIndex), "°C");
      }
    }

    // Process pending commands
    const commandsToSend = [];
    device.pendingCommands = device.pendingCommands.map(cmd => {
      if (cmd.status === "pending" && cmd.attempts < cmd.maxAttempts) {
        cmd.status = "sent";
        cmd.attempts += 1;
        commandsToSend.push(cmd);
      }
      return cmd;
    });

    await device.save();

    const deviceObj = device.toObject();
    delete deviceObj.pendingCommands;
    req.app.get("io").emit("device:update", deviceObj);

    res.json({
      commands: commandsToSend.map(c => ({
        commandId: c.commandId,
        type: c.type,
        payload: c.payload,
      })),
      serverTime: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});

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

    const deviceObj = device.toObject(); delete deviceObj.pendingCommands;
    req.app.get("io").emit("device:update", deviceObj);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;