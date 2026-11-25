/* =========================
FILE OVERVIEW
========================= */
// Student pages: dashboard, performance, profile (including face enrolment). Also exposes the shared profile
// component used by the lecturer profile page. Students can only READ official attendance and scores.

(function () {
  const M = window.Attend;
  const { db, Query, util, ui } = M;
  const esc = util.esc;

  async function overview(sid) {
    const { members, groups } = await M.data.studentGroups(sid); const gids = groups.map((g) => g.$id);
    const [sessions, records, columns, scores] = await Promise.all([
      gids.length ? db.allIn("sessions", "groupID", gids, [Query.orderDesc("startTime")]) : [], db.all("records", [Query.equal("studentID", sid)]),
      gids.length ? db.allIn("columns", "groupID", gids) : [], db.all("scores", [Query.equal("studentID", sid)])
    ]);
    const perGroup = groups.map((g) => {
      const rules = M.logic.rules(g); const fin = sessions.filter((s) => s.groupID === g.$id && s.status === "finalised");
      const rs = records.filter((r) => r.groupID === g.$id);
      return { g, rules, sessions: fin.length, att: M.logic.attendancePercent(rs, fin.length, rules), cols: columns.filter((c) => c.groupID === g.$id), scores: scores.filter((s) => s.groupID === g.$id), ac: M.logic.academic(columns.filter((c) => c.groupID === g.$id), M.data.scoresByCol(scores.filter((s) => s.groupID === g.$id)), sid, rules) };
    });
    return { members, groups, sessions, records, perGroup };
  }

  /* ---------- dashboard ---------- */
  async function dashboard(root, ctx) {
    const sid = ctx.user.$id; let timer = null, unsub = null;
    async function draw() {
      const o = await overview(sid);
      const notes = await db.list("notifications", [Query.equal("userID", sid), Query.orderDesc("createdAt"), Query.limit(8)]).then((r) => r.documents).catch(() => []);
      const gmap = util.by(o.groups, "$id"); const sOf = util.by(o.sessions, "$id");
      const live = o.sessions.filter((s) => s.status === "active" && +new Date(s.endTime) > Date.now());
      const withAtt = o.perGroup.filter((x) => x.att != null); const overall = withAtt.length ? withAtt.reduce((a, x) => a + x.att, 0) / withAtt.length : null;
      const recent = o.records.filter((r) => sOf[r.sessionID]).sort((a, b) => +new Date(sOf[b.sessionID].startTime) - +new Date(sOf[a.sessionID].startTime)).slice(0, 6);
      const low = o.perGroup.filter((x) => x.att != null && x.att < x.rules.attendance.minimumPercent);
      root.innerHTML = ui.pageHead("Hello, " + ctx.profile.fullName.split(" ")[0], ctx.profile.institution + " · " + ctx.profile.department) +
        live.map((s) => `<div class="card session-banner" style="margin-bottom:1rem"><div><b>Attendance is open: ${esc(gmap[s.groupID].courseCode)}</b><div class="muted small">Closes at ${ui.fmt.t(s.endTime)}</div></div><a class="btn accent" href="attendance.html">Verify now</a></div>`).join("") +
        (low.length ? `<div class="notice warn"><b>Attendance warning.</b> You are below the required attendance in ${low.map((x) => esc(x.g.courseCode)).join(", ")}.</div>` : "") +
        `<div class="grid cols-4"><div class="card stat"><div class="num mono" style="font-size:1.25rem;padding:.4rem 0">${esc(ctx.student ? ctx.student.matricNumber : "—")}</div><div class="lbl">Matriculation number</div></div><div class="card stat"><div class="num">${o.groups.length}</div><div class="lbl">Joined courses</div></div><div class="card stat accent"><div class="num">${ui.fmt.pct(overall)}</div><div class="lbl">Overall attendance</div></div><div class="card stat"><div class="num">${live.length}</div><div class="lbl">Active sessions</div></div></div>
        <div class="grid split" style="margin-top:1rem"><div>
          <div class="card"><h2>Academic performance</h2>${o.perGroup.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Attendance</th><th>Score</th><th>Grade</th></tr></thead><tbody>${o.perGroup.map((x) => `<tr><td><b>${esc(x.g.courseCode)}</b></td><td>${ui.fmt.pct(x.att)}</td><td>${x.ac.max ? ui.fmt.num(x.ac.total) + "/" + ui.fmt.num(x.ac.max) : "—"}</td><td><b>${esc(x.ac.grade)}</b></td></tr>`).join("")}</tbody></table></div>` : ui.empty("No courses yet", "Join a course with a code from your lecturer.")}</div>
          <div class="card"><h2>Recent attendance</h2>${recent.length ? `<ul class="list">${recent.map((r) => `<li><div><b>${esc((gmap[r.groupID] || {}).courseCode || "")}</b><div class="muted small">${ui.fmt.dt(sOf[r.sessionID].startTime)}</div></div>${ui.badge(r.status)}</li>`).join("")}</ul>` : ui.empty("No records yet")}</div>
        </div><div class="card"><div class="row between"><h2>Notifications</h2>${notes.some((n) => !n.isRead) ? '<button class="btn sm ghost" id="readAll">Mark all read</button>' : ""}</div>${notes.length ? `<ul class="list">${notes.map((n) => `<li style="align-items:flex-start"><div><b>${esc(n.title)}</b>${n.isRead ? "" : ' <span class="badge info">new</span>'}<div class="muted small">${esc(n.message)}</div><div class="muted small">${ui.fmt.dt(n.createdAt)}</div></div></li>`).join("")}</ul>` : ui.empty("Nothing new")}</div></div>`;
      const ra = root.querySelector("#readAll"); if (ra) ra.addEventListener("click", async () => { await Promise.allSettled(notes.filter((n) => !n.isRead).map((n) => db.update("notifications", n.$id, { isRead: true }))); draw(); });
    }
    await draw();
    let t; unsub = db.subscribe(["notifications", "sessions", "records", "scores"], () => { clearTimeout(t); t = setTimeout(() => draw().catch(() => {}), 1000); });
  }

  /* ---------- performance ---------- */
  async function performance(root, ctx) {
    const o = await overview(ctx.user.$id);
    root.innerHTML = ui.pageHead("Performance", "Your attendance and results by course. Attendance is reported separately from academic marks.") +
      (o.perGroup.length ? o.perGroup.map((x) => { const cols = x.cols.filter((c) => c.category !== "attendance" && !c.isArchived).sort((a, b) => a.columnOrder - b.columnOrder); const sc = util.by(x.scores, "columnID");
        return `<div class="card"><div class="row between"><h2>${esc(x.g.courseCode)} · ${esc(x.g.courseName)}</h2><span class="badge info">Grade ${esc(x.ac.grade)}</span></div>
          <div class="grid cols-3" style="margin-bottom:.8rem"><div><div class="pct">${ui.fmt.pct(x.att)}</div><div class="muted small">Attendance · ${x.sessions} sessions</div><div class="progress ${x.att != null && x.att < x.rules.attendance.minimumPercent ? "low" : "good"}" style="margin-top:.3rem"><i style="width:${Math.min(100, x.att || 0)}%"></i></div></div><div><div class="pct">${x.ac.max ? ui.fmt.num(x.ac.total) + "/" + ui.fmt.num(x.ac.max) : "—"}</div><div class="muted small">Academic score so far</div></div><div><div class="pct">${ui.fmt.pct(x.ac.percent)}</div><div class="muted small">Academic percent</div></div></div>
          ${cols.length ? `<div class="table-wrap"><table><thead><tr><th>Assessment</th><th>Type</th><th>Score</th><th>Out of</th></tr></thead><tbody>${cols.map((c) => { const s = sc[c.$id]; return `<tr><td>${esc(c.columnName)}</td><td>${esc(c.category)}</td><td>${s ? (s.status === "excused" ? "Excused" : ui.fmt.num(s.score)) : "—"}</td><td>${ui.fmt.num(c.maximumScore)}</td></tr>`; }).join("")}</tbody></table></div>` : '<p class="muted">No assessments yet.</p>'}</div>`; }).join("") : `<div class="card">${ui.empty("No courses yet", "Your results appear after you join a course.")}</div>`);
  }

  /* ---------- profile (shared by both roles) ---------- */
  async function profile(root, ctx, role) {
    const p = ctx.profile; const isStudent = role === "student";
    root.innerHTML = ui.pageHead("Profile", "Your account details and security.") +
      `<div class="card"><div class="row between"><h2>Details</h2><button class="btn sm secondary" id="edit">Edit</button></div><dl style="margin:0;display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1.2rem"><dt class="muted">Name</dt><dd style="margin:0">${esc(p.fullName)}</dd><dt class="muted">Email</dt><dd style="margin:0">${esc(p.email)}</dd><dt class="muted">Role</dt><dd style="margin:0">${esc(p.role)}</dd><dt class="muted">Institution</dt><dd style="margin:0">${esc(p.institution)}</dd><dt class="muted">Department</dt><dd style="margin:0">${esc(p.department)}</dd>${isStudent ? `<dt class="muted">Matric no.</dt><dd style="margin:0">${esc(ctx.student ? ctx.student.matricNumber : "—")}</dd><dt class="muted">Student ID</dt><dd style="margin:0">${esc(ctx.student ? ctx.student.studentID : "—")}</dd>` : `<dt class="muted">Staff ID</dt><dd style="margin:0">${esc((ctx.lecturer && ctx.lecturer.staffID) || "—")}</dd>`}</dl></div>
      ${isStudent ? '<div class="card" id="faceCard"></div>' : ""}
      <div class="card"><h2>Change password</h2><form id="pwForm" class="form-grid"><div class="field"><label>Current password</label><input type="password" name="old" autocomplete="current-password" required></div><div class="field"><label>New password</label><input type="password" name="nw" autocomplete="new-password" minlength="8" required></div><div class="full"><button class="btn" type="submit">Update password</button></div></form></div>
      <div class="card"><h2>Session</h2><p class="muted">Log out of this device.</p><button class="btn secondary" id="out">Log out</button></div>`;
    root.querySelector("#edit").addEventListener("click", () => ui.formModal({ title: "Edit details", fields: [{ name: "fullName", label: "Full name", value: p.fullName, required: true, minLength: 3 }, { name: "institution", label: "Institution", value: p.institution, required: true }, { name: "department", label: "Department", value: p.department, required: true }].concat(isStudent ? [] : [{ name: "staffID", label: "Staff ID (optional)", value: (ctx.lecturer && ctx.lecturer.staffID) || "" }]),
      async onSubmit(v) { await db.update("userProfiles", ctx.user.$id, { fullName: v.fullName, institution: v.institution, department: v.department }); if (!isStudent && ctx.lecturer) await db.update("lecturerProfiles", ctx.user.$id, { institution: v.institution, department: v.department, staffID: v.staffID || "" }); ui.toast("Profile updated.", "success"); setTimeout(() => location.reload(), 600); } }));
    root.querySelector("#pwForm").addEventListener("submit", async (e) => { e.preventDefault(); const f = e.target; if (f.nw.value.length < 8) return ui.toast("Use at least 8 characters.", "warning"); try { await M.account.updatePassword(f.nw.value, f.old.value); ui.toast("Password updated.", "success"); f.reset(); } catch (err) { ui.toast(err.code === 401 ? "Current password is incorrect." : util.errMsg(err), "error"); } });
    root.querySelector("#out").addEventListener("click", () => M.auth.logout());
    if (isStudent) faceCard(root.querySelector("#faceCard"), ctx);
  }

  async function faceCard(el, ctx) {
    const sid = ctx.user.$id; el.innerHTML = "<h2>Face enrolment</h2>" + ui.spinner("Checking…");
    const [enrol, st] = await Promise.all([M.face.getEnrolment(sid).catch(() => null), M.face.status()]);
    el.innerHTML = `<h2>Face enrolment</h2>${st.ready ? "" : `<div class="notice warn small"><b>Face recognition model not installed.</b> ${esc(st.reason || "")} Enrolment and face verification are switched off until your administrator installs a model.</div>`}
      <p>${enrol && enrol.status === "enrolled" ? `Enrolled on ${ui.fmt.d(enrol.enrolledAt)} <span class="muted small">(model ${esc(enrol.modelVersion)})</span>` : "You have not enrolled your face."}</p>
      <p class="muted small">Only a numeric face template is stored, not your photo. It is private to you, and is shared with a course lecturer only when you submit a face-checked attendance claim for that course.</p>
      <div class="table-actions"><button class="btn" id="enrol" ${st.ready ? "" : "disabled"}>${enrol ? "Re-enrol face" : "Enrol face"}</button>${enrol ? '<button class="btn secondary" id="rmFace">Remove enrolment</button>' : ""}</div>`;
    el.querySelector("#enrol").addEventListener("click", () => {
      const N = M.cfg.face.enrolFrames; let shots = [];
      const m = ui.modal({ title: "Enrol your face", body: `<p class="muted small">Face the camera in good light with nothing covering your face. You will be asked to blink and turn your head (a liveness check), then we take ${N} quick photos. Only you should be in the frame.</p><div class="cam-box"><video id="cv" autoplay muted playsinline></video><div class="oval"></div></div><div id="est" class="notice info small">Starting camera…</div>`, onClose: M.face.stopCamera,
        buttons: [{ text: "Cancel" }, { text: "Capture", cls: "accent", async onClick() {
          const out = m.body.querySelector("#est"); out.className = "notice info small"; shots = [];
          try {
            if (M.cfg.face.livenessRequired) { const lv = await M.face.liveness(m.body.querySelector("#cv"), (t) => { out.className = "notice warn small"; out.textContent = t; }); if (!lv.ok) { out.className = "notice bad small"; out.textContent = lv.reason + " Press Capture to retry."; return; } out.className = "notice info small"; }
            for (let i = 0; i < N; i++) { out.textContent = "Capturing " + (i + 1) + " of " + N + "…"; shots.push(M.face.capture(m.body.querySelector("#cv"))); await new Promise((r) => setTimeout(r, 450)); }
            out.textContent = "Creating template…"; await M.face.enrol(sid, shots); M.face.stopCamera(); ui.toast("Face enrolled.", "success"); m.close(); faceCard(el, ctx);
          } catch (e) { out.className = "notice bad small"; out.textContent = util.errMsg(e) + " Press Capture to retake."; }
        } }] });
      M.face.startCamera(m.body.querySelector("#cv")).then(() => (m.body.querySelector("#est").textContent = "Camera ready. Press Capture.")).catch((e) => { m.body.querySelector("#est").className = "notice bad small"; m.body.querySelector("#est").textContent = util.errMsg(e); });
    });
    const rm = el.querySelector("#rmFace"); if (rm) rm.addEventListener("click", async () => { if (await ui.confirm({ title: "Remove face enrolment?", message: "You will not be able to pass face-checked sessions until you enrol again.", confirmText: "Remove", danger: true })) { try { await M.face.removeEnrolment(sid); faceCard(el, ctx); } catch (e) { ui.toast(util.errMsg(e), "error"); } } });
  }

  M.profile = profile;
  M.pages = M.pages || {};
  M.pages["student/dashboard"] = dashboard;
  M.pages["student/performance"] = performance;
  M.pages["student/profile"] = (r, c) => profile(r, c, "student");
})();
