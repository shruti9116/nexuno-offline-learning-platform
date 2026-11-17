
// NEXUNO Learn - Offline Learning Platform
// Node.js 18+ | No external dependencies
// Run: node server.js
// Open: http://localhost:3000

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, "data.json");
const PUBLIC = path.join(__dirname, "public");

// ---------- Database ----------

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch {
    return { attempts: [], version: 1 };
  }
};

const save = (data) => {
  const temp = DB + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, DB);
};

// ---------- Lesson content ----------

const CONTENT = {
  L1: {
    title: "The Water Cycle",
    subject: "Science, Class 6",
    body: [
      "Water evaporates from oceans and rivers when the sun heats it.",
      "The vapour rises, cools and condenses into clouds.",
      "Water returns to the ground as rain, and the cycle repeats."
    ],
    questions: [
      { id: "q1", text: "What makes water evaporate?", options: ["Wind", "Heat from the sun", "Moonlight"], key: 1 },
      { id: "q2", text: "Clouds form when vapour...", options: ["Freezes solid", "Disappears", "Cools and condenses"], key: 2 },
      { id: "q3", text: "Rain is part of which stage?", options: ["Precipitation", "Evaporation", "Condensation"], key: 0 }
    ]
  },

  L2: {
    title: "How Plants Make Food",
    subject: "Science, Class 7",
    body: [
      "Plants make food by photosynthesis, using sunlight.",
      "Leaves take in carbon dioxide from the air and water from the roots.",
      "They produce sugar for energy and release oxygen."
    ],
    questions: [
      { id: "q1", text: "Which gas do plants take in?", options: ["Oxygen", "Carbon dioxide", "Nitrogen"], key: 1 },
      { id: "q2", text: "Which gas do plants release?", options: ["Oxygen", "Hydrogen", "Methane"], key: 0 },
      { id: "q3", text: "What energy source do plants use?", options: ["Sunlight", "Wind", "Heat from soil"], key: 0 }
    ]
  },

  L3: {
    title: "Fractions Made Simple",
    subject: "Maths, Class 6",
    body: [
      "A fraction shows a part of a whole, like 1/2 of a roti.",
      "The top number is the numerator and the bottom is the denominator.",
      "Equal fractions look different but have the same value, like 1/2 and 2/4."
    ],
    questions: [
      { id: "q1", text: "In 3/4, what is 4 called?", options: ["Numerator", "Denominator", "Whole"], key: 1 },
      { id: "q2", text: "Which fraction equals 1/2?", options: ["2/4", "1/3", "3/4"], key: 0 },
      { id: "q3", text: "A fraction shows...", options: ["A part of a whole", "Only whole numbers", "A negative number"], key: 0 }
    ]
  }
};

function lessonFor(id, version) {
  const lesson = CONTENT[id];
  if (!lesson) return null;

  return {
    id,
    version,
    title: lesson.title,
    subject: lesson.subject,
    body: lesson.body,
    quiz: {
      id: "Q-" + id,
      questions: lesson.questions.map(({ key, ...question }) => question)
    }
  };
}

