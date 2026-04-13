const mongoose = require("mongoose");

// ── Relay subdocument ─────────────────────────────────────────────────────────
const relaySchema = new mongoose.Schema({
  index:       { type: Number, required: true, min: 0, max: 7 },
  name:        { type: String, default: "Relay" },   // set correctly in pre-save
  state:       { type: Boolean, default: false },
  type:        { type: String, enum: ["digital", "pwm"], default: "digital" },
  lastUpdated: { type: Date, default: Date.now },
});

// ── Sensor subdocument ────────────────────────────────────────────────────────
const sensorSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["temperature", "humidity", "pressure", "voltage", "current", "rssi", "heap", "uptime", "custom"],
    required: true,
  },
  name:        String,
  value:       mongoose.Schema.Types.Mixed,
  unit:        String,
  lastUpdated: { type: Date, default: Date.now },
});

// ── Command subdocument — NO unique:true on subdoc fields ─────────────────────
const commandSchema = new mongoose.Schema({
  commandId:   { type: String, required: true },   // unique enforced at app level
  type:        { type: String, enum: ["relay", "restart", "config", "ota", "custom"], required: true },
  payload:     { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt:   { type: Date, default: Date.now },
  attempts:    { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  status:      { type: String, enum: ["pending", "sent", "acknowledged", "failed"], default: "pending" },
  error:       String,
});

// ── Device schema ─────────────────────────────────────────────────────────────
const deviceSchema = new mongoose.Schema(
  {
    deviceId:         { type: String, required: true, unique: true, index: true, trim: true },
    name:             { type: String, default: "Unnamed Device", trim: true },
    type:             { type: String, default: "ESP32" },
    firmware: {
      version:        String,
      lastUpdate:     Date,
    },
    online:           { type: Boolean, default: false },
    lastSeen:         { type: Date, default: Date.now },
    lastStatusChange: { type: Date, default: Date.now },
    ipAddress:        String,
    macAddress:       String,
    relays:           { type: [relaySchema], default: [] },
    sensors:          { type: [sensorSchema], default: [] },
    pendingCommands:  { type: [commandSchema], default: [] },
    config: {
      heartbeatInterval: { type: Number, default: 10000, min: 5000, max: 60000 },
      autoReconnect:     { type: Boolean, default: true },
      timezone:          { type: String, default: "UTC" },
    },
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Virtuals ──────────────────────────────────────────────────────────────────
deviceSchema.virtual("status").get(function () {
  if (!this.online) return "offline";
  return Date.now() - new Date(this.lastSeen) > 30000 ? "inactive" : "online";
});

deviceSchema.virtual("relayCount").get(function () {
  return this.relays?.length || 0;
});

deviceSchema.virtual("sensorCount").get(function () {
  return this.sensors?.length || 0;
});

deviceSchema.pre("save", async function () {
  if (this.relays) {
    this.relays.forEach((relay) => {
      if (!relay.name || relay.name === "Relay") {
        relay.name = `Relay ${relay.index + 1}`;
      }
    });
  }
})

// ── Static methods ────────────────────────────────────────────────────────────
deviceSchema.statics.findOnline = function () {
  return this.find({ online: true });
};

deviceSchema.statics.findWithPendingCommands = function () {
  return this.find({ online: true, "pendingCommands.0": { $exists: true } });
};

// ── Instance methods ──────────────────────────────────────────────────────────
deviceSchema.methods.addCommand = function (type, payload) {
  const { v4: uuidv4 } = require("uuid");
  this.pendingCommands.push({
    commandId:   uuidv4(),
    type,
    payload,
    createdAt:   new Date(),
    attempts:    0,
    maxAttempts: 5,
    status:      "pending",
  });
  return this.save();
};

deviceSchema.methods.setRelayState = function (relayIndex, state) {
  const relay = this.relays.find((r) => r.index === relayIndex);
  if (relay) {
    relay.state = state;
    relay.lastUpdated = new Date();
  }
  return this;
};

const Device = mongoose.model("Device", deviceSchema);
module.exports = Device;