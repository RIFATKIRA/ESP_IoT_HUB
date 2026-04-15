const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const Device = require("../models/Device");
const { requireAuth, requireAdmin } = require("../middleware/auth");

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const { online, limit = 100, skip = 0 } = req.query;
    const query = {};
    if (online !== undefined) query.online = online === "true";
    const devices = await Device.find(query, { pendingCommands: 0 })
      .sort({ lastSeen: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));
    res.json(devices);
  } catch (err) {
    next(err);
  }
});

router.get("/:deviceId", async (req, res, next) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId }, { pendingCommands: 0 });
    if (!device) return res.status(404).json({ error: "Device not found" });
    res.json(device);
  } catch (err) {
    next(err);
  }
});

router.patch("/:deviceId", async (req, res, next) => {
  try {
    const { name } = req.body;
    const device = await Device.findOneAndUpdate(
      { deviceId: req.params.deviceId },
      { name },
      { returnDocument: "after", select: "-pendingCommands" }
    );
    if (!device) return res.status(404).json({ error: "Device not found" });
    req.app.get("io").emit("device:update", device.toObject());
    res.json(device);
  } catch (err) {
    next(err);
  }
});

router.delete("/:deviceId", requireAdmin, async (req, res, next) => {
  try {
    await Device.deleteOne({ deviceId: req.params.deviceId });
    req.app.get("io").emit("device:removed", req.params.deviceId);
    res.json({ message: "Device removed" });
  } catch (err) {
    next(err);
  }
});

router.post("/:deviceId/relay", requireAdmin, async (req, res, next) => {
  try {
    const { relayIndex, state } = req.body;
    if (typeof relayIndex !== "number" || typeof state !== "boolean") {
      return res.status(400).json({ error: "relayIndex (number) and state (boolean) required" });
    }

    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });

    const relay = device.relays.find(r => r.index === relayIndex);
    if (!relay) return res.status(404).json({ error: "Relay not found" });

    relay.state = state;
    relay.lastUpdated = new Date();

    const commandId = uuidv4();
    device.pendingCommands.push({
      commandId,
      type: "relay",
      payload: { relayIndex, state },
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 5,
      status: "pending",
    });
    await device.save();

    const sendWs = req.app.get('sendCommandToESP');
    const sent = await sendWs(device.deviceId, { commandId, payload: { relayIndex, state } });

    if (sent) {
      const cmd = device.pendingCommands.find(c => c.commandId === commandId);
      if (cmd) { cmd.status = 'sent'; cmd.attempts = 1; }
      await device.save();
      console.log(`[RELAY] WS sent to ${device.deviceId}`);
    } else {
      console.log(`[RELAY] Queued for heartbeat (WS not connected)`);
    }

    const deviceObj = device.toObject();
    delete deviceObj.pendingCommands;
    req.app.get("io").emit("device:update", deviceObj);

    res.json({ queued: true, commandId, relayIndex, state, sentViaWS: sent });
  } catch (err) {
    next(err);
  }
});

router.patch("/:deviceId/relay/:relayIndex/name", requireAdmin, async (req, res, next) => {
  try {
    const { name } = req.body;
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });

    const relay = device.relays.find(r => r.index === parseInt(req.params.relayIndex));
    if (!relay) return res.status(404).json({ error: "Relay not found" });

    relay.name = name;
    await device.save();

    const deviceObj = device.toObject();
    delete deviceObj.pendingCommands;
    req.app.get("io").emit("device:update", deviceObj);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/:deviceId/commands", requireAdmin, async (req, res, next) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: "Device not found" });
    res.json(device.pendingCommands);
  } catch (err) {
    next(err);
  }
});

router.delete("/:deviceId/commands", requireAdmin, async (req, res, next) => {
  try {
    await Device.updateOne({ deviceId: req.params.deviceId }, { $set: { pendingCommands: [] } });
    res.json({ message: "Commands cleared" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;