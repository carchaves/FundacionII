"use strict";
// Genera el hash bcrypt para ADMIN_PASSWORD_HASH.
// Uso: node hash-password.js "tu-contraseña"
const bcrypt = require("bcryptjs");

var password = process.argv[2];
if (!password) {
  console.error("Uso: node hash-password.js <contraseña>");
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 10));
