#!/usr/bin/env node
/**
 * Админка — одно место, где смотреть аналитику и логи остальных сервисов
 * BurningHouse и управлять ролью админа.
 *
 * Чистый Node.js, без внешних зависимостей. Своих данных не хранит вовсе —
 * никакой базы и volume не заводит: при каждом обращении дёргает /internal/*
 * у настроенных сервисов и отдаёт фронту. Входит через общий auth так же, как
 * остальные сервисы (SSO), но пускает внутрь, только если в токене есть claim
 * admin — его проставляет Auth пользователю через `node server.js make-admin`.
 *
 * Вызовы к другим сервисам (/internal/stats, /internal/logs, /internal/users…)
 * — это НЕ тот SSO-токен браузера, а отдельный server-to-server секрет
 * ADMIN_INTERNAL_KEY (см. admin-internal.js в каждом из них): токен браузера
 * подписан на аудиторию "admin" и другие сервисы его не примут, а гонять
 * пользователя через /authorize каждого сервиса по очереди было бы нелепо.
 *
 * Запуск: node server.js
 *
 * Переменные окружения:
 *   PORT            (по умолчанию 8793)
 *   HOST            (по умолчанию 127.0.0.1)
 *   AUTH_ISSUER     ОБЯЗАТЕЛЬНО — адрес auth-сервиса
 *   AUTH_CLIENT_ID  (по умолчанию admin)
 *   AUTH_BASE       (по умолчанию = AUTH_ISSUER)
 *   AUTH_JWKS_URL   (по умолчанию AUTH_ISSUER + /.well-known/jwks.json)
 *   AUTH_CLOCK_SKEW (по умолчанию 30)
 *   ADMIN_INTERNAL_KEY  ОБЯЗАТЕЛЬНО — общий секрет с /internal/* остальных сервисов
 *   SERVICES_JSON   ОБЯЗАТЕЛЬНО — какие сервисы показывать, JSON-массив:
 *     [{"id":"auth","name":"Вход","baseUrl":"https://auth.burninghouse.ru"}, …]
 *     Один из элементов должен иметь id "auth" — через него идёт управление
 *     пользователями (список, роль админа, блокировка, разлогин).
 *   PEXELS_API_KEY  необязательно — быстрое наполнение библиотеки Puzzle
 *     готовыми фото с pexels.com (вкладка «Импорт» на странице Puzzle).
 *     Без него вкладка отвечает 503, остальной Admin работает как обычно.
 *     Ключ живёт только тут: сама загрузка в Puzzle идёт через уже
 *     существующий POST /api/services/:id/puzzles (см. ниже), Puzzle про
 *     Pexels вообще не знает.
 *
 * Health-check по расписанию (см. runHealthCheck ниже) — раз в
 * HEALTH_CHECK_INTERVAL_MS дёргает /internal/stats у каждого сервиса из
 * SERVICES_JSON (та же проверка, что у /api/overview) и, если хоть один не
 * ответил, шлёт письмо всем админам (см. Auth /internal/users, поле admin).
 * Пока все живы — писем нет вовсе. Это ЕДИНСТВЕННОЕ состояние, которое Admin
 * хранит на диске (см. DATA_DIR) — весь остальной сервис как был, так и
 * остался без своей базы.
 *
 *   DATA_DIR         (по умолчанию ./data) — health-state.json: флаг
 *     «проблема известна, чинится» и последний результат проверки. Только
 *     это и переживает рестарт/редеплой — остальным Admin по-прежнему не
 *     обзаводится.
 *   HEALTH_CHECK_INTERVAL_MS (по умолчанию 3600000 = 1 час)
 *   RESEND_API_KEY, MAIL_FROM — см. mailer.js. Без RESEND_API_KEY письма
 *     просто логируются, health-check при этом всё равно считается и
 *     хранится — только реальная отправка выключена.
 *   PUBLIC_URL       необязательно, напр. https://admin.burninghouse.ru —
 *     ссылка на «Обзор» внутри письма. Без него письмо просто без ссылки.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8793", 10);
const HOST = process.env.HOST || "127.0.0.1";
const APP_HTML = path.join(__dirname, "index.html");
const ASSETS_DIR = path.join(__dirname, "assets");

const AUTH_ISSUER = (process.env.AUTH_ISSUER || "").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "admin";
const AUTH_BASE = (process.env.AUTH_BASE || AUTH_ISSUER).replace(/\/+$/, "");
const ADMIN_INTERNAL_KEY = process.env.ADMIN_INTERNAL_KEY || "";
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || "";
if (!PEXELS_API_KEY) console.warn("PEXELS_API_KEY не задан — вкладка «Импорт» у Puzzle отвечает 503.");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const HEALTH_STATE_PATH = path.join(DATA_DIR, "health-state.json");
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || String(60 * 60 * 1000), 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const mailer = require("./mailer");
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!AUTH_ISSUER) {
  console.error("Не задан AUTH_ISSUER — без него нечем проверять токены. Укажите адрес auth-сервиса, напр. AUTH_ISSUER=https://auth.burninghouse.ru");
  process.exit(1);
}
if (!ADMIN_INTERNAL_KEY) {
  console.error("Не задан ADMIN_INTERNAL_KEY — Admin не сможет ходить в /internal/* остальных сервисов. То же значение должно быть прописано и у них.");
  process.exit(1);
}
// Ключ уходит в HTTP-заголовок X-Admin-Key (см. callService ниже), а заголовки —
// это ASCII/Latin1. Кириллица или любой юникод там технически невалидны и
// роняют fetch с нечитаемой ошибкой "Cannot convert argument to a ByteString…"
// на КАЖДЫЙ запрос, а не один раз при старте — проверяем сразу, чтобы не гадать.
if (!/^[\x21-\x7e]+$/.test(ADMIN_INTERNAL_KEY)) {
  console.error("ADMIN_INTERNAL_KEY должен состоять из ASCII-символов без пробелов (это значение HTTP-заголовка). Похоже, в переменной остался плейсхолдер или скопировался юникод. Сгенерировать: openssl rand -hex 32");
  process.exit(1);
}

let SERVICES = [];
try {
  SERVICES = JSON.parse(process.env.SERVICES_JSON || "[]").map(s => ({
    id: String(s.id), name: String(s.name || s.id), baseUrl: String(s.baseUrl || "").replace(/\/+$/, ""),
  }));
} catch (e) {
  console.error("SERVICES_JSON: не удалось разобрать —", e.message);
}
if (!SERVICES.length) console.error("[!] SERVICES_JSON пуст — обзору и логам показывать нечего.");
const AUTH_SERVICE = SERVICES.find(s => s.id === "auth") || null;
if (!AUTH_SERVICE) console.error("[!] В SERVICES_JSON нет сервиса с id \"auth\" — управление пользователями работать не будет.");

const auth = require("./auth-client")({
  issuer: AUTH_ISSUER,
  audience: AUTH_CLIENT_ID,
  jwksUrl: process.env.AUTH_JWKS_URL,
  clockSkew: process.env.AUTH_CLOCK_SKEW == null ? undefined : parseInt(process.env.AUTH_CLOCK_SKEW, 10),
});
auth.warmup();

/** Требует не просто вход, а именно claim admin в токене (см. Auth/lib/tokens.js). */
async function requireAdmin(req) {
  const user = await auth.userFromRequest(req);
  if (!user || !user.admin) return null;
  return user;
}

