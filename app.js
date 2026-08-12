(function () {
  "use strict";

  var STORAGE_KEY = "banco_ejercicios_v1";
  var LANGS = [
    ["javascript", "JavaScript"], ["python", "Python"], ["java", "Java"], ["c", "C"],
    ["cpp", "C++"], ["csharp", "C#"], ["go", "Go"], ["rust", "Rust"],
    ["sql", "SQL"], ["html", "HTML"], ["css", "CSS"], ["plaintext", "Otro / texto plano"]
  ];
  var DEFAULT_SUBJECT_NAMES = [
    "Algebra Lineal Computacional", "Analisis matemático",
    "Paradigmas de la programación", "Algoritmos y estructuras de datos"
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
    copiedId: null
  };

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        state.subjects = data.subjects || [];
        state.exercises = data.exercises || [];
      } else {
        state.subjects = DEFAULT_SUBJECT_NAMES.map(function (n) { return { id: uid(), name: n }; });
      }
    } catch (e) {
      state.subjects = DEFAULT_SUBJECT_NAMES.map(function (n) { return { id: uid(), name: n }; });
    }
  }
  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ subjects: state.subjects, exercises: state.exercises }));
  }

  // ── actions ──────────────────────────────────────────────────────────
  function goHome() { state.view = "home"; state.currentSubjectId = null; state.currentExerciseId = null; render(); }
  function openSubject(id) { state.view = "subject"; state.currentSubjectId = id; state.practiceTopic = ""; render(); }
  function back() {
    var v = state.view;
    if (v === "subject") goHome();
    else if (v === "practice") { state.view = "subject"; render(); }
    else if (v === "form") { state.view = state.formReturnView || "subject"; render(); }
  }

  function openAddSubject() { state.addSubjectOpen = true; state.newSubjectName = ""; render(); }
  function closeAddSubject() { state.addSubjectOpen = false; state.newSubjectName = ""; render(); }
  function confirmAddSubject() {
    var name = (state.newSubjectName || "").trim();
    if (!name) return;
    state.subjects = state.subjects.concat([{ id: uid(), name: name }]);
    state.addSubjectOpen = false; state.newSubjectName = "";
    persist(); render();
  }
  function deleteSubject(id) {
    if (!window.confirm("¿Eliminar esta materia y todos sus ejercicios?")) return;
    state.subjects = state.subjects.filter(function (x) { return x.id !== id; });
    state.exercises = state.exercises.filter(function (e) { return e.subjectId !== id; });
    if (state.currentSubjectId === id) state.view = "home";
    persist(); render();
  }

  function openAddExercise() {
    state.view = "form"; state.editingExerciseId = null; state.formReturnView = "subject";
    state.formDraft = { code: "", topic: "", statement: [], resolution: [] };
    render();
  }
  function openEditExercise(ex, returnView) {
    if (!ex) return;
    var clone = JSON.parse(JSON.stringify(ex));
    state.view = "form"; state.editingExerciseId = ex.id; state.formReturnView = returnView || "subject";
    state.formDraft = { code: clone.code || "", topic: clone.topic || "", statement: clone.statement || [], resolution: clone.resolution || [] };
    render();
  }
  function saveForm() {
    var draft = state.formDraft;
    var editingId = state.editingExerciseId;
    var returnView = state.formReturnView || "subject";
    if (editingId) {
      state.exercises = state.exercises.map(function (e) {
        return e.id === editingId ? Object.assign({}, e, { code: draft.code, topic: draft.topic, statement: draft.statement, resolution: draft.resolution }) : e;
      });
    } else {
      var newEx = {
        id: uid(), subjectId: state.currentSubjectId, code: draft.code, topic: draft.topic,
        statement: draft.statement, resolution: draft.resolution, myAttempt: []
      };
      state.exercises = state.exercises.concat([newEx]);
    }
    state.view = returnView;
    persist(); render();
  }
  function cancelForm() { state.view = state.formReturnView || "subject"; render(); }
  function deleteExercise(id) {
    if (!window.confirm("¿Eliminar este ejercicio? No se puede deshacer.")) return;
    state.exercises = state.exercises.filter(function (e) { return e.id !== id; });
    if (state.view === "practice" && state.currentExerciseId === id) state.view = "subject";
    persist(); render();
  }

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
    var draft = state.attemptDraft;
    var exId = state.currentExerciseId;
    state.exercises = state.exercises.map(function (e) { return e.id === exId ? Object.assign({}, e, { myAttempt: draft }) : e; });
    persist(); render();
  }
  function clearAttempt() {
    if (!window.confirm("¿Borrar tu resolución cargada?")) return;
    var exId = state.currentExerciseId;
    state.exercises = state.exercises.map(function (e) { return e.id === exId ? Object.assign({}, e, { myAttempt: [] }) : e; });
    state.attemptDraft = [];
    persist(); render();
  }

  function getBlocks(section) { return section === "attempt" ? state.attemptDraft : state.formDraft[section]; }
  function setBlocks(section, arr) { if (section === "attempt") state.attemptDraft = arr; else state.formDraft[section] = arr; }
  function addBlock(section, type) {
    setBlocks(section, getBlocks(section).concat([{ id: uid(), type: type, text: "", language: "javascript", dataUrl: null }]));
    render();
  }
  function removeBlock(section, id) {
    setBlocks(section, getBlocks(section).filter(function (b) { return b.id !== id; }));
    render();
  }
  // Mutates the block in place without a re-render, so the textarea keeps focus/caret while typing.
  function updateBlockText(section, id, text) {
    var b = getBlocks(section).find(function (b) { return b.id === id; });
    if (b) b.text = text;
  }
  function updateBlockLang(section, id, lang) {
    var b = getBlocks(section).find(function (b) { return b.id === id; });
    if (b) b.language = lang;
    render();
  }
  function updateBlockFile(section, id, file) {
    var reader = new FileReader();
    reader.onload = function () {
      var b = getBlocks(section).find(function (b) { return b.id === id; });
      if (b) { b.dataUrl = reader.result; b.fileName = file.name; }
      render();
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
    return (
      '<nav class="nav" style="border-bottom:1px solid var(--color-divider)">' +
      '<div class="nav-brand" style="cursor:pointer" data-action="go-home">Banco de Ejercicios</div>' +
      (showBack ?
        '<button class="btn btn-ghost" data-action="back">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>' +
        "Volver</button>" : "") +
      "</nav>"
    );
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
        (blk.dataUrl ? '<img src="' + blk.dataUrl + '" style="max-width:100%;margin-top:var(--space-2);border:1px solid var(--color-divider)" />' : "");
    } else if (blk.type === "pdf") {
      inner = '<input type="file" accept="application/pdf" data-action="block-file" data-section="' + section + '" data-id="' + blk.id + '" />' +
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
        '<button class="btn btn-icon" style="position:absolute;top:6px;right:6px;color:var(--color-accent-700)" data-action="delete-subject" data-id="' + sub.id + '" title="Eliminar materia">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12z"></path></svg>' +
        "</button>" +
        '<div style="flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:var(--space-4)"><h3 style="font-size:22px">' + esc(sub.name) + "</h3></div>" +
        '<div class="card-meta" style="justify-content:center">' + countLabel + "</div></div>"
      );
    }).join("");
    return (
      '<div style="padding:var(--space-8) var(--space-6);max-width:1200px;margin:0 auto">' +
      "<h1>Materias</h1>" +
      '<p class="text-muted" style="margin-bottom:var(--space-6)">Elegí una materia para ver, cargar o practicar ejercicios.</p>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--space-6)">' +
      cards +
      '<div class="blueprint" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;cursor:pointer;border-style:dashed;gap:8px;color:var(--color-accent-700)" data-action="open-add-subject">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>' +
      '<span style="font-family:var(--font-heading);font-weight:600">Agregar materia</span></div></div></div>'
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
        '<div style="display:flex;gap:4px">' +
        '<button class="btn btn-icon" data-action="edit-exercise" data-id="' + ex.id + '" data-return="subject" title="Editar">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>' +
        "</button>" +
        '<button class="btn btn-icon" data-action="delete-exercise" data-id="' + ex.id + '" title="Eliminar">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12z"></path></svg>' +
        "</button></div></div>"
      );
    }).join("");

    return (
      '<div style="padding:var(--space-8) var(--space-6);max-width:900px;margin:0 auto">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:var(--space-4);flex-wrap:wrap;margin-bottom:var(--space-4)">' +
      "<div><h1 style=\"margin-bottom:2px\">" + esc(currentSubject.name) + '</h1><p class="text-muted">' + exerciseCountLabel + "</p></div>" +
      '<button class="btn btn-primary" data-action="add-exercise">+ Agregar ejercicio</button></div>' +

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
    var attemptSection = state.showAnswer
      ? "<h3>Tu resolución</h3>" +
        '<p class="text-muted" style="margin-top:-6px">Cargá tu intento para comparar con la resolución del punto anterior.</p>' +
        state.attemptDraft.map(function (b) { return renderEditableBlock("attempt", b); }).join("") +
        renderAddButtons("attempt") +
        '<div style="display:flex;gap:var(--space-2)"><button class="btn btn-primary" data-action="save-attempt">Guardar mi resolución</button>' +
        (state.attemptDraft.length > 0 ? '<button class="btn btn-ghost" data-action="clear-attempt">Borrar</button>' : "") + "</div>"
      : '<p class="text-muted">Mostrá la resolución para poder cargar tu intento y comparar.</p>';

    return (
      '<div style="padding:var(--space-8) var(--space-6);max-width:820px;margin:0 auto">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-6);flex-wrap:wrap;gap:8px">' +
      '<div><h1 style="margin-bottom:2px">' + esc(ex.code || "(sin código)") + "</h1>" +
      (ex.topic ? '<span class="tag tag-accent">' + esc(ex.topic) + "</span>" : "") + "</div>" +
      '<div style="display:flex;gap:8px">' +
      '<button class="btn btn-secondary" data-action="edit-exercise" data-id="' + ex.id + '" data-return="practice">Editar</button>' +
      '<button class="btn btn-secondary" data-action="delete-exercise" data-id="' + ex.id + '">Eliminar</button></div></div>' +

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

  function render() {
    var app = document.getElementById("app");
    var viewHtml = "";
    if (state.view === "home") viewHtml = renderHome();
    else if (state.view === "subject") viewHtml = renderSubject();
    else if (state.view === "form") viewHtml = renderForm();
    else if (state.view === "practice") viewHtml = renderPractice();
    app.innerHTML =
      '<div style="min-height:100vh;background:var(--color-bg)">' + renderNav() + viewHtml + "</div>" +
      renderAddSubjectDialog();
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
    });

    load();
    render();
  }

  document.addEventListener("DOMContentLoaded", setup);
})();
