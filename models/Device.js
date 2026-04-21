const mongoose = require("mongoose");

// ── Relay subdocument ──────────────────────────────────────────────────────
const relaySchema = new mongoose.Schema({
  index:       { type: Number, required: true, min: 0, max: 7 },
  name:        { type: String, default: "Relay" },
  state:       { type: Boolean, default: false },
  type:        { type: String, enum: ["digital", "pwm"], default: "digital" },
  lastUpdated: { type: Date, default: Date.now },
});

// ── Sensor subdocument ─────────────────────────────────────────────────────
const sensorSchema = new mongoose.Schema({
  type: {
    type: String,
    // ✅ FIX: "heatIndex" was missing. Mongoose threw a validation error on
    // every heartbeat with DHT22 connected, causing device.save() to FAIL.
    // This meant NOTHING (not even RSSI / heap / uptime) was ever stored.
    enum: [
      "temperature", "humidity", "heatIndex", "pressure",
      "voltage", "current", "power", "energy",
      "rssi", "heap", "uptime",
      "co2", "lux", "distance", "motion",
      "custom",
    ],
    required: true,
  },
  name:        { type: String, default: "" },
  // ✅ FIX: "group" field added so dashboard can group related readings
  // (e.g. temperature + humidity + heatIndex all belong to "DHT22").
  // Without this, Mongoose strict-mode silently dropped the value.
  group:       { type: String, default: "" },
  value:       { type: mongoose.Schema.Types.Mixed, default: null },
  unit:        { type: String, default: "" },
  lastUpdated: { type: Date, default: Date.now },
});

// ── Command subdocument ────────────────────────────────────────────────────
const commandSchema = new mongoose.Schema({
  commandId:   { type: String, required: true },
  type:        { type: String, enum: ["relay", "restart", "config", "ota", "custom"], required: true },
  payload:     { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt:   { type: Date, default: Date.now },
  attempts:    { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  status:      { type: String, enum: ["pending", "sent", "acknowledged", "failed"], default: "pending" },
  error:       String,
});

// ── Device schema ──────────────────────────────────────────────────────────
const deviceSchema = new mongoose.Schema(
  {
    deviceId:         { type: String, required: true, unique: true, index: true, trim: true },
    name:             { type: String, default: "Unnamed Device", trim: true },
    type:             { type: String, default: "ESP32" },
    firmware:         { version: String, lastUpdate: Date },
    online:           { type: Boolean, default: false },
    lastSeen:         { type: Date, default: Date.now },
    lastStatusChange: { type: Date, default: Date.now },
    ipAddress:        String,
    macAddress:       String,
    relays:           { type: [relaySchema],   default: [] },
    sensors:          { type: [sensorSchema],  default: [] },
    pendingCommands:  { type: [commandSchema], default: [] },
    config: {
      heartbeatInterval: { type: Number, default: 1000, min: 500, max: 60000 },
      autoReconnect:     { type: Boolean, default: true },
      timezone:          { type: String,  default: "UTC" },
    },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Virtuals ───────────────────────────────────────────────────────────────
deviceSchema.virtual("status").get(function () {
  if (!this.online) return "offline";
  return (Date.now() - new Date(this.lastSeen)) > 35000 ? "inactive" : "online";
});
deviceSchema.virtual("relayCount").get(function () { return this.relays?.length || 0; });
deviceSchema.virtual("sensorCount").get(function () { return this.sensors?.length || 0; });

// ── Hooks ──────────────────────────────────────────────────────────────────
deviceSchema.pre("save", function () {
  if (this.relays) {
    this.relays.forEach(relay => {
      if (!relay.name || relay.name === "Relay") relay.name = `Relay ${relay.index + 1}`;
    });
  }
});

// ── Statics ────────────────────────────────────────────────────────────────
deviceSchema.statics.findOnline = function () { return this.find({ online: true }); };
deviceSchema.statics.findWithPendingCommands = function () {
  return this.find({ online: true, "pendingCommands.0": { $exists: true } });
};

// ── Instance methods ───────────────────────────────────────────────────────
deviceSchema.methods.addCommand = function (type, payload) {
  const { v4: uuidv4 } = require("uuid");
  this.pendingCommands.push({
    commandId: uuidv4(), type, payload,
    createdAt: new Date(), attempts: 0, maxAttempts: 5, status: "pending",
  });
  return this.save();
};
deviceSchema.methods.setRelayState = function (relayIndex, state) {
  const relay = this.relays.find(r => r.index === relayIndex);
  if (relay) { relay.state = state; relay.lastUpdated = new Date(); }
  return this;
};

const Device = mongoose.model("Device", deviceSchema);
module.exports = Device;