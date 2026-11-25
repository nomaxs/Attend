/* =========================
FILE OVERVIEW
========================= */
// Shared UI toolkit (toasts, modals, confirmations, loaders, form dialogs, CSV export), the page shell
// (sidebar + top bar), shared calculation helpers, and the page boot sequence.

(function () {
  const M = window.Muster;
  const { util } = M;
  const esc = util.esc;

  /* ---------- formatting ---------- */
  const fmt = {
    dt: (v) => (v ? new Date(v).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"),
    d: (v) => (v ? new Date(v).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "—"),
    t: (v) => (v ? new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"),
    pct: (n) => (n == null || isNaN(n) ? "—" : (Math.round(n * 10) / 10) + "%"),
    num: (n) => (n == null || n === "" || isNaN(n) ? "—" : String(Math.round(n * 100) / 100)),
    mmss: (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
  };
  const badge = (status) => `<span class="badge ${esc(String(status || "").toLowerCase())}">${esc(status ? status[0].toUpperCase() + status.slice(1) : "—")}</span>`;

  /* ---------- toast / loader / modal ---------- */
  function toast(message, type) {
    let box = document.getElementById("toasts");
    if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
    const t = document.createElement("div"); t.className = "toast " + (type || "info"); t.textContent = message; box.appendChild(t);
    setTimeout(() => t.remove(), type === "error" ? 6000 : 3500);
  }
  function loading(on) {
    let l = document.getElementById("loader");
    if (on && !l) { l = document.createElement("div"); l.id = "loader"; l.innerHTML = '<div class="spinner" role="status" aria-label="Loading"></div>'; document.body.appendChild(l); }
    if (!on && l) l.remove();
  }
  const spinner = (text) => `<div class="inline-load"><div class="spinner"></div><span>${esc(text || "Loading…")}</span></div>`;
  const empty = (title, text) => `<div class="empty"><b>${esc(title)}</b>${esc(text || "")}</div>`;

  function modal(opts) {
    const back = document.createElement("div"); back.className = "modal-back";
    back.innerHTML = `<div class="modal ${opts.wide ? "wide" : ""}" role="dialog" aria-modal="true"><div class="modal-head"><h2>${esc(opts.title || "")}</h2><button class="icon-btn" aria-label="Close" data-x>✕</button></div><div class="modal-body"></div><div class="modal-foot"></div></div>`;
    const body = back.querySelector(".modal-body"); const foot = back.querySelector(".modal-foot");
    if (typeof opts.body === "string") body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
    const api = { el: back, body, close() { back.remove(); document.removeEventListener("keydown", onKey); if (opts.onClose) opts.onClose(); } };
    const onKey = (e) => { if (e.key === "Escape") api.close(); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", (e) => { if (e.target === back) api.close(); });
    back.querySelector("[data-x]").addEventListener("click", api.close);
    (opts.buttons || []).forEach((b) => {
      const el = document.createElement("button"); el.className = "btn " + (b.cls || "secondary"); el.textContent = b.text; if (b.type) el.type = b.type;
      el.addEventListener("click", async () => { if (b.onClick) { el.disabled = true; try { await b.onClick(api); } finally { el.disabled = false; } } else api.close(); });
      foot.appendChild(el);
    });
    if (!opts.buttons || !opts.buttons.length) foot.remove();
    document.body.appendChild(back);
    const first = back.querySelector("input,select,textarea,button.btn"); if (first) first.focus();
    return api;
  }

  function confirm(o) {
    return new Promise((resolve) => {
      let done = false; const fin = (v, api) => { if (!done) { done = true; resolve(v); } api.close(); };
      const m = modal({ title: o.title || "Are you sure?", body: `<p>${esc(o.message || "")}</p>`, onClose: () => { if (!done) { done = true; resolve(false); } },
        buttons: [{ text: o.cancelText || "Cancel", onClick: (a) => fin(false, a) }, { text: o.confirmText || "Confirm", cls: o.danger ? "danger" : "", onClick: (a) => fin(true, a) }] });
      return m;
    });
  }

  // Generic validated form dialog. fields: [{name,label,type,value,options:[[v,label]],hint,required,min,max,minLength,maxLength,full,rows}]
  function formModal(o) {
    const html = '<form class="form-grid" novalidate>' + o.fields.map((f) => {
      const id = "fm_" + f.name; const val = f.value == null ? "" : f.value; const req = f.required ? "required" : "";
      let input;
      if (f.type === "select") input = `<select id="${id}" name="${f.name}" ${req}>${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
      else if (f.type === "textarea") input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" ${req} ${f.maxLength ? `maxlength="${f.maxLength}"` : ""}>${esc(val)}</textarea>`;
      else if (f.type === "checkbox") input = `<label style="font-weight:500"><input type="checkbox" id="${id}" name="${f.name}" ${val ? "checked" : ""}>${esc(f.label)}</label>`;
      else input = `<input id="${id}" name="${f.name}" type="${f.type || "text"}" value="${esc(val)}" ${req} ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""} ${f.step ? `step="${f.step}"` : ""} ${f.maxLength ? `maxlength="${f.maxLength}"` : ""} autocomplete="off">`;
      return `<div class="field ${f.full === false ? "" : "full"}">${f.type === "checkbox" ? "" : `<label for="${id}">${esc(f.label)}</label>`}${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ""}<div class="err" data-err="${f.name}"></div></div>`;
    }).join("") + (o.extra || "") + "</form>";
    const m = modal({ title: o.title, html, body: html, wide: o.wide, buttons: [{ text: "Cancel" }, { text: o.submitText || "Save", cls: o.danger ? "danger" : "", onClick: submit }] });
    const form = m.body.querySelector("form");
    form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    async function submit() {
      const vals = {}; let bad = false;
      form.querySelectorAll("[data-err]").forEach((x) => (x.textContent = ""));
      for (const f of o.fields) {
        const el = form.elements[f.name]; let v = f.type === "checkbox" ? el.checked : el.value.trim();
        const fail = (msg) => { form.querySelector(`[data-err="${f.name}"]`).textContent = msg; bad = true; };
        if (f.type === "number" && v !== "") { v = Number(v); if (isNaN(v)) { fail("Enter a number."); continue; } if (f.min != null && v < f.min) fail("Minimum is " + f.min + "."); if (f.max != null && v > f.max) fail("Maximum is " + f.max + "."); }
        else if (f.required && f.type !== "checkbox" && v === "") fail("This field is required.");
        else if (f.minLength && v.length < f.minLength) fail("Use at least " + f.minLength + " characters.");
        if (f.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail("Enter a valid email address.");
        vals[f.name] = v;
      }
      if (bad) return;
      try { await o.onSubmit(vals, m); m.close(); } catch (e) { console.error(e); toast(util.errMsg(e), "error"); }
    }
    return m;
  }

  async function busy(btn, fn) {
    if (btn) { btn.disabled = true; btn.dataset.t = btn.textContent; }
    try { return await fn(); } finally { if (btn) { btn.disabled = false; if (btn.dataset.t) btn.textContent = btn.dataset.t; } }
  }

  /* ---------- CSV / download ---------- */
  const csvCell = (v) => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/csv;charset=utf-8" }); const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------- shared calculations ---------- */
  const DEFAULT_RULES = { bands: [{ min: 70, grade: "A" }, { min: 60, grade: "B" }, { min: 50, grade: "C" }, { min: 45, grade: "D" }, { min: 40, grade: "E" }, { min: 0, grade: "F" }], categoryWeights: null, attendance: { lateWeight: 1, minimumPercent: 75 } };
  const logic = {
    DEFAULT_RULES,
    rules(group) {
      const r = util.json(group && group.gradingRules, null) || {};
      const bands = Array.isArray(r.bands) && r.bands.length ? r.bands.map((b) => ({ min: Number(b.min), grade: String(b.grade) })).filter((b) => !isNaN(b.min)).sort((a, b) => b.min - a.min) : DEFAULT_RULES.bands;
      return { bands, categoryWeights: r.categoryWeights && typeof r.categoryWeights === "object" ? r.categoryWeights : null, attendance: Object.assign({}, DEFAULT_RULES.attendance, r.attendance || {}) };
    },
    gradeFor(percent, rules) { if (percent == null) return "—"; const b = rules.bands.find((x) => percent >= x.min); return b ? b.grade : "—"; },
    // Attendance % is calculated separately from academic marks: attended / finalised sessions.
    attendancePercent(records, finalisedSessionCount, rules) {
      if (!finalisedSessionCount) return null;
      const w = rules.attendance.lateWeight;
      const attended = records.reduce((n, r) => n + (r.status === "present" ? 1 : r.status === "late" ? w : 0), 0);
      return (attended / finalisedSessionCount) * 100;
    },
    // Academic total for one student. Attendance columns are never included.
    // A column counts for a student once that student has a score in it (blank = not yet graded, "excused" = ignored),
    // so empty or future columns never lower anyone's total. Students can compute the same figure from their own scores.
    academic(columns, scoresByCol, studentId, rules) {
      const cols = columns.filter((c) => c.category !== "attendance" && !c.isArchived);
      const cat = {}; let total = 0, max = 0;
      cols.forEach((c) => {
        const s = (scoresByCol[c.$id] || {})[studentId];
        if (!s || s.score == null || s.status === "excused") return;
        const v = Number(s.score), m = Number(c.maximumScore);
        total += v; max += m;
        const k = (cat[c.category] = cat[c.category] || { s: 0, m: 0 }); k.s += v; k.m += m;
      });
      if (!max) return { total: 0, max: 0, percent: null, grade: "\u2014" };
      let percent = (total / max) * 100;
      if (rules.categoryWeights) {
        let wsum = 0, acc = 0;
        Object.entries(cat).forEach(([k, v]) => { const w = Number(rules.categoryWeights[k]); if (w > 0 && v.m > 0) { wsum += w; acc += w * (v.s / v.m) * 100; } });
        if (wsum > 0) percent = acc / wsum;
      }
      return { total, max, percent, grade: logic.gradeFor(percent, rules) };
    }
  };

  /* ---------- shell ---------- */
  const ICON = {
    home: '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    book: '<path d="M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z"/><path d="M4 17a3 3 0 0 1 3-3h12"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 20a6 6 0 0 0-3-5"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>'
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
  const NAV = {
    student: [["dashboard", "Dashboard", "home"], ["courses", "My courses", "book"], ["attendance", "Attendance", "check"], ["performance", "Performance", "chart"], ["profile", "Profile", "user"]],
    lecturer: [["dashboard", "Dashboard", "home"], ["courses", "Courses", "book"], ["students", "Students", "users"], ["attendance", "Attendance", "check"], ["gradebook", "Gradebook", "grid"], ["reports", "Reports", "file"], ["profile", "Profile", "user"]]
  };

  function renderShell(ctx, role, page, title) {
    const root = document.getElementById("app");
    const links = NAV[role].map(([k, l, i]) => `<a href="${k}.html" class="${k === page ? "active" : ""}" ${k === page ? 'aria-current="page"' : ""}>${svg(i)}<span>${l}</span></a>`).join("");
    root.innerHTML = `<div class="shell"><aside class="sidebar" id="sidebar"><div class="brand"><b>${esc(M.cfg.appName)}</b><span>${role === "lecturer" ? "Lecturer workspace" : "Student workspace"}</span></div><nav class="nav" aria-label="Main">${links}</nav><div class="side-foot"><b>${esc(ctx.profile.fullName)}</b>${esc(ctx.profile.institution)}<br><button class="btn secondary sm block" id="logoutBtn" style="margin-top:.6rem">Log out</button></div></aside><div class="scrim hidden" id="scrim"></div><div class="main"><header class="topbar"><button class="icon-btn" id="menuBtn" aria-label="Open menu"><svg viewBox="0 0 24 24">${ICON.menu}</svg></button><h1>${esc(title)}</h1></header><main class="content" id="view"></main></div></div><div id="toasts" aria-live="polite"></div>`;
    const sb = document.getElementById("sidebar"), sc = document.getElementById("scrim");
    const set = (o) => { sb.classList.toggle("open", o); sc.classList.toggle("hidden", !o); };
    document.getElementById("menuBtn").addEventListener("click", () => set(true));
    sc.addEventListener("click", () => set(false));
    sb.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => set(false)));
    document.getElementById("logoutBtn").addEventListener("click", async () => { if (await confirm({ title: "Log out?", message: "You will need to log in again to continue.", confirmText: "Log out" })) M.auth.logout(); });
    return document.getElementById("view");
  }

  const view = () => document.getElementById("view");
  const pageHead = (title, sub, actions) => `<div class="page-head row between"><div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ""}</div>${actions ? `<div class="row">${actions}</div>` : ""}</div>`;

  /* ---------- boot ---------- */
  async function boot() {
    const d = document.body.dataset; const role = d.role; const page = d.page;
    try {
      if (role === "none") return;
      if (role === "public") { const fn = M.pages["public/" + page]; if (fn) fn(); return; }
      const ctx = await M.auth.requireRole(role); if (!ctx) return;
      const el = renderShell(ctx, role, page, d.title || page);
      el.innerHTML = spinner();
      if (role === "lecturer" && M.cfg.lecturerTeamId && ctx.teamOk === false) el.innerHTML = '<div class="notice warn"><b>Awaiting approval.</b> Your lecturer account is not yet in the institution\'s Lecturers team, so you cannot create or manage courses. Ask your administrator to add you, then reload.</div>';
      else if (role === "lecturer" && !M.cfg.lecturerTeamId) el.innerHTML = '<div class="notice warn small"><b>Pilot mode.</b> No Lecturers team is configured, so any registered lecturer account is trusted. Set <span class="mono">lecturerTeamId</span> before real use.</div><div id="pageRoot"></div>';
      else el.innerHTML = '<div id="pageRoot"></div>';
      if (role === "lecturer" && M.cfg.lecturerTeamId && ctx.teamOk === false) return;
      const root = document.getElementById("pageRoot"); root.innerHTML = spinner();
      const fn = M.pages[role + "/" + page];
      if (fn) await fn(root, ctx); else root.innerHTML = empty("Page not available");
    } catch (e) { console.error(e); toast(util.errMsg(e), "error"); const r = document.getElementById("pageRoot") || view(); if (r) r.innerHTML = `<div class="notice bad"><b>Could not load this page.</b> ${esc(util.errMsg(e))}</div>`; }
  }

  M.ui = { toast, loading, modal, confirm, formModal, busy, spinner, empty, badge, esc, fmt, download, toCSV, pageHead, view };
  M.logic = Object.assign(M.logic || {}, logic);
  M.boot = boot;
  document.addEventListener("DOMContentLoaded", () => { if (!document.body.dataset.manualBoot) setTimeout(boot, 0); });
})();
