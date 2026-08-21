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
    return { id: service.id, name: service.name, ok: true, stats };
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
async function readJsonBody(req) {
  try { return JSON.parse((await readBody(req)) || "{}"); } catch { return {}; }
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

// Свой лог — только последние события этого процесса, в памяти. Данные Admin
// не хранит нигде, а тут важна не история, а «что пошло не так только что».
const SELF_LOG_LIMIT = 200;
const selfLog = [];
function logSelf(level, message, meta) {
  selfLog.push({ id: selfLog.length + 1, ts: Date.now(), level, message, meta: meta || null });
  if (selfLog.length > SELF_LOG_LIMIT) selfLog.shift();
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  out(`[${level}]`, message, meta || "");
}

// ---------- сервер ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method;

  try {
    if (p === "/api/health") return json(res, 200, { ok: true });
    if (p === "/api/config") return json(res, 200, { authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID });

    if (p.startsWith("/api/")) {
      const admin = await requireAdmin(req);
      if (!admin) return json(res, 403, { error: "forbidden", message: "Доступ только для админов BurningHouse" });

      // Сводка по всем сервисам разом — параллельно, каждый может упасть отдельно.
      if (p === "/api/overview" && method === "GET") {
        const results = await Promise.all(SERVICES.map(fetchServiceStats));
        return json(res, 200, { services: results, self: { logs: selfLog.slice(-20) } });
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

      // Управление пользователями — только через auth, остальные сервисы своих не ведут.
      if (p === "/api/users" && method === "GET") {
        if (!AUTH_SERVICE) return json(res, 501, { error: "auth_not_configured" });
        try { return json(res, 200, await callService(AUTH_SERVICE, "/internal/users")); }
        catch (e) { return json(res, 502, { error: "upstream", message: e.message }); }
      }

      const roleMatch = p.match(/^\/api\/users\/([\w-]+)\/(admin|disabled|logout-all)$/);
      if (roleMatch && method === "POST") {
        if (!AUTH_SERVICE) return json(res, 501, { error: "auth_not_configured" });
        const [, userId, action] = roleMatch;
        // Самому себе доступ отзывать через эту же кнопку — верный способ
        // остаться снаружи закрытой двери без второго админа под рукой.
        if (action !== "logout-all" && userId === admin.id) {
          return json(res, 400, { error: "self_action", message: "Нельзя менять роль самому себе отсюда — используйте CLI на сервере" });
        }
        const body = action === "logout-all" ? {} : await readJsonBody(req);
        try {
          await callService(AUTH_SERVICE, `/internal/users/${encodeURIComponent(userId)}/${action}`, { method: "POST", body });
          logSelf("info", `Admin-действие: ${action}`, { userId, by: admin.username, on: action === "logout-all" ? undefined : !!body.on });
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
