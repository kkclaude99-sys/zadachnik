"use strict";

/* ---------------------------------------------------------
   Справочники
--------------------------------------------------------- */
const COLUMNS = [
  { id: "idea", name: "Идеи", color: "#9B8AFB", hint: "в долгую" },
  { id: "todo", name: "К работе", color: "#9BA3B4" },
  { id: "doing", name: "В работе", color: "#5B8DEF" },
  { id: "waiting", name: "Ждёт", color: "#E8B84B", hint: "чего-то не хватает" },
  { id: "done", name: "Готово", color: "#49B287" },
];
const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));
const DONE_VISIBLE_DAYS = 14; // в «Готово» показываем только свежие карточки
const LONG_IN_STATUS_DAYS = 5; // столько дней «В работе»/«Ждёт» — уже повод присмотреться
const POLL_MS = 4000;
const MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

const ICONS = {
  repeat: '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
};
function icon(name, size = 13) {
  return `<svg class="icon" style="width:${size}px;height:${size}px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

/* ---------------------------------------------------------
   Состояние
--------------------------------------------------------- */
const state = {
  board: null,
  me: storageGet("zk_me"),
  filterPeople: [],
  filterProject: "",
  search: "",
  showArchived: false,
  showOldDone: false,
  openCardId: null,
  quickAddColumn: null,
  dragId: null,
};

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

/* ---------------------------------------------------------
   Связь с сервером
--------------------------------------------------------- */
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-User": state.me || "" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    toast("Нет связи с сервером — изменения не сохранены");
    throw e;
  }
  if (res.status === 401 && url !== "/api/login") {
    renderLogin();
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || "Не удалось сохранить");
    throw new Error(data.error || res.status);
  }
  return data;
}

async function loadBoard() {
  state.board = await api("GET", "/api/board");
  render();
}

// Раз в несколько секунд спрашиваем сервер, не поменялось ли что-то у коллег.
let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.hidden || !state.board) return;
    try {
      const { version } = await api("GET", "/api/version");
      if (version !== state.board.version) await loadBoard();
    } catch (e) {}
  }, POLL_MS);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.board) loadBoard().catch(() => {});
});

// Меняем карточку сразу на экране, потом отправляем на сервер.
async function updateCard(id, patch) {
  const card = cardById(id);
  if (!card) return;
  const before = { ...card };
  Object.assign(card, patch);
  render();
  try {
    const saved = await api("PATCH", `/api/cards/${id}`, patch);
    replaceCard(saved);
  } catch (e) {
    Object.assign(card, before);
    render();
  }
}
function replaceCard(saved) {
  const i = state.board.cards.findIndex((c) => c.id === saved.id);
  if (i >= 0) state.board.cards[i] = saved;
  else state.board.cards.push(saved);
  state.board.version = -1; // при следующем опросе подтянем свежую версию целиком
  render();
}

/* ---------------------------------------------------------
   Помощники
--------------------------------------------------------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function cardById(id) {
  return state.board.cards.find((c) => c.id === id);
}
function person(id) {
  return state.board.people.find((p) => p.id === id) || null;
}
function project(id) {
  return state.board.projects.find((p) => p.id === id) || null;
}
function avatar(id, cls = "") {
  const p = person(id);
  if (!p) return `<span class="avatar none ${cls}" title="Не назначено"></span>`;
  return `<span class="avatar ${cls}" style="background:${p.color}" title="${esc(p.name)}">${esc(p.name[0])}</span>`;
}
function projectPill(p) {
  return p ? `<span class="pill" style="color:${p.color};background:${p.color}22" title="${esc(p.name)}">${esc(p.code)}</span>` : "";
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function humanDue(due) {
  const [y, m, d] = due.split("-").map(Number);
  const diff = Math.round((new Date(y, m - 1, d) - new Date(todayStr())) / 86400000);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  if (diff === -1) return "вчера";
  return `${d} ${MONTHS[m - 1]}`;
}
function humanDateTime(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `сегодня, ${time}` : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}
function duration(ms) {
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} мин`;
  if (h < 24) return `${Math.round(h)} ч`;
  return `${Math.round(h / 24)} д`;
}
// Сколько времени карточка провела в каждом статусе — по журналу переходов.
function timeByStatus(card) {
  const out = {};
  card.history.forEach((h, i) => {
    const end = i + 1 < card.history.length ? new Date(card.history[i + 1].at) : new Date();
    out[h.to] = (out[h.to] || 0) + (end - new Date(h.at));
  });
  return out;
}
let toastTimer = null;
function toast(text) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4500);
}

