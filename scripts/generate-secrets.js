"use strict";
// Genera secrets.generated.js: el token de GitHub cifrado con una clave
// derivada de la contraseña de la app. Correr SIEMPRE localmente — nunca
// pegar el token en un chat ni commitearlo en texto plano.
//
// Uso: node scripts/generate-secrets.js <github-token> <contraseña>
//
// Formato compatible con lo que app.js espera desencriptar en el navegador
// vía Web Crypto (PBKDF2-SHA256 + AES-GCM 256).

const crypto = require("crypto").webcrypto;
const fs = require("fs");
const path = require("path");

const ITERATIONS = 300000;

async function main() {
  const token = process.argv[2];
  const password = process.argv[3];
  if (!token || !password) {
    console.error("Uso: node scripts/generate-secrets.js <github-token> <contraseña>");
    process.exit(1);
  }

  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(token));

  const toB64 = (buf) => Buffer.from(buf).toString("base64");
  const out =
    "window.__GH_AUTH__ = {\n" +
    '  saltB64: "' + toB64(salt) + '",\n' +
    '  ivB64: "' + toB64(iv) + '",\n' +
    '  cipherB64: "' + toB64(cipherBuf) + '",\n' +
    "  iterations: " + ITERATIONS + "\n" +
    "};\n";

  const outPath = path.join(__dirname, "..", "secrets.generated.js");
  fs.writeFileSync(outPath, out);
  console.log("OK: " + outPath + " generado. El token NO quedó en este archivo, solo el blob cifrado.");
}

main().catch((err) => {
  console.error("Error generando el secreto:", err.message);
  process.exit(1);
});
