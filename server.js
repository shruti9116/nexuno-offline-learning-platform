// Nexuno prototype server: zero dependencies (Node 18+).
// Run: node server.js   then open http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DB = path.join(__dirname, "data.json");
const PUBLIC = path.join(__dirname, "public");

const load = () => { try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return { attempts: [], version: 1 }; } };
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));

// Lesson content is versioned. Answer keys stay on the server; grading happens here.
const CONTENT = {
  L1: {
    title: "The Water Cycle", level: "6-10", subject: "Science", grade: "Class 6",
    body: ["Water evaporates from oceans and rivers when the sun heats it.", "The vapour rises, cools and condenses into clouds.", "Water returns to the ground as rain, and the cycle repeats."],
    questions: [
      { id: "q1", text: "What makes water evaporate?", options: ["Wind", "Heat from the sun", "Moonlight"], key: 1 },
      { id: "q2", text: "Clouds form when vapour...", options: ["Freezes solid", "Disappears", "Cools and condenses"], key: 2 },
      { id: "q3", text: "Rain is part of which stage?", options: ["Precipitation", "Evaporation", "Condensation"], key: 0 },
    ],
  },
  L2: {
    title: "How Plants Make Food", level: "6-10", subject: "Science", grade: "Class 7",
    body: ["Plants make food by photosynthesis, using sunlight.", "Leaves take in carbon dioxide from the air and water from the roots.", "They produce sugar for energy and release oxygen."],
    questions: [
      { id: "q1", text: "Which gas do plants take in?", options: ["Oxygen", "Carbon dioxide", "Nitrogen"], key: 1 },
      { id: "q2", text: "Which gas do plants release?", options: ["Oxygen", "Hydrogen", "Methane"], key: 0 },
      { id: "q3", text: "What energy source do plants use?", options: ["Sunlight", "Wind", "Heat from soil"], key: 0 },
    ],
  },
  L3: {
    title: "Fractions Made Simple", level: "6-10", subject: "Maths", grade: "Class 6",
    body: ["A fraction shows a part of a whole, like 1/2 of a roti.", "The top number is the numerator and the bottom is the denominator.", "Equal fractions look different but have the same value, like 1/2 and 2/4."],
    questions: [
      { id: "q1", text: "In 3/4, what is 4 called?", options: ["Numerator", "Denominator", "Whole"], key: 1 },
      { id: "q2", text: "Which fraction equals 1/2?", options: ["2/4", "1/3", "3/4"], key: 0 },
      { id: "q3", text: "A fraction shows...", options: ["A part of a whole", "Only whole numbers", "A negative number"], key: 0 },
    ],
  },
  L4: {
    title: "Newton's Laws of Motion", level: "11-12", subject: "Physics", grade: "Class 11",
    body: ["First law: an object stays at rest or in uniform motion unless a net force acts on it.", "Second law: force equals mass times acceleration, F = ma.", "Third law: every action has an equal and opposite reaction, and the two forces act on different objects."],
    questions: [
      { id: "q1", text: "Which law is written as F = ma?", options: ["First law", "Second law", "Third law"], key: 1 },
      { id: "q2", text: "An object stays at rest unless a net force acts. This is the...", options: ["First law", "Second law", "Third law"], key: 0 },
      { id: "q3", text: "Action and reaction forces act on...", options: ["The same object", "Different objects", "No object"], key: 1 },
    ],
  },
  L5: {
    title: "Binary Search", level: "eng", subject: "CSE", grade: "Year 1",
    body: ["Binary search finds an item in a sorted list.", "It compares the target with the middle item and discards half of the list each step.", "Because the range halves every time, it takes about log n steps."],
    questions: [
      { id: "q1", text: "Binary search needs the list to be...", options: ["Sorted", "Random", "Empty"], key: 0 },
      { id: "q2", text: "Each step, the search range...", options: ["Doubles", "Halves", "Stays the same"], key: 1 },
      { id: "q3", text: "Its time complexity is...", options: ["O(n)", "O(log n)", "O(n squared)"], key: 1 },
    ],
  },
};

function lessonFor(id, version) {
  const c = CONTENT[id];
  if (!c) return null;
  return { id, version, title: c.title, level: c.level, subject: c.subject, grade: c.grade, body: c.body,
    quiz: { id: "Q-" + id, questions: c.questions.map(({ key, ...q }) => q) } };
}

function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, bad) => {
    let s = ""; req.on("data", (c) => (s += c));
    req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { bad(e); } });
    req.on("error", bad);
  });
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/catalog" && req.method === "GET") {
      const v = load().version;
      return send(res, 200, Object.keys(CONTENT).map((id) => {
        const l = lessonFor(id, v);
        return { id, title: l.title, level: l.level, subject: l.subject, grade: l.grade, version: v, sizeKB: Math.max(1, Math.round(JSON.stringify(l).length / 1024 * 10) / 10) };
      }));
    }
    if (url.pathname === "/api/lesson" && req.method === "GET") {
      const l = lessonFor(url.searchParams.get("id"), load().version);
      return l ? send(res, 200, l) : send(res, 404, { error: "no such lesson" });
    }
    if (url.pathname === "/api/attempts" && req.method === "POST") {
      const a = await body(req);
      if (!a.id || !CONTENT[a.lessonId] || !a.answers) return send(res, 400, { error: "bad attempt" });
      const db = load();
      const existing = db.attempts.find((x) => x.id === a.id);
      if (existing) {
        // Idempotency: the same attempt ID returns the stored record, never a second row.
        return send(res, 200, { ok: true, duplicate: true, attempt: existing });
      }
      const qs = CONTENT[a.lessonId].questions;
      const score = qs.filter((q) => a.answers[q.id] === q.key).length;
      const rec = {
        id: a.id, student: a.student || "Student", lessonId: a.lessonId, lessonTitle: CONTENT[a.lessonId].title,
        lessonVersion: a.lessonVersion, answers: a.answers, score, total: qs.length,
        takenAt: a.takenAt, receivedAt: new Date().toISOString(),
        // Conflict rule: an attempt keeps the lesson version it was taken on.
        note: a.lessonVersion < db.version ? "Taken on older lesson version; kept as submitted" : "",
      };
      db.attempts.push(rec);
      save(db); // stored fully in one write
      if (req.headers["x-demo-drop"] === "1") {
        // Demo only: the server has stored the attempt, then the connection dies mid-response.
        console.log("DEMO: dropping response for", a.id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"ok":tr');
        return setTimeout(() => req.socket.destroy(), 60);
      }
      return send(res, 200, { ok: true, duplicate: false, attempt: rec });
    }
    if (url.pathname === "/api/teacher" && req.method === "GET") {
      const db = load();
      return send(res, 200, { lessonVersion: db.version, attempts: db.attempts });
    }
    if (url.pathname === "/api/demo/bump" && req.method === "POST") {
      const db = load(); db.version += 1; save(db);
      return send(res, 200, { version: db.version });
    }
    if (url.pathname === "/api/demo/reset" && req.method === "POST") {
      save({ attempts: [], version: 1 });
      return send(res, 200, { ok: true });
    }
    let f = url.pathname === "/" ? "/index.html" : url.pathname;
    const p = path.normalize(path.join(PUBLIC, f));
    if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log("Nexuno prototype on http://localhost:" + PORT));