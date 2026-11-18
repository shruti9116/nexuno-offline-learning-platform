
// NEXUNO Learn — Offline-first client
// Vanilla JavaScript. No external dependencies.
// Features: IndexedDB, offline lessons, saved quiz answers,
// duplicate-free sync, retry handling and teacher submissions.

"use strict";

// --------------------------------------------------
// 1. IndexedDB
// --------------------------------------------------

const DB_NAME = "nexuno";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VER);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("lessons")) {
        db.createObjectStore("lessons", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("attempts")) {
        db.createObjectStore("attempts", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "k" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const dbp = openDB();

async function tx(store, mode, action) {
  const db = await dbp;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));

    let result;

    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };

      request.onerror = () => reject(request.error);
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const put = (store, value) =>
  tx(store, "readwrite", objectStore => objectStore.put(value));

const get = (store, key) =>
  tx(store, "readonly", objectStore => objectStore.get(key));

const all = store =>
  tx(store, "readonly", objectStore => objectStore.getAll());

// --------------------------------------------------
// 2. Helpers and application state
// --------------------------------------------------

const $ = id => document.getElementById(id);

const uuid = () => {
  if (crypto.randomUUID) return crypto.randomUUID();

  return "attempt-" +
    Date.now() + "-" +
    Math.random().toString(16).slice(2);
};

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttr(value) {
  return escapeHTML(value);
}

function baseDelay() {
  try {
    return Number(localStorage.getItem("backoffBase")) || 6000;
  } catch {
    return 6000;
  }
}

let catalog = [];
let packs = {};
let lesson = null;
let draft = null;
let syncing = false;
let selected = null;

const backoff = {};

const simOffline = () =>
  $("simOffline")?.checked === true;

const isOnline = () =>
  navigator.onLine && !simOffline();

// --------------------------------------------------
// 3. Connection indicator
// --------------------------------------------------

function paintNet() {
  const indicator = $("net");
  const text = $("netText");
  const note = $("netNote");
  const meter = $("meter");

  if (!indicator || !text) return;

  const online = isOnline();

  indicator.textContent = "●";
  indicator.style.color = online ? "#8ce5c2" : "#ff9a9a";

  text.textContent = online ? "Online" : "Offline";

  if (note) {
    note.textContent = online
      ? "Connected — ready to sync"
      : "Offline learning enabled";
  }

  if (meter) {
    const bar = meter.querySelector("div");

    if (bar) {
      bar.style.width = online ? "100%" : "45%";
    }
  }
}

// --------------------------------------------------
// 4. Navigation
// --------------------------------------------------

function show(name) {
  ["lesson", "quiz", "attempts"].forEach(tab => {
    $("v-" + tab).classList.toggle("hide", tab !== name);

    $("t-" + tab).classList.toggle(
      "active",
      tab === name
    );
  });

  if (name === "attempts") {
    renderAttempts();
  }
}

["lesson", "quiz", "attempts"].forEach(tab => {
  $("t-" + tab).onclick = () => show(tab);
});

// --------------------------------------------------
// 5. Education levels and subjects
// --------------------------------------------------

const LEVELS = [
  {
    id: "6-10",
    name: "Classes 6–10",
    subjects: [
      "Science",
      "Maths",
      "English",
      "Social Studies"
    ]
  },
  {
    id: "11-12",
    name: "Classes 11–12",
    subjects: [
      "Physics",
      "Chemistry",
      "Maths",
      "Biology",
      "Commerce"
    ]
  },
  {
    id: "eng",
    name: "Engineering",
    subjects: [
      "CSE",
      "IT",
      "Mechanical",
      "Civil",
      "Electrical",
      "and more"
    ]
  }
];

function renderLevels() {
  $("levels").innerHTML = LEVELS.map(level => `
    <div class="shelf" data-level="${escapeAttr(level.id)}">
      <h3>${escapeHTML(level.name)}</h3>

      <div class="chips">
        ${level.subjects.map(subject => {
          if (subject === "and more") {
            return `<span class="chip more">and more</span>`;
          }

          const active =
            selected &&
            selected.level === level.id &&
            selected.subject === subject;

          return `
            <button
              type="button"
              class="chip ${active ? "active" : ""}"
              data-subject="${escapeAttr(subject)}">
              ${escapeHTML(subject)}
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `).join("");

  document.querySelectorAll(
    "#levels [data-subject]"
  ).forEach(button => {
    button.onclick = () => {
      selected = {
        level: button.closest("[data-level]").dataset.level,
        subject: button.dataset.subject
      };

      $("packState").textContent =
        "Download a lesson once to access it offline.";

      renderLevels();
      renderCatalog();
    };
  });
}

// --------------------------------------------------
// 6. Catalog
// --------------------------------------------------

async function loadCatalog() {
  if (isOnline()) {
    try {
      const response = await fetch("/api/catalog");

      if (!response.ok) {
        throw new Error("Unable to load catalog");
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error("Invalid catalog response");
      }

      catalog = data;

      await put("meta", {
        k: "catalog",
        v: catalog
      });

    } catch (error) {
      console.warn("Using cached catalog:", error);
    }
  }

  if (!catalog.length) {
    const cached = await get("meta", "catalog");
    catalog = cached?.v || [];
  }

  renderCatalog();
}

function renderCatalog() {
  if (!selected) {
    $("catalog").innerHTML =
      `<p class="meta">Choose a subject to explore available lessons.</p>`;

    $("pickTitle").textContent = "Choose a subject";

    renderDownloads();
    return;
  }

  const level = LEVELS.find(
    item => item.id === selected.level
  );

  $("pickTitle").textContent =
    level.name + " · " + selected.subject;

  const list = catalog.filter(item =>
    item.level === selected.level &&
    item.subject === selected.subject
  );

  $("catalog").innerHTML = list.map(item => {
    const downloaded = Boolean(packs[item.id]);

    return `
      <div class="row" data-id="${escapeAttr(item.id)}">
        <div>
          <h3>${escapeHTML(item.title)}</h3>
          <div class="meta">
            ${escapeHTML(item.grade)} ·
            ${escapeHTML(item.sizeKB)} KB
          </div>
        </div>

        ${
          downloaded
            ? `
              <span class="tick">✓ On this device</span>
              <button type="button" class="btn open">
                Open
              </button>
            `
            : `
              <button type="button" class="btn go dl">
                Download ↓
              </button>
            `
        }
      </div>
    `;
  }).join("") || `
    <p class="meta">
      ${escapeHTML(selected.subject)} lessons are coming soon.
    </p>
  `;

  document.querySelectorAll("#catalog .dl").forEach(button => {
    button.onclick = () =>
      downloadPack(button.closest(".row").dataset.id);
  });

  document.querySelectorAll("#catalog .open").forEach(button => {
    button.onclick = () =>
      openLesson(button.closest(".row").dataset.id);
  });

  renderDownloads();
}

// --------------------------------------------------
// 7. Downloaded lessons
// --------------------------------------------------

function renderDownloads() {
  const ids = Object.keys(packs);

  $("downloads").innerHTML = ids.map(id => {
    const item = packs[id];

    return `
      <div class="row" data-id="${escapeAttr(id)}">
        <div>
          <h3>${escapeHTML(item.title)}</h3>
          <div class="meta">
            ${escapeHTML(item.subject)} ·
            ${escapeHTML(item.grade)}
          </div>
        </div>

        <button type="button" class="btn open">
          Open lesson
        </button>
      </div>
    `;
  }).join("") || `
    <p class="meta">
      No lessons downloaded yet. Download a lesson while online.
    </p>
  `;

  document.querySelectorAll("#downloads .open").forEach(button => {
    button.onclick = () =>
      openLesson(button.closest(".row").dataset.id);
  });
}

async function downloadPack(id) {
  if (!isOnline()) {
    $("packState").textContent =
      "You are offline. Connect to the internet to download lessons.";
    return;
  }

  try {
    $("packState").textContent = "Downloading lesson...";

    const response = await fetch(
      "/api/lesson?id=" + encodeURIComponent(id)
    );

    if (!response.ok) {
      throw new Error("Download failed: " + response.status);
    }

    const item = await response.json();

    if (!item || !item.id || !Array.isArray(item.body) ||
        !item.quiz || !Array.isArray(item.quiz.questions)) {
      throw new Error("Invalid lesson data received.");
    }

    await put("lessons", item);

    packs[item.id] = item;

    $("packState").textContent =
      "Downloaded successfully: " + item.title;

    renderCatalog();

  } catch (error) {
    console.error(error);

    $("packState").textContent =
      "Download failed. Please try again when connected.";
  }
}

// --------------------------------------------------
// 8. Open lesson
// --------------------------------------------------

async function openLesson(id) {
  lesson = packs[id];

  if (!lesson) return;

  $("lessonCard").classList.remove("hide");

  $("lessonBody").innerHTML = `
    <h2>${escapeHTML(lesson.title)}</h2>

    <p class="meta">
      ${escapeHTML(lesson.subject)} ·
      ${escapeHTML(lesson.grade)} ·
      Version ${escapeHTML(lesson.version)}
    </p>

    ${lesson.body.map(paragraph =>
      `<p>${escapeHTML(paragraph)}</p>`
    ).join("")}
  `;

  await buildQuiz();

  $("lessonCard").scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });
}

$("takeQuiz").onclick = () => {
  if (!lesson) return;
  show("quiz");
};

// --------------------------------------------------
// 9. Build and restore quiz
// --------------------------------------------------

async function buildQuiz() {
  if (!lesson) return;

  const attempts = await all("attempts");

  draft = attempts.find(attempt =>
    attempt.status === "draft" &&
    attempt.lessonId === lesson.id &&
    attempt.lessonVersion === lesson.version
  ) || null;

  if (!draft) {
    draft = {
      id: uuid(),
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      lessonVersion: lesson.version,
      answers: {},
      status: "draft",
      takenAt: null,
      student: "Asha"
    };

    await put("attempts", draft);
  }

  $("quizTitle").textContent =
    "Quiz: " + lesson.title;

  $("quizForm").innerHTML = lesson.quiz.questions.map(question => {
    return `
      <div class="q">
        <h3>${escapeHTML(question.text)}</h3>

        ${question.options.map((option, index) => {
          const checked =
            draft.answers[question.id] === index;

          return `
            <label class="opt ${checked ? "sel" : ""}">
              <input
                type="radio"
                name="${escapeAttr(question.id)}"
                value="${index}"
                ${checked ? "checked" : ""}>
              ${escapeHTML(option)}
            </label>
          `;
        }).join("")}
      </div>
    `;
  }).join("") + `
    <p id="saveNote" class="meta" style="margin:15px 0"></p>

    <button id="submit" type="submit" class="btn go">
      Submit answers →
    </button>
  `;

  $("quizForm").querySelectorAll("input").forEach(input => {
    input.onchange = async () => {
      if (!draft || draft.status !== "draft") return;

      draft.answers[input.name] = Number(input.value);

      await put("attempts", draft);

      $("saveNote").textContent =
        "✓ Answer saved on this device.";

      $("quizForm").querySelectorAll(".opt").forEach(label => {
        label.classList.toggle(
          "sel",
          label.querySelector("input").checked
        );
      });

      updateQuizProgress();
    };
  });

  updateQuizProgress();

  const count = Object.keys(draft.answers).length;

  $("saveNote").textContent = count
    ? `Restored ${count} saved answer(s) from this device.`
    : "Your answers will be saved automatically.";
}

function updateQuizProgress() {
  if (!lesson || !draft) return;

  const total = lesson.quiz.questions.length;
  const answered = Object.keys(draft.answers).length;
  const percentage = total
    ? (answered / total) * 100
    : 0;

  $("qcount").textContent =
    `${answered} of ${total} questions answered`;

  const bar = $("qprog").querySelector("div");

  if (bar) {
    bar.style.width = percentage + "%";
  }
}

// --------------------------------------------------
// 10. Submit quiz
// --------------------------------------------------

$("quizForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (!draft || !lesson) return;

  const total = lesson.quiz.questions.length;
  const answered = Object.keys(draft.answers).length;

  if (answered !== total) {
    $("saveNote").textContent =
      "Please answer every question before submitting.";
    return;
  }

  if (draft.status !== "draft") {
    $("saveNote").textContent =
      "This attempt has already been submitted.";
    return;
  }

  draft.status = "pending";
  draft.takenAt = new Date().toISOString();

  // Persist before starting network upload.
  await put("attempts", draft);

  $("saveNote").textContent =
    "Your answers are saved. Preparing submission...";

  show("attempts");

  sync();
});

// --------------------------------------------------
// 11. Submission history
// --------------------------------------------------

async function renderAttempts() {
  const attempts = await all("attempts");

  const rows = attempts
    .filter(item => item.status !== "draft")
    .sort((a, b) =>
      (b.takenAt || "").localeCompare(a.takenAt || "")
    );

  const statusLabels = {
    pending: "Pending",
    syncing: "Syncing",
    synced: "Synced",
    failed: "Failed"
  };

  $("rows").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Lesson</th>
          <th>Status</th>
          <th>Answers</th>
          <th>Action</th>
        </tr>
      </thead>

      <tbody>
        ${rows.map((attempt, index) => `
          <tr data-id="${escapeAttr(attempt.id)}">
            <td>
              ${index + 1}. ${escapeHTML(attempt.lessonTitle)}
              <div class="meta">
                ${escapeHTML(attempt.id.slice(0, 8))}
              </div>
            </td>

            <td>
              <span class="st s-${escapeAttr(attempt.status)}">
                ${escapeHTML(statusLabels[attempt.status] || attempt.status)}
              </span>
            </td>

            <td>
              ${Object.keys(attempt.answers || {}).length} saved
            </td>

            <td>
              ${
                attempt.status === "failed" ||
                attempt.status === "pending"
                  ? `<button type="button" class="btn retry">Retry</button>`
                  : "—"
              }
            </td>
          </tr>
        `).join("")}

        ${rows.length ? "" : `
          <tr>
            <td colspan="4" class="meta">
              No submissions yet.
            </td>
          </tr>
        `}
      </tbody>
    </table>
  `;

  document.querySelectorAll("#rows .retry").forEach(button => {
    button.onclick = () => sync(true);
  });

  const waiting = rows.some(attempt =>
    attempt.status === "pending" ||
    attempt.status === "failed" ||
    attempt.status === "syncing"
  );

  $("attNote").textContent = waiting
    ? "Some submissions are waiting to sync. Your answers are safe on this device."
    : rows.length
      ? "All submissions have been received by your teacher."
      : "Your submission history will appear here.";
}

// --------------------------------------------------
// 12. Reliable upload queue
// --------------------------------------------------

async function sync(force = false) {
  if (syncing || !isOnline()) {
    renderAttempts();
    return;
  }

  syncing = true;

  try {
    const attempts = await all("attempts");

    const queue = attempts.filter(attempt =>
      attempt.status === "pending" ||
      attempt.status === "failed" ||
      attempt.status === "syncing"
    );

    for (const attempt of queue) {
      if (!isOnline()) break;

      if (
        !force &&
        attempt.status === "failed" &&
        (backoff[attempt.id] || 0) > Date.now()
      ) {
        continue;
      }

      // A previously syncing attempt is safe to retry
      // because the same ID is reused for every upload.
      attempt.status = "syncing";

      await put("attempts", attempt);
      await renderAttempts();

      try {
        const headers = {
          "Content-Type": "application/json"
        };

        if ($("simDrop").checked) {
          headers["x-demo-drop"] = "1";
          $("simDrop").checked = false;
        }

        const response = await fetch("/api/attempts", {
          method: "POST",
          headers,

          body: JSON.stringify({
            id: attempt.id,
            student: attempt.student,
            lessonId: attempt.lessonId,
            lessonVersion: attempt.lessonVersion,
            answers: attempt.answers,
            takenAt: attempt.takenAt
          })
        });

        if (!response.ok) {
          throw new Error("Server error: " + response.status);
        }

        const result = await response.json();

        if (!result || result.ok !== true) {
          throw new Error("Invalid server confirmation");
        }

        // The backend must confirm that it accepted or
        // already has this exact attempt ID.
        attempt.status = "synced";
        delete backoff[attempt.id];

      } catch (error) {
        console.warn("Sync failed:", error);

        attempt.status = "failed";
        attempt.tries = (attempt.tries || 0) + 1;

        const delay = Math.min(
          120000,
          baseDelay() * (2 ** (attempt.tries - 1))
        );

        backoff[attempt.id] = Date.now() + delay;
      }

      await put("attempts", attempt);
      await renderAttempts();
    }

  } finally {
    syncing = false;
  }
}

// --------------------------------------------------
// 13. Offline / online events
// --------------------------------------------------

$("simOffline").onchange = () => {
  try {
    localStorage.setItem(
      "simOffline",
      $("simOffline").checked ? "1" : "0"
    );
  } catch {}

  paintNet();

  if (isOnline()) {
    loadCatalog();
    sync();
  }
};

window.addEventListener("online", () => {
  paintNet();
  loadCatalog();
  sync();
});

window.addEventListener("offline", paintNet);

// Periodically check the queue.
// Retry delay is respected for failed attempts.
setInterval(() => {
  if (isOnline()) {
    sync();
  }
}, 3000);

// --------------------------------------------------
// 14. App initialization
// --------------------------------------------------

(async function init() {
  try {
    try {
      $("simOffline").checked =
        localStorage.getItem("simOffline") === "1";
    } catch {}

    paintNet();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch(error => {
          console.warn("Service worker registration failed:", error);
        });
    }

    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }

    const savedLessons = await all("lessons");

    savedLessons.forEach(item => {
      packs[item.id] = item;
    });

    renderLevels();

    await loadCatalog();

    await renderAttempts();

    sync();

  } catch (error) {
    console.error("NEXUNO initialization error:", error);

    $("packState").textContent =
      "App initialization failed. Please refresh and try again.";
  }
})();