/* ---------------------------------------------------------
   Отбор карточек по фильтрам
--------------------------------------------------------- */
function visibleCards() {
  const q = state.search.trim().toLowerCase();
  return state.board.cards.filter((c) => {
    if (c.archived && !state.showArchived) return false;
    if (state.filterPeople.length && !state.filterPeople.includes(c.assignee)) return false;
    if (state.filterProject && c.projectId !== state.filterProject) return false;
    if (q && !`${c.title} ${c.desc}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
function isOldDone(c) {
  return c.status === "done" && Date.now() - new Date(c.statusAt) > DONE_VISIBLE_DAYS * 86400000;
}

/* ---------------------------------------------------------
   Отрисовка
--------------------------------------------------------- */
function renderLogin(error = "") {
  clearInterval(pollTimer);
  document.getElementById("modal-root").innerHTML = "";
  document.getElementById("app").innerHTML = `
    <div class="login">
      <form id="login-form">
        <h1>Задачник</h1>
        <div class="muted">Введите пароль команды</div>
        <input type="password" name="password" placeholder="Пароль" autofocus autocomplete="current-password" />
        <div class="err">${esc(error)}</div>
        <button class="btn btn-primary" type="submit">Войти</button>
      </form>
    </div>`;
  document.getElementById("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: e.target.password.value }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return renderLogin(data.error || "Не получилось войти");
    }
    start();
  };
}

function render() {
  if (!state.board) return;
  const app = document.getElementById("app");
  // Сохраняем фокус и прокрутку, чтобы обновления от коллег не сбивали работу.
  const scrolls = [...app.querySelectorAll(".col-body")].map((el) => el.scrollTop);
  const boardScroll = app.querySelector(".board")?.scrollLeft || 0;
  const focusedSearch = document.activeElement?.id === "search";
  const quickText = app.querySelector(".quick textarea")?.value;

  app.innerHTML = `<div class="app">${renderHeader()}${renderBoard()}</div>`;

  app.querySelectorAll(".col-body").forEach((el, i) => (el.scrollTop = scrolls[i] || 0));
  const boardEl = app.querySelector(".board");
  if (boardEl) boardEl.scrollLeft = boardScroll;
  if (focusedSearch) {
    const s = document.getElementById("search");
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }
  const quick = app.querySelector(".quick textarea");
  if (quick) {
    if (quickText) quick.value = quickText;
    quick.focus();
  }
  if (state.openCardId) renderModal();
}

function renderHeader() {
  const { board } = state;
  const today = todayStr();
  const active = board.cards.filter((c) => !c.archived && c.status !== "done" && c.status !== "idea");
  const overdue = active.filter((c) => c.due && c.due < today).length;
  const waiting = active.filter((c) => c.status === "waiting").length;

  const people = board.people.map((p) => {
    const on = state.filterPeople.includes(p.id);
    return `<button class="chip ${on ? "on" : ""}" data-filter-person="${p.id}" style="${on ? `border-color:${p.color};background:${p.color}22` : ""}">${avatar(p.id, "sm")}${esc(p.name)}</button>`;
  }).join("");
  const projects = board.projects.map((p) => `<option value="${p.id}" ${state.filterProject === p.id ? "selected" : ""}>${esc(p.code)} — ${esc(p.name)}</option>`).join("");
  const meOptions = board.people.map((p) => `<option value="${p.id}" ${state.me === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");

  return `
    <header>
      <div class="top">
        <div class="brand">
          <h1>Задачник</h1>
          <div class="sub">${active.length} в работе и планах${overdue ? ` · <span class="bad">${overdue} просрочено</span>` : ""}${waiting ? ` · ${waiting} ждут` : ""}</div>
        </div>
        <div class="spacer"></div>
        <label class="me ${state.me ? "" : "unset"}" title="Кто вы — чтобы было видно, кто двигал карточки">
          <select id="me">
            <option value="" ${state.me ? "" : "selected"} disabled>Я — это…</option>
            ${meOptions}
          </select>
        </label>
        <button class="btn btn-primary" id="new-card">${icon("plus", 15)} <span class="txt">Задача</span></button>
      </div>
      <div class="filters">
        <input type="search" id="search" placeholder="Поиск по задачам" value="${esc(state.search)}" />
        ${people}
        <div class="sep"></div>
        <select id="filter-project">
          <option value="">Все проекты</option>
          ${projects}
        </select>
        <button class="chip plain ${state.showArchived ? "on" : ""}" id="toggle-archive" style="${state.showArchived ? "border-color:var(--accent)" : ""}">Архив</button>
      </div>
    </header>`;
}

function renderBoard() {
  const cards = visibleCards();
  const cols = COLUMNS.map((col) => {
    let list = cards.filter((c) => c.status === col.id).sort((a, b) => a.order - b.order);
    let hiddenOld = 0;
    if (col.id === "done" && !state.showOldDone && !state.showArchived) {
      const fresh = list.filter((c) => !isOldDone(c));
      hiddenOld = list.length - fresh.length;
      list = fresh;
    }
    if (col.id === "done") list.reverse(); // свежевыполненные — сверху
    const quick = state.quickAddColumn === col.id
      ? `<div class="quick">
           <textarea rows="2" placeholder="Название задачи — Enter, чтобы добавить"></textarea>
           <div class="row"><button class="btn btn-primary" data-quick-save>Добавить</button><button class="btn" data-quick-cancel>Отмена</button></div>
         </div>`
      : `<button class="add-btn" data-quick-open="${col.id}">${icon("plus")} Добавить</button>`;
    return `
      <section class="column" data-column="${col.id}">
        <div class="col-head">
          <span class="dot" style="background:${col.color}"></span>
          <span class="name">${col.name}</span>
          <span class="count">${list.length}</span>
          ${col.hint ? `<span class="hint">${col.hint}</span>` : ""}
        </div>
        <div class="col-body">
          ${list.map(renderCard).join("")}
          ${hiddenOld ? `<button class="show-old" data-show-old>Показать старые (${hiddenOld})</button>` : ""}
          ${col.id === "done" && state.showOldDone ? `<button class="show-old" data-hide-old>Скрыть старые</button>` : ""}
        </div>
        <div class="col-foot">${quick}</div>
      </section>`;
  });
  return `<main class="board">${cols.join("")}</main>`;
}

function renderCard(c) {
  const p = project(c.projectId);
  const who = person(c.assignee);
  const today = todayStr();
  const isDone = c.status === "done";
  let dueHtml = "";
  if (c.due && !isDone) {
    const cls = c.due < today ? "overdue" : c.due === today ? "today" : "";
    dueHtml = `<span class="due ${cls}">${icon("calendar", 12)} ${c.due < today ? "просрочено · " : ""}${humanDue(c.due)}</span>`;
  }
  let ageHtml = "";
  if (c.status === "doing" || c.status === "waiting") {
    const ms = Date.now() - new Date(c.statusAt);
    const long = ms > LONG_IN_STATUS_DAYS * 86400000;
    ageHtml = `<span class="age ${long ? "long" : ""}" title="Столько карточка уже в колонке «${COLUMN_BY_ID[c.status].name}»">${icon("clock", 12)} ${duration(ms)}</span>`;
  }
  const border = c.status === "waiting" ? COLUMN_BY_ID.waiting.color : who?.color || "var(--border)";
  return `
    <article class="card ${isDone ? "done" : ""} ${c.archived ? "archived" : ""}" draggable="true" data-card="${c.id}" style="border-left-color:${border}">
      ${p || c.weekly ? `<div class="tags">${projectPill(p)}${c.weekly ? `<span class="pill" style="color:var(--accent);background:var(--accent-soft)" title="Каждую неделю: в понедельник вернётся в «К работе»">${icon("repeat", 11)} неделя</span>` : ""}</div>` : ""}
      <div class="title">${esc(c.title)}</div>
      ${c.status === "waiting" && c.waitingFor ? `<div class="wait">Ждём: ${esc(c.waitingFor)}</div>` : ""}
      <div class="meta">
        ${avatar(c.assignee, "sm")}
        ${dueHtml}${ageHtml}
        <span class="grow"></span>
        ${c.desc ? `<span title="Есть описание">${icon("text", 12)}</span>` : ""}
        ${c.comments.length ? `<span>${icon("message", 12)} ${c.comments.length}</span>` : ""}
      </div>
    </article>`;
}

function renderModal() {
  const root = document.getElementById("modal-root");
  const c = cardById(state.openCardId);
  if (!c) {
    state.openCardId = null;
    root.innerHTML = "";
    return;
  }
  // Не перерисовываем поле, в котором человек сейчас печатает.
  const focused = document.activeElement;
  const keep = root.contains(focused) && focused.dataset.field ? { field: focused.dataset.field, value: focused.value, start: focused.selectionStart } : null;
  const commentDraft = root.querySelector("#comment-text")?.value || "";
  const scroll = root.querySelector(".modal")?.scrollTop || 0;

  const times = timeByStatus(c);
  const total = Object.values(times).reduce((a, b) => a + b, 0) || 1;
  const bar = COLUMNS.filter((col) => times[col.id]).map((col) => `<div style="width:${(times[col.id] / total) * 100}%;background:${col.color}" title="${col.name}: ${duration(times[col.id])}"></div>`).join("");
  const legend = COLUMNS.filter((col) => times[col.id]).map((col) => `<span><span class="dot" style="background:${col.color}"></span>${col.name}: <b>${duration(times[col.id])}</b></span>`).join("");

  const history = [...c.history].reverse().map((h) => {
    const by = person(h.by);
    const what = h.from ? `${COLUMN_BY_ID[h.from]?.name || h.from} → <b>${COLUMN_BY_ID[h.to]?.name || h.to}</b>` : `создана в «${COLUMN_BY_ID[h.to]?.name || h.to}»`;
    return `<li><span class="when">${humanDateTime(h.at)}</span><span>${by ? esc(by.name) : h.note ? "" : "кто-то"}${h.note ? esc(h.note) : ""}: ${what}</span></li>`;
  }).join("");

  const comments = c.comments.map((m) => `
    <div class="comment">
      <div class="who">${avatar(m.by, "sm")} ${esc(person(m.by)?.name || "Гость")} <span class="muted">${humanDateTime(m.at)}</span></div>
      <p>${esc(m.text)}</p>
    </div>`).join("");

  const statusBtns = COLUMNS.map((col) => {
    const on = c.status === col.id;
    return `<button class="status-btn" data-set-status="${col.id}" style="${on ? `border-color:${col.color};color:var(--text);background:${col.color}26` : ""}"><span class="dot" style="background:${col.color}"></span>${col.name}</button>`;
  }).join("");

  const peopleBtns = [`<button class="chip plain ${!c.assignee ? "on" : ""}" data-set-assignee="" style="${!c.assignee ? "border-color:var(--accent)" : ""}">Никто</button>`]
    .concat(state.board.people.map((p) => {
      const on = c.assignee === p.id;
      return `<button class="chip ${on ? "on" : ""}" data-set-assignee="${p.id}" style="${on ? `border-color:${p.color};background:${p.color}22` : ""}">${avatar(p.id, "sm")}${esc(p.name)}</button>`;
    })).join("");

  const projectOpts = state.board.projects.map((p) => `<option value="${p.id}" ${c.projectId === p.id ? "selected" : ""}>${esc(p.code)} — ${esc(p.name)}</option>`).join("");

  root.innerHTML = `
    <div class="overlay" data-close-overlay>
      <div class="modal" role="dialog" aria-label="Задача">
        <div class="modal-head">
          <input class="title-input" data-field="title" value="${esc(c.title)}" />
          <button class="close" data-close aria-label="Закрыть">${icon("x", 20)}</button>
        </div>

        <span class="label">Статус</span>
        <div class="statuses">${statusBtns}</div>
        ${c.status === "waiting" ? `<input data-field="waitingFor" value="${esc(c.waitingFor)}" placeholder="Чего ждём: ответа, доступа, данных…" style="width:100%;margin-top:8px;border-color:var(--warn)" />` : ""}

        <span class="label">Ответственный</span>
        <div class="people">${peopleBtns}</div>

        <div class="grid">
          <div>
            <span class="label">Проект</span>
            <select data-field="projectId" style="width:100%">
              <option value="">Без проекта</option>
              ${projectOpts}
              <option value="__new">+ Новый проект…</option>
            </select>
          </div>
          <div>
            <span class="label">Срок</span>
            <input type="date" data-field="due" value="${c.due || ""}" style="width:100%" />
          </div>
        </div>
        <label class="check"><input type="checkbox" data-field="weekly" ${c.weekly ? "checked" : ""} /><span>Повторять каждую неделю<span class="muted" style="display:block;font-weight:500;font-size:12.5px">в понедельник сама вернётся из «Готово» в «К работе»</span></span></label>

        <span class="label">Описание</span>
        <textarea class="desc" data-field="desc" placeholder="Детали, ссылки, критерии готовности">${esc(c.desc)}</textarea>

        <div class="two">
          <div>
            <span class="label">Комментарии ${c.comments.length ? `(${c.comments.length})` : ""}</span>
            <div class="comments">${comments || `<div class="muted" style="font-size:13px">Пока пусто.</div>`}</div>
            <div class="comment-form">
              <textarea id="comment-text" rows="1" placeholder="${state.me ? `Написать как ${esc(person(state.me)?.name)}…` : "Сначала выберите «Я — это…» вверху"}"></textarea>
              <button class="btn btn-primary" data-add-comment>Отправить</button>
            </div>
          </div>
          <div>
            <span class="label">Время по статусам</span>
            <div class="timebar">${bar}</div>
            <div class="timelegend">${legend}</div>
            <span class="label">История</span>
            <ul class="history">${history}</ul>
          </div>
        </div>

        <div class="modal-foot">
          <div class="info">Создана ${humanDateTime(c.createdAt)}${person(c.createdBy) ? ` · ${esc(person(c.createdBy).name)}` : ""}</div>
          <div style="display:flex;gap:8px">
            <button class="btn" data-archive>${c.archived ? "Вернуть из архива" : "В архив"}</button>
            <button class="btn btn-danger" data-delete>Удалить</button>
          </div>
        </div>
      </div>
    </div>`;

  root.querySelector(".modal").scrollTop = scroll;
  root.querySelector("#comment-text").value = commentDraft;
  if (keep) {
    const el = root.querySelector(`[data-field="${keep.field}"]`);
    if (el) {
      el.value = keep.value;
      el.focus();
      try { el.setSelectionRange(keep.start, keep.start); } catch (e) {}
    }
  }
}

/* ---------------------------------------------------------
   Действия
--------------------------------------------------------- */
function openCard(id) {
  if (state.quickAddColumn) {
    state.quickAddColumn = null;
    render();
  }
  state.openCardId = id;
  renderModal();
}
function closeCard() {
  // Если человек закрыл окно, не уйдя из поля, — сохраним то, что он напечатал.
  const focused = document.activeElement;
  if (focused?.dataset?.field) saveField(focused);
  state.openCardId = null;
  document.getElementById("modal-root").innerHTML = "";
}

async function createCard(title, status) {
  const assignee = state.filterPeople.length === 1 ? state.filterPeople[0] : state.me || null;
  const card = await api("POST", "/api/cards", {
    title, status, assignee,
    projectId: state.filterProject || null,
    order: Date.now(),
  });
  replaceCard(card);
  return card;
}

async function newProjectPrompt() {
  const name = prompt("Название нового проекта:");
  if (!name || !name.trim()) return null;
  const code = prompt("Короткий код (2–4 буквы), например «АВИ»:", name.trim().slice(0, 3).toUpperCase());
  if (!code || !code.trim()) return null;
  const palette = ["#4FB6C9", "#F2B705", "#E85D75", "#8BC34A", "#9B8AFB", "#5FD3A0", "#F2946B", "#6EC1E4", "#D889C4"];
  const p = await api("POST", "/api/projects", { name, code, color: palette[state.board.projects.length % palette.length] });
  state.board.projects.push(p);
  return p;
}

async function saveField(el) {
  const id = state.openCardId;
  const c = id && cardById(id);
  if (!c) return;
  const field = el.dataset.field;
  let value = el.type === "checkbox" ? el.checked : el.value;
  if (field === "projectId" && value === "__new") {
    const p = await newProjectPrompt().catch(() => null);
    value = p ? p.id : c.projectId || "";
  }
  if (field === "projectId" || field === "due") value = value || null;
  if (field === "title" && !String(value).trim()) {
    el.value = c.title;
    return;
  }
  if (c[field] === value) return;
  await updateCard(id, { [field]: value });
}

async function addComment() {
  const ta = document.getElementById("comment-text");
  const text = ta.value.trim();
  if (!text) return;
  if (!state.me) return toast("Сначала выберите вверху, кто вы («Я — это…»)");
  ta.value = "";
  const saved = await api("POST", `/api/cards/${state.openCardId}/comments`, { text }).catch(() => {
    ta.value = text;
    return null;
  });
  if (saved) replaceCard(saved);
}

/* Клики — один общий обработчик на всю страницу */
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, article, .overlay");
  if (!t || !state.board) return;

  if (t.dataset.filterPerson) {
    const id = t.dataset.filterPerson;
    state.filterPeople = state.filterPeople.includes(id) ? state.filterPeople.filter((x) => x !== id) : [...state.filterPeople, id];
    return render();
  }
  if (t.id === "toggle-archive") {
    state.showArchived = !state.showArchived;
    return render();
  }
  if (t.id === "new-card") {
    state.quickAddColumn = "todo";
    render();
    return document.querySelector('[data-column="todo"]').scrollIntoView({ inline: "center", behavior: "smooth" });
  }
  if (t.dataset.quickOpen) {
    state.quickAddColumn = t.dataset.quickOpen;
    return render();
  }
  if (t.hasAttribute("data-quick-cancel")) {
    state.quickAddColumn = null;
    return render();
  }
  if (t.hasAttribute("data-quick-save")) return submitQuick();
  if (t.hasAttribute("data-show-old")) {
    state.showOldDone = true;
    return render();
  }
  if (t.hasAttribute("data-hide-old")) {
    state.showOldDone = false;
    return render();
  }
  if (t.matches("article.card")) return openCard(t.dataset.card);

  // Внутри окна карточки
  if (t.hasAttribute("data-close") || (t.hasAttribute("data-close-overlay") && e.target === t)) return closeCard();
  const id = state.openCardId;
  if (!id) return;
  if (t.dataset.setStatus) {
    if (!state.me) toast("Подсказка: выберите вверху «Я — это…», чтобы в истории было видно, кто двигал карточку");
    return updateCard(id, { status: t.dataset.setStatus, statusAt: new Date().toISOString() });
  }
  if (t.dataset.setAssignee !== undefined) return updateCard(id, { assignee: t.dataset.setAssignee || null });
  if (t.hasAttribute("data-add-comment")) return addComment();
  if (t.hasAttribute("data-archive")) {
    const c = cardById(id);
    await updateCard(id, { archived: !c.archived });
    return closeCard();
  }
  if (t.hasAttribute("data-delete")) {
    if (!confirm("Удалить задачу совсем? Вернуть не получится. Если она просто больше не нужна — лучше «В архив».")) return;
    await api("DELETE", `/api/cards/${id}`);
    state.board.cards = state.board.cards.filter((c) => c.id !== id);
    closeCard();
    return render();
  }
});

async function submitQuick() {
  const ta = document.querySelector(".quick textarea");
  const title = ta?.value.trim();
  if (!title) return;
  const status = state.quickAddColumn;
  ta.value = "";
  await createCard(title, status).catch(() => (ta.value = title));
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches(".quick textarea")) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitQuick();
    } else if (e.key === "Escape") {
      state.quickAddColumn = null;
      render();
    }
    return;
  }
  if (e.target.id === "comment-text" && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    return addComment();
  }
  if (e.target.dataset?.field === "title" && e.key === "Enter") return e.target.blur();
  if (e.key === "Escape" && state.openCardId) closeCard();
});

