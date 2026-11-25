/* =========================
FILE OVERVIEW
========================= */
// Authentication, profiles, role guards, and the login / register page logic.
// Passwords go to Appwrite Authentication only. They are never written to any database document.

(function () {
  const M = window.Attend;
  const { account, db, perm, util, ID } = M;
  const base = () => document.body.dataset.base || "";
  const HOME = { student: "student/dashboard.html", lecturer: "lecturer/dashboard.html" };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* ---------- session + profile ---------- */
  async function currentUser() { try { return await account.get(); } catch (_) { return null; } }

  async function loadContext() {
    const user = await currentUser();
    if (!user) return null;
    const profile = await db.tryGet("userProfiles", user.$id);
    const ctx = { user, profile, student: null, lecturer: null, teamOk: null };
    if (profile && profile.role === "student") ctx.student = await db.tryGet("studentProfiles", user.$id);
    if (profile && profile.role === "lecturer") { ctx.lecturer = await db.tryGet("lecturerProfiles", user.$id); ctx.teamOk = await M.inLecturerTeam(); }
    return ctx;
  }

  async function login(email, password) {
    const existing = await currentUser();
    if (existing && existing.email.toLowerCase() === email.toLowerCase()) return existing;
    if (existing) { try { await account.deleteSession("current"); } catch (_) {} }
    await account.createEmailSession(email, password);
    return account.get();
  }

  async function logout() {
    try { await account.deleteSession("current"); } catch (_) {}
    M.ctx = null;
    window.location.replace(base() + "login.html");
  }

  /* ---------- page guard ---------- */
  async function requireRole(role) {
    if (!M.isConfigured()) { renderSetupNeeded(); return null; }
    const ctx = await loadContext();
    if (!ctx) { window.location.replace(base() + "login.html?next=" + encodeURIComponent(location.pathname.split("/").slice(-2).join("/"))); return null; }
    if (!ctx.profile) { window.location.replace(base() + "register.html?complete=1"); return null; }
    if (ctx.profile.role !== role) { window.location.replace(base() + HOME[ctx.profile.role]); return null; }
    M.ctx = ctx;
    return ctx;
  }

  function renderSetupNeeded() {
    document.body.innerHTML = '<div class="auth-body"><div class="auth-card"><h1>Connect Attend to Appwrite</h1><p>Open <span class="mono">assets/js/config.js</span> and set <span class="mono">projectId</span> and <span class="mono">databaseId</span> to the real IDs from your Appwrite project.</p></div></div>';
  }

  /* ---------- registration ---------- */
  async function createProfiles(user, role, f) {
    const now = util.iso(); const self = perm.self(user.$id);
    await db.create("userProfiles", user.$id, { userID: user.$id, fullName: f.fullName, email: user.email, role, institution: f.institution, department: f.department, createdAt: now }, self);
    if (role === "student") {
      await db.create("studentProfiles", user.$id, { userID: user.$id, matricNumber: f.matricNumber, studentID: f.studentID, faceEnrolled: false, createdAt: now }, self);
    } else {
      const d = { userID: user.$id, institution: f.institution, department: f.department };
      if (f.staffID) d.staffID = f.staffID;
      await db.create("lecturerProfiles", user.$id, d, self);
    }
  }

  async function register(role, f) {
    await account.create(ID.unique(), f.email, f.password, f.fullName);
    await account.createEmailSession(f.email, f.password);
    const user = await account.get();
    await createProfiles(user, role, f);
    return user;
  }

  function validate(role, f, complete) {
    const errs = {};
    if (f.fullName.length < 3) errs.fullName = "Enter your full name.";
    if (!complete) {
      if (!EMAIL_RE.test(f.email)) errs.email = "Enter a valid email address.";
      if (f.password.length < 8) errs.password = "Use at least 8 characters.";
    }
    if (f.institution.length < 2) errs.institution = "Enter your institution.";
    if (f.department.length < 2) errs.department = "Enter your department.";
    if (role === "student") {
      if (!/^[A-Za-z0-9\/\-_. ]{3,40}$/.test(f.matricNumber || "")) errs.matricNumber = "Enter your matriculation number (letters, numbers, / - _ .).";
      if (!/^[A-Za-z0-9\/\-_. ]{2,40}$/.test(f.studentID || "")) errs.studentID = "Enter your student ID.";
    } else if (f.staffID && !/^[A-Za-z0-9\/\-_. ]{2,40}$/.test(f.staffID)) errs.staffID = "Staff ID has invalid characters.";
    return errs;
  }

  /* ---------- page: login ---------- */
  function initLogin() {
    const form = document.getElementById("loginForm"); const btn = document.getElementById("loginBtn");
    if (!M.isConfigured()) { document.getElementById("setupWarn").classList.remove("hidden"); }
    currentUser().then(async (u) => { if (!u) return; const p = await db.tryGet("userProfiles", u.$id).catch(() => null); if (p) location.replace(base() + HOME[p.role]); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = form.email.value.trim().toLowerCase(); const password = form.password.value;
      if (!EMAIL_RE.test(email) || !password) return M.ui.toast("Enter your email and password.", "warning");
      btn.disabled = true; btn.textContent = "Logging in…";
      try {
        const user = await login(email, password);
        const profile = await db.tryGet("userProfiles", user.$id);
        if (!profile) return location.replace(base() + "register.html?complete=1");
        const next = new URLSearchParams(location.search).get("next");
        const ok = next && /^(student|lecturer)\/[a-z]+\.html$/.test(next) && next.startsWith(profile.role + "/");
        location.replace(base() + (ok ? next : HOME[profile.role]));
      } catch (err) {
        M.ui.toast(err.code === 401 ? "Incorrect email or password." : util.errMsg(err), "error");
        btn.disabled = false; btn.textContent = "Log in";
      }
    });
    document.getElementById("pwToggle").addEventListener("click", (e) => { const i = form.password; i.type = i.type === "password" ? "text" : "password"; e.target.textContent = i.type === "password" ? "Show" : "Hide"; });
    document.getElementById("forgot").addEventListener("click", async (e) => {
      e.preventDefault();
      M.ui.formModal({ title: "Reset password", submitText: "Send reset link", fields: [{ name: "email", label: "Account email", type: "email", required: true }],
        async onSubmit(v) { try { await account.createRecovery(v.email, new URL("login.html", location.href).href); } catch (_) {} M.ui.toast("If an account exists for that email, a reset link has been sent.", "success"); } });
    });
  }

  /* ---------- page: register ---------- */
  function initRegister() {
    const params = new URLSearchParams(location.search);
    const complete = params.get("complete") === "1";
    let role = params.get("role") === "lecturer" ? "lecturer" : "student";
    const form = document.getElementById("regForm"); const btn = document.getElementById("regBtn");
    const fieldsEl = document.getElementById("regFields");
    const FIELD = (name, label, type, extra) => `<div class="field ${extra && extra.full ? "full" : ""}"><label for="f_${name}">${label}</label><input id="f_${name}" name="${name}" type="${type || "text"}" ${extra && extra.req === false ? "" : "required"} autocomplete="${(extra && extra.ac) || "off"}"><div class="err" id="e_${name}"></div>${extra && extra.hint ? `<div class="hint">${extra.hint}</div>` : ""}</div>`;

    function draw() {
      document.querySelectorAll(".role-pick button").forEach((b) => b.classList.toggle("active", b.dataset.role === role));
      fieldsEl.innerHTML = FIELD("fullName", "Full name", "text", { ac: "name", full: true }) +
        (complete ? "" : FIELD("email", "Email", "email", { ac: "email" }) + FIELD("password", "Password", "password", { ac: "new-password", hint: "At least 8 characters." })) +
        FIELD("institution", "Institution", "text", { full: true }) + FIELD("department", "Department", "text", { full: true }) +
        (role === "student" ? FIELD("matricNumber", "Matriculation number", "text") + FIELD("studentID", "Student ID", "text") : FIELD("staffID", "Staff ID (optional)", "text", { req: false, full: true }));
      btn.textContent = complete ? "Finish setting up" : role === "student" ? "Create student account" : "Create lecturer account";
    }
    document.querySelectorAll(".role-pick button").forEach((b) => b.addEventListener("click", () => { role = b.dataset.role; draw(); }));
    if (complete) { document.getElementById("regTitle").textContent = "Finish your profile"; document.getElementById("regSwitch").classList.add("hidden"); }
    draw();
    if (!M.isConfigured()) document.getElementById("setupWarn").classList.remove("hidden");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const g = (n) => (form.elements[n] ? form.elements[n].value.trim() : "");
      const f = { fullName: g("fullName"), email: g("email").toLowerCase(), password: form.elements.password ? form.elements.password.value : "", institution: g("institution"), department: g("department"), matricNumber: g("matricNumber"), studentID: g("studentID"), staffID: g("staffID") };
      form.querySelectorAll(".err").forEach((x) => (x.textContent = ""));
      const errs = validate(role, f, complete);
      if (Object.keys(errs).length) { Object.entries(errs).forEach(([k, v]) => { const el = document.getElementById("e_" + k); if (el) el.textContent = v; }); return M.ui.toast("Please fix the highlighted fields.", "warning"); }
      btn.disabled = true; const label = btn.textContent; btn.textContent = "Please wait…";
      try {
        let user;
        if (complete) { user = await currentUser(); if (!user) return location.replace(base() + "login.html"); f.email = user.email; await createProfiles(user, role, f); }
        else user = await register(role, f);
        location.replace(base() + HOME[role]);
      } catch (err) {
        console.error("REGISTER ERROR", err);
        M.ui.toast(err.code === 409 ? "An account with this email already exists. Log in instead." : util.errMsg(err), "error");
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  M.auth = { currentUser, loadContext, login, logout, requireRole, register, createProfiles, HOME };
  M.pages = M.pages || {};
  M.pages["public/login"] = initLogin;
  M.pages["public/register"] = initRegister;
})();
