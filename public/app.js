"use strict";

// ==========================================
// NEXUNO LEARN - OFFLINE FIRST CLIENT
// ==========================================

const DB_NAME = "nexuno";
const DB_VER = 1;

const $ = (id) => document.getElementById(id);

const uuid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : "a-" + Date.now() + "-" + Math.random().toString(16).slice(2);

// ==========================================
// INDEXED DB
// ==========================================

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

async function tx(store, mode, callback) {
  const db = await dbp;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const result = callback(transaction.objectStore(store));

    transaction.oncomplete = () => {
      resolve(result && result.result !== undefined
        ? result.result
        : undefined);
    };

    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const put = (store, value) =>
  tx(store, "readwrite", (objectStore) => objectStore.put(value));

const get = (store, key) =>
  tx(store, "readonly", (objectStore) => objectStore.get(key));

const all = (store) =>
  tx(store, "readonly", (objectStore) => objectStore.getAll());

// ==========================================
// APPLICATION STATE
// ==========================================

let catalog = [];
let packs = {};
let lesson = null;
let draft = null;
let syncing = false;

const backoff = {};

function baseDelay() {
  try {
    return Number(localStorage.getItem("backoffBase")) || 6000;
  } catch {
    return 6000;
  }
}

const simOffline = () => $("simOffline").checked;

const isOnline = () => navigator.onLine && !simOffline();

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function paintNet() {
  const element = $("net");

  element.textContent = isOnline() ? "Online" : "Offline";
  element.className = "badge " + (isOnline() ? "on" : "off");
}

// ==========================================
// NAVIGATION
// ==========================================

function show(name) {
  for (const tab of ["lesson", "quiz", "attempts"]) {
    const active = tab === name;

    $("v-" + tab).classList.toggle("hide", !active);
    $("t-" + tab).classList.toggle("act", active);

    if (active) {
      $("t-" + tab).setAttribute("aria-current", "page");
    } else {
      $("t-" + tab).removeAttribute("aria-current");
    }
  }

  if (name === "attempts") {
    renderAttempts();
  }
}

["lesson", "quiz", "attempts"].forEach((tab) => {
  $("t-" + tab).onclick = () => show(tab);
});

// ==========================================
// CATALOG
// ==========================================

async function loadCatalog() {
  if (isOnline()) {
    try {
      const response = await fetch("/api/catalog");

      if (!response.ok) {
        throw new Error("Unable to load catalogue");
      }

      catalog = await response.json();

      await put("meta", {
        k: "catalog",
        v: catalog
      });

    } catch (error) {
      console.warn("Using saved catalogue:", error);
    }
  }

  if (!catalog.length) {
    const saved = await get("meta", "catalog");
    catalog = saved ? saved.v : [];
  }

  renderCatalog();
}

function renderCatalog() {
  $("catalog").innerHTML = catalog.map((item) => {
    const have = packs[item.id];

    return `
      <div class="row" data-id="${escapeHTML(item.id)}">
        <div class="meta">
          <b>${escapeHTML(item.title)}</b>
          <small>
            ${escapeHTML(item.subject)}
            &middot;
            ${escapeHTML(item.sizeKB)} KB
          </small>
        </div>

        ${
          have
            ? `
              <span class="tick">✓ On this device</span>
              <button class="ghost open">Open</button>
            `
            : `<button class="dl">Download</button>`
        }
      </div>
    `;
  }).join("") || `
    <p class="muted">
      No lessons available. Connect to the internet to load lessons.
    </p>
  `;

  document.querySelectorAll(".dl").forEach((button) => {
    button.onclick = () =>
      downloadPack(button.closest(".row").dataset.id);
  });

  document.querySelectorAll(".open").forEach((button) => {
    button.onclick = () =>
      openLesson(button.closest(".row").dataset.id);
  });
}

// ==========================================
// DOWNLOAD LESSON
// ==========================================

async function downloadPack(id) {
  if (!isOnline()) {
    $("packState").textContent =
      "You are offline. Connect to the internet to download this lesson.";
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

    const lessonData = await response.json();

    if (
      !lessonData.id ||
      !Array.isArray(lessonData.body) ||
      !lessonData.quiz ||
      !Array.isArray(lessonData.quiz.questions)
    ) {
      throw new Error("Invalid lesson data received.");
    }

    await put("lessons", lessonData);

    packs[id] = lessonData;

    $("packState").textContent =
      "Downloaded: " + lessonData.title +
      ". This lesson is now available offline.";

    renderCatalog();

  } catch (error) {
    console.error(error);

    $("packState").textContent =
      "Download failed. Please try again when your connection is available.";
  }
}

// ==========================================
// OPEN LESSON
// ==========================================

async function openLesson(id) {
  lesson = packs[id];

  if (!lesson) {
    return;
  }

  $("lessonCard").classList.remove("hide");

  $("lessonBody").innerHTML = `
    <h2>${escapeHTML(lesson.title)}</h2>
    <p class="muted">
      ${escapeHTML(lesson.subject)}
      &middot;
      Version ${escapeHTML(lesson.version)}
    </p>

    ${lesson.body.map((paragraph) =>
      `<p>${escapeHTML(paragraph)}</p>`
    ).join("")}
  `;

  await buildQuiz();

  $("lessonCard").scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });
}

