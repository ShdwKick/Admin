"use strict";
/**
 * Фронт админки. Никакого фреймворка — как и в остальных сервисах
 * BurningHouse, обычный DOM и fetch. Кто админ, фронт не решает сам: он
 * просто дёргает защищённый /api/overview и по 403 понимает, что доступа нет
 * (см. Auth/INTEGRATION.md — claim admin проверяется на бэкенде, не на фронте).
 */
(async function () {
  const app = document.getElementById("app");
  const whoBox = document.getElementById("whoBox");
  const whoName = document.getElementById("whoName");
  const logoutBtn = document.getElementById("logoutBtn");

  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const cfg = await (await fetch("/api/config")).json();
  const auth = createAuthClient({
    authBase: cfg.authBase,
    clientId: cfg.clientId,
    redirectUri: location.origin + location.pathname,
    storagePrefix: "admin",
  });

  await auth.handleRedirect();

  if (!auth.isAuthenticated()) return showLoginGate();
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
    whoBox.style.display = "none";
    app.innerHTML = `
      <div class="bh-gate">
        <p>Аналитика, логи и управление ролями по сервисам BurningHouse.
        Вход — тем же аккаунтом, что и везде.</p>
        <button class="bh-btn" id="loginBtn">Войти</button>
      </div>`;
    document.getElementById("loginBtn").onclick = () => auth.login();
  }

  function showForbiddenGate(user) {
    app.innerHTML = `
      <div class="bh-gate">
        <p>Вы вошли как «${escapeHtml(user.name || user.username || "")}», но у этого аккаунта
        нет доступа в Админку. Доступ выдаётся командой <code>make-admin</code> на сервере Auth.</p>
      </div>`;
  }

  const user = auth.getUser() || {};
  whoBox.style.display = "flex";
  whoName.textContent = user.name || user.username || "";

  let overview;
  try {
    overview = await api("/api/overview");
  } catch (e) {
    if (e instanceof ForbiddenError) return showForbiddenGate(user);
    if (e.name === "AuthRequiredError") return; // showLoginGate уже вызван внутри api()
    app.innerHTML = `<div class="bh-empty">Не удалось загрузить: ${escapeHtml(e.message)}</div>`;
    return;
  }

  renderShell(overview);

  function renderShell(initialOverview) {
    app.innerHTML = `
      <div class="bh-tabs">
        <button class="bh-tab is-active" data-tab="overview">Обзор</button>
        <button class="bh-tab" data-tab="logs">Логи</button>
        <button class="bh-tab" data-tab="users">Пользователи</button>
      </div>
      <div id="tabBody"></div>
    `;
    const tabs = [...app.querySelectorAll(".bh-tab")];
    const body = document.getElementById("tabBody");

    async function show(tab) {
      tabs.forEach(t => t.classList.toggle("is-active", t.dataset.tab === tab));
      body.innerHTML = `<div class="bh-empty">Загрузка…</div>`;
      try {
        if (tab === "overview") return renderOverview(body, initialOverview);
        if (tab === "logs") return renderLogs(body, initialOverview.services);
        if (tab === "users") return renderUsers(body);
      } catch (e) {
        if (!(e instanceof ForbiddenError) && e.name !== "AuthRequiredError") {
          body.innerHTML = `<div class="bh-empty">Ошибка: ${escapeHtml(e.message)}</div>`;
        }
      }
    }
    tabs.forEach(t => t.onclick = () => show(t.dataset.tab));
    show("overview");
  }

  function renderOverview(body, data) {
    if (!data.services.length) { body.innerHTML = `<div class="bh-empty">Сервисы не настроены (SERVICES_JSON)</div>`; return; }
    body.innerHTML = `<div class="bh-grid">${data.services.map(cardHtml).join("")}</div>`;
  }

  function cardHtml(s) {
    if (!s.ok) {
      return `<div class="bh-card"><h3><span class="bh-dot down"></span>${escapeHtml(s.name)}</h3><div class="bh-error">${escapeHtml(s.error)}</div></div>`;
    }
    const rows = Object.entries(s.stats || {}).filter(([k]) => k !== "ok").map(([k, v]) =>
      `<div class="bh-stat-row"><span>${escapeHtml(k)}</span><b>${v === null || v === undefined ? "—" : escapeHtml(String(v))}</b></div>`
    ).join("");
    return `<div class="bh-card"><h3><span class="bh-dot ok"></span>${escapeHtml(s.name)}</h3>${rows || '<div class="bh-stat-row"><span>—</span></div>'}</div>`;
  }

  function logLineHtml(l) {
    const ts = new Date(l.ts).toLocaleString("ru-RU");
    const meta = l.meta ? " " + JSON.stringify(l.meta) : "";
    return `<div class="bh-logline ${escapeHtml(l.level)}"><span class="ts">${ts}</span><span class="lvl">${escapeHtml(l.level)}</span><span class="msg">${escapeHtml(l.message)}${escapeHtml(meta)}</span></div>`;
  }

  function renderLogs(body, services) {
    if (!services.length) { body.innerHTML = `<div class="bh-empty">Сервисы не настроены</div>`; return; }
    body.innerHTML = `
      <div class="bh-toolbar">
        <select id="logService">${services.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("")}</select>
        <select id="logLevel">
          <option value="">Все уровни</option>
          <option value="warn">Предупреждения и ошибки</option>
          <option value="error">Только ошибки</option>
        </select>
        <button class="bh-btn" id="logRefresh">Обновить</button>
      </div>
      <div class="bh-loglist" id="logList"></div>
    `;
    const svcSel = document.getElementById("logService");
    const lvlSel = document.getElementById("logLevel");
    const list = document.getElementById("logList");
    const RANK = { info: 0, warn: 1, error: 2 };

    async function load() {
      list.innerHTML = `<div class="bh-empty">Загрузка…</div>`;
      try {
        const data = await api(`/api/services/${encodeURIComponent(svcSel.value)}/logs?limit=200`);
        let logs = data.logs || [];
        if (lvlSel.value) logs = logs.filter(l => RANK[l.level] >= RANK[lvlSel.value]);
        list.innerHTML = logs.length ? logs.map(logLineHtml).join("") : `<div class="bh-empty">Пусто</div>`;
      } catch (e) {
        list.innerHTML = `<div class="bh-empty">Ошибка: ${escapeHtml(e.message)}</div>`;
      }
    }
    svcSel.onchange = load;
    lvlSel.onchange = load;
    document.getElementById("logRefresh").onclick = load;
    load();
  }

  async function renderUsers(body) {
    const data = await api("/api/users");
    const rows = (data.users || []).map(u => `
      <tr data-id="${escapeHtml(u.id)}">
        <td>${escapeHtml(u.username)}${u.id === user.id ? ' <span class="bh-badge">это вы</span>' : ""}</td>
        <td>${escapeHtml(u.email || "—")}</td>
        <td>${u.admin ? '<span class="bh-badge admin">админ</span>' : ""}${u.disabled ? ' <span class="bh-badge disabled">заблокирован</span>' : ""}</td>
        <td>
          <button class="bh-btn" data-action="admin" data-on="${u.admin ? "0" : "1"}" ${u.id === user.id ? "disabled" : ""}>${u.admin ? "Забрать доступ" : "Сделать админом"}</button>
          <button class="bh-btn" data-action="disabled" data-on="${u.disabled ? "0" : "1"}" ${u.id === user.id ? "disabled" : ""}>${u.disabled ? "Разблокировать" : "Заблокировать"}</button>
          <button class="bh-btn danger" data-action="logout-all">Разлогинить</button>
        </td>
      </tr>`).join("");

    body.innerHTML = rows
      ? `<table class="bh-table"><thead><tr><th>Логин</th><th>Почта</th><th>Статус</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="bh-empty">Пользователей нет</div>`;

    body.querySelectorAll("button[data-action]").forEach(btn => {
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
