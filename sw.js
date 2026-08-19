"use strict";
// Service worker mínimo: solo existe para poder registrar la PWA como
// Web Share Target (recibir una imagen compartida desde otra app) sin
// backend. No cachea nada del sitio (no se pidió soporte offline).

var DB_NAME = "fundacion2-share";
var STORE_NAME = "shared";

self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function storeSharedFile(file) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ id: "pending", file: file, name: file.name, type: file.type, at: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  var isShareTarget = event.request.method === "POST" && url.pathname.indexOf("/share-target.html") !== -1;
  if (!isShareTarget) return;

  event.respondWith((function () {
    return event.request.formData()
      .then(function (formData) {
        var file = formData.get("sharedImage");
        if (file && file.size > 0) return storeSharedFile(file);
      })
      .then(function () { return Response.redirect("./?shared=1", 303); })
      .catch(function () { return Response.redirect("./?shared=error", 303); });
  })());
});