$("takeQuiz").onclick = () => show("quiz");

// ==========================================
// QUIZ AND SAVED ANSWERS
// ==========================================

async function buildQuiz() {
  if (!lesson) {
    return;
  }

  const attempts = await all("attempts");

  draft = attempts.find((attempt) =>
    attempt.status === "draft" &&
    attempt.lessonId === lesson.id
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

  $("quizTitle").textContent = "Quiz: " + lesson.title;

  $("quizForm").innerHTML = lesson.quiz.questions.map((question) => `
    <div class="q">
      <p>${escapeHTML(question.text)}</p>

      ${question.options.map((option, index) => `
        <label class="opt ${
          draft.answers[question.id] === index ? "sel" : ""
        }">
          <input
            type="radio"
            name="${escapeHTML(question.id)}"
            value="${index}"
            ${draft.answers[question.id] === index ? "checked" : ""}
          >
          ${escapeHTML(option)}
        </label>
      `).join("")}
    </div>
  `).join("");

  $("quizForm").querySelectorAll("input").forEach((input) => {
    input.onchange = async () => {
      draft.answers[input.name] = Number(input.value);

      await put("attempts", draft);

      $("saveNote").textContent = "✓ Answer saved on this device.";

      $("quizForm").querySelectorAll(".opt").forEach((label) => {
        label.classList.toggle(
          "sel",
          label.querySelector("input").checked
        );
      });
    };
  });

  const count = Object.keys(draft.answers).length;

  $("saveNote").textContent = count
    ? count + " saved answer(s) restored from this device."
    : "Your answers will be saved automatically.";
}

// ==========================================
// SUBMIT QUIZ
// ==========================================

$("submit").onclick = async () => {
  if (!draft || !lesson) {
    return;
  }

  const total = lesson.quiz.questions.length;
  const answered = Object.keys(draft.answers).length;

  if (answered < total) {
    $("saveNote").textContent =
      "Please answer every question before submitting.";
    return;
  }

  draft.status = "pending";
  draft.takenAt = new Date().toISOString();

  await put("attempts", draft);

  $("saveNote").textContent = "Quiz saved. Preparing submission...";

  await buildQuiz();

  $("saveNote").textContent = "";

  show("attempts");

  await sync();
};

// ==========================================
// UPLOAD QUEUE AND SYNCHRONIZATION
// ==========================================