// ---------- HTTP helpers ----------

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", chunk => {
      data += chunk;

      if (data.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

// ---------- API server ----------

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {

    // Get lesson catalog
    if (url.pathname === "/api/catalog" && req.method === "GET") {
      const version = load().version;

      const catalog = Object.keys(CONTENT).map(id => {
        const lesson = lessonFor(id, version);

        return {
          id,
          title: lesson.title,
          subject: lesson.subject,
          version,
          sizeKB: Math.max(
            1,
            Math.round(JSON.stringify(lesson).length / 1024 * 10) / 10
          )
        };
      });

      return send(res, 200, catalog);
    }

    // Download a lesson
    if (url.pathname === "/api/lesson" && req.method === "GET") {
      const lesson = lessonFor(
        url.searchParams.get("id"),
        load().version
      );

      if (!lesson) {
        return send(res, 404, { error: "Lesson not found" });
      }

      return send(res, 200, lesson);
    }

    // Receive quiz submission
    if (url.pathname === "/api/attempts" && req.method === "POST") {
      const attempt = await readBody(req);

      if (
        typeof attempt.id !== "string" ||
        attempt.id.length < 1 ||
        attempt.id.length > 150 ||
        !CONTENT[attempt.lessonId] ||
        !attempt.answers ||
        typeof attempt.answers !== "object" ||
        Array.isArray(attempt.answers)
      ) {
        return send(res, 400, { error: "Invalid quiz submission" });
      }

      const db = load();

      // Idempotency: an existing attempt ID is never inserted twice.
      const existing = db.attempts.find(
        item => item.id === attempt.id
      );

      if (existing) {
        return send(res, 200, {
          ok: true,
          duplicate: true,
          attempt: existing
        });
      }

      const lesson = CONTENT[attempt.lessonId];

      // Validate submitted answers.
      const validQuestionIds = lesson.questions.map(q => q.id);
      const submittedIds = Object.keys(attempt.answers);

      if (
        submittedIds.length !== validQuestionIds.length ||
        !validQuestionIds.every(id =>
          Number.isInteger(attempt.answers[id]) &&
          attempt.answers[id] >= 0 &&
          attempt.answers[id] < lesson.questions.find(q => q.id === id).options.length
        )
      ) {
        return send(res, 400, { error: "Incomplete or invalid answers" });
      }

      const score = lesson.questions.filter(
        question => attempt.answers[question.id] === question.key
      ).length;

      const record = {
        id: attempt.id,
        student: String(attempt.student || "Student").slice(0, 100),
        lessonId: attempt.lessonId,
        lessonTitle: lesson.title,
        lessonVersion: Number(attempt.lessonVersion) || 1,
        answers: attempt.answers,
        score,
        total: lesson.questions.length,
        takenAt: attempt.takenAt || new Date().toISOString(),
        receivedAt: new Date().toISOString(),

        // Conflict rule:
        // Existing attempts retain the lesson version used by the student.
        note:
          Number(attempt.lessonVersion) < db.version
            ? "Taken on an older lesson version; preserved as submitted."
            : ""
      };

      db.attempts.push(record);
      save(db);

      // Demo interruption:
      // Store the attempt first, then interrupt the response.
      // Retrying with the same ID must not create another record.
      if (req.headers["x-demo-drop"] === "1") {
        console.log("DEMO: response interrupted for", attempt.id);

        res.writeHead(200, {
          "Content-Type": "application/json"
        });

        res.write('{"ok":tr');

        return setTimeout(() => {
          req.socket.destroy();
        }, 60);
      }

      return send(res, 200, {
        ok: true,
        duplicate: false,
        attempt: record
      });
    }

    // Teacher dashboard data
    if (url.pathname === "/api/teacher" && req.method === "GET") {
      const db = load();

      return send(res, 200, {
        lessonVersion: db.version,
        attempts: db.attempts
      });
    }

    // Demo: publish a new lesson version
    if (url.pathname === "/api/demo/bump" && req.method === "POST") {
      const db = load();

      db.version += 1;
      save(db);

      return send(res, 200, {
        ok: true,
        version: db.version
      });
    }

    // Demo: reset submissions and lesson version
    if (url.pathname === "/api/demo/reset" && req.method === "POST") {
      save({
        attempts: [],
        version: 1
      });

      return send(res, 200, { ok: true });
    }

    // ---------- Static files ----------

    const requestedFile =
      url.pathname === "/" ? "index.html" : url.pathname.slice(1);

    const filePath = path.resolve(PUBLIC, requestedFile);

    if (
      !filePath.startsWith(PUBLIC + path.sep) ||
      !fs.existsSync(filePath) ||
      !fs.statSync(filePath).isFile()
    ) {
      res.writeHead(404);
      return res.end("Not found");
    }

    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });

    fs.createReadStream(filePath).pipe(res);

  } catch (error) {
    if (!res.headersSent) {
      send(res, 500, {
        error: String(error.message || error)
      });
    } else {
      res.destroy();
    }
  }

}).listen(PORT, () => {
  console.log("NEXUNO Learn running at http://localhost:" + PORT);
});
