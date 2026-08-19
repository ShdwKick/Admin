"use strict";
/**
 * Фронт админки. Никакого фреймворка — как и в остальных сервисах
 * BurningHouse, обычный DOM и fetch. Кто админ, фронт не решает сам: он
 * просто дёргает защищённый /api/overview и по 403 понимает, что доступа нет
 * (см. Auth/INTEGRATION.md — claim admin проверяется на бэкенде, не на фронте).
 *
 * Навигация — хэш, как у Movies/Trip ("SPA с маршрутизацией по хэшу"):
 *   #overview        — сетка карточек сервисов (по умолчанию)
 *   #users           — управление пользователями
 *   #service/<id>    — подробности одного сервиса: статистика, график,
 *                       комнаты (если сервис их отдаёт) и логи — раньше это
 *                       были отдельные вкладки «Комнаты»/«Логи» на все сервисы
 *                       разом, теперь всё в одном месте на своём сервисе.
 */
(async function () {
  const app = document.getElementById("app");
  const appbar = document.getElementById("appbar");
  const whoName = document.getElementById("whoName");
  const accountBtn = document.getElementById("accountBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  window.addEventListener("scroll", () => appbar.classList.toggle("scrolled", window.scrollY > 4), { passive: true });

  const cfg = await (await fetch("/api/config")).json();
  const auth = createAuthClient({
    authBase: cfg.authBase,
    clientId: cfg.clientId,
    redirectUri: location.origin + location.pathname,
    storagePrefix: "admin",
  });

  await auth.handleRedirect();

  if (!auth.isAuthenticated()) return showLoginGate();

  // Показываем сразу по факту входа, не дожидаясь проверки claim admin —
  // иначе у залогиненного, но не-админа, нет кнопки выйти вообще никак.
  const user = auth.getUser() || {};
  whoName.textContent = user.name || user.username || "";
  whoName.style.display = "";
  accountBtn.style.display = "";
  accountBtn.onclick = () => window.open(auth.accountUrl(), "_blank", "noopener");
  logoutBtn.style.display = "";
  logoutBtn.onclick = () => auth.logout();

  class ForbiddenError extends Error {}
  async function api(path, opts) {
    let res;
    try {
      res = await auth.fetch(path, opts);
    } catch (e) {
      if (e.name === "AuthRequiredError") return showLoginGate(), Promise.reject(e);
      throw e;
    }
    if (res.status === 403) throw new ForbiddenError();
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  function showLoginGate() {
    whoName.style.display = "none";
    accountBtn.style.display = "none";
    logoutBtn.style.display = "none";
    app.innerHTML = `
      <div class="bh-gate">
        <p>Аналитика, логи и управление ролями по сервисам BurningHouse.
        Вход — тем же аккаунтом, что и везде.</p>
        <button class="bh-btn" id="loginBtn">Войти</button>
      </div>`;
    document.getElementById("loginBtn").onclick = () => auth.login();
  }

  function showForbiddenGate() {
    app.innerHTML = `
      <div class="bh-gate">
        <p>Вы вошли как «${escapeHtml(user.name || user.username || "")}», но у этого аккаунта
        нет доступа в Админку.</p>
      </div>`;
  }

  // Пробный запрос заодно проверяет доступ (403 → showForbiddenGate).
  try {
    await api("/api/overview");
  } catch (e) {
    if (e instanceof ForbiddenError) return showForbiddenGate();
    if (e.name === "AuthRequiredError") return; // showLoginGate уже вызван внутри api()
    app.innerHTML = `<div class="bh-empty">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
    return;
  }

  // Таймер поллинга статуса скана библиотеки, пока он идёт (см.
  // wireLibraryScan) — один на всё приложение, чистится в render() ниже при
  // уходе со страницы сервиса. Объявлены здесь, а не рядом с
  // renderServiceDetail — на них ссылается render(), который вызывается
  // синхронно из renderShell() ниже, ещё до того, как исполнение дошло бы до
  // объявления этих let дальше по файлу (иначе ReferenceError: temporal dead zone).
  let scanTimer = null;
  // Таймер автообновления логов (см. wireLogs) — так же один на всё
  // приложение и чистится в render() при уходе со страницы сервиса.
  let logTimer = null;

  renderShell();

  /* ---------- маршрутизация по хэшу ---------- */

  function currentRoute() {
    const h = location.hash.replace(/^#/, "");
    if (h.startsWith("service/")) return { view: "service", id: decodeURIComponent(h.slice("service/".length)) };
    if (h === "users") return { view: "users" };
    return { view: "overview" };
  }

  function renderShell() {
    app.innerHTML = `
      <div class="bh-tabs">
        <button class="bh-tab" data-tab="overview">Обзор</button>
        <button class="bh-tab" data-tab="users">Пользователи</button>
      </div>
      <div id="tabBody"></div>
    `;
    const tabs = [...app.querySelectorAll(".bh-tab")];
    const body = document.getElementById("tabBody");
    tabs.forEach(t => t.onclick = () => { location.hash = t.dataset.tab; });

    async function render() {
      // Уходим со страницы сервиса — глушим поллинг скана библиотеки (см.
      // wireLibraryScan), иначе таймер продолжит дёргать api() и писать в
      // #libraryScan, которого уже нет в DOM после следующего innerHTML.
      if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
      if (logTimer) { clearInterval(logTimer); logTimer = null; }
      const route = currentRoute();
      tabs.forEach(t => t.classList.toggle("is-active", t.dataset.tab === (route.view === "service" ? null : route.view)));
      body.innerHTML = `<div class="bh-empty">Загрузка…</div>`;
      try {
        if (route.view === "service") return await renderServiceDetail(body, route.id);
        if (route.view === "users") return await renderUsers(body);
        return await renderOverview(body);
      } catch (e) {
        if (e instanceof ForbiddenError) return showForbiddenGate();
        if (e.name === "AuthRequiredError") return;
        body.innerHTML = `<div class="bh-empty">Ошибка: ${escapeHtml(e.message)}</div>`;
      }
    }
    window.addEventListener("hashchange", render);
    render();
  }

  /* ---------- Обзор ---------- */

  async function renderOverview(body) {
    const data = await api("/api/overview");
    if (!data.services.length) { body.innerHTML = `<div class="bh-empty">Сервисы не настроены (SERVICES_JSON)</div>`; return; }
    body.innerHTML = `<div class="bh-grid">${data.services.map(cardHtml).join("")}</div>`;
  }

  function cardHtml(s) {
    if (!s.ok) {
      return `<a class="bh-card" href="#service/${encodeURIComponent(s.id)}">
        <h3><span class="bh-dot down"></span>${escapeHtml(s.name)}</h3>
        <div class="bh-error">${escapeHtml(s.error)}</div>
      </a>`;
    }
    // Сокращённый список — 5 первых показателей, остальное на странице сервиса.
    const entries = Object.entries(s.stats || {}).filter(([k]) => k !== "ok");
    const rows = entries.slice(0, 5).map(([k, v]) =>
      `<div class="bh-stat-row"><span>${escapeHtml(k)}</span><b>${v === null || v === undefined ? "—" : escapeHtml(String(v))}</b></div>`
    ).join("");
    const more = entries.length > 5 ? `<div class="bh-stat-row"><span>ещё ${entries.length - 5}…</span></div>` : "";
    return `<a class="bh-card" href="#service/${encodeURIComponent(s.id)}">
      <h3><span class="bh-dot ok"></span>${escapeHtml(s.name)}</h3>
      ${rows || '<div class="bh-stat-row"><span>—</span></div>'}${more}
    </a>`;
  }

  /* ---------- Подробности сервиса: статистика + график + комнаты + логи ---------- */

  const ROOM_STATUS = { planning: "в планах", active: "в процессе", done: "завершена" };
  const LOG_RANK = { info: 0, warn: 1, error: 2 };

  async function renderServiceDetail(body, id) {
    let s;
    try {
      s = await api(`/api/services/${encodeURIComponent(id)}/stats`);
    } catch (e) {
      body.innerHTML = `<a class="bh-back" href="#overview">← Обзор</a><div class="bh-empty">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
      return;
    }

    body.innerHTML = `
      <a class="bh-back" href="#overview">← Обзор</a>
      <div class="bh-detail-head">
        <span class="bh-dot ${s.ok ? "ok" : "down"}"></span>
        <h2>${escapeHtml(s.name || id)}</h2>
      </div>
      ${s.ok ? statsAndChartHtml(s.stats) : `<div class="bh-empty">Сервис недоступен: ${escapeHtml(s.error || "")}</div>`}

      <div class="bh-section-title">Комнаты</div>
      <div id="detailRooms"><div class="bh-empty">Загрузка…</div></div>

      <div class="bh-section-title">Библиотека</div>
      <div id="libraryScan"><div class="bh-empty">Загрузка…</div></div>

      <div class="bh-section-title">Логи</div>
      <div class="bh-toolbar">
        <select id="logLevel">
          <option value="">Все уровни</option>
          <option value="warn">Предупреждения и ошибки</option>
          <option value="error">Только ошибки</option>
        </select>
        <button class="bh-btn" id="logRefresh">Обновить</button>
        <label class="bh-check">
          <input type="checkbox" id="logAuto">
          Автообновление
        </label>
        <select id="logAutoInterval">
          <option value="5000">5 с</option>
          <option value="10000" selected>10 с</option>
          <option value="30000">30 с</option>
          <option value="60000">60 с</option>
        </select>
      </div>
      <div class="bh-loglist" id="logList"></div>
    `;

    loadRooms(id);
    wireLibraryScan(id);
    wireLogs(id);
  }

  /** Числовые показатели — горизонтальным графиком, остальное (строки, null) — списком. */
  function statsAndChartHtml(stats) {
    const numeric = Object.entries(stats).filter(([k, v]) => k !== "ok" && typeof v === "number");
    const rest = Object.entries(stats).filter(([k, v]) => k !== "ok" && typeof v !== "number");
    const max = Math.max(1, ...numeric.map(([, v]) => v));

    const chart = numeric.length ? `<div class="bh-chart">${numeric.map(([k, v]) => `
      <div class="bh-chart-row">
        <span class="label">${escapeHtml(k)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, Math.round(v / max * 100))}%"></span></span>
        <span class="value">${escapeHtml(String(v))}</span>
      </div>`).join("")}</div>` : "";

    const restRows = rest.map(([k, v]) =>
      `<div class="bh-stat-row"><span>${escapeHtml(k)}</span><b>${v === null || v === undefined ? "—" : escapeHtml(String(v))}</b></div>`
    ).join("");
    const restCard = restRows ? `<div class="bh-card">${restRows}</div>` : "";

    return chart + restCard;
  }

  async function loadRooms(id) {
    const el = document.getElementById("detailRooms");
    try {
      const data = await api(`/api/services/${encodeURIComponent(id)}/rooms`);
      const rooms = data.rooms || [];
      if (!rooms.length) { el.innerHTML = `<div class="bh-empty">Пусто</div>`; return; }
      const rows = rooms.map(r => `
        <tr>
          <td>${escapeHtml(r.title || "—")}</td>
          <td>${escapeHtml(r.destination || "—")}</td>
          <td>${escapeHtml(ROOM_STATUS[r.status] || r.status || "—")}</td>
          <td>${r.membersCount}</td>
          <td>${r.placesCount}</td>
          <td>${r.joinCode ? `<code>${escapeHtml(r.joinCode)}</code>` : "—"}</td>
          <td>${new Date(r.createdAt).toLocaleDateString("ru-RU")}</td>
        </tr>`).join("");
      el.innerHTML = `
        <table class="bh-table">
          <thead><tr><th>Название</th><th>Направление</th><th>Статус</th><th>Участники</th><th>Мест</th><th>Код</th><th>Создана</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch {
      // Обычно значит, что у сервиса просто нет /internal/rooms (пока — только у Trip).
      el.innerHTML = `<div class="bh-empty">Не поддерживается этим сервисом</div>`;
    }
  }

  /** Расширение библиотеки диапазоном kinopoisk_id (сейчас есть только у
      Movies, см. её server.js) — форма запуска/остановки + прогресс, который
      сам себя переопрашивает раз в 5с, пока скан идёт (см. scanTimer). */
  const SCAN_STATUS = {
    idle: "не запускался", running: "идёт", paused_quota: "пауза — дневная квота исчерпана",
    done: "готово", stopped: "остановлен",
  };

  function libraryScanProgressHtml(data) {
    const total = data.toId != null ? data.toId - data.fromId + 1 : 0;
    const passed = data.status !== "idle" ? Math.min(data.nextId - data.fromId, total) : 0;
    const rows = data.status !== "idle" ? `
      <div class="bh-stat-row"><span>Диапазон</span><b>${data.fromId}–${data.toId}</b></div>
      <div class="bh-stat-row"><span>Статус</span><b>${escapeHtml(SCAN_STATUS[data.status] || data.status)}</b></div>
      <div class="bh-stat-row"><span>Пройдено</span><b>${passed} / ${total}</b></div>
      <div class="bh-stat-row"><span>Добавлено</span><b>${data.added}</b></div>
      <div class="bh-stat-row"><span>Уже были в кэше</span><b>${data.cached}</b></div>
      <div class="bh-stat-row"><span>Не найдено</span><b>${data.notFound}</b></div>
      <div class="bh-stat-row"><span>Ошибок</span><b>${data.errors}</b></div>
    ` : "";
    return rows + `<div class="bh-stat-row"><span>Квота на скан/импорт сегодня</span><b>${escapeHtml(data.apiUsage)}</b></div>`;
  }

  async function wireLibraryScan(id) {
    const el = document.getElementById("libraryScan");
    // Форма строится один раз, дальше поллинг (см. poll ниже) обновляет
    // только #scanProgress — если перерисовывать весь блок целиком каждые 5с,
    // это стирало бы то, что админ как раз набирает в scanFrom/scanTo для
    // следующего запуска.
    el.innerHTML = `
      <div class="bh-card" id="scanProgress"><div class="bh-empty">Загрузка…</div></div>
      <div class="bh-toolbar">
        <input type="number" class="bh-input-narrow" id="scanFrom" placeholder="От id" min="1">
        <input type="number" class="bh-input-narrow" id="scanTo" placeholder="До id" min="1">
        <button class="bh-btn" id="scanStart">Запустить</button>
        <button class="bh-btn danger" id="scanStop" disabled>Остановить</button>
      </div>
    `;
    const progressEl = document.getElementById("scanProgress");
    const stopBtn = document.getElementById("scanStop");
    let last = null; // последний известный статус — для confirm() при перезапуске

    async function poll() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/library/scan`);
      } catch {
        // Как и с комнатами — сервис просто не реализует /internal/library/scan.
        el.innerHTML = `<div class="bh-empty">Не поддерживается этим сервисом</div>`;
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
        return;
      }
      last = data;
      progressEl.innerHTML = libraryScanProgressHtml(data);
      const running = data.status === "running";
      stopBtn.disabled = !running;
      // Поллинг только пока реально что-то происходит — «готово»/«остановлен»/
      // «пауза на квоте» сами по себе не изменятся без нового запуска.
      if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
      if (running) scanTimer = setInterval(poll, 5000);
    }

    document.getElementById("scanStart").onclick = async () => {
      const from = parseInt(document.getElementById("scanFrom").value, 10);
      const to = parseInt(document.getElementById("scanTo").value, 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
        alert("Нужны целые kinopoisk_id, «от» ≤ «до».");
        return;
      }
      if (last && last.status === "running" && !confirm(`Скан уже идёт (${last.fromId}–${last.toId}). Запустить новый диапазон ${from}–${to}? Прогресс текущего скана потеряется.`)) return;
      try {
        await api(`/api/services/${encodeURIComponent(id)}/library/scan`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to }),
        });
        await poll();
      } catch (e) { alert("Не получилось: " + e.message); }
    };
    document.getElementById("scanStop").onclick = async () => {
      try { await api(`/api/services/${encodeURIComponent(id)}/library/scan/stop`, { method: "POST" }); await poll(); }
      catch (e) { alert("Не получилось: " + e.message); }
    };

    await poll();
  }

  function logLineHtml(l) {
    const ts = new Date(l.ts).toLocaleString("ru-RU");
    const meta = l.meta ? " " + JSON.stringify(l.meta) : "";
    return `<div class="bh-logline ${escapeHtml(l.level)}"><span class="ts">${ts}</span><span class="lvl">${escapeHtml(l.level)}</span><span class="msg">${escapeHtml(l.message)}${escapeHtml(meta)}</span></div>`;
  }

  function wireLogs(id) {
    const lvlSel = document.getElementById("logLevel");
    const list = document.getElementById("logList");
    const autoBox = document.getElementById("logAuto");
    const intervalSel = document.getElementById("logAutoInterval");

    async function load() {
      list.innerHTML = `<div class="bh-empty">Загрузка…</div>`;
      try {
        const data = await api(`/api/services/${encodeURIComponent(id)}/logs?limit=200`);
        let logs = data.logs || [];
        if (lvlSel.value) logs = logs.filter(l => LOG_RANK[l.level] >= LOG_RANK[lvlSel.value]);
        list.innerHTML = logs.length ? logs.map(logLineHtml).join("") : `<div class="bh-empty">Пусто</div>`;
      } catch (e) {
        list.innerHTML = `<div class="bh-empty">Ошибка: ${escapeHtml(e.message)}</div>`;
      }
    }
    // Автообновление — тот же принцип, что и в wireLibraryScan: один общий
    // logTimer, перезапускаем при смене чекбокса/интервала, глушим в render()
    // при уходе со страницы сервиса.
    function restartAuto() {
      if (logTimer) { clearInterval(logTimer); logTimer = null; }
      if (autoBox.checked) logTimer = setInterval(load, parseInt(intervalSel.value, 10));
    }
    lvlSel.onchange = load;
    document.getElementById("logRefresh").onclick = load;
    autoBox.onchange = restartAuto;
    intervalSel.onchange = restartAuto;
    load();
  }

  /* ---------- Пользователи ---------- */

  async function renderUsers(body) {
    const data = await api("/api/users");
    const rows = (data.users || []).map(u => `
      <tr data-id="${escapeHtml(u.id)}" data-username="${escapeHtml(u.username)}">
        <td>${escapeHtml(u.username)}${u.id === user.id ? ' <span class="bh-badge">это вы</span>' : ""}</td>
        <td>${escapeHtml(u.email || "—")}</td>
        <td>${u.admin ? '<span class="bh-badge admin">админ</span>' : ""}${u.disabled ? ' <span class="bh-badge disabled">заблокирован</span>' : ""}</td>
        <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString("ru-RU") : "—"}</td>
        <td>${u.lastSeen ? new Date(u.lastSeen).toLocaleString("ru-RU") : "никогда"}</td>
        <td>
          <button class="bh-btn" data-action="admin" data-on="${u.admin ? "0" : "1"}" ${u.id === user.id ? "disabled" : ""}>${u.admin ? "Забрать доступ" : "Сделать админом"}</button>
          <button class="bh-btn" data-action="disabled" data-on="${u.disabled ? "0" : "1"}" ${u.id === user.id ? "disabled" : ""}>${u.disabled ? "Разблокировать" : "Заблокировать"}</button>
          <button class="bh-btn danger" data-action="logout-all">Разлогинить</button>
          <button class="bh-btn danger" data-action="delete" ${u.id === user.id ? "disabled" : ""}>Удалить</button>
        </td>
      </tr>`).join("");

    body.innerHTML = rows
      ? `<table class="bh-table"><thead><tr><th>Логин</th><th>Почта</th><th>Статус</th><th>Регистрация</th><th>Активность</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="bh-empty">Пользователей нет</div>`;

    // Удаление безвозвратно и задевает данные во всех сервисах сразу — обычного
    // confirm() мало. Как и у самих пользователей в кабинете BurningHouse
    // (см. Auth/INTEGRATION.md), подтверждение — набрать логин вручную.
    body.querySelectorAll("button[data-action='delete']").forEach(btn => {
      btn.onclick = async () => {
        const tr = btn.closest("tr");
        const id = tr.dataset.id;
        const username = tr.dataset.username;
        const typed = prompt(`Это удалит аккаунт «${username}» безвозвратно — данные в Auth, привязка к остальным сервисам не восстановить.\nНаберите логин «${username}», чтобы подтвердить:`);
        if (typed === null) return;
        if (typed !== username) { alert("Логин введён неверно — отменено."); return; }

        tr.querySelectorAll("button").forEach(b => b.disabled = true);
        try {
          await api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
          renderUsers(body);
        } catch (e) {
          alert("Не получилось: " + e.message);
          tr.querySelectorAll("button").forEach(b => b.disabled = false);
        }
      };
    });

    body.querySelectorAll("button[data-action]:not([data-action='delete'])").forEach(btn => {
      btn.onclick = async () => {
        const tr = btn.closest("tr");
        const id = tr.dataset.id;
        const action = btn.dataset.action;
        const on = btn.dataset.on === "1";
        const label = {
          admin: on ? "выдать доступ в Админку" : "забрать доступ в Админку",
          disabled: on ? "заблокировать вход" : "разблокировать вход",
          "logout-all": "разлогинить на всех устройствах",
        }[action];
        if (!confirm(`Точно ${label}?`)) return;

        tr.querySelectorAll("button").forEach(b => b.disabled = true);
        try {
          const init = action === "logout-all"
            ? { method: "POST" }
            : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) };
          await api(`/api/users/${encodeURIComponent(id)}/${action}`, init);
          renderUsers(body);
        } catch (e) {
          alert("Не получилось: " + e.message);
          tr.querySelectorAll("button").forEach(b => b.disabled = false);
        }
      };
    });
  }
})();
