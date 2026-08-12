(function () {
  "use strict";

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

  // ── cookie-backed session storage for Supabase Auth ────────────────────
  var COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 días
  var cookieStorage = {
    getItem: function (key) {
      var m = document.cookie.match(new RegExp("(?:^|; )" + key.replace(/([.$?*|{}()\[\]\\\/+^])/g, "\\$1") + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    },
    setItem: function (key, value) {
      var secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = key + "=" + encodeURIComponent(value) + "; max-age=" + COOKIE_MAX_AGE + "; path=/; SameSite=Lax" + secure;
    },
    removeItem: function (key) {
      document.cookie = key + "=; max-age=0; path=/; SameSite=Lax";
    }
  };

  var supabaseClient = (window.supabase && window.SUPABASE_URL && window.SUPABASE_ANON_KEY)
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
        auth: { storage: cookieStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      })
    : null;

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
    authEmail: "",
    authPassword: "",
    authError: "",
    authLoading: false,
    loading: true,
    syncError: null
  };

  function isAuthed() { return !!(state.session && state.session.user); }

  // ── remote data (Supabase) ──────────────────────────────────────────
  function rowToSubject(r) { return { id: r.id, name: r.name }; }
  function rowToExercise(r) {
    return {
      id: r.id, subjectId: r.subject_id, code: r.code || "", topic: r.topic || "",
      statement: r.statement || [], resolution: r.resolution || [], myAttempt: r.my_attempt || []
    };
  }
  function loadRemote() {
    if (!supabaseClient) {
      state.loading = false;
      state.syncError = "Backend no configurado: completá config.js con la URL y anon key de tu proyecto de Supabase.";
      render();
      return;
    }
    Promise.all([
      supabaseClient.from("subjects").select("*").order("created_at"),
      supabaseClient.from("exercises").select("*").order("created_at")
    ]).then(function (results) {
      var subjRes = results[0], exRes = results[1];
      state.loading = false;
      if (subjRes.error || exRes.error) {
        state.syncError = "No se pudo sincronizar con el servidor.";
        render();
        return;
      }
      state.syncError = null;
      state.subjects = subjRes.data.map(rowToSubject);
      state.exercises = exRes.data.map(rowToExercise);
      render();
    });
  }
  function subscribeRealtime() {
    if (!supabaseClient) return;
    supabaseClient.channel("public:banco-de-ejercicios")
      .on("postgres_changes", { event: "*", schema: "public", table: "subjects" }, loadRemote)
      .on("postgres_changes", { event: "*", schema: "public", table: "exercises" }, loadRemote)
      .subscribe();
  }

  // ── auth ─────────────────────────────────────────────────────────────
  function initAuth() {
    if (!supabaseClient) return;
    supabaseClient.auth.getSession().then(function (res) { state.session = res.data.session; render(); });
    supabaseClient.auth.onAuthStateChange(function (event, session) { state.session = session; render(); });
  }
  function openAuth() { state.authOpen = true; state.authEmail = ""; state.authPassword = ""; state.authError = ""; render(); }
  function closeAuth() { state.authOpen = false; render(); }
  function signIn() {
    if (!supabaseClient) { state.authError = "Backend no configurado."; render(); return; }
    if (!state.authEmail || !state.authPassword) { state.authError = "Completá email y contraseña."; render(); return; }
    state.authLoading = true; state.authError = ""; render();
    supabaseClient.auth.signInWithPassword({ email: state.authEmail.trim(), password: state.authPassword }).then(function (res) {
      state.authLoading = false;
      if (res.error) { state.authError = "Credenciales inválidas."; render(); return; }
      state.session = res.data.session;
      state.authOpen = false;
      render();
    });
  }
  function signOut() {
    if (!supabaseClient) return;
    supabaseClient.auth.signOut().then(function () { state.session = null; render(); });
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
    supabaseClient.from("subjects").insert({ name: name }).then(function (res) {
      if (res.error) window.alert("Error al guardar: " + res.error.message);
    });
  }
  function deleteSubject(id) {
    if (!isAuthed()) return;
    if (!window.confirm("¿Eliminar esta materia y todos sus ejercicios?")) return;
    if (state.currentSubjectId === id) state.view = "home";
    render();
    supabaseClient.from("subjects").delete().eq("id", id).then(function (res) {
      if (res.error) window.alert("Error al eliminar: " + res.error.message);
    });
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
    var returnView = state.formReturnView || "subject";
    var payload = { code: draft.code, topic: draft.topic, statement: draft.statement, resolution: draft.resolution };
    var req = editingId
      ? supabaseClient.from("exercises").update(payload).eq("id", editingId)
      : supabaseClient.from("exercises").insert(Object.assign({ subject_id: state.currentSubjectId, my_attempt: [] }, payload));
    state.view = returnView;
    render();
    req.then(function (res) { if (res.error) window.alert("Error al guardar: " + res.error.message); });
  }
  function cancelForm() { state.view = state.formReturnView || "subject"; render(); }
  function deleteExercise(id) {
    if (!isAuthed()) return;
    if (!window.confirm("¿Eliminar este ejercicio? No se puede deshacer.")) return;
    if (state.view === "practice" && state.currentExerciseId === id) state.view = "subject";
    render();
    supabaseClient.from("exercises").delete().eq("id", id).then(function (res) {
      if (res.error) window.alert("Error al eliminar: " + res.error.message);
    });
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
    var draft = state.attemptDraft;
    var exId = state.currentExerciseId;
    supabaseClient.from("exercises").update({ my_attempt: draft }).eq("id", exId).then(function (res) {
      if (res.error) window.alert("Error al guardar: " + res.error.message);
    });
  }
  function clearAttempt() {
    if (!isAuthed()) return;
    if (!window.confirm("¿Borrar tu resolución cargada?")) return;
    var exId = state.currentExerciseId;
    state.attemptDraft = [];
    render();
    supabaseClient.from("exercises").update({ my_attempt: [] }).eq("id", exId).then(function (res) {
      if (res.error) window.alert("Error al guardar: " + res.error.message);
    });
  }

  // ── statement / resolution / attempt blocks ─────────────────────────
  function getBlocks(section) { return section === "attempt" ? state.attemptDraft : state.formDraft[section]; }
  function setBlocks(section, arr) { if (section === "attempt") state.attemptDraft = arr; else state.formDraft[section] = arr; }
  function addBlock(section, type) {
    if (!isAuthed()) return;
    setBlocks(section, getBlocks(section).concat([{ id: uid(), type: type, text: "", language: "javascript", dataUrl: null }]));
    render();
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
    if (!isAuthed() || !supabaseClient) return;
    var b = getBlocks(section).find(function (b) { return b.id === id; });
    if (b) { b.uploading = true; b.uploadError = null; render(); }
    var ext = (file.name.split(".").pop() || "bin").toLowerCase();
    var path = state.session.user.id + "/" + uid() + "." + ext;
    supabaseClient.storage.from("exercise-files").upload(path, file, { upsert: false }).then(function (res) {
      var b2 = getBlocks(section).find(function (b) { return b.id === id; });
      if (!b2) return;
      b2.uploading = false;
      if (res.error) { b2.uploadError = res.error.message; render(); return; }
      var pub = supabaseClient.storage.from("exercise-files").getPublicUrl(path);
      b2.dataUrl = pub.data.publicUrl;
      b2.fileName = file.name;
      render();
    });
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
      ? '<span class="text-muted" style="font-size:13px">' + esc(state.session.user.email) + "</span>" +
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
    var cards = state.subjects.map(function (sub) {
      var count = state.exercises.filter(function (e) { return e.subjectId === sub.id; }).length;
      var countLabel = count === 0 ? "Sin ejercicios" : count + (count === 1 ? " ejercicio" : " ejercicios");
      return (
        '<div class="blueprint" style="aspect-ratio:1;display:flex;flex-direction:column;justify-content:space-between;padding:var(--space-4);cursor:pointer;position:relative" data-action="open-subject" data-id="' + sub.id + '">' +
        '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>' +
        (isAuthed() ?
          '<button class="btn btn-icon" style="position:absolute;top:6px;right:6px;color:var(--color-accent-700)" data-action="delete-subject" data-id="' + sub.id + '" title="Eliminar materia">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12z"></path></svg>' +
          "</button>" : "") +
        '<div style="flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:var(--space-4)"><h3 style="font-size:22px">' + esc(sub.name) + "</h3></div>" +
        '<div class="card-meta" style="justify-content:center">' + countLabel + "</div></div>"
      );
    }).join("");
    return (
      '<div style="padding:var(--space-8) var(--space-6);max-width:1200px;margin:0 auto">' +
      "<h1>Materias</h1>" +
      '<p class="text-muted" style="margin-bottom:var(--space-6)">Elegí una materia para ver, cargar o practicar ejercicios.</p>' +
      (state.loading ? '<p class="text-muted">Cargando…</p>' :
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--space-6)">' +
      cards +
      (isAuthed() ?
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
      draft.statement.map(function (b) { return renderEditableBlock("statement", b); }).join("") +
      renderAddButtons("statement") +

      "<h3>Resolución</h3>" +
      draft.resolution.map(function (b) { return renderEditableBlock("resolution", b); }).join("") +
      renderAddButtons("resolution") +

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
      '<div class="field"><label>Email</label>' +
      '<input class="input" type="email" data-action="auth-email" value="' + esc(state.authEmail) + '" placeholder="tu@email.com" /></div>' +
      '<div class="field"><label>Contraseña</label>' +
      '<input class="input" type="password" data-action="auth-password" value="' + esc(state.authPassword) + '" placeholder="••••••••" /></div>' +
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
      else if (el.dataset.action === "auth-email") state.authEmail = el.value;
      else if (el.dataset.action === "auth-password") state.authPassword = el.value;
    });

    app.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var el = e.target.closest("[data-action]");
      if (!el) return;
      if (el.dataset.action === "auth-email" || el.dataset.action === "auth-password") signIn();
      else if (el.dataset.action === "new-subject-name") confirmAddSubject();
    });

    render();
    initAuth();
    loadRemote();
    subscribeRealtime();
  }

  document.addEventListener("DOMContentLoaded", setup);
})();
