"use strict";
/**
 * Фронт админки. Никакого фреймворка — как и в остальных сервисах
 * BurningHouse, обычный DOM и fetch. Кто админ, фронт не решает сам: он
 * просто дёргает защищённый /api/overview и по 403 понимает, что доступа нет
 * (см. Auth/INTEGRATION.md — claim admin проверяется на бэкенде, не на фронте).
 *
 * Навигация — хэш, как у Movies/Trip ("SPA с маршрутизацией по хэшу"):
 *   #overview            — сетка карточек сервисов (по умолчанию)
 *   #users               — управление пользователями
 *   #service/<id>/<tab>  — подробности одного сервиса: статистика (всегда
 *                           видна) + подвкладки rooms/library/logs
 *                           (см. DETAIL_TABS) — раньше все три шли одним
 *                           длинным списком на странице сервиса, но когда у
 *                           Movies под «Библиотекой» набралось пять разных
 *                           инструментов, читать это стало неудобно.
 *                           <tab> необязателен и по умолчанию — rooms.
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
  // Список подвкладок страницы сервиса (см. renderServiceDetail) — тоже
  // нужен ДО renderShell(): на него ссылается currentRoute(), которую
  // render() вызывает синхронно при первом заходе, ещё до объявления
  // const дальше по файлу.
  const DETAIL_TABS = ["rooms", "library", "logs"];

  renderShell();

  /* ---------- маршрутизация по хэшу ---------- */

  function currentRoute() {
    const h = location.hash.replace(/^#/, "");
    if (h.startsWith("service/")) {
      const rest = decodeURIComponent(h.slice("service/".length));
      const slash = rest.indexOf("/");
      const id = slash === -1 ? rest : rest.slice(0, slash);
      const tab = slash === -1 ? "" : rest.slice(slash + 1);
      return { view: "service", id, tab: DETAIL_TABS.includes(tab) ? tab : "rooms" };
    }
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
        if (route.view === "service") return await renderServiceDetail(body, route.id, route.tab);
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

  const DETAIL_TAB_LABELS = { rooms: "Комнаты", library: "Библиотека", logs: "Логи" };

  /** Подробности сервиса теперь на подвкладках (#service/<id>/<tab>) — у
      Movies под «Библиотекой» скопилось пять разных инструментов (скан,
      очередь докачки, ключи poiskkino, импорт подборок, удаление фильма),
      и держать их вперемешку со статистикой/комнатами/логами одним долгим
      списком стало неудобно читать. Статистика — единственное, что видно
      всегда: это общая сводка по сервису, а не часть какого-то одного
      инструмента. */
  async function renderServiceDetail(body, id, tab) {
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

      <div class="bh-tabs bh-subtabs">
        ${DETAIL_TABS.map(t => `<a class="bh-tab ${t === tab ? "is-active" : ""}" href="#service/${encodeURIComponent(id)}/${t}">${DETAIL_TAB_LABELS[t]}</a>`).join("")}
      </div>
      <div id="detailTabBody"></div>
    `;

    const tabBody = document.getElementById("detailTabBody");
    if (tab === "rooms") {
      tabBody.innerHTML = `<div id="detailRooms"><div class="bh-empty">Загрузка…</div></div>`;
      loadRooms(id);
    } else if (tab === "library") {
      tabBody.innerHTML = `
        <div class="bh-section-title">Скан по kinopoisk_id</div>
        <div id="libraryScan"><div class="bh-empty">Загрузка…</div></div>

        <div class="bh-section-title">Очередь докачки деталей</div>
        <div id="detailQueue"></div>

        <div class="bh-section-title">Ключи poiskkino.dev</div>
        <div id="poiskkinoKeys"></div>

        <div class="bh-section-title">Импорт подборки Кинопоиска</div>
        <div id="collectionImport"></div>

        <div class="bh-section-title">Удаление фильма</div>
        <div id="movieDelete"></div>
      `;
      wireLibraryScan(id);
      loadDetailQueue(id);
      loadPoiskkinoKeys(id);
      wireCollectionImport(id);
      wireMovieDelete(id);
    } else {
      tabBody.innerHTML = `
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
      wireLogs(id);
    }
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

  /** Очередь докачки деталей фильмов, добавленных расширением импорта без
      квоты (см. Movies server.js /internal/movies/detail-queue) — видимость
      + ручное «Обновить»: очередь тикает раз в 15 минут сама по себе (см.
      drainMovieDetailQueue), гонять автополлинг под этот темп смысла нет
      (как у скана библиотеки, где реально что-то меняется каждые
      секунды) — но без кнопки счётчик выглядел бы «зависшим» до перезахода
      на страницу целиком, а после этой правки в Movies тот же вопрос уже
      закрыт логами (см. «Логи» ниже — «Очередь деталей: ждёт квоту» / «…
      докатил партию» на каждый тик). */
  async function loadDetailQueue(id) {
    const el = document.getElementById("detailQueue");
    async function render() {
      try {
        const data = await api(`/api/services/${encodeURIComponent(id)}/movies/detail-queue`);
        el.innerHTML = `
          <div class="bh-card">
            <div class="bh-stat-row"><span>Очередь докачки деталей</span><b>${data.pending}</b></div>
            ${data.pending ? `<div class="bh-stat-row"><span>Старейшая заявка</span><b>${new Date(data.oldestRequestedAt).toLocaleString("ru-RU")}</b></div>` : ""}
            <div class="bh-stat-row"><span>Квота на скан/импорт сегодня</span><b>${escapeHtml(data.apiUsage)}</b></div>
          </div>
          <div class="bh-toolbar">
            <button class="bh-btn" id="detailQueueRefresh">Обновить</button>
          </div>`;
        document.getElementById("detailQueueRefresh").onclick = render;
      } catch {
        // Как и с комнатами — сервис просто не реализует /internal/movies/detail-queue.
        el.innerHTML = "";
      }
    }
    await render();
  }

  /** Расход квоты по каждому ключу poiskkino.dev отдельно (см. Movies
      server.js /internal/poiskkino/keys) — несколько ключей через запятую
      в POISKKINO_API_KEY, сервис сам переключается на следующий при
      исчерпании текущего (см. poiskkino.js). Только видимость, тем же
      принципом, что у loadDetailQueue/loadRooms — один запрос при заходе на
      страницу плюс ручное «Обновить», без автополлинга. Значения самих
      ключей сервис не отдаёт вовсе — тут только индекс и счётчики.
      k.live — настоящие цифры от САМОГО provider'а (GET /v1.5/token, лимит
      не тратит), k.calls/k.cap — наша локальная оценка (может отличаться от
      реального тарифа ключа, отсюда и live рядом: раньше только по локальной
      оценке казалось, что запас есть, а provider уже отвечал 403). Если
      live не пришёл (k.liveError) — ключ невалиден или provider недоступен
      прямо сейчас, показываем сообщение вместо цифр. */
  async function loadPoiskkinoKeys(id) {
    const el = document.getElementById("poiskkinoKeys");
    async function render() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/poiskkino/keys`);
      } catch {
        // Сервис просто не реализует /internal/poiskkino/keys.
        el.innerHTML = "";
        return;
      }
      if (!data.enabled || !data.keys.length) { el.innerHTML = ""; return; }
      const rows = data.keys.map(k => {
        const live = k.live;
        const exhausted = live ? live.requestsRemaining <= 0 : k.calls >= k.cap;
        const resetAt = live && (live.resetAt || live.ttl != null)
          ? new Date(live.resetAt || (Date.now() + live.ttl * 1000)).toLocaleString("ru-RU")
          : null;
        const liveLine = live
          ? `<div class="bh-stat-row"><span>У provider'а</span><b>${live.requestsUsed}/${live.requestsLimit}${resetAt ? `, сброс ${escapeHtml(resetAt)}` : ""}</b></div>`
          : `<div class="bh-stat-row"><span>У provider'а</span><span>${k.liveError ? `не удалось проверить: ${escapeHtml(k.liveError)}` : "—"}</span></div>`;
        return `
          <div class="bh-stat-row"><span>Ключ ${k.index + 1}${exhausted ? " — исчерпан" : ""}</span><b>наша оценка ${k.calls}/${k.cap}</b></div>
          ${liveLine}`;
      }).join("<hr style=\"border-color:var(--card-border);margin:.4rem 0\">");
      el.innerHTML = `
        <div class="bh-card">${rows}</div>
        <div class="bh-toolbar">
          <button class="bh-btn" id="poiskkinoKeysRefresh">Обновить</button>
        </div>`;
      document.getElementById("poiskkinoKeysRefresh").onclick = render;
    }
    await render();
  }

  /** Удаление фильма из библиотеки по kinopoisk_id (сейчас есть только у
      Movies, см. её server.js /internal/movies/:id) — «Найти» показывает
      название и счётчики использования ПЕРЕД удалением: и чтобы админ не
      удалял вслепую по голому id, и потому что сам сервис откажет (409),
      если фильм где-то используется (в очереди/истории комнаты, у кого-то
      оценён, лежит в чьём-то личном списке) — тут это видно заранее, а не
      только из текста ошибки. */
  async function wireMovieDelete(id) {
    const el = document.getElementById("movieDelete");
    el.innerHTML = `
      <div class="bh-toolbar">
        <input type="number" class="bh-input-narrow" id="movieDeleteId" placeholder="kinopoisk_id" min="1">
        <button class="bh-btn" id="movieDeleteFind">Найти</button>
      </div>
      <div class="bh-card" id="movieDeleteResult" hidden></div>
    `;
    const resultEl = document.getElementById("movieDeleteResult");

    document.getElementById("movieDeleteFind").onclick = async () => {
      const kpId = parseInt(document.getElementById("movieDeleteId").value, 10);
      if (!Number.isFinite(kpId) || kpId < 1) { alert("Нужен целый kinopoisk_id."); return; }
      resultEl.hidden = false;
      resultEl.innerHTML = `<div class="bh-empty">Загрузка…</div>`;
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/movies/${kpId}`);
      } catch (e) {
        resultEl.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      const u = data.usage || { rooms: 0, marks: 0, personalList: 0 };
      const inUse = u.rooms > 0 || u.marks > 0 || u.personalList > 0;
      resultEl.innerHTML = `
        <div class="bh-stat-row"><span>Фильм</span><b>${escapeHtml(data.title || "—")}${data.year ? " (" + data.year + ")" : ""}</b></div>
        <div class="bh-stat-row"><span>В очередях/истории комнат</span><b>${u.rooms}</b></div>
        <div class="bh-stat-row"><span>Оценок/просмотров</span><b>${u.marks}</b></div>
        <div class="bh-stat-row"><span>В личных списках</span><b>${u.personalList}</b></div>
        ${inUse ? `<div class="bh-error">Используется — сначала уберите из комнат/списков, потом удаляйте.</div>` : ""}
        <div class="bh-toolbar" style="margin-bottom:0;margin-top:.6rem">
          <button class="bh-btn danger" id="movieDeleteBtn" ${inUse ? "disabled" : ""}>Удалить из библиотеки</button>
        </div>
      `;
      document.getElementById("movieDeleteBtn").onclick = async () => {
        if (!confirm(`Удалить «${data.title}»${data.year ? " (" + data.year + ")" : ""} из библиотеки? Действие необратимо.`)) return;
        try {
          await api(`/api/services/${encodeURIComponent(id)}/movies/${kpId}`, { method: "DELETE" });
          resultEl.hidden = true;
          document.getElementById("movieDeleteId").value = "";
        } catch (e) {
          alert("Не получилось: " + e.message);
        }
      };
    };
  }

  /** Импорт подборки Кинопоиска целиком в библиотеку (см. Movies server.js
      /internal/collections/import — POST собирает список подборки
      синхронно, детали каждого фильма докатываются фоном через уже
      существующую очередь деталей, см. её виджет выше). Список уже
      импортированных — снизу, с удалением (саму группировку, фильмы из
      библиотеки не трогает — см. подсказку у кнопки). */
  async function wireCollectionImport(id) {
    const el = document.getElementById("collectionImport");
    el.innerHTML = `
      <div class="bh-toolbar">
        <input type="text" class="bh-input-narrow" id="collectionImportSlug" placeholder="slug, напр. top250">
        <button class="bh-btn" id="collectionImportBtn">Импортировать с Кинопоиска</button>
      </div>
      <div id="collectionImportResult"></div>
      <div id="collectionsListBox"><div class="bh-empty">Загрузка…</div></div>
    `;
    const resultEl = document.getElementById("collectionImportResult");
    const listBox = document.getElementById("collectionsListBox");

    async function loadList() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/collections`);
      } catch (e) {
        listBox.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      const rows = data.collections || [];
      if (!rows.length) { listBox.innerHTML = `<div class="bh-empty">Пока ничего не импортировано</div>`; return; }
      listBox.innerHTML = `
        <table class="bh-table">
          <thead><tr><th>Название</th><th>Slug</th><th>Источник</th><th>Фильмов</th><th>Обновлено</th><th></th></tr></thead>
          <tbody>${rows.map(c => `
            <tr data-id="${escapeHtml(c.id)}">
              <td>${escapeHtml(c.name)}</td>
              <td><code>${escapeHtml(c.slug)}</code></td>
              <td>${c.source === "kinopoisk" ? "Кинопоиск" : "Своя"}</td>
              <td>${c.moviesCount}</td>
              <td>${new Date(c.updatedAt).toLocaleDateString("ru-RU")}</td>
              <td><button class="bh-btn danger" data-action="delete">Удалить</button></td>
            </tr>`).join("")}</tbody>
        </table>`;
      listBox.querySelectorAll("button[data-action='delete']").forEach(btn => {
        btn.onclick = async () => {
          const tr = btn.closest("tr");
          const cid = tr.dataset.id;
          const name = tr.querySelector("td").textContent;
          if (!confirm(`Удалить подборку «${name}» из библиотеки? Сами фильмы останутся в кэше, удаляется только группировка.`)) return;
          try {
            await api(`/api/services/${encodeURIComponent(id)}/collections/${encodeURIComponent(cid)}`, { method: "DELETE" });
            await loadList();
          } catch (e) { alert("Не получилось: " + e.message); }
        };
      });
    }

    document.getElementById("collectionImportBtn").onclick = async () => {
      const slug = document.getElementById("collectionImportSlug").value.trim();
      if (!slug) { alert("Укажите slug подборки — например top250."); return; }
      resultEl.innerHTML = `<div class="bh-empty">Импортирую…</div>`;
      try {
        const data = await api(`/api/services/${encodeURIComponent(id)}/collections/import`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }),
        });
        resultEl.innerHTML = `
          <div class="bh-card">
            ${data.partial ? `<div class="bh-stat-row" style="color:var(--warn)">Квота кончилась раньше срока — собрана только часть подборки. Запустите импорт того же slug ещё раз позже, когда квота освободится, чтобы дособрать остальное.</div>` : ""}
            <div class="bh-stat-row"><span>${escapeHtml(data.name)}</span><b>${data.moviesCount} фильмов${data.partial ? " (частично)" : ""}</b></div>
            ${data.skipped > 0 ? `<div class="bh-stat-row" style="color:var(--warn)"><span>Пропущено (кривые данные у Кинопоиска)</span><b>${data.skipped}</b></div>` : ""}
            <div class="bh-stat-row"><span>Уже были детали</span><b>${data.alreadyCached}</b></div>
            <div class="bh-stat-row"><span>Поставлено в очередь докачки</span><b>${data.queued}</b></div>
          </div>`;
        document.getElementById("collectionImportSlug").value = "";
        await loadList();
      } catch (e) {
        resultEl.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
      }
    };

    await loadList();
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