// ---------- вызовы /internal/* других сервисов ----------

/**
 * Server-to-server: заголовок X-Admin-Key вместо SSO-токена (см. заголовок файла).
 * Таймаут короткий — это дашборд, лучше показать один сервис как недоступный,
 * чем держать всю страницу висящей из-за одного медленного соседа.
 */
async function callService(service, urlPath, { method = "GET", body, timeout = 5000 } = {}) {
  const res = await fetch(service.baseUrl + urlPath, {
    method,
    headers: {
      "X-Admin-Key": ADMIN_INTERNAL_KEY,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* сервис ответил не JSON-ом */ }
  // data.message — человекочитаемая причина (напр. «фильм используется в N
  // комнатах», см. Movies /internal/movies/:id) — без неё код ошибки
  // (data.error) долетал бы до админа голым, а сам текст, ради которого
  // сервис вообще прислал 4xx/5xx, терялся.
  if (!res.ok) {
    const detail = data && data.message ? " — " + data.message : (data && data.error ? " (" + data.error + ")" : "");
    throw new Error(`${service.id}: HTTP ${res.status}${detail}`);
  }
  return data;
}

/** Общее для /api/overview (все сервисы разом) и /api/services/:id/stats (один). */
async function fetchServiceStats(service) {
  try {
    const stats = await callService(service, "/internal/stats");
    // baseUrl уходит фронту не просто справочно: он публичный домен сервиса
    // и так, а вкладкам «Библиотека»/«Модерация» у Puzzle нужен, чтобы
    // достроить абсолютный <img src> — свои /uploads/* сервис отдаёт по
    // относительному пути, а картинка рисуется на странице Admin, у него
    // другой origin (см. wirePuzzleLibrary/wireModerationQueue в app.js).
    return { id: service.id, name: service.name, ok: true, baseUrl: service.baseUrl, stats };
  } catch (e) {
    return { id: service.id, name: service.name, ok: false, error: e.message };
  }
}

// ---------- HTTP-утилиты ----------

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
async function readJsonBody(req, limit) {
  try { return JSON.parse((await readBody(req, limit)) || "{}"); } catch { return {}; }
}

function serveApp(res) {
  try {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(APP_HTML));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("index.html не найден рядом с server.js");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
function serveStatic(res, pathname) {
  if (!pathname.startsWith("/assets/")) return false;
  const file = path.join(__dirname, path.normalize(pathname).replace(/^([\\/])+/, ""));
  if (!(file === ASSETS_DIR || file.startsWith(ASSETS_DIR + path.sep))) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}

// Свой лог — только последние события этого процесса, в памяти. Из
// постоянных данных у Admin теперь только health-state.json (см. ниже) —
// историю запросов/действий по-прежнему нигде не хранит, тут важно
// «что пошло не так только что», не история.
const SELF_LOG_LIMIT = 200;
const selfLog = [];
function logSelf(level, message, meta) {
  selfLog.push({ id: selfLog.length + 1, ts: Date.now(), level, message, meta: meta || null });
  if (selfLog.length > SELF_LOG_LIMIT) selfLog.shift();
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(`[${level}]`, message, meta || "");
}

// ---------- health-check по расписанию ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Флаг acknowledged переживает рестарт/редеплой контейнера (иначе Watchtower
// молча сбрасывал бы его при каждом обновлении образа, а обновления у Admin
// частые) — единственное, что Admin пишет на диск. Формат простой настолько,
// что для него не стали заводить SQLite ради одного объекта.
let healthState = {
  acknowledged: false, acknowledgedBy: null, acknowledgedAt: null,
  lastCheckAt: null, lastResults: [], lastAlertSentAt: null,
};
try {
  healthState = { ...healthState, ...JSON.parse(fs.readFileSync(HEALTH_STATE_PATH, "utf8")) };
} catch { /* первый запуск или файл повреждён — остаёмся на дефолте */ }

function saveHealthState() {
  try { fs.writeFileSync(HEALTH_STATE_PATH, JSON.stringify(healthState)); }
  catch (e) { logSelf("error", "Не удалось сохранить health-state.json", { message: e.message }); }
}

async function sendHealthAlert(down) {
  if (!AUTH_SERVICE) { logSelf("error", "Health-check: не задан AUTH_SERVICE, письмо о недоступности не отправлено"); return; }
  let admins;
  try {
    const data = await callService(AUTH_SERVICE, "/internal/users");
    admins = (data.users || []).filter(u => u.admin && !u.disabled && u.email);
  } catch (e) {
    logSelf("error", "Health-check: не удалось получить список админов для письма", { message: e.message });
    return;
  }
  if (!admins.length) { logSelf("warn", "Health-check: недоступные сервисы есть, но ни одного админа с email — письмо некому слать"); return; }

  const overviewLink = PUBLIC_URL ? `${PUBLIC_URL}/#overview` : null;
  const rows = down.map(d => ({ name: d.name, reason: d.error || "недоступен" }));
  const subject = down.length === 1
    ? `BurningHouse: «${rows[0].name}» недоступен`
    : `BurningHouse: ${down.length} сервисов недоступны`;
  const html = `
    <p>Проверка сервисов BurningHouse обнаружила проблему:</p>
    <ul>${rows.map(r => `<li><b>${escapeHtml(r.name)}</b> — ${escapeHtml(r.reason)}</li>`).join("")}</ul>
    <p>Повторные письма приостановятся, если отметить проблему как известную в Admin${overviewLink ? ` (<a href="${escapeHtml(overviewLink)}">Обзор</a>)` : ""} — и возобновятся только когда кто-то из админов снимет эту отметку сам.</p>
  `;
  const text = `Проверка сервисов BurningHouse обнаружила проблему:\n${rows.map(r => `- ${r.name} — ${r.reason}`).join("\n")}\n\n` +
    `Повторные письма приостановятся, если отметить проблему как известную в Admin${overviewLink ? ` (${overviewLink})` : ""} — и возобновятся только когда админ снимет эту отметку сам.`;

  await Promise.all(admins.map(a => mailer.send({ to: a.email, subject, html, text })));
  healthState.lastAlertSentAt = Date.now();
  saveHealthState();
  logSelf("warn", "Health-check: письмо о недоступности отправлено", { down: down.map(d => d.id), to: admins.map(a => a.email) });
}

async function runHealthCheck() {
  const results = await Promise.all(SERVICES.map(fetchServiceStats));
  const down = results.filter(r => !r.ok);
  healthState.lastCheckAt = Date.now();
  healthState.lastResults = results.map(r => ({ id: r.id, name: r.name, ok: r.ok, error: r.error || null }));
  saveHealthState();
  if (!down.length) return;
  if (healthState.acknowledged) {
    logSelf("info", "Health-check: есть недоступные сервисы, но проблема отмечена как известная — письмо не шлём", { down: down.map(d => d.id) });
    return;
  }
  await sendHealthAlert(down);
}

// Первая проверка — вскоре после старта (не мгновенно: даём auth.warmup()
// и самим сервисам время подняться при одновременном докатывании стека),
// дальше — раз в HEALTH_CHECK_INTERVAL_MS. setInterval, не рекурсивный
// setTimeout: карта дежурства не должна дрейфовать от времени самого
// запроса — раз в час значит раз в час, а не «час после конца предыдущего».
setTimeout(() => { runHealthCheck().catch(e => logSelf("error", "Health-check упал", { message: e.message })); }, 15000);
setInterval(() => { runHealthCheck().catch(e => logSelf("error", "Health-check упал", { message: e.message })); }, HEALTH_CHECK_INTERVAL_MS);

// ---------- сервер ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method;

  try {
    if (p === "/api/health") return json(res, 200, { ok: true });
    if (p === "/api/config") return json(res, 200, { authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID });

    // Админка — не для поисковиков (см. meta robots в index.html и тот же
    // приём у Movies/server.js): дублируем запрет для краулеров, которые
    // robots.txt уважают, но meta-тег на странице не читают.
    if (p === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("User-agent: *\nDisallow: /\n");
    }

    if (p.startsWith("/api/")) {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: "forbidden", message: "Доступ только для админов BurningHouse" });

      // Сводка по всем сервисам разом — параллельно, каждый может упасть отдельно.
      if (p === "/api/overview" && method === "GET") {
        const results = await Promise.all(SERVICES.map(fetchServiceStats));
        return json(res, 200, { services: results, self: { logs: selfLog.slice(-20) } });
      }

      // Состояние health-check для баннера на «Обзоре» — см. runHealthCheck.
      if (p === "/api/health-check" && method === "GET") {
        return json(res, 200, healthState);
      }
      // «Проверить сейчас» — та же runHealthCheck, что и по расписанию, просто
      // по кнопке: удобно проверить, что письмо реально уходит, не дожидаясь часа.
      if (p === "/api/health-check/run" && method === "POST") {
        try {
          await runHealthCheck();
          logSelf("info", "Admin-действие: health-check запущен вручную", { by: admin.username });
          return json(res, 200, healthState);
        } catch (e) {
          return json(res, 500, { error: "health_check_failed", message: e.message });
        }
      }
      // Отметка «проблема известна, чинится» — гасит письма, пока кто-то из
      // админов не снимет её сам (см. runHealthCheck: не авто-сбрасывается
      // при восстановлении сервисов — так и просили).
      if (p === "/api/health-check/acknowledge" && method === "POST") {
        const body = await readJsonBody(req);
        healthState.acknowledged = !!body.on;
        healthState.acknowledgedBy = healthState.acknowledged ? admin.username : null;
        healthState.acknowledgedAt = healthState.acknowledged ? Date.now() : null;
        saveHealthState();
        logSelf("info", `Admin-действие: проблема ${healthState.acknowledged ? "отмечена как известная" : "снята с отметки"}`, { by: admin.username });
        return json(res, 200, healthState);
      }

      // Тот же снимок, но для одного сервиса — страница его подробностей.
      const statsMatch = p.match(/^\/api\/services\/([\w-]+)\/stats$/);
      if (statsMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === statsMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        return json(res, 200, await fetchServiceStats(service));
      }

      const logsMatch = p.match(/^\/api\/services\/([\w-]+)\/logs$/);
      if (logsMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === logsMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        const qs = new URLSearchParams();
        if (url.searchParams.get("since")) qs.set("since", url.searchParams.get("since"));
        if (url.searchParams.get("limit")) qs.set("limit", url.searchParams.get("limit"));
        try {
          const data = await callService(service, "/internal/logs" + (qs.toString() ? "?" + qs : ""));
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Список "комнат" (общих групп с кодом приглашения — trips у Trip, rooms у
      // Movies, если появится). Не все сервисы это реализуют — тогда сервис
      // просто ответит 404 на /internal/rooms, и это уйдёт как upstream-ошибка.
      const roomsMatch = p.match(/^\/api\/services\/([\w-]+)\/rooms$/);
      if (roomsMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === roomsMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          return json(res, 200, await callService(service, "/internal/rooms"));
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Расширение библиотеки диапазоном kinopoisk_id (сейчас реализовано
      // только у Movies, см. её server.js /internal/library/scan) — тот же
      // принцип, что у /rooms выше: не все сервисы это умеют, тогда просто
      // 404 от сервиса уходит наверх как upstream-ошибка, фронт прячет блок.
      const scanMatch = p.match(/^\/api\/services\/([\w-]+)\/library\/scan$/);
      if (scanMatch && (method === "GET" || method === "POST")) {
        const service = SERVICES.find(s => s.id === scanMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          if (method === "GET") return json(res, 200, await callService(service, "/internal/library/scan"));
          const body = await readJsonBody(req);
          const data = await callService(service, "/internal/library/scan", { method: "POST", body });
          logSelf("info", "Admin-действие: запуск скана библиотеки", { service: service.id, by: admin.username, from: body.from, to: body.to });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const scanStopMatch = p.match(/^\/api\/services\/([\w-]+)\/library\/scan\/stop$/);
      if (scanStopMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === scanStopMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const data = await callService(service, "/internal/library/scan/stop", { method: "POST" });
          logSelf("info", "Admin-действие: остановка скана библиотеки", { service: service.id, by: admin.username });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Карточка фильма + удаление из библиотеки (сейчас реализовано только
      // у Movies, см. её server.js /internal/movies/:id) — тот же принцип,
      // что у library/scan выше: не все сервисы это умеют, 404 от сервиса
      // уходит наверх как upstream-ошибка. GET — посмотреть, что удаляем
      // (название + счётчики использования), DELETE — сама отдача может
      // прийти 409 «используется», это не баг прокси — см. callService,
      // причина долетает в e.message.
      const movieMatch = p.match(/^\/api\/services\/([\w-]+)\/movies\/(\d+)$/);
      if (movieMatch && (method === "GET" || method === "DELETE")) {
        const service = SERVICES.find(s => s.id === movieMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        const kpId = movieMatch[2];
        try {
          const data = await callService(service, `/internal/movies/${kpId}`, { method });
          if (method === "DELETE") logSelf("info", "Admin-действие: удаление фильма из библиотеки", { service: service.id, by: admin.username, kinopoiskId: kpId });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Очередь докачки деталей фильмов от импорта из расширения (см.
      // Movies server.js /internal/movies/detail-queue) — только видимость,
      // управлять тут нечем, очередь дренится сама по тику.
      const detailQueueMatch = p.match(/^\/api\/services\/([\w-]+)\/movies\/detail-queue$/);
      if (detailQueueMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === detailQueueMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          return json(res, 200, await callService(service, "/internal/movies/detail-queue"));
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Расход квоты по ключам poiskkino.dev (см. Movies server.js
      // /internal/poiskkino/keys) — несколько ключей через запятую,
      // автопереключение при исчерпании одного.
      const poiskkinoKeysMatch = p.match(/^\/api\/services\/([\w-]+)\/poiskkino\/keys$/);
      if (poiskkinoKeysMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === poiskkinoKeysMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          return json(res, 200, await callService(service, "/internal/poiskkino/keys"));
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Подборки (см. Movies server.js /internal/collections*) — импорт с
      // Кинопоиска целиком, список уже заведённых, удаление.
      const collectionsMatch = p.match(/^\/api\/services\/([\w-]+)\/collections$/);
      if (collectionsMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === collectionsMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          return json(res, 200, await callService(service, "/internal/collections"));
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const collectionsImportMatch = p.match(/^\/api\/services\/([\w-]+)\/collections\/import$/);
      if (collectionsImportMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === collectionsImportMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const body = await readJsonBody(req);
          // Собирает всю подборку синхронно (постранично, но недорого — до
          // 250 фильмов за вызов) — таймаут дефолтных 5с у callService мал
          // для этого конкретного вызова, поднимаем отдельно.
          const data = await callService(service, "/internal/collections/import", { method: "POST", body, timeout: 20000 });
          logSelf("info", "Admin-действие: импорт подборки", { service: service.id, by: admin.username, slug: body.slug });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const collectionDeleteMatch = p.match(/^\/api\/services\/([\w-]+)\/collections\/([\w-]+)$/);
      if (collectionDeleteMatch && method === "DELETE") {
        const service = SERVICES.find(s => s.id === collectionDeleteMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const data = await callService(service, `/internal/collections/${encodeURIComponent(collectionDeleteMatch[2])}`, { method: "DELETE" });
          logSelf("info", "Admin-действие: удаление подборки", { service: service.id, by: admin.username, collectionId: collectionDeleteMatch[2] });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Библиотека картинок Puzzle (см. её server.js /internal/puzzles,
      // README «Загрузка через Admin») — новые дефолтные пазлы, доступные
      // без входа. Файл идёт как base64 внутри JSON, не FormData/multipart:
      // callService выше всегда JSON.stringify'ит body, поднимать бинарный
      // проброс под один этот вызов не стали. Лимит readJsonBody здесь
      // намного больше дефолтных 64 КиБ — 4 МиБ картинка в base64 весит
      // около 5.3 МиБ плюс обвязка JSON.
      const puzzlesMatch = p.match(/^\/api\/services\/([\w-]+)\/puzzles$/);
      if (puzzlesMatch && (method === "GET" || method === "POST")) {
        const service = SERVICES.find(s => s.id === puzzlesMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          if (method === "GET") return json(res, 200, await callService(service, "/internal/puzzles"));
          const body = await readJsonBody(req, 6 * 1024 * 1024);
          const data = await callService(service, "/internal/puzzles", { method: "POST", body, timeout: 20000 });
          logSelf("info", "Admin-действие: добавлена картинка в библиотеку", { service: service.id, by: admin.username, title: body.title });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const puzzleDeleteMatch = p.match(/^\/api\/services\/([\w-]+)\/puzzles\/([\w-]+)$/);
      if (puzzleDeleteMatch && method === "DELETE") {
        const service = SERVICES.find(s => s.id === puzzleDeleteMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const data = await callService(service, `/internal/puzzles/${encodeURIComponent(puzzleDeleteMatch[2])}`, { method: "DELETE" });
          logSelf("info", "Admin-действие: удалена картинка из библиотеки", { service: service.id, by: admin.username, puzzleId: puzzleDeleteMatch[2] });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Поиск на Pexels — быстрое наполнение дефолтной библиотеки Puzzle (см.
      // PEXELS_API_KEY выше). Не привязан к конкретному сервису: это ключ
      // самого Admin, Puzzle про Pexels не знает вовсе.
      if (p === "/api/pexels/search" && method === "GET") {
        if (!PEXELS_API_KEY) return json(res, 503, { error: "not_configured", message: "PEXELS_API_KEY не задан." });
        const query = (url.searchParams.get("query") || "").trim();
        if (!query) return json(res, 400, { error: "missing_query" });
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
        try {
          const pxRes = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=24&page=${page}`, {
            headers: { Authorization: PEXELS_API_KEY },
            signal: AbortSignal.timeout(10000),
          });
          const pxData = await pxRes.json().catch(() => ({}));
          if (!pxRes.ok) return json(res, 502, { error: "pexels", message: (pxData && pxData.error) || `HTTP ${pxRes.status}` });
          // Лимит — не отдельная ручка (у Pexels её и нет), а заголовки на
          // КАЖДОМ ответе /search; отдаём фронту, чтобы админ видел остаток
          // и не улетел в 429 посреди массового импорта не глядя.
          const rlLimit = parseInt(pxRes.headers.get("x-ratelimit-limit"), 10);
          const rlRemaining = parseInt(pxRes.headers.get("x-ratelimit-remaining"), 10);
          const rlReset = parseInt(pxRes.headers.get("x-ratelimit-reset"), 10);
          return json(res, 200, {
            photos: (pxData.photos || []).map(ph => ({
              id: ph.id, width: ph.width, height: ph.height, alt: ph.alt || "",
              photographer: ph.photographer, thumbUrl: ph.src.medium, importUrl: ph.src.large2x,
            })),
            page: pxData.page, hasMore: !!pxData.next_page,
            rateLimit: Number.isFinite(rlLimit) && Number.isFinite(rlRemaining)
              ? { limit: rlLimit, remaining: rlRemaining, resetAt: Number.isFinite(rlReset) ? rlReset * 1000 : null }
              : null,
          });
        } catch (e) {
          return json(res, 502, { error: "pexels", message: e.message });
        }
      }

      // Сам импорт: картинка качается тут, на сервере Admin (быстрее, чем
      // тащить её в браузер админа и обратно, и без вопросов CORS у
      // images.pexels.com), а дальше уходит тем же путём, что и обычная
      // ручная загрузка — POST /internal/puzzles у Puzzle (см. puzzlesMatch
      // выше). Puzzle про Pexels ничего не знает, для него это просто ещё
      // один base64-аплоад.
      const pexelsImportMatch = p.match(/^\/api\/services\/([\w-]+)\/pexels\/import$/);
      if (pexelsImportMatch && method === "POST") {
        if (!PEXELS_API_KEY) return json(res, 503, { error: "not_configured", message: "PEXELS_API_KEY не задан." });
        const service = SERVICES.find(s => s.id === pexelsImportMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        const body = await readJsonBody(req);
        const { importUrl, width, height, title, categoryIds } = body || {};
        if (!importUrl || !title) return json(res, 400, { error: "missing_fields" });
        try {
          const imgRes = await fetch(importUrl, { signal: AbortSignal.timeout(20000) });
          if (!imgRes.ok) return json(res, 502, { error: "pexels", message: `Не удалось скачать фото с Pexels: HTTP ${imgRes.status}` });
          const imageBase64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
          const data = await callService(service, "/internal/puzzles", {
            method: "POST", body: { title, imageBase64, width, height, categoryIds }, timeout: 20000,
          });
          logSelf("info", "Admin-действие: импорт картинки с Pexels", { service: service.id, by: admin.username, title });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Категории библиотеки (см. Puzzle server.js /internal/categories,
      // план «Категории пазлов в библиотеке»).
      const categoriesMatch = p.match(/^\/api\/services\/([\w-]+)\/categories$/);
      if (categoriesMatch && (method === "GET" || method === "POST")) {
        const service = SERVICES.find(s => s.id === categoriesMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          if (method === "GET") return json(res, 200, await callService(service, "/internal/categories"));
          const body = await readJsonBody(req);
          const data = await callService(service, "/internal/categories", { method: "POST", body });
          logSelf("info", "Admin-действие: создана категория", { service: service.id, by: admin.username, name: body.name });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const categoryDeleteMatch = p.match(/^\/api\/services\/([\w-]+)\/categories\/([\w-]+)$/);
      if (categoryDeleteMatch && method === "DELETE") {
        const service = SERVICES.find(s => s.id === categoryDeleteMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const data = await callService(service, `/internal/categories/${encodeURIComponent(categoryDeleteMatch[2])}`, { method: "DELETE" });
          logSelf("info", "Admin-действие: удалена категория", { service: service.id, by: admin.username, categoryId: categoryDeleteMatch[2] });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      // Множественное число в пути — категория стала many-to-many (см.
      // план «Категории many-to-many, автор карточки, профиль»), тело
      // теперь {categoryIds: [...]}, не одиночный {categoryId}.
      const puzzleCategoryMatch = p.match(/^\/api\/services\/([\w-]+)\/puzzles\/([\w-]+)\/categories$/);
      if (puzzleCategoryMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === puzzleCategoryMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        const body = await readJsonBody(req);
        try {
          const data = await callService(service, `/internal/puzzles/${encodeURIComponent(puzzleCategoryMatch[2])}/categories`, { method: "POST", body });
          logSelf("info", "Admin-действие: изменены категории пазла", { service: service.id, by: admin.username, puzzleId: puzzleCategoryMatch[2], categoryIds: body.categoryIds });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      // Переименование — та же кнопка «Сохранить», что и у категорий строкой
      // выше (см. wirePuzzleLibrary в app.js): после импорта с Pexels без
      // alt-текста название иногда уходит болванкой, тут его можно поправить.
      const puzzleTitleMatch = p.match(/^\/api\/services\/([\w-]+)\/puzzles\/([\w-]+)\/title$/);
      if (puzzleTitleMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === puzzleTitleMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        const body = await readJsonBody(req);
        try {
          const data = await callService(service, `/internal/puzzles/${encodeURIComponent(puzzleTitleMatch[2])}/title`, { method: "POST", body });
          logSelf("info", "Admin-действие: переименован пазл", { service: service.id, by: admin.username, puzzleId: puzzleTitleMatch[2], title: body.title });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Модерация загруженных пользователями фото (см. Puzzle server.js
      // /internal/moderation/*, план «Модерация загруженных фото»).
      const modPhotosMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/photos$/);
      if (modPhotosMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === modPhotosMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try { return json(res, 200, await callService(service, "/internal/moderation/photos")); }
        catch (e) { return json(res, 502, { error: "upstream", message: e.message }); }
      }
      const modApproveMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/photos\/([\w-]+)\/approve$/);
      if (modApproveMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === modApproveMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const data = await callService(service, `/internal/moderation/photos/${encodeURIComponent(modApproveMatch[2])}/approve`, { method: "POST" });
          logSelf("info", "Admin-действие: одобрена публикация фото", { service: service.id, by: admin.username, photoId: modApproveMatch[2] });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const modRejectMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/photos\/([\w-]+)\/reject$/);
      if (modRejectMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === modRejectMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        const body = await readJsonBody(req);
        try {
          const data = await callService(service, `/internal/moderation/photos/${encodeURIComponent(modRejectMatch[2])}/reject`, { method: "POST", body });
          logSelf("info", "Admin-действие: отклонена публикация фото", { service: service.id, by: admin.username, photoId: modRejectMatch[2], reason: body.reason });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const modDeleteMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/photos\/([\w-]+)$/);
      if (modDeleteMatch && method === "DELETE") {
        const service = SERVICES.find(s => s.id === modDeleteMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const data = await callService(service, `/internal/moderation/photos/${encodeURIComponent(modDeleteMatch[2])}`, { method: "DELETE" });
          logSelf("warn", "Admin-действие: удалено загруженное фото (модерация)", { service: service.id, by: admin.username, photoId: modDeleteMatch[2] });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Фоновая модерация ЗАГРУЗКИ В КОМНАТУ (см. Puzzle server.js
      // /internal/moderation/room-uploads/*, план «Разделение модерации:
      // загрузка в комнату vs публикация + письма») — отдельная очередь от
      // заявок на публикацию выше, тот же паттерн проксирования.
      const roomUploadsMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/room-uploads$/);
      if (roomUploadsMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === roomUploadsMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try { return json(res, 200, await callService(service, "/internal/moderation/room-uploads")); }
        catch (e) { return json(res, 502, { error: "upstream", message: e.message }); }
      }
      const roomUploadApproveMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/room-uploads\/([\w-]+)\/approve$/);
      if (roomUploadApproveMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === roomUploadApproveMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const data = await callService(service, `/internal/moderation/room-uploads/${encodeURIComponent(roomUploadApproveMatch[2])}/approve`, { method: "POST" });
          logSelf("info", "Admin-действие: одобрена загрузка в комнату", { service: service.id, by: admin.username, photoId: roomUploadApproveMatch[2] });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const roomUploadRejectMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/room-uploads\/([\w-]+)\/reject$/);
      if (roomUploadRejectMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === roomUploadRejectMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        const body = await readJsonBody(req);
        try {
          const data = await callService(service, `/internal/moderation/room-uploads/${encodeURIComponent(roomUploadRejectMatch[2])}/reject`, { method: "POST", body });
          logSelf("warn", "Admin-действие: отклонена загрузка в комнату (удалено)", { service: service.id, by: admin.username, photoId: roomUploadRejectMatch[2], reason: body.reason });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Модерация пользовательских категорий (см. Puzzle server.js
      // /internal/moderation/categories/*, план «Категории many-to-many») —
      // тот же паттерн, что у модерации фото выше.
      const modCategoriesMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/categories$/);
      if (modCategoriesMatch && method === "GET") {
        const service = SERVICES.find(s => s.id === modCategoriesMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try { return json(res, 200, await callService(service, "/internal/moderation/categories")); }
        catch (e) { return json(res, 502, { error: "upstream", message: e.message }); }
      }
      const modCategoryApproveMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/categories\/([\w-]+)\/approve$/);
      if (modCategoryApproveMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === modCategoryApproveMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        try {
          const data = await callService(service, `/internal/moderation/categories/${encodeURIComponent(modCategoryApproveMatch[2])}/approve`, { method: "POST" });
          logSelf("info", "Admin-действие: одобрена категория", { service: service.id, by: admin.username, categoryId: modCategoryApproveMatch[2] });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }
      const modCategoryRejectMatch = p.match(/^\/api\/services\/([\w-]+)\/moderation\/categories\/([\w-]+)\/reject$/);
      if (modCategoryRejectMatch && method === "POST") {
        const service = SERVICES.find(s => s.id === modCategoryRejectMatch[1]);
        if (!service) return json(res, 404, { error: "unknown_service" });
        const body = await readJsonBody(req);
        try {
          const data = await callService(service, `/internal/moderation/categories/${encodeURIComponent(modCategoryRejectMatch[2])}/reject`, { method: "POST", body });
          logSelf("info", "Admin-действие: отклонена категория", { service: service.id, by: admin.username, categoryId: modCategoryRejectMatch[2], reason: body.reason });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Управление пользователями — только через auth, остальные сервисы своих не ведут.
      if (p === "/api/users" && method === "GET") {
        if (!AUTH_SERVICE) return json(res, 501, { error: "auth_not_configured" });
        try { return json(res, 200, await callService(AUTH_SERVICE, "/internal/users")); }
        catch (e) { return json(res, 502, { error: "upstream", message: e.message }); }
      }

      const roleMatch = p.match(/^\/api\/users\/([\w-]+)\/(admin|disabled|logout-all|ban-devices)$/);
      if (roleMatch && method === "POST") {
        if (!AUTH_SERVICE) return json(res, 501, { error: "auth_not_configured" });
        const [, userId, action] = roleMatch;
        // Самому себе доступ отзывать через эту же кнопку — верный способ
        // остаться снаружи закрытой двери без второго админа под рукой.
        // ban-devices сюда тоже подпадает (action !== "logout-all") — забанить
        // самому себе все свои устройства из этой же вкладки было бы так же
        // неприятно, как самобан аккаунта.
        if (action !== "logout-all" && userId === admin.id) {
          return json(res, 400, { error: "self_action", message: "Нельзя менять роль самому себе отсюда — используйте CLI на сервере" });
        }
        const body = action === "logout-all" ? {} : await readJsonBody(req);
        if (action === "ban-devices") body.by = admin.username;
        try {
          const data = await callService(AUTH_SERVICE, `/internal/users/${encodeURIComponent(userId)}/${action}`, { method: "POST", body });
          logSelf("info", `Admin-действие: ${action}`, { userId, by: admin.username, on: action === "logout-all" ? undefined : !!body.on });
          return json(res, 200, action === "ban-devices" ? data : { ok: true });
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      // Устройства конкретного аккаунта (см. Auth server.js user_devices) —
      // для показа перед массовым баном (roleMatch выше, action=ban-devices).
      const userDevicesMatch = p.match(/^\/api\/users\/([\w-]+)\/devices$/);
      if (userDevicesMatch && method === "GET") {
        if (!AUTH_SERVICE) return json(res, 501, { error: "auth_not_configured" });
        try { return json(res, 200, await callService(AUTH_SERVICE, `/internal/users/${encodeURIComponent(userDevicesMatch[1])}/devices`)); }
        catch (e) { return json(res, 502, { error: "upstream", message: e.message }); }
      }

      // Бан ОДНОГО конкретного устройства — из вкладки «Модерация» Puzzle,
      // по uploadDevice конкретного фото (не обязательно все устройства
      // владельца, см. ban-devices выше — это более узкое, точечное
      // действие). Звонит не в service, а в сам Auth: устройства — его
      // реестр (см. план «Модерация загруженных фото», часть 0).
      const deviceBanMatch = p.match(/^\/api\/devices\/([\w-]+)\/banned$/);
      if (deviceBanMatch && method === "POST") {
        if (!AUTH_SERVICE) return json(res, 501, { error: "auth_not_configured" });
        const body = await readJsonBody(req);
        try {
          await callService(AUTH_SERVICE, `/internal/devices/${encodeURIComponent(deviceBanMatch[1])}/banned`, { method: "POST", body: { ...body, by: admin.username } });
          logSelf("warn", `Admin-действие: ${body.on ? "бан" : "разбан"} устройства`, { deviceId: deviceBanMatch[1], by: admin.username });
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      const deleteMatch = p.match(/^\/api\/users\/([\w-]+)$/);
      if (deleteMatch && method === "DELETE") {
        if (!AUTH_SERVICE) return json(res, 501, { error: "auth_not_configured" });
        const userId = deleteMatch[1];
        if (userId === admin.id) {
          return json(res, 400, { error: "self_action", message: "Нельзя удалить самого себя отсюда — используйте CLI на сервере" });
        }
        try {
          await callService(AUTH_SERVICE, `/internal/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
          logSelf("warn", "Admin-действие: delete", { userId, by: admin.username });
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, 502, { error: "upstream", message: e.message });
        }
      }

      return json(res, 404, { error: "not_found" });
    }

    if (method === "GET") {
      if (p !== "/" && serveStatic(res, p)) return;
      return serveApp(res); // SPA — маршрутизация на фронте
    }
    res.writeHead(405); res.end();
  } catch (e) {
    console.error("Необработанная ошибка:", e);
    logSelf("error", "Необработанная ошибка", { path: p, method, message: e.message });
    if (!res.headersSent) return json(res, 500, { error: "server_error" });
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Админка: http://${HOST}:${PORT}`);
  console.log(`Авторизация: ${AUTH_BASE} (клиент «${AUTH_CLIENT_ID}»)`);
  console.log(`Сервисы: ${SERVICES.map(s => s.id).join(", ") || "(не заданы)"}`);
});