async function sync(force = false) {
  if (syncing || !isOnline()) {
    await renderAttempts();
    return;
  }

  syncing = true;

  try {
    const queue = (await all("attempts")).filter((attempt) =>
      attempt.status === "pending" ||
      attempt.status === "failed"
    );

    for (const attempt of queue) {
      if (!isOnline()) {
        attempt.status = "pending";
        await put("attempts", attempt);
        break;
      }

      if (
        !force &&
        attempt.status === "failed" &&
        (backoff[attempt.id] || 0) > Date.now()
      ) {
        continue;
      }

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

        await response.json();

        attempt.status = "synced";

        delete backoff[attempt.id];

      } catch (error) {
        console.warn("Sync failed:", error);

        attempt.status = "failed";
        attempt.tries = (attempt.tries || 0) + 1;

        backoff[attempt.id] =
          Date.now() +
          Math.min(
            120000,
            baseDelay() * Math.pow(2, attempt.tries - 1)
          );
      }

      await put("attempts", attempt);
      await renderAttempts();
    }

  } finally {
    syncing = false;
  }
}

// ==========================================
// SUBMISSION HISTORY
// ==========================================

async function renderAttempts() {
  const attempts = (await all("attempts"))
    .filter((attempt) => attempt.status !== "draft")
    .sort((a, b) =>
      (a.takenAt || "").localeCompare(b.takenAt || "")
    );

  $("rows").innerHTML = attempts.map((attempt, index) => {
    const labels = {
      pending: "Pending",
      syncing: "Syncing",
      synced: "Synced",
      failed: "Failed"
    };

    const status = labels[attempt.status] || attempt.status;

    return `
      <tr data-id="${escapeHTML(attempt.id)}">
        <td>
          #${index + 1} ${escapeHTML(attempt.lessonTitle)}
          <div class="muted">
            ${escapeHTML(attempt.id.slice(0, 8))}
          </div>
        </td>

        <td>
          <span class="st s-${escapeHTML(attempt.status)}">
            ${escapeHTML(status)}
          </span>
        </td>

        <td>
          ${Object.keys(attempt.answers || {}).length} saved
        </td>

        <td>
          ${
            attempt.status === "failed"
              ? `<button class="retry">Retry</button>`
              : ""
          }
        </td>
      </tr>
    `;
  }).join("") || `
    <tr>
      <td colspan="4" class="muted">
        No submissions yet.
      </td>
    </tr>
  `;

  document.querySelectorAll(".retry").forEach((button) => {
    button.onclick = () => sync(true);
  });

  const hasPending = attempts.some((attempt) =>
    attempt.status === "pending" ||
    attempt.status === "failed" ||
    attempt.status === "syncing"
  );

  $("attNote").textContent = hasPending
    ? "Some submissions are waiting to reach your teacher. Your answers are saved on this device."
    : attempts.length
      ? "All submissions have been received by your teacher."
      : "";
}

// ==========================================
// NETWORK AND OFFLINE SETTINGS
// ==========================================

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

window.addEventListener("offline", () => {
  paintNet();
});

// Automatic retry check
setInterval(() => {
  if (isOnline()) {
    sync();
  }
}, 3000);

// ==========================================
// APPLICATION STARTUP
// ==========================================

(async function init() {
  try {
    try {
      $("simOffline").checked =
        localStorage.getItem("simOffline") === "1";
    } catch {}

    paintNet();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("sw.js")
        .catch((error) =>
          console.warn("Service worker registration failed:", error)
        );
    }

    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }

    // Restore downloaded lessons
    const savedLessons = await all("lessons");

    for (const savedLesson of savedLessons) {
      packs[savedLesson.id] = savedLesson;
    }

    // IMPORTANT:
    // A previous session may have closed during an upload.
    // Restore syncing attempts to pending so they can retry.
    const savedAttempts = await all("attempts");

    for (const attempt of savedAttempts) {
      if (attempt.status === "syncing") {
        attempt.status = "pending";
        await put("attempts", attempt);
      }
    }

    await loadCatalog();

    await renderAttempts();

    // Automatically retry saved submissions
    await sync();

    console.log("NEXUNO Learn initialized successfully.");

  } catch (error) {
    console.error("NEXUNO initialization error:", error);
  }
})();
  
