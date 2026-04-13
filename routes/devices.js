const express = require('express');
const router = express.Router();
const Device = require('../models/Device');
const { v4: uuidv4 } = require('uuid');

// Get all devices
router.get('/', async (req, res) => {
  try {
    const { online, limit = 100, skip = 0 } = req.query;
    
    const query = {};
    if (online !== undefined) {
      query.online = online === 'true';
    }
    
    const devices = await Device.find(query, { pendingCommands: 0 })
      .sort({ lastSeen: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));
    
    res.json({
      success: true,
      count: devices.length,
      data: devices
    });
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch devices'
    });
  }
});

// Get single device
router.get('/:deviceId', async (req, res) => {
  try {
    const device = await Device.findOne({ 
      deviceId: req.params.deviceId 
    }, { pendingCommands: 0 });
    
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
    
    res.json({
      success: true,
      data: device
    });
  } catch (error) {
    console.error('Error fetching device:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch device'
    });
  }
});

// Register new device
router.post('/register', async (req, res) => {
  try {
    const { deviceId, name, type, metadata } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: 'Device ID is required'
      });
    }
    
    let device = await Device.findOne({ deviceId });
    
    if (device) {
      // Update existing device
      device.name = name || device.name;
      device.type = type || device.type;
      device.metadata = { ...device.metadata, ...metadata };
      device.lastSeen = new Date();
      device.online = true;
      await device.save();
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
      await device.save();
    }
    
    const io = req.app.get('io');
    io.emit('device:update', device.toObject());
    
    res.json({
      success: true,
      data: device,
      message: device.isNew ? 'Device registered' : 'Device updated'
    });
  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to register device'
    });
  }
});

// Update device
router.put('/:deviceId', async (req, res) => {
  try {
    const { name, type, config, metadata } = req.body;
    
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
    
    if (name) device.name = name;
    if (type) device.type = type;
    if (config) device.config = { ...device.config, ...config };
    if (metadata) device.metadata = { ...device.metadata, ...metadata };
    
    await device.save();
    
    const io = req.app.get('io');
    io.emit('device:update', device.toObject());
    
    res.json({
      success: true,
      data: device
    });
  } catch (error) {
    console.error('Error updating device:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update device'
    });
  }
});

// Delete device
router.delete('/:deviceId', async (req, res) => {
  try {
    const device = await Device.findOneAndDelete({ 
      deviceId: req.params.deviceId 
    });
    
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
    
    const io = req.app.get('io');
    io.emit('device:deleted', { deviceId: req.params.deviceId });
    
    res.json({
      success: true,
      message: 'Device deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting device:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete device'
    });
  }
});

// Control relay
router.post('/:deviceId/relay/:relayIndex', async (req, res) => {
  try {
    const { state } = req.body;
    const relayIndex = parseInt(req.params.relayIndex);
    
    if (typeof state !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'State must be a boolean'
      });
    }
    
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
    
    const relay = device.relays.find(r => r.index === relayIndex);
    if (!relay) {
      return res.status(404).json({
        success: false,
        error: 'Relay not found'
      });
    }
    
    relay.state = state;
    relay.lastUpdated = new Date();
    
    // Add command to queue
    device.pendingCommands.push({
      commandId: uuidv4(),
      type: 'relay',
      payload: { relayIndex, state },
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 5,
      status: 'pending'
    });
    
    await device.save();
    
    const io = req.app.get('io');
    const deviceObj = device.toObject();
    delete deviceObj.pendingCommands;
    io.emit('device:update', deviceObj);
    
    res.json({
      success: true,
      data: device
    });
  } catch (error) {
    console.error('Error controlling relay:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to control relay'
    });
  }
});

// Get device commands
router.get('/:deviceId/commands', async (req, res) => {
  try {
    const device = await Device.findOne({ 
      deviceId: req.params.deviceId 
    });
    
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
    
    res.json({
      success: true,
      data: device.pendingCommands
    });
  } catch (error) {
    console.error('Error fetching commands:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch commands'
    });
  }
});

// Clear device commands
router.delete('/:deviceId/commands', async (req, res) => {
  try {
    const device = await Device.findOne({ 
      deviceId: req.params.deviceId 
    });
    
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
    
    device.pendingCommands = [];
    await device.save();
    
    res.json({
      success: true,
      message: 'Commands cleared successfully'
    });
  } catch (error) {
    console.error('Error clearing commands:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear commands'
    });
  }
});

// Send custom command
router.post('/:deviceId/command', async (req, res) => {
  try {
    const { type, payload } = req.body;
    
    if (!type || !payload) {
      return res.status(400).json({
        success: false,
        error: 'Command type and payload are required'
      });
    }
    
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    
    if (!device) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
    
    await device.addCommand(type, payload);
    
    res.json({
      success: true,
      message: 'Command queued successfully'
    });
  } catch (error) {
    console.error('Error sending command:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send command'
    });
  }
});

module.exports = router;