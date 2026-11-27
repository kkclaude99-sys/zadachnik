// Разовый перенос задач из старого задачника (Supabase) в новый.
// Запуск — при ОСТАНОВЛЕННОМ сервере, из папки kanban:
//   node scripts/import-supabase.js
// Повторный запуск безопасен: уже перенесённые задачи пропускаются.

const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://uhvgoragwdcdvzvnefvu.supabase.co";
const SUPABASE_KEY = "sb_publishable_o62eggkRQguhEi7VbqL7Bw_z2TX5wvj";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const DATA_FILE = path.join(DATA_DIR, "board.json");

async function get(table) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ответил ${res.status} на ${table}. Если проект уснул — разбудите его на supabase.com.`);
  return res.json();
}

// Старые статусы → колонки доски
function columnFor(t) {
  if (t.id.startsWith("idea_")) return t.status === "active" ? "idea" : "done";
  if (t.status === "done" || t.status === "cancelled") return "done";
  if (t.status === "deferred") return "idea";
  if (t.blocked) return "waiting";
  return "doing";
}

(async () => {
  if (!fs.existsSync(DATA_FILE)) {
    console.error("Нет файла data/board.json. Сначала запустите сервер один раз (node server.js), потом остановите его и повторите.");
    process.exit(1);
  }
  const board = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const [tasks, projects] = await Promise.all([get("tasks"), get("projects")]);

  for (const p of projects) {
    if (!board.projects.some((x) => x.id === p.id || x.code === p.code)) {
      board.projects.push({ id: p.id, code: p.code, name: p.name, color: p.color || "#9B8AFB" });
    }
  }
  const projectId = (oldId) => {
    if (!oldId) return null;
    if (board.projects.some((x) => x.id === oldId)) return oldId;
    const old = projects.find((p) => p.id === oldId);
    return board.projects.find((x) => x.code === old?.code)?.id || null;
  };

  let added = 0;
  for (const t of tasks) {
    const id = `old_${t.id}`;
    if (board.cards.some((c) => c.id === id)) continue;
    const status = columnFor(t);
    const createdAt = t.created_at || new Date().toISOString();
    const statusAt = status === "done" && t.completed_at ? t.completed_at : createdAt;
    const history = [{ at: createdAt, by: null, from: null, to: status === "done" ? "doing" : status, note: "из старого задачника" }];
    if (status === "done") history.push({ at: statusAt, by: null, from: "doing", to: "done", note: "из старого задачника" });
    board.cards.push({
      id,
      title: t.title,
      desc: t.description || "",
      assignee: board.people.some((p) => p.id === t.assignee) ? t.assignee : null,
      projectId: projectId(t.project_id),
      due: t.due_date || null,
      weekly: t.id.startsWith("wk_") || t.recurring?.freq === "weekly",
      waitingFor: t.blocked?.reason || "",
      archived: t.status === "cancelled",
      order: new Date(createdAt).getTime(),
      status,
      statusAt,
      createdAt,
      createdBy: null,
      history,
      comments: (t.comments || []).map((m) => ({ id: m.id, at: m.createdAt, by: m.author, text: m.text })),
    });
    added++;
  }
  board.version += 1;
  fs.writeFileSync(DATA_FILE, JSON.stringify(board, null, 1));
  console.log(`Готово: перенесено задач — ${added}, всего на доске — ${board.cards.length}.`);
})().catch((e) => {
  console.error("Ошибка:", e.message);
  process.exit(1);
});
