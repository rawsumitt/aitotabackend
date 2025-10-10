const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema({
  name: {
    type: String,
    required: false,
    trim: true,
    default: ''
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    default: ''
  },
  status: {
    type: String,
    enum: ['default', 'interested', 'maybe', 'not interested'],
    default: 'default'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const groupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  category:{
    type: String,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  contacts: [contactSchema],
  agentIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent'
  }],
  // Ownership: who owns this group (client or humanAgent)
  ownerType: {
    type: String,
    enum: ['client', 'humanAgent'],
    required: false,
    default: 'client',
    index: true
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
    index: true
  },
  clientId: {
    type: String,
    required: true,
    index: true
  },
  category: {
    type: String,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt field before saving
groupSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Group', groupSchema); 

// Compound index for fast listing by ownership and recency
groupSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });