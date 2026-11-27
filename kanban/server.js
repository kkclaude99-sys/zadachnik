// Задачник-канбан: маленький сервер без внешних зависимостей.
// Нужен только Node.js 18+. Данные лежат в одном файле data/board.json.
//
// Настройки через переменные окружения:
//   PORT           — порт (по умолчанию 3000)
//   HOST           — адрес (по умолчанию 0.0.0.0; за Caddy ставьте 127.0.0.1)
//   TEAM_PASSWORD  — общий пароль команды (обязательно задать на сервере)
//   DATA_DIR       — папка для данных (по умолчанию ./data)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const DATA_FILE = path.join(DATA_DIR, "board.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PUBLIC_DIR = path.join(__dirname, "public");
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || "";
const COOKIE = "zk_session";
const SESSION_DAYS = 60;

const STATUSES = ["idea", "doing", "waiting", "done"];

/* ---------------------------------------------------------
   Хранилище
--------------------------------------------------------- */
function defaultBoard() {
  return {
    version: 1,
    people: [
      { id: "sasha", name: "Саша", color: "#E0954F" },
      { id: "kostya", name: "Костя", color: "#5B8DEF" },
      { id: "nikita", name: "Никита", color: "#C77DFF" },
    ],
    projects: [
      { id: "bar", code: "БАР", name: "Биржа авитологов", color: "#4FB6C9" },
      { id: "ya", code: "ЯА", name: "Я — Авитолог", color: "#F2B705" },
      { id: "par", code: "ПРТ", name: "Партнёрка", color: "#E85D75" },
      { id: "avi", code: "АВИ", name: "Авитология", color: "#8BC34A" },
    ],
    cards: [],
  };
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
let board = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : defaultBoard();
if (!board.secret) board.secret = crypto.randomBytes(32).toString("hex");
// Колонку «К работе» убрали: такие карточки переезжают в «В работе».
for (const c of board.cards) {
  if (c.status === "todo") moveCard(c, "doing", null, "колонка «К работе» убрана");
}
save();

// Запись через временный файл: если сервер упадёт посреди записи, старые данные не испортятся.
function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(board, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}
function bump() {
  board.version += 1;
  save();
}

// Резервная копия раз в сутки, храним последние 30.
function dailyBackup() {
  const name = `board-${new Date().toISOString().slice(0, 10)}.json`;
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) fs.copyFileSync(DATA_FILE, file);
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith("board-")).sort();
  for (const old of all.slice(0, -30)) fs.unlinkSync(path.join(BACKUP_DIR, old));
}
dailyBackup();
setInterval(dailyBackup, 60 * 60 * 1000);

/* ---------------------------------------------------------
   Еженедельные задачи: в новый понедельник «Готово» → «В работе»
--------------------------------------------------------- */
function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
function resetWeekly() {
  const thisMonday = mondayOf(Date.now());
  let changed = false;
  for (const c of board.cards) {
    if (c.weekly && c.status === "done" && !c.archived && mondayOf(c.statusAt) < thisMonday) {
      moveCard(c, "doing", null, "новая неделя");
      changed = true;
    }
  }
  if (changed) bump();
}
resetWeekly();
setInterval(resetWeekly, 10 * 60 * 1000);

/* ---------------------------------------------------------
   Работа с карточками
--------------------------------------------------------- */
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}
function moveCard(card, to, by, note) {
  const now = new Date().toISOString();
  card.history.push({ at: now, by, from: card.status, to, note: note || undefined });
  card.status = to;
  card.statusAt = now;
  if (to !== "waiting") card.waitingFor = "";
}
function clean(str, max) {
  return String(str ?? "").trim().slice(0, max);
}
// Берём из запроса только известные поля и проверяем их.
function applyFields(card, body) {
  if ("title" in body) card.title = clean(body.title, 300) || card.title;
  if ("desc" in body) card.desc = clean(body.desc, 10000);
  if ("assignee" in body) card.assignee = board.people.some((p) => p.id === body.assignee) ? body.assignee : null;
  if ("projectId" in body) card.projectId = board.projects.some((p) => p.id === body.projectId) ? body.projectId : null;
  if ("due" in body) card.due = /^\d{4}-\d{2}-\d{2}$/.test(body.due || "") ? body.due : null;
  if ("weekly" in body) card.weekly = !!body.weekly;
  if ("waitingFor" in body) card.waitingFor = clean(body.waitingFor, 300);
  if ("archived" in body) card.archived = !!body.archived;
  if ("order" in body && Number.isFinite(body.order)) card.order = body.order;
}

