"use strict";
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const db = require("./db");
const auth = require("./auth");

const pool = db.pool;
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

function mapExercise(row) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    code: row.code || "",
    topic: row.topic || "",
    statement: row.statement || [],
    resolution: row.resolution || [],
    myAttempt: row.my_attempt || []
  };
}

// ── auth ─────────────────────────────────────────────────────────────
app.post("/api/auth/login", auth.login);
app.post("/api/auth/logout", auth.logout);
app.get("/api/auth/me", auth.me);

// ── subjects ─────────────────────────────────────────────────────────
app.get("/api/subjects", function (req, res, next) {
  pool.query("select id, name from subjects order by created_at")
    .then(function (r) { res.json(r.rows); })
    .catch(next);
});
app.post("/api/subjects", auth.requireAuth, function (req, res, next) {
  var name = String((req.body && req.body.name) || "").trim();
  if (!name) return res.status(400).json({ error: "Falta el nombre." });
  pool.query("insert into subjects (name) values ($1) returning id, name", [name])
    .then(function (r) { res.status(201).json(r.rows[0]); })
    .catch(next);
});
app.delete("/api/subjects/:id", auth.requireAuth, function (req, res, next) {
  pool.query("delete from subjects where id = $1", [req.params.id])
    .then(function () { res.json({ ok: true }); })
    .catch(next);
});

// ── exercises ────────────────────────────────────────────────────────
app.get("/api/exercises", function (req, res, next) {
  pool.query("select id, subject_id, code, topic, statement, resolution, my_attempt from exercises order by created_at")
    .then(function (r) { res.json(r.rows.map(mapExercise)); })
    .catch(next);
});
app.post("/api/exercises", auth.requireAuth, function (req, res, next) {
  var b = req.body || {};
  pool.query(
    "insert into exercises (subject_id, code, topic, statement, resolution, my_attempt) values ($1, $2, $3, $4, $5, '[]') " +
    "returning id, subject_id, code, topic, statement, resolution, my_attempt",
    [b.subjectId, b.code || "", b.topic || "", JSON.stringify(b.statement || []), JSON.stringify(b.resolution || [])]
  ).then(function (r) { res.status(201).json(mapExercise(r.rows[0])); }).catch(next);
});
app.put("/api/exercises/:id", auth.requireAuth, function (req, res, next) {
  var b = req.body || {};
  pool.query(
    "update exercises set code=$2, topic=$3, statement=$4, resolution=$5 where id=$1 " +
    "returning id, subject_id, code, topic, statement, resolution, my_attempt",
    [req.params.id, b.code || "", b.topic || "", JSON.stringify(b.statement || []), JSON.stringify(b.resolution || [])]
  ).then(function (r) {
    if (!r.rows[0]) return res.status(404).json({ error: "No encontrado." });
    res.json(mapExercise(r.rows[0]));
  }).catch(next);
});
app.put("/api/exercises/:id/attempt", auth.requireAuth, function (req, res, next) {
  pool.query(
    "update exercises set my_attempt=$2 where id=$1 returning id, subject_id, code, topic, statement, resolution, my_attempt",
    [req.params.id, JSON.stringify((req.body && req.body.myAttempt) || [])]
  ).then(function (r) {
    if (!r.rows[0]) return res.status(404).json({ error: "No encontrado." });
    res.json(mapExercise(r.rows[0]));
  }).catch(next);
});
app.delete("/api/exercises/:id", auth.requireAuth, function (req, res, next) {
  pool.query("delete from exercises where id = $1", [req.params.id])
    .then(function () { res.json({ ok: true }); })
    .catch(next);
});

// ── files (imágenes / PDFs adjuntos) ────────────────────────────────
app.post("/api/upload", auth.requireAuth, upload.single("file"), function (req, res, next) {
  if (!req.file) return res.status(400).json({ error: "Falta el archivo." });
  pool.query(
    "insert into files (filename, mime_type, data) values ($1, $2, $3) returning id",
    [req.file.originalname, req.file.mimetype, req.file.buffer]
  ).then(function (r) { res.status(201).json({ url: "/api/files/" + r.rows[0].id }); }).catch(next);
});
app.get("/api/files/:id", function (req, res, next) {
  pool.query("select filename, mime_type, data from files where id = $1", [req.params.id])
    .then(function (r) {
      if (!r.rows[0]) return res.status(404).end();
      res.setHeader("Content-Type", r.rows[0].mime_type || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(r.rows[0].data);
    }).catch(next);
});

app.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

// ── frontend estático (index.html, app.js, styles.css en la raíz del repo) ──
app.use(express.static(path.join(__dirname, "..")));

var PORT = process.env.PORT || 3000;
db.migrate()
  .then(function () { app.listen(PORT, function () { console.log("Listening on " + PORT); }); })
  .catch(function (err) { console.error("Migration failed", err); process.exit(1); });
