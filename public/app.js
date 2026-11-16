// Nexuno offline-first client. Vanilla JS, no dependencies.
// Storage: IndexedDB (lesson packs, attempts = the upload queue, catalog cache). Shell: service worker cache.
"use strict";

// ---------- tiny IndexedDB helper ----------
const DB_NAME = "nexuno", DB_VER = 1;
function openDB() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("lessons", { keyPath: "id" });
      d.createObjectStore("attempts", { keyPath: "id" });
      d.createObjectStore("meta", { keyPath: "k" });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
const dbp = openDB();
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((ok, bad) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => ok(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => bad(t.error);
  });
}
const put = (s, v) => tx(s, "readwrite", (o) => o.put(v));
const get = (s, k) => tx(s, "readonly", (o) => o.get(k));
const all = (s) => tx(s, "readonly", (o) => o.getAll());

// ---------- state ----------
const $ = (id) => document.getElementById(id);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "a-" + Date.now() + "-" + Math.random().toString(16).slice(2));
let catalog = [];       // lessons the teacher has published
let packs = {};         // lessons downloaded to this device, by id
let lesson = null;      // lesson currently open
let draft = null;       // attempt currently being answered
let syncing = false;
const backoff = {};     // attemptId -> next retry time (ms epoch)
function baseDelay() { try { return Number(localStorage.getItem("backoffBase")) || 6000; } catch (e) { return 6000; } }

const simOffline = () => $("simOffline").checked;
const isOnline = () => navigator.onLine && !simOffline();
function paintNet() {
  const n = $("net");
  n.textContent = isOnline() ? "Online" : "Offline";
  n.className = "badge " + (isOnline() ? "on" : "off");
}

// ---------- tabs ----------
function show(name) {
  for (const t of ["lesson", "quiz", "attempts"]) {
    $("v-" + t).classList.toggle("hide", t !== name);
    $("t-" + t).classList.toggle("act", t === name);
  }
  if (name === "attempts") renderAttempts();
}
["lesson", "quiz", "attempts"].forEach((t) => ($("t-" + t).onclick = () => show(t)));

