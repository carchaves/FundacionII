"use strict";
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const COOKIE_NAME = "session";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function login(req, res) {
  var email = String((req.body && req.body.email) || "").trim().toLowerCase();
  var password = (req.body && req.body.password) || "";
  var adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  var adminHash = process.env.ADMIN_PASSWORD_HASH || "";
  var secret = process.env.SESSION_SECRET;
  if (!adminEmail || !adminHash || !secret) {
    return res.status(500).json({ error: "El servidor no tiene configurada la cuenta de administrador (ADMIN_EMAIL / ADMIN_PASSWORD_HASH / SESSION_SECRET)." });
  }
  if (email !== adminEmail || !bcrypt.compareSync(password, adminHash)) {
    return res.status(401).json({ error: "Credenciales inválidas." });
  }
  var token = jwt.sign({ email: adminEmail }, secret, { expiresIn: "30d" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE_MS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
  res.json({ email: adminEmail });
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
}

function readSession(req) {
  var token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token || !process.env.SESSION_SECRET) return null;
  try {
    var payload = jwt.verify(token, process.env.SESSION_SECRET);
    return { email: payload.email };
  } catch (e) {
    return null;
  }
}

function me(req, res) {
  res.json({ user: readSession(req) });
}

function requireAuth(req, res, next) {
  var session = readSession(req);
  if (!session) return res.status(401).json({ error: "No autenticado." });
  req.user = session;
  next();
}

module.exports = { login: login, logout: logout, me: me, requireAuth: requireAuth };
