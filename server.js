
// Nexuno prototype server: zero dependencies (Node 18+).
// Run: node server.js, then open http://localhost:3000

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, "data.json");
const PUBLIC = path.join(__dirname, "public");
const MAX_BODY = 64 * 1024;

const load = () => {
  try {
    const data = JSON.parse(fs.readFileSync(DB, "utf8"));
    return {
      attempts: Array.isArray(data.attempts) ? data.attempts : [],
      version: Number.isInteger(data.version) && data.version > 0 ? data.version : 1
    };
  } catch {
    return { attempts: [], version: 1 };
  }
};

const save = (data) => {
  const temp = DB + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, DB);
};

// Lesson content is versioned. Answer keys stay on the server.
const CONTENT = {
  L1: {
    title: "The Water Cycle", level: "6-10", subject: "Science", grade: "Class 6",
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
    title: "How Plants Make Food", level: "6-10", subject: "Science", grade: "Class 7",
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
    title: "Fractions Made Simple", level: "6-10", subject: "Maths", grade: "Class 6",
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
  },
  L4: {
    title: "Newton's Laws of Motion", level: "11-12", subject: "Physics", grade: "Class 11",
    body: [
      "First law: an object stays at rest or in uniform motion unless a net force acts on it.",
      "Second law: force equals mass times acceleration, F = ma.",
      "Third law: every action has an equal and opposite reaction, and the two forces act on different objects."
    ],
    questions: [
      { id: "q1", text: "Which law is written as F = ma?", options: ["First law", "Second law", "Third law"], key: 1 },
      { id: "q2", text: "An object stays at rest unless a net force acts. This is the...", options: ["First law", "Second law", "Third law"], key: 0 },
      { id: "q3", text: "Action and reaction forces act on...", options: ["The same object", "Different objects", "No object"], key: 1 }
    ]
  },
  L5: {
    title: "Binary Search", level: "eng", subject: "CSE", grade: "Year 1",
    body: [
      "Binary search finds an item in a sorted list.",
      "It compares the target with the middle item and discards half of the list each step.",
      "Because the range halves every time, it takes about log n steps."
    ],
    questions: [
      { id: "q1", text: "Binary search needs the list to be...", options: ["Sorted", "Random", "Empty"], key: 0 },
      { id: "q2", text: "Each step, the search range...", options: ["Doubles", "Halves", "Stays the same"], key: 1 },
      { id: "q3", text: "Its time complexity is...", options: ["O(n)", "O(log n)", "O(n squared)"], key: 1 }
    ]
  }
};

function lessonFor(id, version) {
  const content = CONTENT[id];
  if (!content) return null;

  return {
    id,
    version,
    title: content.title,
    level: content.level,
    subject: content.subject,
    grade: content.grade,
    body: content.body,
    quiz: {
      id: "Q-" + id,
      questions: content.questions.map(({ key, ...question }) => question)
    }
  };
}

function send(res, code, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }

      raw += chunk.toString("utf8");
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function validAttempt(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  if (typeof a.id !== "string" || a.id.length < 1 || a.id.length > 128) return false;
  if (typeof a.lessonId !== "string" || !CONTENT[a.lessonId]) return false;
  if (!Number.isInteger(a.lessonVersion) || a.lessonVersion < 1) return false;
  if (!a.answers || typeof a.answers !== "object" || Array.isArray(a.answers)) return false;

  const questions = CONTENT[a.lessonId].questions;
  const allowedIds = new Set(questions.map(q => q.id));
  const answerIds = Object.keys(a.answers);

  if (answerIds.length !== questions.length) return false;

  return answerIds.every(id =>
    allowedIds.has(id) &&
    Number.isInteger(a.answers[id]) &&
    a.answers[id] >= 0 &&
    a.answers[id] < questions.find(q => q.id === id).options.length
  );
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (url.pathname === "/api/catalog" && req.method === "GET") {
      const version = load().version;

      return send(res, 200, Object.keys(CONTENT).map(id => {
        const lesson = lessonFor(id, version);

        return {
          id,
          title: lesson.title,
          level: lesson.level,
          subject: lesson.subject,
          grade: lesson.grade,
          version,
          sizeKB: Math.max(
            1,
            Math.round(JSON.stringify(lesson).length / 1024 * 10) / 10
          )
        };
      }));
    }

    if (url.pathname === "/api/lesson" && req.method === "GET") {
      const lesson = lessonFor(url.searchParams.get("id"), load().version);

      return lesson
        ? send(res, 200, lesson)
        : send(res, 404, { error: "No such lesson" });
    }

    if (url.pathname === "/api/attempts" && req.method === "POST") {
      const attempt = await readBody(req);

      if (!validAttempt(attempt)) {
        return send(res, 400, {
          error: "Invalid attempt. Check ID, lesson, version and answers."
        });
      }

      const db = load();

      // Same attempt ID can never create a second submission.
      const existing = db.attempts.find(item => item.id === attempt.id);

      if (existing) {
        return send(res, 200, {
          ok: true,
          duplicate: true,
          attempt: existing
        });
      }

      const content = CONTENT[attempt.lessonId];
      const score = content.questions.filter(
        question => attempt.answers[question.id] === question.key
      ).length;

      const record = {
        id: attempt.id,
        student: typeof attempt.student === "string"
          ? attempt.student.slice(0, 100)
          : "Student",
        lessonId: attempt.lessonId,
        lessonTitle: content.title,
        lessonVersion: attempt.lessonVersion,
        answers: attempt.answers,
        score,
        total: content.questions.length,
        takenAt: typeof attempt.takenAt === "string" ? attempt.takenAt : null,
        receivedAt: new Date().toISOString(),
        note: attempt.lessonVersion < db.version
          ? "Taken on older lesson version; kept as submitted"
          : ""
      };

      db.attempts.push(record);
      save(db);

      // Demo: save first, then deliberately interrupt the response.
      if (req.headers["x-demo-drop"] === "1") {
        console.log("DEMO: dropping response for", attempt.id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"ok":tr');
        return setTimeout(() => req.socket.destroy(), 60);
      }

      return send(res, 200, {
        ok: true,
        duplicate: false,
        attempt: record
      });
    }

    if (url.pathname === "/api/teacher" && req.method === "GET") {
      const db = load();

      return send(res, 200, {
        lessonVersion: db.version,
        attempts: db.attempts
      });
    }

    if (url.pathname === "/api/demo/bump" && req.method === "POST") {
      const db = load();
      db.version += 1;
      save(db);

      return send(res, 200, { version: db.version });
    }

    if (url.pathname === "/api/demo/reset" && req.method === "POST") {
      save({ attempts: [], version: 1 });
      return send(res, 200, { ok: true });
    }

    // Serve public files.
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.resolve(PUBLIC, "." + requested);

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
    if (!res.destroyed && !res.writableEnded) {
      const status = error.message === "Request body too large" ? 413 : 400;
      send(res, status, { error: error.message || "Request failed" });
    }
  }
});

server.listen(PORT, () => {
  console.log("Nexuno prototype running on port " + PORT);
});