// ---------- catalog and lesson packs ----------
async function loadCatalog() {
  if (isOnline()) {
    try {
      catalog = await (await fetch("/api/catalog")).json();
      await put("meta", { k: "catalog", v: catalog });
    } catch (e) { /* fall back to the cached list */ }
  }
  if (!catalog.length) { const m = await get("meta", "catalog"); catalog = m ? m.v : []; }
  renderCatalog();
}
function renderCatalog() {
  $("catalog").innerHTML = catalog.map((c) => {
    const have = packs[c.id];
    return "<div class='row' data-id='" + c.id + "'><div class='meta'><b>" + c.title + "</b><span class='muted'>" + c.subject + " &middot; " + c.sizeKB + " KB</span></div>" +
      (have ? "<span class='tick'>&#10003; On this device</span><button class='ghost open'>Open</button>"
            : "<button class='dl'>Download</button>") + "</div>";
  }).join("") || "<p class='muted'>Connect once to see your lessons.</p>";
  document.querySelectorAll(".dl").forEach((b) => (b.onclick = () => downloadPack(b.closest(".row").dataset.id)));
  document.querySelectorAll(".open").forEach((b) => (b.onclick = () => openLesson(b.closest(".row").dataset.id)));
}
async function downloadPack(id) {
  if (!isOnline()) { $("packState").textContent = "You are offline. Connect once to download a lesson."; return; }
  const l = await (await fetch("/api/lesson?id=" + encodeURIComponent(id))).json();
  await put("lessons", l);
  packs[id] = l;
  $("packState").textContent = "Downloaded: " + l.title + ". It now works with no network.";
  renderCatalog();
}
async function openLesson(id) {
  lesson = packs[id];
  if (!lesson) return;
  $("lessonCard").classList.remove("hide");
  $("lessonBody").innerHTML = "<h2>" + lesson.title + "</h2><p class='muted'>" + lesson.subject + " &middot; version " + lesson.version + "</p>" + lesson.body.map((p) => "<p>" + p + "</p>").join("");
  await buildQuiz();
  $("lessonCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("takeQuiz").onclick = () => show("quiz");

// ---------- quiz with persisted answers ----------
async function buildQuiz() {
  if (!lesson) return;
  const atts = await all("attempts");
  draft = atts.find((a) => a.status === "draft" && a.lessonId === lesson.id) || null;   // resume after a restart
  if (!draft) draft = { id: uuid(), lessonId: lesson.id, lessonTitle: lesson.title, lessonVersion: lesson.version, answers: {}, status: "draft", takenAt: null, student: "Asha" };
  $("quizTitle").textContent = "Quiz: " + lesson.title;
  $("quizForm").innerHTML = lesson.quiz.questions.map((q) =>
    '<div class="q"><p>' + q.text + "</p>" + q.options.map((o, i) =>
      '<label class="opt' + (draft.answers[q.id] === i ? " sel" : "") + '"><input type="radio" name="' + q.id + '" value="' + i + '"' + (draft.answers[q.id] === i ? " checked" : "") + ">" + o + "</label>").join("") + "</div>").join("");
  $("quizForm").querySelectorAll("input").forEach((inp) => {
    inp.onchange = async () => {
      draft.answers[inp.name] = Number(inp.value);
      await put("attempts", draft);          // saved on every answer
      $("saveNote").textContent = "Saved on device";
      $("quizForm").querySelectorAll(".opt").forEach((l) => l.classList.toggle("sel", l.querySelector("input").checked));
    };
  });
  const n = Object.keys(draft.answers).length;
  $("saveNote").textContent = n ? "Restored " + n + " saved answer(s) from this device" : "";
}
$("submit").onclick = async () => {
  if (!draft) return;
  if (Object.keys(draft.answers).length < lesson.quiz.questions.length) { $("saveNote").textContent = "Please answer every question first."; return; }
  draft.status = "pending";
  draft.takenAt = new Date().toISOString();
  await put("attempts", draft);              // now in the upload queue
  await buildQuiz();
  $("saveNote").textContent = "";
  show("attempts");
  sync();
};

// ---------- upload queue + sync ----------
async function sync(force) {
  if (syncing || !isOnline()) { renderAttempts(); return; }
  syncing = true;
  try {
    const queue = (await all("attempts")).filter((a) => a.status === "pending" || a.status === "failed");
    for (const a of queue) {
      if (!force && a.status === "failed" && (backoff[a.id] || 0) > Date.now()) continue;
      a.status = "syncing"; await put("attempts", a); renderAttempts();
      try {
        const headers = { "Content-Type": "application/json" };
        if ($("simDrop").checked) { headers["x-demo-drop"] = "1"; $("simDrop").checked = false; } // interrupt once
        const r = await fetch("/api/attempts", {
          method: "POST", headers,
          body: JSON.stringify({ id: a.id, student: a.student, lessonId: a.lessonId, lessonVersion: a.lessonVersion, answers: a.answers, takenAt: a.takenAt }),
        });
        if (!r.ok) throw new Error("server " + r.status);
        await r.json(); // a truncated response throws here, so the attempt is not marked Synced
        a.status = "synced"; delete backoff[a.id];
      } catch (e) {
        a.status = "failed"; a.tries = (a.tries || 0) + 1;
        backoff[a.id] = Date.now() + Math.min(120000, baseDelay() * 2 ** (a.tries - 1)); // exponential back-off
      }
      await put("attempts", a); renderAttempts();
    }
  } finally { syncing = false; }
}
async function renderAttempts() {
  const rows = (await all("attempts")).filter((a) => a.status !== "draft").sort((x, y) => (x.takenAt < y.takenAt ? -1 : 1));
  $("rows").innerHTML = rows.map((a, i) => {
    const label = { pending: "Pending", syncing: "Syncing", synced: "Synced", failed: "Failed" }[a.status] || a.status;
    return "<tr data-id='" + a.id + "'><td>#" + (i + 1) + " " + (a.lessonTitle || "") + "<div class='muted'>" + a.id.slice(0, 8) + "</div></td><td><span class='st s-" + a.status + "'>" + label + "</span></td><td>" + Object.keys(a.answers).length + " saved</td><td>" +
      (a.status === "failed" ? "<button class='retry'>Retry</button>" : "") + "</td></tr>";
  }).join("") || "<tr><td colspan='4' class='muted'>No submissions yet.</td></tr>";
  document.querySelectorAll(".retry").forEach((b) => (b.onclick = () => sync(true)));
  $("attNote").textContent = rows.some((a) => a.status === "pending" || a.status === "failed") ? "Not yet received by your teacher. Your answers are safe on this device." : rows.length ? "All submissions received by your teacher." : "";
}

// ---------- wiring ----------
$("simOffline").onchange = () => {
  try { localStorage.setItem("simOffline", $("simOffline").checked ? "1" : "0"); } catch (e) {}
  paintNet(); if (isOnline()) { loadCatalog(); sync(); }
};
window.addEventListener("online", () => { paintNet(); loadCatalog(); sync(); });
window.addEventListener("offline", paintNet);
setInterval(() => { if (isOnline()) sync(); }, 3000);  // retries honour the per-attempt back-off

(async function init() {
  try { $("simOffline").checked = localStorage.getItem("simOffline") === "1"; } catch (e) {}
  paintNet();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  for (const l of await all("lessons")) packs[l.id] = l;
  await loadCatalog();
  renderAttempts();
  sync();           // on app open
})();