document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    state.search = e.target.value;
    render();
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "me") {
    state.me = e.target.value;
    storageSet("zk_me", state.me);
    return render();
  }
  if (e.target.id === "filter-project") {
    state.filterProject = e.target.value;
    return render();
  }
  if (e.target.dataset?.field) saveField(e.target);
});
// Текстовые поля сохраняем, когда человек из них уходит.
document.addEventListener("focusout", (e) => {
  const f = e.target.dataset?.field;
  if (f === "title" || f === "desc" || f === "waitingFor") saveField(e.target);
});

/* ---------------------------------------------------------
   Перетаскивание карточек мышкой
--------------------------------------------------------- */
function dropTarget(colBody, y) {
  const cards = [...colBody.querySelectorAll("article.card:not(.dragging)")];
  return cards.find((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) || null;
}
document.addEventListener("dragstart", (e) => {
  const card = e.target.closest?.("article.card");
  if (!card) return;
  state.dragId = card.dataset.card;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", state.dragId);
  requestAnimationFrame(() => card.classList.add("dragging"));
});
document.addEventListener("dragend", () => {
  state.dragId = null;
  document.querySelectorAll(".dragging, .drop").forEach((el) => el.classList.remove("dragging", "drop"));
  document.querySelectorAll(".drop-line").forEach((el) => el.remove());
});
document.addEventListener("dragover", (e) => {
  const col = e.target.closest?.(".column");
  if (!col || !state.dragId) return;
  e.preventDefault();
  document.querySelectorAll(".column.drop").forEach((el) => el !== col && el.classList.remove("drop"));
  col.classList.add("drop");
  const body = col.querySelector(".col-body");
  const before = dropTarget(body, e.clientY);
  let line = document.querySelector(".drop-line");
  if (!line) {
    line = document.createElement("div");
    line.className = "drop-line";
  }
  if (before) body.insertBefore(line, before);
  else body.insertBefore(line, body.querySelector(".show-old"));
});
document.addEventListener("drop", (e) => {
  const col = e.target.closest?.(".column");
  if (!col || !state.dragId) return;
  e.preventDefault();
  const id = state.dragId;
  const status = col.dataset.column;
  const body = col.querySelector(".col-body");
  const line = body.querySelector(".drop-line");
  // Порядок: ставим карточку между соседями (в «Готово» список перевёрнут).
  const siblings = [...body.children].filter((el) => el === line || (el.matches("article.card") && el.dataset.card !== id));
  const idx = siblings.indexOf(line);
  const prev = siblings[idx - 1] && cardById(siblings[idx - 1].dataset.card);
  const next = siblings[idx + 1] && cardById(siblings[idx + 1].dataset.card);
  let order;
  if (status === "done") {
    // сверху — бо́льший порядок
    order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order - 1000 : next ? next.order + 1000 : Date.now();
  } else {
    order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1000 : next ? next.order - 1000 : Date.now();
  }
  const c = cardById(id);
  const patch = { order };
  if (c.status !== status) {
    patch.status = status;
    patch.statusAt = new Date().toISOString();
  }
  updateCard(id, patch);
});

/* ---------------------------------------------------------
   Запуск
--------------------------------------------------------- */
async function start() {
  try {
    await loadBoard();
    startPolling();
  } catch (e) {
    if (e.message !== "unauthorized") toast("Не удалось загрузить доску");
  }
}
start();
