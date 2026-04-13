const mongoose = require('mongoose');

const relaySchema = new mongoose.Schema({
  index: {
    type: Number,
    required: true,
    min: 0,
    max: 7
  },
  name: {
    type: String,
    default: function() {
      return `Relay ${this.index + 1}`;
    }
  },
  state: {
    type: Boolean,
    default: false
  },
  type: {
    type: String,
    enum: ['digital', 'pwm'],
    default: 'digital'
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

const sensorSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['temperature', 'humidity', 'pressure', 'voltage', 'current', 'custom'],
    required: true
  },
  name: String,
  value: mongoose.Schema.Types.Mixed,
  unit: String,
  lastUpdated: {
    type: Date,
    default: Date.now
  }
});

const commandSchema = new mongoose.Schema({
  commandId: {
    type: String,
    required: true,
    unique: true
  },
  type: {
    type: String,
    enum: ['relay', 'restart', 'config', 'ota', 'custom'],
    required: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 5
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'acknowledged', 'failed'],
    default: 'pending'
  }
});

const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true
  },
  name: {
    type: String,
    default: function() {
      return `Device ${this.deviceId}`;
    },
    trim: true
  },
  type: {
    type: String,
    default: 'ESP32',
    enum: ['ESP32', 'ESP8266', 'Arduino', 'RaspberryPi', 'Custom']
  },
  firmware: {
    version: String,
    lastUpdate: Date
  },
  online: {
    type: Boolean,
    default: false
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  lastStatusChange: {
    type: Date,
    default: Date.now
  },
  ipAddress: String,
  macAddress: String,
  relays: {
    type: [relaySchema],
    default: function() {
      return Array.from({ length: 4 }, (_, i) => ({
        index: i,
        name: `Relay ${i + 1}`,
        state: false,
        type: 'digital'
      }));
    }
  },
  sensors: [sensorSchema],
  pendingCommands: {
    type: [commandSchema],
    default: []
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  },
  config: {
    heartbeatInterval: {
      type: Number,
      default: 10000,
      min: 5000,
      max: 60000
    },
    autoReconnect: {
      type: Boolean,
      default: true
    },
    timezone: {
      type: String,
      default: 'UTC'
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for device status
deviceSchema.virtual('status').get(function() {
  if (!this.online) return 'offline';
  const timeSinceLastSeen = Date.now() - this.lastSeen;
  if (timeSinceLastSeen > 30000) return 'inactive';
  return 'online';
});

// Virtual for relay count
deviceSchema.virtual('relayCount').get(function() {
  return this.relays?.length || 0;
});

// Virtual for sensor count
deviceSchema.virtual('sensorCount').get(function() {
  return this.sensors?.length || 0;
});

// Pre-save middleware
deviceSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // Update lastStatusChange if online status changed
  if (this.isModified('online')) {
    this.lastStatusChange = new Date();
  }
  
  next();
});

// Static method to find online devices
deviceSchema.statics.findOnline = function() {
  return this.find({ online: true });
};

// Static method to find devices needing commands
deviceSchema.statics.findWithPendingCommands = function() {
  return this.find({
    online: true,
    'pendingCommands.0': { $exists: true }
  });
};

// Instance method to add command
deviceSchema.methods.addCommand = function(type, payload) {
  const { v4: uuidv4 } = require('uuid');
  
  this.pendingCommands.push({
    commandId: uuidv4(),
    type,
    payload,
    createdAt: new Date(),
    attempts: 0,
    maxAttempts: 5,
    status: 'pending'
  });
  
  return this.save();
};

// Instance method to remove command
deviceSchema.methods.removeCommand = function(commandId) {
  this.pendingCommands = this.pendingCommands.filter(
    cmd => cmd.commandId !== commandId
  );
  return this.save();
};

// Instance method to update relay state
deviceSchema.methods.setRelayState = function(relayIndex, state) {
  const relay = this.relays.find(r => r.index === relayIndex);
  if (relay) {
    relay.state = state;
    relay.lastUpdated = new Date();
  }
  return this;
};

const Device = mongoose.model('Device', deviceSchema);

module.exports = Device;