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
  const DETAIL_TABS = ["rooms", "library", "import", "moderation", "logs"];

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
    body.innerHTML = `<div id="healthBanner"></div><div class="bh-grid">${data.services.map(cardHtml).join("")}</div>`;
    wireHealthBanner();
  }

  /** Баннер health-check (см. Admin/server.js runHealthCheck) — раз в час
      сервер сам проверяет доступность всех сервисов и шлёт письмо админам,
      если кто-то не отвечает; тут просто показываем то же состояние и даём
      кнопки «Проверить сейчас» / отметить проблему известной. Отметка не
      снимается сама при восстановлении сервиса — так и просили: письма
      возобновляются только когда админ явно снимет отметку. */
  async function wireHealthBanner() {
    const el = document.getElementById("healthBanner");
    if (!el) return; // ушли со страницы, пока грузилось

    async function load() {
      let state;
      try {
        state = await api("/api/health-check");
      } catch {
        el.innerHTML = ""; // необязательная фича — молча не показываем баннер, если ручка недоступна
        return;
      }
      const down = (state.lastResults || []).filter(r => !r.ok);
      const checkedAt = state.lastCheckAt ? new Date(state.lastCheckAt).toLocaleString("ru-RU") : null;

      const ackBtnHtml = down.length
        ? `<button class="bh-btn ${state.acknowledged ? "" : "danger"}" id="healthAckBtn">${state.acknowledged ? "Возобновить оповещения" : "Отметить как известную проблему"}</button>`
        : (state.acknowledged ? `<button class="bh-btn" id="healthAckBtn">Снять отметку «известная проблема»</button>` : "");

      let banner = "";
      if (down.length) {
        const list = down.map(d => `${escapeHtml(d.name)} — ${escapeHtml(d.error || "недоступен")}`).join("; ");
        banner = state.acknowledged
          ? `<div class="bh-alert">Известная проблема (письма приостановлены): ${list}. Отметил ${escapeHtml(state.acknowledgedBy || "—")} ${state.acknowledgedAt ? new Date(state.acknowledgedAt).toLocaleString("ru-RU") : ""}.</div>`
          : `<div class="bh-alert danger">Недоступны: ${list}</div>`;
      } else if (state.acknowledged) {
        banner = `<div class="bh-alert">Все сервисы отвечают, но отметка «известная проблема» всё ещё стоит — можно снять.</div>`;
      }

      el.innerHTML = `
        ${banner}
        <div class="bh-toolbar" style="margin-top:${banner ? ".5rem" : "0"}">
          ${ackBtnHtml}
          <button class="bh-btn" id="healthRunBtn">Проверить сейчас</button>
          <span class="bh-empty" style="padding:0">${checkedAt ? `Проверено: ${checkedAt}` : "Ещё не проверялось"}</span>
        </div>
      `;

      const ackBtn = document.getElementById("healthAckBtn");
      if (ackBtn) ackBtn.onclick = async () => {
        ackBtn.disabled = true;
        try {
          await api("/api/health-check/acknowledge", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: !state.acknowledged }),
          });
          await load();
        } catch (e) { alert("Не получилось: " + e.message); ackBtn.disabled = false; }
      };
      document.getElementById("healthRunBtn").onclick = async () => {
        const btn = document.getElementById("healthRunBtn");
        btn.disabled = true;
        btn.textContent = "Проверяю…";
        try { await api("/api/health-check/run", { method: "POST" }); await load(); }
        catch (e) { alert("Не получилось: " + e.message); btn.disabled = false; btn.textContent = "Проверить сейчас"; }
      };
    }

    await load();
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

  const DETAIL_TAB_LABELS = { rooms: "Комнаты", library: "Библиотека", import: "Импорт", moderation: "Модерация", logs: "Логи" };

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
    } else if (tab === "library" && id === "movies") {
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
    } else if (tab === "library" && id === "puzzle") {
      tabBody.innerHTML = `<div id="puzzleUpload"></div>`;
      wirePuzzleLibrary(id, s.baseUrl);
    } else if (tab === "library") {
      // У остальных сервисов своих инструментов «Библиотеки» пока нет — тот
      // же принцип, что у «Комнат» без /internal/rooms: пусто, а не ошибка.
      tabBody.innerHTML = `<div class="bh-empty">У этого сервиса нет инструментов библиотеки</div>`;
    } else if (tab === "moderation" && id === "puzzle") {
      tabBody.innerHTML = `
        <div class="bh-section-title">Фото в комнатах — на проверке</div>
        <div id="roomUploadQueue"><div class="bh-empty">Загрузка…</div></div>
        <div class="bh-section-title">Заявки на публикацию</div>
        <div id="moderationQueue"><div class="bh-empty">Загрузка…</div></div>
        <div class="bh-section-title">Категории на модерации</div>
        <div id="categoryModerationQueue"><div class="bh-empty">Загрузка…</div></div>
      `;
      wireRoomUploadQueue(id, s.baseUrl);
      wireModerationQueue(id, s.baseUrl);
      wireCategoryModerationQueue(id);
    } else if (tab === "moderation") {
      tabBody.innerHTML = `<div class="bh-empty">У этого сервиса нет модерации контента</div>`;
    } else if (tab === "import" && id === "puzzle") {
      tabBody.innerHTML = `<div id="pexelsImport"></div>`;
      wirePexelsImport(id);
    } else if (tab === "import") {
      tabBody.innerHTML = `<div class="bh-empty">У этого сервиса нет импорта из внешних источников</div>`;
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

  /** Добавление картинок в библиотеку Puzzle (см. её server.js
      /internal/puzzles, README «Загрузка через Admin») — новые дефолтные
      пазлы, доступные без входа, наравне со стартовыми. Файл шлём как base64
      внутри JSON (не FormData/multipart): callService всегда JSON.stringify'ит
      body, а поднимать бинарный проброс под один этот вызов не стали (см.
      комментарий у callService выше и в Puzzle README). Ширину/высоту берём
      из реального изображения (new Image()), не только из File — нужны для
      того, чтобы сетка деталей получилась примерно квадратной, а не как
      попало (см. gridForPieceTarget в Puzzle server.js). */
  /** Категории (см. план «Категории пазлов в библиотеке») — общий список,
      переиспользуется и в форме загрузки (выбор при добавлении), и в
      таблице уже добавленных картинок (смена категории задним числом,
      иначе три стартовые и всё загруженное раньше этого захода навсегда
      остались бы без категории). categories — замыкание, актуализируется
      после каждого создания/удаления, обе таблицы просто перерисовываются
      заново, без точечных патчей DOM — картинок и категорий немного,
      сложность не окупается. */
  async function wirePuzzleLibrary(id, baseUrl) {
    const el = document.getElementById("puzzleUpload");
    el.innerHTML = `
      <div class="bh-section-title">Категории</div>
      <div class="bh-toolbar">
        <input type="text" class="bh-input-narrow" id="categoryCreateName" placeholder="Название категории (люди видят это)">
        <input type="text" class="bh-input-narrow" id="categoryCreateSlug" placeholder="Алиас — необязательно (в пути, напр. cats)" style="width:14em">
        <button class="bh-btn" id="categoryCreateBtn">Создать</button>
      </div>
      <div id="categoryListBox"></div>

      <div class="bh-section-title">Добавить картинку в библиотеку</div>
      <div class="bh-toolbar">
        <input type="text" class="bh-input-narrow" id="puzzleUploadTitle" placeholder="Название">
        <input type="file" id="puzzleUploadFile" accept="image/png,image/jpeg,image/webp">
        <button class="bh-btn" id="puzzleUploadBtn">Добавить в библиотеку</button>
      </div>
      <div id="puzzleUploadCategories" style="margin:.4rem 0"></div>
      <div id="puzzleUploadResult"></div>
      <div class="bh-toolbar">
        <input type="text" class="bh-input-narrow" id="puzzleFilterSearch" placeholder="Поиск по названию" style="width:12em">
        <select id="puzzleFilterCategory"><option value="">Все категории</option></select>
      </div>
      <div id="puzzleListBox"><div class="bh-empty">Загрузка…</div></div>
    `;
    const resultEl = document.getElementById("puzzleUploadResult");
    const listBox = document.getElementById("puzzleListBox");
    const categoryListBox = document.getElementById("categoryListBox");
    const uploadCategoriesBox = document.getElementById("puzzleUploadCategories");
    const filterSearchInput = document.getElementById("puzzleFilterSearch");
    const filterCategorySelect = document.getElementById("puzzleFilterCategory");

    // Категория стала many-to-many (см. план «Категории many-to-many,
    // автор карточки, профиль») — везде, где раньше был одиночный <select>,
    // теперь группа чекбоксов. Пикеры (форма загрузки, строка таблицы)
    // предлагают только approved категории — pending/rejected админ видит
    // только в списке управления ниже, привязывать картинку к ним отсюда
    // нельзя (approved решается через отдельную модерацию категорий).
    let categories = [];

    function categoryCheckboxesHtml(name, selectedIds) {
      const approved = categories.filter(c => c.status === "approved");
      if (!approved.length) return `<div class="bh-empty">Нет ни одной категории</div>`;
      return approved.map(c => `
        <label style="display:inline-flex;align-items:center;gap:.3em;margin:0 .8em .3em 0">
          <input type="checkbox" name="${name}" value="${escapeHtml(c.id)}" ${selectedIds.includes(c.id) ? "checked" : ""}>
          ${escapeHtml(c.name)}
        </label>`).join("");
    }

    async function loadCategories() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/categories`);
      } catch (e) {
        categoryListBox.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      categories = data.categories || [];
      uploadCategoriesBox.innerHTML = categoryCheckboxesHtml("puzzleUploadCategory", []);
      // slug — технический алиас (см. план «Алиас и публичное название
      // категории»): люди на странице видят name, slug идёт только в путь
      // (/category/:slug) — тут показываем оба, moderate-серым, чтобы не
      // спорил визуально с самим названием.
      categoryListBox.innerHTML = categories.length
        ? categories.map(c => `
            <span class="bh-badge${c.status !== "approved" ? " " + c.status : ""}" data-id="${escapeHtml(c.id)}" style="display:inline-flex;align-items:center;gap:.4em;margin:.2em .3em .2em 0">
              ${escapeHtml(c.name)}${c.status !== "approved" ? ` (${c.status === "pending" ? "на модерации" : "отклонена"})` : ""}
              <span style="font-family:monospace;font-size:.85em;opacity:.7">/${escapeHtml(c.slug || "")}</span>
              <button class="bh-btn" data-action="edit-category" style="padding:.1em .5em" title="Изменить название/алиас">✎</button>
              <button class="bh-btn danger" data-action="delete-category" style="padding:.1em .5em">×</button>
            </span>`).join("")
        : `<div class="bh-empty">Пока нет ни одной категории</div>`;
      categoryListBox.querySelectorAll("button[data-action='edit-category']").forEach(btn => {
        btn.onclick = async () => {
          const cid = btn.closest("span").dataset.id;
          const cat = categories.find(x => x.id === cid);
          if (!cat) return;
          const newName = prompt("Название категории (видят люди на странице):", cat.name);
          if (newName === null) return; // отмена
          const newSlug = prompt("Алиас (технический, идёт в путь /category/…):", cat.slug || "");
          if (newSlug === null) return;
          const body = {};
          if (newName.trim() && newName.trim() !== cat.name) body.name = newName.trim();
          if (newSlug.trim() && newSlug.trim() !== cat.slug) body.slug = newSlug.trim();
          if (!Object.keys(body).length) return; // ничего не поменяли
          try {
            await api(`/api/services/${encodeURIComponent(id)}/categories/${encodeURIComponent(cid)}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            await loadCategories();
            await loadList();
          } catch (e) { alert("Не получилось: " + e.message); }
        };
      });
      categoryListBox.querySelectorAll("button[data-action='delete-category']").forEach(btn => {
        btn.onclick = async () => {
          const span = btn.closest("span");
          const cid = span.dataset.id;
          const cat = categories.find(x => x.id === cid);
          if (!confirm(`Удалить категорию «${cat ? cat.name : cid}»? Картинки этой категории останутся, просто потеряют эту метку.`)) return;
          try {
            await api(`/api/services/${encodeURIComponent(id)}/categories/${encodeURIComponent(cid)}`, { method: "DELETE" });
            await loadCategories();
            await loadList();
          } catch (e) { alert("Не получилось: " + e.message); }
        };
      });
    }

    let allPuzzles = []; // полный список с последней загрузки — фильтры ниже работают по нему на месте, без похода на сервер

    // Фильтр по названию/категории — на клиенте: библиотека админ-загруженных
    // картинок даже после массового импорта с Pexels остаётся сотнями, не
    // десятками тысяч строк, отдельная серверная фильтрация/пагинация тут
    // не окупается (в отличие, скажем, от витрины фильмов у Movies).
    function renderList(rows) {
      if (!rows.length) { listBox.innerHTML = `<div class="bh-empty">${allPuzzles.length ? "Ничего не подходит под фильтр" : "Пока ничего не добавлено"}</div>`; return; }
      listBox.innerHTML = `
        <table class="bh-table">
          <thead><tr><th></th><th>Название</th><th>Категории</th><th>Вариантов</th><th>Добавлено</th><th></th></tr></thead>
          <tbody>${rows.map(p => `
            <tr data-id="${escapeHtml(p.id)}">
              <td><img src="${escapeHtml(baseUrl + p.imageUrl)}" alt="" style="width:48px;height:36px;object-fit:cover;border-radius:4px;display:block"></td>
              <td><input type="text" class="bh-input-narrow" data-role="title" value="${escapeHtml(p.title)}" style="width:11em"></td>
              <td>
                <div data-role="categories">${categoryCheckboxesHtml("rowCategory-" + escapeHtml(p.id), p.categoryIds || [])}</div>
              </td>
              <td>${p.variants}</td>
              <td>${new Date(p.createdAt).toLocaleDateString("ru-RU")}</td>
              <td>
                <button class="bh-btn" data-action="save">Сохранить</button>
                <button class="bh-btn danger" data-action="delete">Удалить</button>
              </td>
            </tr>`).join("")}</tbody>
        </table>`;
      listBox.querySelectorAll("button[data-action='delete']").forEach(btn => {
        btn.onclick = async () => {
          const tr = btn.closest("tr");
          const pid = tr.dataset.id;
          const title = tr.querySelector('[data-role="title"]').value;
          if (!confirm(`Удалить «${title}» из библиотеки? Если этим пазлом уже играли в какой-то комнате, сервис откажет.`)) return;
          try {
            await api(`/api/services/${encodeURIComponent(id)}/puzzles/${encodeURIComponent(pid)}`, { method: "DELETE" });
            await loadList();
          } catch (e) { alert("Не получилось: " + e.message); }
        };
      });
      // Название и категории сохраняются одной кнопкой, не по каждому
      // изменению отдельно — с несколькими независимыми полями/чекбоксами
      // применение на лету было бы дёргано (N запросов на N правок вместо
      // одного). Название пуcтым не бывает — после импорта с Pexels у
      // фото без alt-текста оно уходит "Пазл с Pexels" (см.
      // wirePexelsImport), но иногда его всё равно хочется поправить руками.
      listBox.querySelectorAll("button[data-action='save']").forEach(btn => {
        btn.onclick = async () => {
          const tr = btn.closest("tr");
          const pid = tr.dataset.id;
          const titleInput = tr.querySelector('[data-role="title"]');
          const title = titleInput.value.trim();
          if (!title) { alert("Название не может быть пустым."); titleInput.focus(); return; }
          const categoryIds = [...tr.querySelectorAll("input[type=checkbox]:checked")].map(cb => cb.value);
          btn.disabled = true;
          try {
            await Promise.all([
              api(`/api/services/${encodeURIComponent(id)}/puzzles/${encodeURIComponent(pid)}/title`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
              }),
              api(`/api/services/${encodeURIComponent(id)}/puzzles/${encodeURIComponent(pid)}/categories`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categoryIds }),
              }),
            ]);
            titleInput.value = title;
          } catch (e) {
            alert("Не получилось: " + e.message);
          }
          btn.disabled = false;
        };
      });
    }

    function applyFilter() {
      const query = filterSearchInput.value.trim().toLowerCase();
      const categoryId = filterCategorySelect.value;
      const filtered = allPuzzles.filter(p =>
        (!query || p.title.toLowerCase().includes(query)) &&
        (!categoryId || (p.categoryIds || []).includes(categoryId))
      );
      renderList(filtered);
    }

    async function loadList() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/puzzles`);
      } catch (e) {
        listBox.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      allPuzzles = data.puzzles || [];
      // Опции селекта — из тех же approved-категорий, что и чекбоксы строк
      // (см. categories выше); сохраняем текущий выбор, если категория никуда
      // не делась, чтобы фильтр не сбрасывался на каждый loadList() (после
      // сохранения строки, удаления и т.п.).
      const approved = categories.filter(c => c.status === "approved");
      const selected = filterCategorySelect.value;
      filterCategorySelect.innerHTML = `<option value="">Все категории</option>${approved.map(c =>
        `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join("")}`;
      if (approved.some(c => c.id === selected)) filterCategorySelect.value = selected;
      applyFilter();
    }

    function readImageAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
        reader.onload = () => {
          const dataUrl = String(reader.result);
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          const img = new Image();
          img.onload = () => resolve({ base64, width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error("Файл не похож на картинку"));
          img.src = dataUrl;
        };
        reader.readAsDataURL(file);
      });
    }

    filterSearchInput.oninput = applyFilter;
    filterCategorySelect.onchange = applyFilter;

    document.getElementById("categoryCreateBtn").onclick = async () => {
      const input = document.getElementById("categoryCreateName");
      const slugInput = document.getElementById("categoryCreateSlug");
      const name = input.value.trim();
      const slug = slugInput.value.trim();
      if (!name) { alert("Укажите название категории."); return; }
      try {
        // slug — необязательное поле (см. план «Алиас и публичное название
        // категории»): не заполнили — сервер сам выведет его из name.
        await api(`/api/services/${encodeURIComponent(id)}/categories`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(slug ? { name, slug } : { name }),
        });
        input.value = "";
        slugInput.value = "";
        await loadCategories();
        await loadList(); // подтягивает новую категорию и в фильтр, и в чекбоксы строк
      } catch (e) { alert("Не получилось: " + e.message); }
    };

    document.getElementById("puzzleUploadBtn").onclick = async () => {
      const title = document.getElementById("puzzleUploadTitle").value.trim();
      const categoryIds = [...uploadCategoriesBox.querySelectorAll("input[type=checkbox]:checked")].map(cb => cb.value);
      const fileInput = document.getElementById("puzzleUploadFile");
      const file = fileInput.files[0];
      if (!title) { alert("Укажите название."); return; }
      if (!file) { alert("Выберите картинку."); return; }
      resultEl.innerHTML = `<div class="bh-empty">Загружаю…</div>`;
      try {
        const { base64, width, height } = await readImageAsBase64(file);
        const data = await api(`/api/services/${encodeURIComponent(id)}/puzzles`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, imageBase64: base64, width, height, categoryIds }),
        });
        resultEl.innerHTML = `<div class="bh-card"><div class="bh-stat-row"><span>${escapeHtml(data.title)}</span><b>${data.variants.length} вариантов сложности</b></div></div>`;
        document.getElementById("puzzleUploadTitle").value = "";
        fileInput.value = "";
        await loadList();
      } catch (e) {
        resultEl.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
      }
    };

    await loadCategories();
    await loadList();
  }

  /** Импорт из Pexels (см. Admin/server.js /api/pexels/search и
      /api/services/:id/pexels/import, PEXELS_API_KEY) — быстрое наполнение
      дефолтной библиотеки: находим фото по запросу, отмечаем нужные, разом
      закидываем в библиотеку с общим набором категорий. Название пазла
      берётся из alt-текста Pexels — редактировать его тут негде, это
      быстрое накидывание болванок, точечная правка названия/категорий уже
      есть в таблице на вкладке «Библиотека» после импорта. */
  async function wirePexelsImport(id) {
    const el = document.getElementById("pexelsImport");
    el.innerHTML = `
      <div class="bh-toolbar">
        <input type="text" class="bh-input-narrow" id="pexelsQuery" placeholder="Запрос, напр. mountains" style="width:16em">
        <button class="bh-btn" id="pexelsSearchBtn">Искать</button>
      </div>
      <div id="pexelsRateLimit"></div>
      <div class="bh-section-title">Категории для импортируемых</div>
      <div id="pexelsCategories"><div class="bh-empty">Загрузка…</div></div>
      <div id="pexelsResults"><div class="bh-empty">Введите запрос и нажмите «Искать»</div></div>
      <div id="pexelsPager"></div>
      <div class="bh-toolbar">
        <button class="bh-btn" id="pexelsImportBtn" disabled>Импортировать выбранные (0)</button>
      </div>
      <div id="pexelsImportResult"></div>
    `;
    const categoriesBox = document.getElementById("pexelsCategories");
    const rateLimitEl = document.getElementById("pexelsRateLimit");
    const resultsEl = document.getElementById("pexelsResults");
    const pagerEl = document.getElementById("pexelsPager");
    const importBtn = document.getElementById("pexelsImportBtn");
    const importResultEl = document.getElementById("pexelsImportResult");
    let photos = []; // последний результат поиска — для сопоставления с чекбоксами при импорте

    async function loadCategories() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/categories`);
      } catch (e) {
        categoriesBox.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      const approved = (data.categories || []).filter(c => c.status === "approved");
      categoriesBox.innerHTML = approved.length
        ? approved.map(c => `
            <label style="display:inline-flex;align-items:center;gap:.3em;margin:0 .8em .3em 0">
              <input type="checkbox" name="pexelsCategory" value="${escapeHtml(c.id)}">
              ${escapeHtml(c.name)}
            </label>`).join("")
        : `<div class="bh-empty">Нет ни одной категории — создайте на вкладке «Библиотека»</div>`;
    }

    function updateImportButton() {
      const n = resultsEl.querySelectorAll("input:checked").length;
      importBtn.disabled = n === 0;
      importBtn.textContent = `Импортировать выбранные (${n})`;
    }

    // Отдельной ручки «сколько осталось» у Pexels нет — лимит виден только в
    // заголовках ответа на сам /search (см. Admin/server.js), поэтому
    // обновляется тут же, после каждого поиска, а не запрашивается отдельно.
    function renderRateLimit(rateLimit) {
      if (!rateLimit) { rateLimitEl.innerHTML = ""; return; }
      const low = rateLimit.remaining < rateLimit.limit * 0.05;
      rateLimitEl.innerHTML = `<div class="bh-stat-row"><span>Лимит Pexels${low ? " — почти исчерпан" : ""}</span><b>${rateLimit.remaining} / ${rateLimit.limit}${rateLimit.resetAt ? `, сброс ${new Date(rateLimit.resetAt).toLocaleString("ru-RU")}` : ""}</b></div>`;
    }

    async function search(page = 1) {
      const query = document.getElementById("pexelsQuery").value.trim();
      if (!query) { alert("Введите запрос."); return; }
      resultsEl.innerHTML = `<div class="bh-empty">Ищу…</div>`;
      pagerEl.innerHTML = "";
      let data;
      try {
        data = await api(`/api/pexels/search?query=${encodeURIComponent(query)}&page=${page}`);
        photos = data.photos || [];
        renderRateLimit(data.rateLimit);
      } catch (e) {
        resultsEl.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      if (!photos.length) { resultsEl.innerHTML = `<div class="bh-empty">Ничего не нашлось</div>`; return; }
      resultsEl.innerHTML = `<div class="bh-photo-grid">${photos.map(ph => `
        <label class="bh-photo-cell">
          <input type="checkbox" value="${escapeHtml(String(ph.id))}" hidden>
          <img src="${escapeHtml(ph.thumbUrl)}" alt="${escapeHtml(ph.alt)}" loading="lazy">
          <span class="bh-photo-caption">${escapeHtml(ph.photographer || "")}</span>
        </label>`).join("")}</div>`;
      updateImportButton();
      // Выбранное на предыдущей странице при листании теряется — сопоставлять
      // id между страницами ради сохранения десятка чекбоксов не того стоит,
      // это же просто накидывание болванок в библиотеку, не форма с данными.
      pagerEl.innerHTML = `
        <div class="bh-toolbar">
          <button class="bh-btn" id="pexelsPrevBtn" ${page <= 1 ? "disabled" : ""}>← Назад</button>
          <span class="bh-empty" style="padding:0">Страница ${page}</span>
          <button class="bh-btn" id="pexelsNextBtn" ${data.hasMore ? "" : "disabled"}>Вперёд →</button>
        </div>`;
      document.getElementById("pexelsPrevBtn").onclick = () => search(page - 1);
      document.getElementById("pexelsNextBtn").onclick = () => search(page + 1);
    }

    resultsEl.addEventListener("change", updateImportButton);
    document.getElementById("pexelsSearchBtn").onclick = () => search(1);
    document.getElementById("pexelsQuery").onkeydown = e => { if (e.key === "Enter") search(1); };

    importBtn.onclick = async () => {
      const checkedIds = [...resultsEl.querySelectorAll("input:checked")].map(cb => cb.value);
      if (!checkedIds.length) return;
      const categoryIds = [...categoriesBox.querySelectorAll("input:checked")].map(cb => cb.value);
      importBtn.disabled = true;
      let done = 0, failed = 0;
      for (const photoId of checkedIds) {
        const photo = photos.find(ph => String(ph.id) === photoId);
        importResultEl.innerHTML = `<div class="bh-empty">Импортирую ${done + failed + 1} из ${checkedIds.length}…</div>`;
        try {
          await api(`/api/services/${encodeURIComponent(id)}/pexels/import`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              importUrl: photo.importUrl, width: photo.width, height: photo.height,
              title: photo.alt || "Пазл с Pexels", categoryIds,
            }),
          });
          done++;
        } catch (e) { failed++; }
      }
      importResultEl.innerHTML = `
        <div class="bh-card">
          <div class="bh-stat-row"><span>Импортировано</span><b>${done}</b></div>
          ${failed ? `<div class="bh-stat-row"><span>Ошибок</span><b>${failed}</b></div>` : ""}
        </div>`;
      updateImportButton();
    };

    await loadCategories();
  }

  const MODERATION_STATUS_LABEL = {
    pending: '<span class="bh-badge">на модерации</span>',
    approved: '<span class="bh-badge admin">опубликовано</span>',
    rejected: '<span class="bh-badge disabled">отклонено</span>',
  };

  function closePhotoModal() {
    const el = document.getElementById("bhPhotoModal");
    if (el) el.remove();
    document.removeEventListener("keydown", closePhotoModalOnEsc);
  }
  function closePhotoModalOnEsc(e) { if (e.key === "Escape") closePhotoModal(); }

  /** Модалка «фото целиком» — общая для обеих очередей ниже (см.
      wireRoomUploadQueue/wireModerationQueue). Миниатюра 48–64px в таблице
      мало, чтобы разглядеть запрещённый контент — тут оригинал во весь
      доступный экран. Кнопки действий в модалке НЕ дублируют логику
      approve/reject/ban: это тонкое реле, которое жмёт настоящую кнопку той
      же строки таблицы и закрывает модалку — один источник правды на клик,
      а не две копии confirm()/api() при этом и в строке, и в модалке. */
  function openPhotoModal(photo, baseUrl, tr, fields) {
    closePhotoModal();
    const backdrop = document.createElement("div");
    backdrop.className = "bh-modal-backdrop";
    backdrop.id = "bhPhotoModal";
    backdrop.innerHTML = `
      <div class="bh-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(photo.title)}">
        <div class="bh-modal-head">
          <h3>${escapeHtml(photo.title)}</h3>
          <button class="bh-modal-close" aria-label="Закрыть">×</button>
        </div>
        <img src="${escapeHtml(baseUrl + photo.imageUrl)}" alt="">
        <div class="bh-modal-fields">${fields.map(([k, v]) => `<div class="bh-stat-row"><span>${escapeHtml(k)}</span><b>${v}</b></div>`).join("")}</div>
        <div class="bh-toolbar" id="bhPhotoModalActions"></div>
      </div>
    `;
    backdrop.querySelector(".bh-modal-close").onclick = closePhotoModal;
    backdrop.onclick = e => { if (e.target === backdrop) closePhotoModal(); };
    document.addEventListener("keydown", closePhotoModalOnEsc);

    const actionsEl = backdrop.querySelector("#bhPhotoModalActions");
    tr.querySelectorAll("td.bh-toolbar button").forEach(rowBtn => {
      const relayBtn = document.createElement("button");
      relayBtn.className = rowBtn.className;
      relayBtn.textContent = rowBtn.textContent;
      relayBtn.onclick = () => { closePhotoModal(); rowBtn.click(); };
      actionsEl.appendChild(relayBtn);
    });

    document.body.appendChild(backdrop);
  }

  /** Очередь ЗАГРУЗКИ В КОМНАТУ — фоновая модерация, отдельная от заявок на
      публикацию (см. Puzzle server.js /internal/moderation/room-uploads,
      план «Разделение модерации: загрузка в комнату vs публикация +
      письма»): своё фото видно в комнате сразу после загрузки
      (самосертификация галочкой при загрузке), но ждёт проверки админом
      постфактум. «Отклонить» тут СРАЗУ удаляет группу (в отличие от
      отклонения публикации, которое просто помечает статус) — раз фото
      нарушает правила загрузки в комнату, держать его там незачем, отдельной
      кнопки «Удалить» поэтому нет. Почти копия wireModerationQueue ниже —
      тот же baseUrl-префикс картинок, та же общая кнопка «Забанить». */
  async function wireRoomUploadQueue(id, baseUrl) {
    const el = document.getElementById("roomUploadQueue");

    async function load() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/moderation/room-uploads`);
      } catch (e) {
        el.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      const rows = data.photos || [];
      if (!rows.length) { el.innerHTML = `<div class="bh-empty">Нечего проверять</div>`; return; }
      el.innerHTML = `
        <table class="bh-table">
          <thead><tr><th></th><th>Название</th><th>Загрузил</th><th>Комната</th><th>Загружено</th><th></th></tr></thead>
          <tbody>${rows.map(p => `
            <tr data-id="${escapeHtml(p.id)}" data-owner="${escapeHtml(p.ownerUserId || "")}" data-device="${escapeHtml(p.uploadDevice || "")}">
              <td><img class="bh-modal-thumb" src="${escapeHtml(baseUrl + p.imageUrl)}" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:4px;display:block"></td>
              <td>${escapeHtml(p.title)}</td>
              <td><code>${escapeHtml(p.ownerUserId || "—")}</code></td>
              <td>${escapeHtml(p.roomTitle || "—")}</td>
              <td>${new Date(p.createdAt).toLocaleDateString("ru-RU")}</td>
              <td class="bh-toolbar" style="margin:0">
                <button class="bh-btn" data-action="approve">Одобрить</button>
                <button class="bh-btn danger" data-action="reject">Отклонить</button>
                <button class="bh-btn danger" data-action="ban">Забанить</button>
              </td>
            </tr>`).join("")}</tbody>
        </table>`;

      el.querySelectorAll("tr[data-id]").forEach(tr => {
        const photoId = tr.dataset.id, ownerUserId = tr.dataset.owner, deviceId = tr.dataset.device;
        const title = tr.children[1].textContent;
        const setBusy = busy => tr.querySelectorAll("button").forEach(b => b.disabled = busy);
        const btn = action => tr.querySelector(`button[data-action="${action}"]`);

        const photo = rows.find(r => String(r.id) === photoId);
        tr.querySelector("img").onclick = () => openPhotoModal(photo, baseUrl, tr, [
          ["Загрузил", `<code>${escapeHtml(photo.ownerUserId || "—")}</code>`],
          ["Устройство", `<code>${escapeHtml(photo.uploadDevice || "—")}</code>`],
          ["Комната", escapeHtml(photo.roomTitle || "—")],
          ["Согласие при загрузке", photo.consentAt ? escapeHtml(new Date(photo.consentAt).toLocaleString("ru-RU")) : "не получено"],
          ["Вариантов сложности", String(photo.variants)],
          ["Загружено", escapeHtml(new Date(photo.createdAt).toLocaleString("ru-RU"))],
        ]);

        btn("approve").onclick = async () => {
          setBusy(true);
          try { await api(`/api/services/${encodeURIComponent(id)}/moderation/room-uploads/${encodeURIComponent(photoId)}/approve`, { method: "POST" }); await load(); }
          catch (e) { alert("Не получилось: " + e.message); setBusy(false); }
        };
        btn("reject").onclick = async () => {
          const reason = prompt(`Причина отказа для «${title}» (фото будет удалено):`);
          if (reason === null) return;
          setBusy(true);
          try {
            await api(`/api/services/${encodeURIComponent(id)}/moderation/room-uploads/${encodeURIComponent(photoId)}/reject`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
            });
            await load();
          } catch (e) { alert("Не получилось: " + e.message); setBusy(false); }
        };
        // Та же общая кнопка «Забанить» (аккаунт+устройство разом), что и в
        // очереди публикации ниже — см. комментарий там же.
        btn("ban").onclick = async () => {
          if (!ownerUserId && !deviceId) {
            alert("У этого фото нет ни владельца-аккаунта, ни device-id — банить нечего.");
            return;
          }
          const lines = [`Заблокировать того, кто загрузил «${title}»?`];
          if (ownerUserId) lines.push("— аккаунт: блокирует вход во ВСЕХ сервисах BurningHouse, не только в Puzzle");
          if (deviceId) lines.push("— устройство: следующая загрузка с той же cookie отобьётся");
          if (!confirm(lines.join("\n"))) return;
          let reason;
          if (deviceId) {
            reason = prompt("Причина бана устройства (для лога):");
            if (reason === null) return;
          }
          setBusy(true);
          try {
            if (ownerUserId) {
              await api(`/api/users/${encodeURIComponent(ownerUserId)}/disabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true }) });
            }
            if (deviceId) {
              await api(`/api/devices/${encodeURIComponent(deviceId)}/banned`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true, reason }),
              });
            }
            alert("Забанено.");
          } catch (e) { alert("Не получилось: " + e.message); }
          setBusy(false);
        };
      });
    }

    await load();
  }

  /** Вкладка «Модерация» (только Puzzle, см. Puzzle server.js
      /internal/moderation/photos) — ЗАЯВКИ НА ПУБЛИКАЦИЮ: только фото,
      которые хоть раз отправлялись на публикацию (см. план «Разделение
      модерации» — фото, просто загруженные в комнату и никогда не
      публиковавшиеся, теперь отдельная очередь, wireRoomUploadQueue выше).
      Одобрить/Отклонить — только для pending. Удалить/забанить — всегда. */
  async function wireModerationQueue(id, baseUrl) {
    const el = document.getElementById("moderationQueue");

    async function load() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/moderation/photos`);
      } catch (e) {
        el.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      const rows = data.photos || [];
      if (!rows.length) { el.innerHTML = `<div class="bh-empty">Пока никто ничего не загружал</div>`; return; }
      el.innerHTML = `
        <table class="bh-table">
          <thead><tr><th></th><th>Название</th><th>Загрузил</th><th>Комната</th><th>Статус</th><th>Загружено</th><th></th></tr></thead>
          <tbody>${rows.map(p => `
            <tr data-id="${escapeHtml(p.id)}" data-owner="${escapeHtml(p.ownerUserId || "")}" data-device="${escapeHtml(p.uploadDevice || "")}">
              <td><img class="bh-modal-thumb" src="${escapeHtml(baseUrl + p.imageUrl)}" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:4px;display:block"></td>
              <td>${escapeHtml(p.title)}</td>
              <td><code>${escapeHtml(p.ownerUserId || "—")}</code></td>
              <td>${escapeHtml(p.roomTitle || "—")}</td>
              <td>${MODERATION_STATUS_LABEL[p.moderationStatus] || '<span class="bh-badge">—</span>'}${p.moderationReason ? `<div class="bh-empty" style="padding:.2rem 0">${escapeHtml(p.moderationReason)}</div>` : ""}</td>
              <td>${new Date(p.createdAt).toLocaleDateString("ru-RU")}</td>
              <td class="bh-toolbar" style="margin:0">
                ${p.moderationStatus === "pending" ? `
                  <button class="bh-btn" data-action="approve">Одобрить</button>
                  <button class="bh-btn danger" data-action="reject">Отклонить</button>
                ` : ""}
                <button class="bh-btn danger" data-action="delete">Удалить</button>
                <button class="bh-btn danger" data-action="ban">Забанить</button>
              </td>
            </tr>`).join("")}</tbody>
        </table>`;

      el.querySelectorAll("tr[data-id]").forEach(tr => {
        const photoId = tr.dataset.id, ownerUserId = tr.dataset.owner, deviceId = tr.dataset.device;
        const title = tr.children[1].textContent;
        const setBusy = busy => tr.querySelectorAll("button").forEach(b => b.disabled = busy);

        const btn = action => tr.querySelector(`button[data-action="${action}"]`);

        const photo = rows.find(r => String(r.id) === photoId);
        tr.querySelector("img").onclick = () => openPhotoModal(photo, baseUrl, tr, [
          ["Загрузил", `<code>${escapeHtml(photo.ownerUserId || "—")}</code>`],
          ["Устройство", `<code>${escapeHtml(photo.uploadDevice || "—")}</code>`],
          ["Комната", escapeHtml(photo.roomTitle || "—")],
          ["Согласие при загрузке", photo.consentAt ? escapeHtml(new Date(photo.consentAt).toLocaleString("ru-RU")) : "не получено"],
          ["Вариантов сложности", String(photo.variants)],
          ["Статус публикации", MODERATION_STATUS_LABEL[photo.moderationStatus] || '<span class="bh-badge">—</span>'],
          ...(photo.moderationReason ? [["Причина", escapeHtml(photo.moderationReason)]] : []),
          ["Загружено", escapeHtml(new Date(photo.createdAt).toLocaleString("ru-RU"))],
        ]);

        if (btn("approve")) btn("approve").onclick = async () => {
          if (!confirm(`Опубликовать «${title}» в общую библиотеку без входа?`)) return;
          setBusy(true);
          try { await api(`/api/services/${encodeURIComponent(id)}/moderation/photos/${encodeURIComponent(photoId)}/approve`, { method: "POST" }); await load(); }
          catch (e) { alert("Не получилось: " + e.message); setBusy(false); }
        };
        if (btn("reject")) btn("reject").onclick = async () => {
          const reason = prompt(`Причина отказа для «${title}» (увидит автор):`);
          if (reason === null) return;
          setBusy(true);
          try {
            await api(`/api/services/${encodeURIComponent(id)}/moderation/photos/${encodeURIComponent(photoId)}/reject`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
            });
            await load();
          } catch (e) { alert("Не получилось: " + e.message); setBusy(false); }
        };
        btn("delete").onclick = async () => {
          if (!confirm(`Удалить «${title}» безвозвратно? Сработает, даже если пазл уже собирали в комнате.`)) return;
          setBusy(true);
          try { await api(`/api/services/${encodeURIComponent(id)}/moderation/photos/${encodeURIComponent(photoId)}`, { method: "DELETE" }); await load(); }
          catch (e) { alert("Не получилось: " + e.message); setBusy(false); }
        };
        // Аккаунт и устройство банятся одной кнопкой: цель у обоих одна — не
        // дать тому же человеку загрузить ещё раз, а не два разных действия.
        // Заодно закрывает дыру, которую оставляло раздельное нажатие: бан
        // только аккаунта не мешает грузить анонимно с того же браузера, бан
        // только устройства не мешает перелогиниться на другом.
        btn("ban").onclick = async () => {
          if (!ownerUserId && !deviceId) {
            alert("У этого фото нет ни владельца-аккаунта, ни device-id (например, загружено анонимно/через Admin) — банить нечего.");
            return;
          }
          const lines = [`Заблокировать того, кто загрузил «${title}»?`];
          if (ownerUserId) lines.push("— аккаунт: блокирует вход во ВСЕХ сервисах BurningHouse, не только в Puzzle");
          if (deviceId) lines.push("— устройство: следующая загрузка с той же cookie отобьётся");
          if (!confirm(lines.join("\n"))) return;
          let reason;
          if (deviceId) {
            reason = prompt("Причина бана устройства (для лога):");
            if (reason === null) return;
          }
          setBusy(true);
          try {
            if (ownerUserId) {
              await api(`/api/users/${encodeURIComponent(ownerUserId)}/disabled`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true }) });
            }
            if (deviceId) {
              await api(`/api/devices/${encodeURIComponent(deviceId)}/banned`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true, reason }),
              });
            }
            alert("Забанено.");
          } catch (e) { alert("Не получилось: " + e.message); }
          setBusy(false);
        };
      });
    }

    await load();
  }

  /** Вкладка «Модерация» — категории, предложенные пользователями при
      публикации (см. Puzzle server.js /internal/moderation/categories,
      план «Категории many-to-many, автор карточки, профиль»). Только
      pending — одобренные/отклонённые дальше не видны тут же, как и у
      фото-очереди список сам сужается по мере разбора. */
  async function wireCategoryModerationQueue(id) {
    const el = document.getElementById("categoryModerationQueue");

    async function load() {
      let data;
      try {
        data = await api(`/api/services/${encodeURIComponent(id)}/moderation/categories`);
      } catch (e) {
        el.innerHTML = `<div class="bh-empty">${escapeHtml(e.message)}</div>`;
        return;
      }
      const rows = data.categories || [];
      if (!rows.length) { el.innerHTML = `<div class="bh-empty">Нет категорий на модерации</div>`; return; }
      el.innerHTML = `
        <table class="bh-table">
          <thead><tr><th>Название</th><th>Предложил</th><th>Когда</th><th></th></tr></thead>
          <tbody>${rows.map(c => `
            <tr data-id="${escapeHtml(c.id)}">
              <td>${escapeHtml(c.name)}</td>
              <td><code>${escapeHtml(c.createdBy || "—")}</code></td>
              <td>${new Date(c.createdAt).toLocaleDateString("ru-RU")}</td>
              <td class="bh-toolbar" style="margin:0">
                <button class="bh-btn" data-action="approve">Одобрить</button>
                <button class="bh-btn danger" data-action="reject">Отклонить</button>
              </td>
            </tr>`).join("")}</tbody>
        </table>`;
      el.querySelectorAll("tr[data-id]").forEach(tr => {
        const categoryId = tr.dataset.id;
        const name = tr.children[0].textContent;
        const setBusy = busy => tr.querySelectorAll("button").forEach(b => b.disabled = busy);
        tr.querySelector("button[data-action='approve']").onclick = async () => {
          setBusy(true);
          try { await api(`/api/services/${encodeURIComponent(id)}/moderation/categories/${encodeURIComponent(categoryId)}/approve`, { method: "POST" }); await load(); }
          catch (e) { alert("Не получилось: " + e.message); setBusy(false); }
        };
        tr.querySelector("button[data-action='reject']").onclick = async () => {
          const reason = prompt(`Причина отказа для категории «${name}» (не показывается автору сейчас — своей вкладки заявок у пользователя пока нет):`);
          if (reason === null) return;
          setBusy(true);
          try {
            await api(`/api/services/${encodeURIComponent(id)}/moderation/categories/${encodeURIComponent(categoryId)}/reject`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
            });
            await load();
          } catch (e) { alert("Не получилось: " + e.message); setBusy(false); }
        };
      });
    }

    await load();
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
          <button class="bh-btn danger" data-action="ban-devices" ${u.id === user.id ? "disabled" : ""}>Забанить устройства</button>
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
          "ban-devices": "забанить ВСЕ устройства, с которых этот аккаунт когда-либо логинился (по cookie — очистка cookies это обходит, но поднимает планку для повторной загрузки под новым аккаунтом)",
        }[action];
        if (!confirm(`Точно ${label}?`)) return;

        tr.querySelectorAll("button").forEach(b => b.disabled = true);
        try {
          const init = action === "logout-all" || action === "ban-devices"
            ? { method: "POST" }
            : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) };
          const data = await api(`/api/users/${encodeURIComponent(id)}/${action}`, init);
          if (action === "ban-devices") alert(`Забанено устройств: ${data.count}.`);
          renderUsers(body);
        } catch (e) {
          alert("Не получилось: " + e.message);
          tr.querySelectorAll("button").forEach(b => b.disabled = false);
        }
      };
    });
  }
})();