/* ---------------------------------------------------------
   Вход по общему паролю
--------------------------------------------------------- */
function sign(value) {
  return crypto.createHmac("sha256", board.secret).update(value).digest("hex");
}
function makeToken() {
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return `${exp}.${sign(exp)}`;
}
function isAuthed(req) {
  if (!TEAM_PASSWORD) return true; // пароль не задан — открытый режим для локальной проверки
  const m = (req.headers.cookie || "").match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function samePassword(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const loginAttempts = new Map(); // защита от перебора: не больше 10 попыток за 10 минут с одного адреса

/* ---------------------------------------------------------
   HTTP
--------------------------------------------------------- */
function send(res, code, data, headers = {}) {
  const body = data === undefined ? "" : JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 200000) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}
function publicBoard() {
  const { secret, ...rest } = board;
  return rest;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
function serveStatic(req, res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === "/api/login" && method === "POST") {
    const ip = req.headers["x-real-ip"] || req.socket.remoteAddress;
    const now = Date.now();
    const recent = (loginAttempts.get(ip) || []).filter((t) => now - t < 600000);
    if (recent.length >= 10) return send(res, 429, { error: "Слишком много попыток, подождите 10 минут" });
    const body = await readBody(req);
    if (TEAM_PASSWORD && !samePassword(body.password || "", TEAM_PASSWORD)) {
      loginAttempts.set(ip, [...recent, now]);
      return send(res, 401, { error: "Неверный пароль" });
    }
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return send(res, 200, { ok: true }, {
      "Set-Cookie": `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
    });
  }

  if (!isAuthed(req)) return send(res, 401, { error: "Нужно войти" });

  // Кто делает действие — выбирается в шапке («Я — это…»)
  const actor = board.people.some((p) => p.id === req.headers["x-user"]) ? req.headers["x-user"] : null;

  if (pathname === "/api/version" && method === "GET") return send(res, 200, { version: board.version });
  if (pathname === "/api/board" && method === "GET") return send(res, 200, publicBoard());

  if (pathname === "/api/cards" && method === "POST") {
    const body = await readBody(req);
    const status = STATUSES.includes(body.status) ? body.status : "doing";
    const now = new Date().toISOString();
    const card = {
      id: uid("c"), title: "", desc: "", assignee: null, projectId: null, due: null,
      weekly: false, waitingFor: "", archived: false, order: Date.now(),
      status, statusAt: now, createdAt: now, createdBy: actor,
      history: [{ at: now, by: actor, from: null, to: status }], comments: [],
    };
    applyFields(card, body);
    if (!card.title) return send(res, 400, { error: "Пустое название" });
    board.cards.push(card);
    bump();
    return send(res, 201, card);
  }

  const cardMatch = pathname.match(/^\/api\/cards\/([\w-]+)(\/comments)?$/);
  if (cardMatch) {
    const card = board.cards.find((c) => c.id === cardMatch[1]);
    if (!card) return send(res, 404, { error: "Карточка не найдена" });

    if (cardMatch[2] && method === "POST") {
      const body = await readBody(req);
      const text = clean(body.text, 5000);
      if (!text) return send(res, 400, { error: "Пустой комментарий" });
      card.comments.push({ id: uid("m"), at: new Date().toISOString(), by: actor, text });
      bump();
      return send(res, 201, card);
    }
    if (!cardMatch[2] && method === "PATCH") {
      const body = await readBody(req);
      applyFields(card, body);
      if (STATUSES.includes(body.status) && body.status !== card.status) moveCard(card, body.status, actor);
      bump();
      return send(res, 200, card);
    }
    if (!cardMatch[2] && method === "DELETE") {
      board.cards = board.cards.filter((c) => c !== card);
      bump();
      return send(res, 200, { ok: true });
    }
  }

  if (pathname === "/api/projects" && method === "POST") {
    const body = await readBody(req);
    const code = clean(body.code, 6).toUpperCase();
    const name = clean(body.name, 80);
    if (!code || !name) return send(res, 400, { error: "Нужны код и название" });
    const project = { id: uid("p"), code, name, color: /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : "#9B8AFB" };
    board.projects.push(project);
    bump();
    return send(res, 201, project);
  }

  send(res, 404, { error: "Нет такого адреса" });
}

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    try {
      if (pathname.startsWith("/api/")) await handleApi(req, res, pathname);
      else serveStatic(req, res, decodeURIComponent(pathname));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: "Ошибка сервера" });
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`Задачник запущен: http://localhost:${PORT}`);
    if (!TEAM_PASSWORD) console.log("ВНИМАНИЕ: TEAM_PASSWORD не задан — вход без пароля. Для сервера в интернете задайте пароль.");
  });
