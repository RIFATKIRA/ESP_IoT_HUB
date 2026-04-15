const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, "Invalid email address"],
  },
  password: { type: String, required: true, minlength: 6 },
  role: { type: String, enum: ["admin", "user"], default: "user" },
  isVerified: { type: Boolean, default: false },
  confirmToken: { type: String, default: null },
  confirmTokenExpiry: { type: Date, default: null },
  resetToken: { type: String, default: null },
  resetTokenExpiry: { type: Date, default: null },
  lastLogin: { type: Date, default: null },
}, { timestamps: true });

userSchema.pre("save", async function () {
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 12);
  }

  const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  if (adminEmail && (this.isNew || this.isModified("email"))) {
    this.role = this.email === adminEmail ? "admin" : "user";
  }
});

userSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.methods.generateConfirmToken = function () {
  const token = crypto.randomBytes(32).toString("hex");
  this.confirmToken = token;
  this.confirmTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return token;
};

userSchema.methods.generateResetToken = function () {
  const token = crypto.randomBytes(32).toString("hex");
  this.resetToken = token;
  this.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
  return token;
};

module.exports = mongoose.model("User", userSchema);