(function () {
  "use strict";

  var GH_OWNER = "carchaves";
  var GH_REPO = "FundacionII";
  var GH_BRANCH = "main";
  var GH_API = "https://api.github.com/repos/" + GH_OWNER + "/" + GH_REPO;
  var GH_RAW = "https://raw.githubusercontent.com/" + GH_OWNER + "/" + GH_REPO + "/" + GH_BRANCH;
  var DB_PATH = "data/db.json";
  var MAX_FILE_MB = 5;
  var TOKEN_COOKIE = "gh_token";
  var COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 días
  var POLL_INTERVAL_MS = 15000;
  var POLL_INTERVAL_MS_ANON = 90000;
  var WRITE_SUPPRESS_POLL_MS = 120000; // ver comentario en loadRemote()
  var SHARE_DB_NAME = "fundacion2-share";
  var SHARE_STORE_NAME = "shared";

  var LANGS = [
    ["javascript", "JavaScript"], ["python", "Python"], ["java", "Java"], ["c", "C"],
    ["cpp", "C++"], ["csharp", "C#"], ["go", "Go"], ["rust", "Rust"],
    ["sql", "SQL"], ["html", "HTML"], ["css", "CSS"], ["plaintext", "Otro / texto plano"]
  ];

  function uid() { return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function typeLabel(type) {
    return type === "text" ? "Texto" : type === "code" ? "Código" : type === "image" ? "Imagen" : "PDF";
  }

  // ── cookies (persiste el token descifrado, no la contraseña) ───────────
  function setCookie(name, value) {
    var secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = name + "=" + encodeURIComponent(value) + "; max-age=" + COOKIE_MAX_AGE + "; path=/; SameSite=Lax" + secure;
  }
  function getCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function clearCookie(name) {
    document.cookie = name + "=; max-age=0; path=/; SameSite=Lax";
  }

  // ── base64 helpers (UTF-8 seguro, para textos con tildes/ñ) ─────────────
  function b64ToBytes(b64) {
    var binary = atob(b64.replace(/\n/g, ""));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function b64ToUtf8(b64) { return new TextDecoder("utf-8").decode(b64ToBytes(b64)); }
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // ── descifrado del token (PBKDF2 + AES-GCM, ver scripts/generate-secrets.js) ──
  function decryptToken(password) {
    var auth = window.__GH_AUTH__;
    if (!auth) return Promise.reject(new Error("Falta secrets.generated.js (correr scripts/generate-secrets.js)."));
    var enc = new TextEncoder();
    var salt = b64ToBytes(auth.saltB64);
    var iv = b64ToBytes(auth.ivB64);
    var cipher = b64ToBytes(auth.cipherB64);
    return crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"])
      .then(function (baseKey) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: auth.iterations, hash: "SHA-256" },
          baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
        );
      })
      .then(function (key) { return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, cipher); })
      .then(function (plainBuf) { return new TextDecoder().decode(plainBuf); });
  }

  // ── API de contenidos de GitHub (lecturas públicas vía raw, escrituras autenticadas) ──
  function ghHeaders() {
    return { "Authorization": "token " + state.session, "Accept": "application/vnd.github+json" };
  }
  function ghGetFile(path) {
    return fetch(GH_API + "/contents/" + path + "?ref=" + GH_BRANCH, { headers: ghHeaders(), cache: "no-store" }).then(function (res) {
      if (res.status === 404) return null;
      if (!res.ok) return res.json().catch(function () { return null; }).then(function (d) {
        var e = new Error((d && d.message) || res.statusText); e.status = res.status; throw e;
      });
      return res.json().then(function (data) { return { sha: data.sha, content: b64ToUtf8(data.content) }; });
    });
  }
  function ghPutFile(path, content, message, sha, isBase64) {
    var body = { message: message, content: isBase64 ? content : utf8ToB64(content), branch: GH_BRANCH };
    if (sha) body.sha = sha;
    return fetch(GH_API + "/contents/" + path, {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, ghHeaders()),
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) return res.json().catch(function () { return null; }).then(function (d) {
        var e = new Error((d && d.message) || res.statusText); e.status = res.status; throw e;
      });
      return res.json();
    });
  }
  // Lee data/db.json (aplica mutate(db) en memoria) y lo commitea.
  // api.github.com cachea las lecturas 60s (cache-control: s-maxage=60, no
  // hay forma de evitarlo desde el cliente), así que dos escrituras seguidas
  // pueden chocar contra un sha desactualizado; se reintenta un par de veces.
  function withDb(mutate, commitMessage) {
    function attempt(retriesLeft) {
      return ghGetFile(DB_PATH).then(function (file) {
        var db = file ? JSON.parse(file.content) : { subjects: [], exercises: [] };
        var result = mutate(db);
        return ghPutFile(DB_PATH, JSON.stringify(db, null, 2), commitMessage, file ? file.sha : null)
          .then(function () {
            state.subjects = db.subjects;
            state.exercises = db.exercises;
            state.lastWriteAt = Date.now();
            return result;
          })
          .catch(function (err) {
            if (err.status === 409 && retriesLeft > 0) return attempt(retriesLeft - 1);
            throw err;
          });
      });
    }
    return attempt(2);
  }

  var state = {
    subjects: [],
    exercises: [],
    view: "home",
    currentSubjectId: null,
    currentExerciseId: null,
    editingExerciseId: null,
    formReturnView: "subject",
    formDraft: { code: "", topic: "", statement: [], resolution: [] },
    attemptDraft: [],
    practiceTopic: "",
    showAnswer: false,
    addSubjectOpen: false,
    newSubjectName: "",
    copiedId: null,
    session: null,
    authOpen: false,
    authPassword: "",
    authError: "",
    authLoading: false,
    loading: true,
    syncError: null,
    lastWriteAt: 0,
    pendingSharedFile: null
  };

  function isAuthed() { return !!state.session; }

  // ── datos remotos (data/db.json en el repo) ─────────────────────────
  // Se lee desde api.github.com en vez de raw.githubusercontent.com: ese CDN
  // cachea por path 5 minutos IGNORANDO el query string (un cache-busting ahí
  // no sirve de nada). api.github.com también cachea (cache-control: s-maxage=60,
  // documentado, no evitable desde el cliente), así que justo después de
  // escribir nosotros mismos NO conviene refrescar desde acá — el estado local
  // ya quedó actualizado en withDb() con lo que realmente se commiteó, y un
  // poll dentro de esa ventana de 60s pisaría eso con la respuesta cacheada
  // (vieja). Ver WRITE_SUPPRESS_POLL_MS.
  function loadRemote() {
    if (Date.now() - state.lastWriteAt < WRITE_SUPPRESS_POLL_MS) return Promise.resolve();
    var headers = { "Accept": "application/vnd.github+json" };
    if (isAuthed()) headers.Authorization = "token " + state.session;
    return fetch(GH_API + "/contents/" + DB_PATH + "?ref=" + GH_BRANCH, { headers: headers, cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      var db = JSON.parse(b64ToUtf8(data.content));
      state.loading = false;
      state.syncError = null;
      state.subjects = db.subjects || [];
      state.exercises = db.exercises || [];
      render();
    }).catch(function () {
      state.loading = false;
      state.syncError = "No se pudo sincronizar con GitHub.";
      render();
    });
  }
  var lastPollAt = 0;
  function startPolling() {
    setInterval(function () {
      if (document.hidden) return;
      var active = document.activeElement;
      // Don't yank focus/caret out from under someone mid-edit; retry next tick.
      if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return;
      // Sin sesión, las lecturas van sin auth contra la API de GitHub (60/hora
      // por IP) — se espacian más para no agotar ese límite entre varios
      // visitantes. Con sesión, el límite autenticado (5000/hora) sobra.
      var minGap = isAuthed() ? POLL_INTERVAL_MS : POLL_INTERVAL_MS_ANON;
      if (Date.now() - lastPollAt < minGap) return;
      lastPollAt = Date.now();
      loadRemote();
    }, POLL_INTERVAL_MS);
  }

  // ── auth ─────────────────────────────────────────────────────────────
  function initAuth() {
    var token = getCookie(TOKEN_COOKIE);
    if (!token) return;
    state.session = token;
    render();
    fetch(GH_API, { headers: ghHeaders() }).then(function (res) {
      if (!res.ok) { state.session = null; clearCookie(TOKEN_COOKIE); render(); }
    }).catch(function () {});
  }
  function openAuth() { state.authOpen = true; state.authPassword = ""; state.authError = ""; render(); }
  function closeAuth() { state.authOpen = false; render(); }
  function signIn() {
    if (!state.authPassword) { state.authError = "Ingresá la contraseña."; render(); return; }
    state.authLoading = true; state.authError = ""; render();
    decryptToken(state.authPassword).then(function (token) {
      state.authLoading = false; state.session = token; state.authOpen = false; state.authPassword = "";
      setCookie(TOKEN_COOKIE, token);
      render(); loadRemote();
    }).catch(function () {
      state.authLoading = false; state.authError = "Contraseña incorrecta.";
      render();
    });
  }
  function signOut() {
    state.session = null;
    clearCookie(TOKEN_COOKIE);
    render();
  }

  // ── compartir imagen desde otra app (Web Share Target, ver sw.js) ────
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
  function openShareDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(SHARE_DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(SHARE_STORE_NAME, { keyPath: "id" }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  // Si venimos de compartir una imagen desde otra app (sw.js dejó el archivo
  // en IndexedDB y redirigió acá con ?shared=1), lo toma, lo borra (consumo
  // único) y lo deja listo en state.pendingSharedFile para que el usuario
  // elija la materia.
  function checkPendingShare() {
    var params = new URLSearchParams(location.search);
    var shared = params.get("shared");
    if (!shared) return;
    history.replaceState(null, "", location.pathname);
    if (shared !== "1") { state.syncError = "No se pudo recibir la imagen compartida, probá de nuevo."; render(); return; }
    openShareDb().then(function (db) {
      var tx = db.transaction(SHARE_STORE_NAME, "readwrite");
      var req = tx.objectStore(SHARE_STORE_NAME).get("pending");
      req.onsuccess = function () {
        var record = req.result;
        if (record && record.file) tx.objectStore(SHARE_STORE_NAME).delete("pending");
        tx.oncomplete = function () {
          if (!record || !record.file) return;
          state.pendingSharedFile = new File([record.file], record.name || "compartido.png", { type: record.type || "image/png" });
          if (!isAuthed()) openAuth(); else render();
        };
      };
    }).catch(function () {});
  }

  // ── navigation ───────────────────────────────────────────────────────
  function goHome() { state.view = "home"; state.currentSubjectId = null; state.currentExerciseId = null; render(); }
  function openSubject(id) { state.view = "subject"; state.currentSubjectId = id; state.practiceTopic = ""; render(); }
  function back() {
    var v = state.view;
    if (v === "subject") goHome();
    else if (v === "practice") { state.view = "subject"; render(); }
    else if (v === "form") { state.view = state.formReturnView || "subject"; render(); }
  }

  // ── subjects ─────────────────────────────────────────────────────────
  function openAddSubject() { if (!isAuthed()) return; state.addSubjectOpen = true; state.newSubjectName = ""; render(); }
  function closeAddSubject() { state.addSubjectOpen = false; state.newSubjectName = ""; render(); }
  function confirmAddSubject() {
    if (!isAuthed()) return;
    var name = (state.newSubjectName || "").trim();
    if (!name) return;
    state.addSubjectOpen = false; state.newSubjectName = "";
    render();
    withDb(function (db) { db.subjects = db.subjects.concat([{ id: uid(), name: name }]); }, "Agregar materia: " + name)
      .then(render).catch(function (err) { window.alert("Error al guardar: " + err.message); });
  }
  function deleteSubject(id) {
    if (!isAuthed()) return;
    if (!window.confirm("¿Eliminar esta materia y todos sus ejercicios?")) return;
    if (state.currentSubjectId === id) state.view = "home";
    render();
    withDb(function (db) {
      db.subjects = db.subjects.filter(function (s) { return s.id !== id; });
      db.exercises = db.exercises.filter(function (e) { return e.subjectId !== id; });
    }, "Eliminar materia").then(render).catch(function (err) { window.alert("Error al eliminar: " + err.message); });
  }

  // ── exercises ────────────────────────────────────────────────────────
  function openAddExercise() {
    if (!isAuthed()) return;
    state.view = "form"; state.editingExerciseId = null; state.formReturnView = "subject";
    state.formDraft = { code: "", topic: "", statement: [], resolution: [] };
    render();
  }
  function openEditExercise(ex, returnView) {
    if (!isAuthed() || !ex) return;
    var clone = JSON.parse(JSON.stringify(ex));
    state.view = "form"; state.editingExerciseId = ex.id; state.formReturnView = returnView || "subject";
    state.formDraft = { code: clone.code || "", topic: clone.topic || "", statement: clone.statement || [], resolution: clone.resolution || [] };
    render();
  }
  function saveForm() {
    if (!isAuthed()) return;
    var draft = state.formDraft;
    var editingId = state.editingExerciseId;
    var subjectId = state.currentSubjectId;
    var returnView = state.formReturnView || "subject";
    state.view = returnView;
    render();
    withDb(function (db) {
      if (editingId) {
        db.exercises = db.exercises.map(function (e) {
          return e.id === editingId ? Object.assign({}, e, { code: draft.code, topic: draft.topic, statement: draft.statement, resolution: draft.resolution }) : e;
        });
      } else {
        db.exercises = db.exercises.concat([{
          id: uid(), subjectId: subjectId, code: draft.code, topic: draft.topic,
          statement: draft.statement, resolution: draft.resolution, myAttempt: []
        }]);
      }
    }, (editingId ? "Editar ejercicio " : "Agregar ejercicio ") + (draft.code || ""))
      .then(render).catch(function (err) { window.alert("Error al guardar: " + err.message); });
  }
  function cancelForm() { state.view = state.formReturnView || "subject"; render(); }
  function deleteExercise(id) {
    if (!isAuthed()) return;
    if (!window.confirm("¿Eliminar este ejercicio? No se puede deshacer.")) return;
    if (state.view === "practice" && state.currentExerciseId === id) state.view = "subject";
    render();
    withDb(function (db) { db.exercises = db.exercises.filter(function (e) { return e.id !== id; }); }, "Eliminar ejercicio")
      .then(render).catch(function (err) { window.alert("Error al eliminar: " + err.message); });
  }

  // ── practice ─────────────────────────────────────────────────────────
  function openExercise(id) {
    var ex = state.exercises.find(function (e) { return e.id === id; });
    state.view = "practice"; state.currentExerciseId = id; state.showAnswer = false;
    state.attemptDraft = (ex && ex.myAttempt) ? JSON.parse(JSON.stringify(ex.myAttempt)) : [];
    render();
  }
  function pickRandom() {
    var topic = state.practiceTopic;
    var subjectId = state.currentSubjectId;
    var list = state.exercises.filter(function (e) { return e.subjectId === subjectId && (!topic || e.topic === topic); });
    if (!list.length) { window.alert("No hay ejercicios para ese tema."); return; }
    openExercise(list[Math.floor(Math.random() * list.length)].id);
  }
  function toggleAnswer() { state.showAnswer = !state.showAnswer; render(); }
  function saveAttempt() {
    if (!isAuthed()) return;
    var exId = state.currentExerciseId;
    var draft = state.attemptDraft;
    withDb(function (db) {
      db.exercises = db.exercises.map(function (e) { return e.id === exId ? Object.assign({}, e, { myAttempt: draft }) : e; });
    }, "Guardar resolución propia").then(render).catch(function (err) { window.alert("Error al guardar: " + err.message); });
  }
  function clearAttempt() {
    if (!isAuthed()) return;
    if (!window.confirm("¿Borrar tu resolución cargada?")) return;
    var exId = state.currentExerciseId;
    state.attemptDraft = [];
    render();
    withDb(function (db) {
      db.exercises = db.exercises.map(function (e) { return e.id === exId ? Object.assign({}, e, { myAttempt: [] }) : e; });
    }, "Borrar resolución propia").then(render).catch(function (err) { window.alert("Error al guardar: " + err.message); });
  }

  // ── statement / resolution / attempt blocks ─────────────────────────
  function getBlocks(section) { return section === "attempt" ? state.attemptDraft : state.formDraft[section]; }
  function setBlocks(section, arr) { if (section === "attempt") state.attemptDraft = arr; else state.formDraft[section] = arr; }
  function addBlock(section, type) {
    if (!isAuthed()) return;
    setBlocks(section, getBlocks(section).concat([{ id: uid(), type: type, text: "", language: "javascript", dataUrl: null }]));
    render();
  }
  // Crea un bloque de imagen y arranca la subida en el mismo paso (pegado, compartido desde el celular).
  function addBlockWithFile(section, file) {
    if (!isAuthed()) return;
    var blk = { id: uid(), type: "image", text: "", language: "javascript", dataUrl: null };
    setBlocks(section, getBlocks(section).concat([blk]));
    render();
    updateBlockFile(section, blk.id, file);
  }
  function removeBlock(section, id) {
    if (!isAuthed()) return;
    setBlocks(section, getBlocks(section).filter(function (b) { return b.id !== id; }));
    render();
  }
  // Mutates the block in place without a re-render, so the textarea keeps focus/caret while typing.
  function updateBlockText(section, id, text) {
    if (!isAuthed()) return;
    var b = getBlocks(section).find(function (b) { return b.id === id; });
    if (b) b.text = text;
  }
  function updateBlockLang(section, id, lang) {
    if (!isAuthed()) return;
    var b = getBlocks(section).find(function (b) { return b.id === id; });
    if (b) b.language = lang;
    render();
  }
  function updateBlockFile(section, id, file) {
    if (!isAuthed()) return;
    var b = getBlocks(section).find(function (b) { return b.id === id; });
    if (!b) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      b.uploadError = "El archivo es demasiado grande (máx " + MAX_FILE_MB + "MB).";
      render();
      return;
    }
    b.uploading = true; b.uploadError = null; render();
    var reader = new FileReader();
    reader.onload = function () {
      var base64 = String(reader.result).split(",")[1];
      var ext = (file.name.split(".").pop() || "bin").toLowerCase();
      var filePath = "data/files/" + uid() + "." + ext;
      ghPutFile(filePath, base64, "Adjuntar archivo: " + file.name, null, true).then(function () {
        var b2 = getBlocks(section).find(function (b) { return b.id === id; });
        if (!b2) return;
        b2.uploading = false; b2.dataUrl = GH_RAW + "/" + filePath; b2.fileName = file.name;
        render();
      }).catch(function (err) {
        var b2 = getBlocks(section).find(function (b) { return b.id === id; });
        if (b2) { b2.uploading = false; b2.uploadError = err.message; render(); }
      });
    };
    reader.readAsDataURL(file);
  }

  var copyTimer = null;
  function copyCode(id, text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text);
    state.copiedId = id;
    render();
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(function () {
      if (state.copiedId === id) { state.copiedId = null; render(); }
    }, 1500);
  }

  // ── rendering ────────────────────────────────────────────────────────
  function renderNav() {
    var showBack = state.view !== "home";
    var authControl = isAuthed()
      ? '<span class="text-muted" style="font-size:13px">Sesión iniciada</span>' +
        '<button class="btn btn-secondary" data-action="sign-out">Salir</button>'
      : '<button class="btn btn-secondary" data-action="open-auth">Iniciar sesión</button>';
    return (
      '<nav class="nav" style="border-bottom:1px solid var(--color-divider)">' +
      '<div class="nav-brand" style="cursor:pointer" data-action="go-home">Banco de Ejercicios</div>' +
      (showBack ?
        '<button class="btn btn-ghost" data-action="back">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>' +
        "Volver</button>" : "") +
      '<div style="display:flex;align-items:center;gap:10px;margin-left:var(--space-3)">' + authControl + "</div>" +
      "</nav>"
    );
  }

  function renderSyncBanner() {
    if (!state.syncError) return "";
    return '<div style="background:var(--color-accent-100);color:var(--color-accent-900);padding:var(--space-2) var(--space-4);font-size:13px;text-align:center">' + esc(state.syncError) + "</div>";
  }

  function renderEditableBlock(section, blk) {
    var inner = "";
    if (blk.type === "text") {
      inner = '<textarea class="input" rows="3" placeholder="Escribí el texto..." data-action="block-text" data-section="' + section + '" data-id="' + blk.id + '">' + esc(blk.text) + "</textarea>";
    } else if (blk.type === "code") {
      inner =
        '<select class="input" style="margin-bottom:var(--space-2);max-width:220px" data-action="block-lang" data-section="' + section + '" data-id="' + blk.id + '">' +
        LANGS.map(function (l) { return '<option value="' + l[0] + '"' + (blk.language === l[0] ? " selected" : "") + ">" + l[1] + "</option>"; }).join("") +
        "</select>" +
        '<textarea class="input" rows="6" style="font-family:monospace;font-size:13px" placeholder="Pegá el código..." data-action="block-text" data-section="' + section + '" data-id="' + blk.id + '">' + esc(blk.text) + "</textarea>";
    } else if (blk.type === "image") {
      inner = '<input type="file" accept="image/*" data-action="block-file" data-section="' + section + '" data-id="' + blk.id + '" />' +
        (blk.uploading ? '<p class="text-muted" style="font-size:12px;margin:6px 0 0">Subiendo…</p>' : "") +
        (blk.uploadError ? '<p style="font-size:12px;margin:6px 0 0;color:var(--color-accent-800)">' + esc(blk.uploadError) + "</p>" : "") +
        (blk.dataUrl ? '<img src="' + blk.dataUrl + '" style="max-width:100%;margin-top:var(--space-2);border:1px solid var(--color-divider)" />' : "");
    } else if (blk.type === "pdf") {
      inner = '<input type="file" accept="application/pdf" data-action="block-file" data-section="' + section + '" data-id="' + blk.id + '" />' +
        (blk.uploading ? '<p class="text-muted" style="font-size:12px;margin:6px 0 0">Subiendo…</p>' : "") +
        (blk.uploadError ? '<p style="font-size:12px;margin:6px 0 0;color:var(--color-accent-800)">' + esc(blk.uploadError) + "</p>" : "") +
        (blk.dataUrl ? '<iframe src="' + blk.dataUrl + '" style="width:100%;height:420px;border:1px solid var(--color-divider);margin-top:var(--space-2)"></iframe>' : "");
    }
    return (
      '<div class="blueprint" style="padding:var(--space-3);margin-bottom:var(--space-2);position:relative">' +
      '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-2)">' +
      '<span class="tag tag-neutral">' + typeLabel(blk.type) + "</span>" +
      '<button class="btn btn-icon" data-action="remove-block" data-section="' + section + '" data-id="' + blk.id + '" title="Quitar bloque">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      "</button></div>" + inner + "</div>"
    );
  }

  function renderAddButtons(section) {
    return (
      '<div style="display:flex;gap:var(--space-2);margin:var(--space-2) 0 var(--space-6);flex-wrap:wrap">' +
      '<button class="btn btn-secondary" data-action="add-block" data-section="' + section + '" data-type="text">+ Texto</button>' +
      '<button class="btn btn-secondary" data-action="add-block" data-section="' + section + '" data-type="code">+ Código</button>' +
      '<button class="btn btn-secondary" data-action="add-block" data-section="' + section + '" data-type="image">+ Imagen</button>' +
      '<button class="btn btn-secondary" data-action="add-block" data-section="' + section + '" data-type="pdf">+ PDF</button>' +
      "</div>"
    );
  }

  function renderViewBlock(blk) {
    var inner = "";
    if (blk.type === "text") {
      inner = '<p style="white-space:pre-wrap;margin:0">' + esc(blk.text) + "</p>";
    } else if (blk.type === "code") {
      var copyLabel = state.copiedId === blk.id ? "Copiado ✓" : "Copiar";
      inner =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
        '<span class="tag tag-neutral">' + esc(blk.language || "plaintext") + "</span>" +
        '<button class="btn btn-ghost" style="font-size:12px" data-action="copy-code" data-id="' + blk.id + '">' + copyLabel + "</button>" +
        "</div>" +
        '<pre style="margin:0;overflow:auto"><code class="language-' + esc(blk.language || "plaintext") + '">' + esc(blk.text) + "</code></pre>";
    } else if (blk.type === "image") {
      inner = blk.dataUrl ? '<img src="' + blk.dataUrl + '" style="max-width:100%" />' : "";
    } else if (blk.type === "pdf") {
      inner = blk.dataUrl ? '<iframe src="' + blk.dataUrl + '" style="width:100%;height:500px;border:1px solid var(--color-divider)"></iframe>' : "";
    }
    return (
      '<div class="blueprint" style="padding:var(--space-3);margin-bottom:var(--space-2);position:relative">' +
      '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
      inner + "</div>"
    );
  }

  function renderHome() {
    var sharing = !!state.pendingSharedFile && isAuthed();
    var cards = state.subjects.map(function (sub) {
      var count = state.exercises.filter(function (e) { return e.subjectId === sub.id; }).length;
      var countLabel = count === 0 ? "Sin ejercicios" : count + (count === 1 ? " ejercicio" : " ejercicios");
      return (
        '<div class="blueprint" style="aspect-ratio:1;display:flex;flex-direction:column;justify-content:space-between;padding:var(--space-4);cursor:pointer;position:relative" data-action="' + (sharing ? "use-shared-image" : "open-subject") + '" data-id="' + sub.id + '">' +
        '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
        (isAuthed() && !sharing ?
          '<button class="btn btn-icon" style="position:absolute;top:6px;right:6px;color:var(--color-accent-700)" data-action="delete-subject" data-id="' + sub.id + '" title="Eliminar materia">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12z"></path></svg>' +
          "</button>" : "") +
        '<div style="flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:var(--space-4)"><h3 style="font-size:22px">' + esc(sub.name) + "</h3></div>" +
        '<div class="card-meta" style="justify-content:center">' + countLabel + "</div></div>"
      );
    }).join("");
    var shareBanner = sharing ?
      '<div class="blueprint" style="padding:var(--space-4);margin-bottom:var(--space-6);display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap">' +
      '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
      '<span>Imagen recibida — tocá la materia para crear el ejercicio con esa imagen ya cargada.</span>' +
      '<button class="btn btn-secondary" data-action="cancel-shared-image">Cancelar</button></div>' : "";
    return (
      '<div style="padding:var(--space-8) var(--space-6);max-width:1200px;margin:0 auto">' +
      "<h1>Materias</h1>" +
      '<p class="text-muted" style="margin-bottom:var(--space-6)">Elegí una materia para ver, cargar o practicar ejercicios.</p>' +
      shareBanner +
      (state.loading ? '<p class="text-muted">Cargando…</p>' :
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--space-6)">' +
      cards +
      (isAuthed() && !sharing ?
        '<div class="blueprint" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;cursor:pointer;border-style:dashed;gap:8px;color:var(--color-accent-700)" data-action="open-add-subject">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
        '<span style="font-family:var(--font-heading);font-weight:600">Agregar materia</span></div>' : "") +
      "</div>") + "</div>"
    );
  }

  function renderSubject() {
    var currentSubject = state.subjects.find(function (x) { return x.id === state.currentSubjectId; }) || { name: "" };
    var subjectExRaw = state.exercises.filter(function (e) { return e.subjectId === state.currentSubjectId; });
    var topics = Array.from(new Set(subjectExRaw.map(function (e) { return e.topic; }).filter(Boolean))).sort();
    var filteredCount = subjectExRaw.filter(function (e) { return !state.practiceTopic || e.topic === state.practiceTopic; }).length;
    var exerciseCountLabel = subjectExRaw.length + (subjectExRaw.length === 1 ? " ejercicio cargado" : " ejercicios cargados");
    var filteredCountLabel = filteredCount + (filteredCount === 1 ? " disponible para sortear" : " disponibles para sortear");

    var list = subjectExRaw.map(function (ex) {
      var firstText = (ex.statement || []).find(function (b) { return b.type === "text" && b.text; });
      var preview = firstText ? (firstText.text.length > 90 ? firstText.text.slice(0, 90) + "…" : firstText.text) : "(sin texto en el enunciado)";
      return (
        '<div class="card" style="flex-direction:row;align-items:center;justify-content:space-between;cursor:pointer" data-action="open-exercise" data-id="' + ex.id + '">' +
        "<div>" +
        '<div style="display:flex;gap:8px;align-items:center">' +
        '<span style="font-family:var(--font-heading);font-weight:600">' + esc(ex.code || "(sin código)") + "</span>" +
        (ex.topic ? '<span class="tag tag-accent">' + esc(ex.topic) + "</span>" : "") +
        "</div>" +
        '<div class="card-body" style="margin-top:4px">' + esc(preview) + "</div></div>" +
        (isAuthed() ?
          '<div style="display:flex;gap:4px">' +
          '<button class="btn btn-icon" data-action="edit-exercise" data-id="' + ex.id + '" data-return="subject" title="Editar">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>' +
          "</button>" +
          '<button class="btn btn-icon" data-action="delete-exercise" data-id="' + ex.id + '" title="Eliminar">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12z"></path></svg>' +
          "</button></div>" : "") +
        "</div>"
      );
    }).join("");

    return (
      '<div style="padding:var(--space-8) var(--space-6);max-width:900px;margin:0 auto">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:var(--space-4);flex-wrap:wrap;margin-bottom:var(--space-4)">' +
      "<div><h1 style=\"margin-bottom:2px\">" + esc(currentSubject.name) + '</h1><p class="text-muted">' + exerciseCountLabel + "</p></div>" +
      (isAuthed() ? '<button class="btn btn-primary" data-action="add-exercise">+ Agregar ejercicio</button>' : "") + "</div>" +

      '<div class="blueprint" style="padding:var(--space-4);margin-bottom:var(--space-6);display:flex;gap:var(--space-3);align-items:end;flex-wrap:wrap">' +
      '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
      '<div class="field" style="min-width:200px;margin:0"><label>Tema (para sortear)</label>' +
      '<select class="input" data-action="topic-filter">' +
      '<option value="' + '"' + (!state.practiceTopic ? " selected" : "") + ">Todos los temas</option>" +
      topics.map(function (t) { return '<option value="' + esc(t) + '"' + (state.practiceTopic === t ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") +
      "</select></div>" +
      '<button class="btn btn-secondary" data-action="random-exercise">Ejercicio aleatorio</button>' +
      '<span class="text-muted" style="font-size:13px">' + filteredCountLabel + "</span></div>" +

      (subjectExRaw.length > 0
        ? '<div style="display:flex;flex-direction:column;gap:var(--space-2)">' + list + "</div>"
        : '<div class="blueprint" style="padding:var(--space-8);text-align:center;position:relative">' +
          '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
          '<p class="text-muted">Todavía no hay ejercicios en esta materia.</p></div>') +
      "</div>"
    );
  }

  function renderForm() {
    if (!isAuthed()) return "";
    var formTitle = state.editingExerciseId ? "Editar ejercicio" : "Agregar ejercicio";
    var draft = state.formDraft;
    return (
      '<div style="padding:var(--space-8) var(--space-6);max-width:820px;margin:0 auto">' +
      "<h1>" + formTitle + "</h1>" +
      '<div style="display:flex;gap:var(--space-4);margin-bottom:var(--space-6);flex-wrap:wrap">' +
      '<div class="field" style="flex:1;min-width:180px"><label>Número / código</label>' +
      '<input class="input" data-action="draft-field" data-field="code" value="' + esc(draft.code) + '" placeholder="Ej: 3.a" /></div>' +
      '<div class="field" style="flex:1;min-width:180px"><label>Tema o unidad</label>' +
      '<input class="input" data-action="draft-field" data-field="topic" value="' + esc(draft.topic) + '" placeholder="Ej: Autovalores" /></div>' +
      "</div>" +

      "<h3>Enunciado</h3>" +
      '<div data-paste-section="statement">' +
      draft.statement.map(function (b) { return renderEditableBlock("statement", b); }).join("") +
      renderAddButtons("statement") +
      "</div>" +

      "<h3>Resolución</h3>" +
      '<div data-paste-section="resolution">' +
      draft.resolution.map(function (b) { return renderEditableBlock("resolution", b); }).join("") +
      renderAddButtons("resolution") +
      "</div>" +

      '<div style="display:flex;gap:var(--space-2)">' +
      '<button class="btn btn-primary" data-action="save-form">Guardar ejercicio</button>' +
      '<button class="btn btn-secondary" data-action="cancel-form">Cancelar</button></div>' +
      "</div>"
    );
  }

  function renderPractice() {
    var ex = state.exercises.find(function (e) { return e.id === state.currentExerciseId; });
    if (!ex) return "";
    var statementBlocks = (ex.statement || []).map(renderViewBlock).join("");
    var resolutionBlocks = state.showAnswer ? (ex.resolution || []).map(renderViewBlock).join("") : "";

    var attemptSection;
    if (!state.showAnswer) {
      attemptSection = '<p class="text-muted">Mostrá la resolución para poder cargar tu intento y comparar.</p>';
    } else if (isAuthed()) {
      attemptSection = "<h3>Tu resolución</h3>" +
        '<p class="text-muted" style="margin-top:-6px">Cargá tu intento para comparar con la resolución del punto anterior.</p>' +
        state.attemptDraft.map(function (b) { return renderEditableBlock("attempt", b); }).join("") +
        renderAddButtons("attempt") +
        '<div style="display:flex;gap:var(--space-2)"><button class="btn btn-primary" data-action="save-attempt">Guardar mi resolución</button>' +
        (state.attemptDraft.length > 0 ? '<button class="btn btn-ghost" data-action="clear-attempt">Borrar</button>' : "") + "</div>";
    } else if ((ex.myAttempt || []).length > 0) {
      attemptSection = "<h3>Resolución cargada</h3>" + ex.myAttempt.map(renderViewBlock).join("") +
        '<p class="text-muted" style="font-size:13px">Iniciá sesión para editarla.</p>';
    } else {
      attemptSection = '<p class="text-muted">Iniciá sesión para cargar tu resolución.</p>';
    }

    return (
      '<div style="padding:var(--space-8) var(--space-6);max-width:820px;margin:0 auto">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-6);flex-wrap:wrap;gap:8px">' +
      '<div><h1 style="margin-bottom:2px">' + esc(ex.code || "(sin código)") + "</h1>" +
      (ex.topic ? '<span class="tag tag-accent">' + esc(ex.topic) + "</span>" : "") + "</div>" +
      (isAuthed() ?
        '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-secondary" data-action="edit-exercise" data-id="' + ex.id + '" data-return="practice">Editar</button>' +
        '<button class="btn btn-secondary" data-action="delete-exercise" data-id="' + ex.id + '">Eliminar</button></div>' : "") +
      "</div>" +

      "<h3>Enunciado</h3>" + statementBlocks +

      '<div style="margin:var(--space-4) 0 var(--space-8)">' +
      (state.showAnswer
        ? '<button class="btn btn-secondary" data-action="toggle-answer">Ocultar resolución</button>'
        : '<button class="btn btn-primary" data-action="toggle-answer">Ver resolución</button>') +
      "</div>" +

      (state.showAnswer ? "<h3>Resolución</h3>" + resolutionBlocks + '<div style="margin-bottom:var(--space-8)"></div>' : "") +

      attemptSection + "</div>"
    );
  }

  function renderAddSubjectDialog() {
    if (!state.addSubjectOpen) return "";
    return (
      '<div class="dialog-backdrop" data-action="close-add-subject">' +
      '<div class="dialog" data-action="stop-prop">' +
      '<div class="dialog-title">Nueva materia</div>' +
      '<div class="field"><label>Nombre</label>' +
      '<input class="input" data-action="new-subject-name" value="' + esc(state.newSubjectName) + '" placeholder="Ej: Probabilidad y Estadística" /></div>' +
      '<div class="dialog-actions">' +
      '<button class="btn btn-secondary" data-action="close-add-subject">Cancelar</button>' +
      '<button class="btn btn-primary" data-action="confirm-add-subject">Crear</button>' +
      "</div></div></div>"
    );
  }

  function renderAuthDialog() {
    if (!state.authOpen) return "";
    return (
      '<div class="dialog-backdrop" data-action="close-auth">' +
      '<div class="dialog" data-action="stop-prop">' +
      '<div class="dialog-title">Iniciar sesión</div>' +
      (state.authError ? '<p style="font-size:13px;margin:0;color:var(--color-accent-800)">' + esc(state.authError) + "</p>" : "") +
      '<div class="field"><label>Contraseña</label>' +
      '<input class="input" type="password" data-action="auth-password" value="' + esc(state.authPassword) + '" placeholder="••••••••" autofocus /></div>' +
      '<div class="dialog-actions">' +
      '<button class="btn btn-secondary" data-action="close-auth">Cancelar</button>' +
      '<button class="btn btn-primary" data-action="sign-in"' + (state.authLoading ? " disabled" : "") + ">" + (state.authLoading ? "Ingresando…" : "Ingresar") + "</button>" +
      "</div></div></div>"
    );
  }

  function render() {
    var app = document.getElementById("app");
    var viewHtml = "";
    if (state.view === "home") viewHtml = renderHome();
    else if (state.view === "subject") viewHtml = renderSubject();
    else if (state.view === "form") viewHtml = renderForm();
    else if (state.view === "practice") viewHtml = renderPractice();
    app.innerHTML =
      '<div style="min-height:100vh;background:var(--color-bg)">' + renderNav() + renderSyncBanner() + viewHtml + "</div>" +
      renderAddSubjectDialog() + renderAuthDialog();
    if (window.hljs) window.hljs.highlightAll();
  }

  // ── event delegation ────────────────────────────────────────────────
  function setup() {
    var app = document.getElementById("app");

    app.addEventListener("click", function (e) {
      var el = e.target.closest("[data-action]");
      if (!el) return;
      var id = el.dataset.id;
      switch (el.dataset.action) {
        case "go-home": goHome(); break;
        case "back": back(); break;
        case "open-subject": openSubject(id); break;
        case "delete-subject": deleteSubject(id); break;
        case "open-add-subject": openAddSubject(); break;
        case "close-add-subject": closeAddSubject(); break;
        case "confirm-add-subject": confirmAddSubject(); break;
        case "open-auth": openAuth(); break;
        case "close-auth": closeAuth(); break;
        case "sign-in": signIn(); break;
        case "sign-out": signOut(); break;
        case "stop-prop": break;
        case "add-exercise": openAddExercise(); break;
        case "edit-exercise": openEditExercise(state.exercises.find(function (x) { return x.id === id; }), el.dataset.return); break;
        case "delete-exercise": deleteExercise(id); break;
        case "open-exercise": openExercise(id); break;
        case "random-exercise": pickRandom(); break;
        case "save-form": saveForm(); break;
        case "cancel-form": cancelForm(); break;
        case "add-block": addBlock(el.dataset.section, el.dataset.type); break;
        case "remove-block": removeBlock(el.dataset.section, id); break;
        case "toggle-answer": toggleAnswer(); break;
        case "save-attempt": saveAttempt(); break;
        case "clear-attempt": clearAttempt(); break;
        case "copy-code":
          var ex = state.exercises.find(function (x) { return x.id === state.currentExerciseId; });
          if (ex) {
            var blk = (ex.statement || []).concat(ex.resolution || []).find(function (b) { return b.id === id; });
            if (blk) copyCode(blk.id, blk.text);
          }
          break;
        case "use-shared-image":
          if (!isAuthed() || !state.pendingSharedFile) return;
          var sharedFile = state.pendingSharedFile;
          state.pendingSharedFile = null;
          state.currentSubjectId = id;
          state.view = "form"; state.editingExerciseId = null; state.formReturnView = "subject";
          state.formDraft = { code: "", topic: "", statement: [], resolution: [] };
          render();
          addBlockWithFile("statement", sharedFile);
          break;
        case "cancel-shared-image":
          state.pendingSharedFile = null;
          render();
          break;
      }
    });

    app.addEventListener("change", function (e) {
      var el = e.target.closest("[data-action]");
      if (!el) return;
      if (el.dataset.action === "topic-filter") { state.practiceTopic = el.value; render(); }
      else if (el.dataset.action === "block-lang") { updateBlockLang(el.dataset.section, el.dataset.id, el.value); }
      else if (el.dataset.action === "block-file") {
        var file = el.files && el.files[0];
        if (file) updateBlockFile(el.dataset.section, el.dataset.id, file);
      }
    });

    app.addEventListener("input", function (e) {
      var el = e.target.closest("[data-action]");
      if (!el) return;
      if (el.dataset.action === "block-text") updateBlockText(el.dataset.section, el.dataset.id, el.value);
      else if (el.dataset.action === "draft-field") state.formDraft[el.dataset.field] = el.value;
      else if (el.dataset.action === "new-subject-name") state.newSubjectName = el.value;
      else if (el.dataset.action === "auth-password") state.authPassword = el.value;
    });

    app.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var el = e.target.closest("[data-action]");
      if (!el) return;
      if (el.dataset.action === "auth-password") signIn();
      else if (el.dataset.action === "new-subject-name") confirmAddSubject();
    });

    // Pegar una imagen copiada (Ctrl+V) directo en el formulario de ejercicio,
    // sin pasar por el selector de archivos.
    app.addEventListener("paste", function (e) {
      if (state.view !== "form" || !isAuthed()) return;
      var items = (e.clipboardData || window.clipboardData) && (e.clipboardData || window.clipboardData).items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          if (!file) return;
          var zone = e.target.closest("[data-paste-section]");
          var section = zone ? zone.dataset.pasteSection : "statement";
          addBlockWithFile(section, file);
          return;
        }
      }
    });

    render();
    initAuth();
    checkPendingShare();
    loadRemote();
    startPolling();
    registerServiceWorker();
  }

  document.addEventListener("DOMContentLoaded", setup);
})();
