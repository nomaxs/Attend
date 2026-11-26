/* =========================
FILE OVERVIEW
========================= */
// Course groups: lecturer management (create/edit/join codes/enrolment) and student joining + course detail views.
// Membership model: a student joins a course by entering its join code, which creates their own group_members document
// straight away (no approval step). Joining never marks anyone present: attendance still needs the Bluetooth proof, the
// lecturer's approval in the live roll and, when required, the face check. The lecturer can remove (and restore) any member.

(function () {
  const M = window.Attend;
  const { db, Query, util, perm, ui } = M;
  const esc = util.esc;

  /* ---------- shared data loaders ---------- */
  const data = {
    lecturerGroups: (lecturerId) => db.all("groups", [Query.equal("lecturerID", lecturerId), Query.orderDesc("createdAt")]),
    groupMembers: (groupId) => db.all("groupMembers", [Query.equal("groupID", groupId), Query.equal("status", "active"), Query.orderAsc("studentName")]),
    removedMembers: (groupId) => db.all("groupMembers", [Query.equal("groupID", groupId), Query.equal("status", "removed"), Query.orderAsc("studentName")]),
    async studentGroups(studentId) {
      const members = await db.all("groupMembers", [Query.equal("studentID", studentId), Query.equal("status", "active")]);
      const groups = members.length ? await db.allIn("groups", "$id", members.map((m) => m.groupID)) : [];
      return { members, groups: groups.sort((a, b) => a.courseName.localeCompare(b.courseName)) };
    },
    finalisedSessions: (groupId) => db.all("sessions", [Query.equal("groupID", groupId), Query.equal("status", "finalised"), Query.orderAsc("startTime")]),
    async count(key, queries) { const r = await db.list(key, [...queries, Query.limit(1)]); return r.total; },
    scoresByCol(scores) { const o = {}; scores.forEach((s) => { (o[s.columnID] = o[s.columnID] || {})[s.studentID] = s; }); return o; }
  };

  /* ---------- lecturer: create / edit course ---------- */
  async function createGroupDoc(ctx, v) {
    const lecturerId = ctx.user.$id; const now = util.iso();
    for (let i = 0; i < 5; i++) {
      try {
        return await db.create("groups", null, { lecturerID: lecturerId, lecturerName: ctx.profile.fullName, courseName: v.courseName, courseCode: v.courseCode.toUpperCase(), joinCode: util.joinCode(8), description: v.description || "", institution: ctx.profile.institution, department: v.department, createdAt: now, isActive: true, gradingRules: JSON.stringify(M.logic.DEFAULT_RULES) }, perm.publicToUsers(lecturerId));
      } catch (e) { if (e.code !== 409) throw e; } // join code collision: try another
    }
    throw new Error("Could not generate a unique join code. Try again.");
  }

  function courseFields(g, ctx) {
    return [
      { name: "courseName", label: "Course name", value: g && g.courseName, required: true, maxLength: 160 },
      { name: "courseCode", label: "Course code", value: g && g.courseCode, required: true, maxLength: 24, hint: "For example CSC 301" },
      { name: "department", label: "Department", value: (g && g.department) || ctx.profile.department, required: true, maxLength: 160 },
      { name: "description", label: "Description", type: "textarea", value: g && g.description, maxLength: 1000 }
    ];
  }

  /* ---------- lecturer: enrolment panel (enrolled + removed students) ---------- */
  async function removeMember(ctx, group, member) {
    await db.update("groupMembers", member.$id, { status: "removed" });
    await M.audit(ctx.user.$id, "member.remove", "group_members", member.$id, { status: "active" }, { status: "removed", studentID: member.studentID });
    await M.notify(member.studentID, "Removed from " + group.courseCode, "You were removed from " + group.courseName + ".", "course", group.$id);
  }
  async function restoreMember(ctx, group, member) {
    await db.update("groupMembers", member.$id, { status: "active" });
    await M.audit(ctx.user.$id, "member.restore", "group_members", member.$id, { status: "removed" }, { status: "active", studentID: member.studentID });
    await M.notify(member.studentID, "Re-added to " + group.courseCode, "You can take part in " + group.courseName + " again.", "course", group.$id);
  }

  async function enrolmentModal(ctx, group, onChange) {
    const m = ui.modal({ title: group.courseCode + " students", wide: true, body: ui.spinner() });
    async function draw() {
      const [members, removed] = await Promise.all([data.groupMembers(group.$id), data.removedMembers(group.$id)]);
      const q = (m.body.querySelector("#sq") || {}).value || "";
      const shown = members.filter((x) => !q || (x.studentName + " " + x.matricNumber).toLowerCase().includes(q.toLowerCase()));
      m.body.innerHTML = `<div class="row between"><h3>Enrolled (${members.length})</h3><input id="sq" type="search" placeholder="Search name or matric no." value="${esc(q)}" style="max-width:260px"></div>
        <p class="muted small">Students join with the code ${esc(group.joinCode)} on their own. Remove anyone who should not be in this course.</p>
        ${shown.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Matric no.</th><th>Joined</th><th></th></tr></thead><tbody>${shown.map((x) => `<tr><td>${esc(x.studentName)}</td><td>${esc(x.matricNumber)}</td><td>${ui.fmt.d(x.joinedAt)}</td><td><button class="btn sm danger" data-a="rm" data-id="${x.$id}">Remove</button></td></tr>`).join("")}</tbody></table></div>` : ui.empty("No students yet", "Share the join code " + group.joinCode + " with your class.")}
        ${removed.length ? `<h3 style="margin-top:1.2rem">Removed (${removed.length})</h3><ul class="list">${removed.map((x) => `<li><span>${esc(x.studentName)} <span class="muted small">${esc(x.matricNumber)}</span></span><button class="btn sm secondary" data-a="re" data-id="${x.$id}">Restore</button></li>`).join("")}</ul>` : ""}`;
      const s = m.body.querySelector("#sq"); s.addEventListener("input", () => { const pos = s.selectionStart; draw().then(() => { const n = m.body.querySelector("#sq"); n.focus(); n.setSelectionRange(pos, pos); }); });
      m.body.querySelectorAll("button[data-a]").forEach((b) => b.addEventListener("click", async () => {
        const id = b.dataset.id; const a = b.dataset.a;
        try {
          if (a === "rm") { const mem = members.find((x) => x.$id === id); if (!(await ui.confirm({ title: "Remove student?", message: mem.studentName + " will lose access to this course. Their past attendance records are kept.", confirmText: "Remove", danger: true }))) return; await removeMember(ctx, group, mem); }
          else await ui.busy(b, () => restoreMember(ctx, group, removed.find((x) => x.$id === id)));
          ui.toast("Done.", "success"); await draw(); if (onChange) onChange();
        } catch (e) { ui.toast(util.errMsg(e), "error"); }
      }));
    }
    try { await draw(); } catch (e) { m.body.innerHTML = `<div class="notice bad">${esc(util.errMsg(e))}</div>`; }
  }

  /* ---------- page: lecturer/courses ---------- */
  async function lecturerCourses(root, ctx) {
    const lecturerId = ctx.user.$id;
    async function draw() {
      const groups = await data.lecturerGroups(lecturerId);
      const counts = await Promise.all(groups.map(async (g) => ({ id: g.$id, members: await data.count("groupMembers", [Query.equal("groupID", g.$id), Query.equal("status", "active")]) })));
      const c = util.by(counts, "id");
      root.innerHTML = ui.pageHead("Courses", "Create course groups, share join codes and manage who is enrolled.", '<button class="btn accent" id="newCourse">New course</button>') +
        (groups.length ? `<div class="grid cols-2">${groups.map((g) => `<article class="card course-card">
          <div class="row between"><span class="code">${esc(g.courseCode)}</span>${ui.badge(g.isActive ? "active" : "closed")}</div>
          <h3>${esc(g.courseName)}</h3><p class="muted small">${esc(g.description || "No description")}<br>${esc(g.institution)} · ${esc(g.department)} · created ${ui.fmt.d(g.createdAt)}</p>
          <div class="row"><span class="joincode" title="Join code">${esc(g.joinCode)}</span><button class="btn sm secondary" data-a="copy" data-id="${g.$id}">Copy</button><button class="btn sm ghost" data-a="regen" data-id="${g.$id}">New code</button></div>
          <div class="row small"><span><b>${c[g.$id].members}</b> enrolled</span></div>
          <div class="table-actions"><button class="btn sm" data-a="students" data-id="${g.$id}">Students</button><a class="btn sm secondary" href="attendance.html?group=${g.$id}">Attendance</a><a class="btn sm secondary" href="gradebook.html?group=${g.$id}">Gradebook</a><button class="btn sm secondary" data-a="edit" data-id="${g.$id}">Edit</button><button class="btn sm ghost" data-a="toggle" data-id="${g.$id}">${g.isActive ? "Close joining" : "Reopen"}</button></div>
        </article>`).join("")}</div>` : `<div class="card">${ui.empty("No courses yet", "Create your first course group to get a join code for your students.")}</div>`);
      root.querySelector("#newCourse").addEventListener("click", () => ui.formModal({ title: "New course", fields: courseFields(null, ctx), submitText: "Create course", async onSubmit(v) { const g = await createGroupDoc(ctx, v); await M.audit(lecturerId, "group.create", "groups", g.$id, null, { courseCode: g.courseCode }); ui.toast("Course created. Join code: " + g.joinCode, "success"); draw(); } }));
      root.querySelectorAll("button[data-a]").forEach((b) => b.addEventListener("click", async () => {
        const g = groups.find((x) => x.$id === b.dataset.id); const a = b.dataset.a;
        try {
          if (a === "copy") { try { await navigator.clipboard.writeText(g.joinCode); ui.toast("Join code copied.", "success"); } catch (_) { ui.toast("Join code: " + g.joinCode, "info"); } }
          else if (a === "students") enrolmentModal(ctx, g, draw);
          else if (a === "edit") ui.formModal({ title: "Edit course", fields: courseFields(g, ctx), async onSubmit(v) { await db.update("groups", g.$id, { courseName: v.courseName, courseCode: v.courseCode.toUpperCase(), department: v.department, description: v.description }); await M.audit(lecturerId, "group.edit", "groups", g.$id, { courseName: g.courseName, courseCode: g.courseCode }, v); ui.toast("Course updated.", "success"); draw(); } });
          else if (a === "regen") { if (!(await ui.confirm({ title: "Generate a new join code?", message: "The old code will stop working. Students already enrolled are not affected.", confirmText: "Generate" }))) return; for (let i = 0; i < 5; i++) { try { const code = util.joinCode(8); await db.update("groups", g.$id, { joinCode: code }); await M.audit(lecturerId, "group.joincode", "groups", g.$id); ui.toast("New join code: " + code, "success"); break; } catch (e) { if (e.code !== 409) throw e; } } draw(); }
          else if (a === "toggle") { await db.update("groups", g.$id, { isActive: !g.isActive }); ui.toast(g.isActive ? "New joins are closed." : "Joining reopened.", "success"); draw(); }
        } catch (e) { ui.toast(util.errMsg(e), "error"); }
      }));
    }
    await draw();
  }

  /* ---------- student: course detail (details / attendance / results) ---------- */
  async function loadCourseData(groupId, studentId) {
    const [sessions, records, columns, scores] = await Promise.all([
      data.finalisedSessions(groupId),
      db.all("records", [Query.equal("groupID", groupId), Query.equal("studentID", studentId)]),
      db.all("columns", [Query.equal("groupID", groupId)]),
      db.all("scores", [Query.equal("groupID", groupId), Query.equal("studentID", studentId)])
    ]);
    return { sessions, records, columns, scores };
  }

  function summarise(group, d, studentId) {
    const rules = M.logic.rules(group);
    const attendance = M.logic.attendancePercent(d.records, d.sessions.length, rules);
    const academic = M.logic.academic(d.columns, data.scoresByCol(d.scores), studentId, rules);
    return { rules, attendance, academic };
  }

  async function courseDetail(group, studentId) {
    const m = ui.modal({ title: group.courseCode + " · " + group.courseName, wide: true, body: ui.spinner() });
    try {
      const d = await loadCourseData(group.$id, studentId); const s = summarise(group, d, studentId);
      const recBySession = util.by(d.records, "sessionID");
      const cols = d.columns.filter((c) => c.category !== "attendance" && !c.isArchived).sort((a, b) => a.columnOrder - b.columnOrder);
      const scoreByCol = util.by(d.scores, "columnID");
      const panes = {
        details: `<p>${esc(group.description || "No description provided.")}</p><p class="muted small">Lecturer: ${esc(group.lecturerName)}<br>${esc(group.institution)} · ${esc(group.department)}</p><div class="grid cols-3"><div class="card stat"><div class="num">${ui.fmt.pct(s.attendance)}</div><div class="lbl">Attendance (${d.sessions.length} sessions)</div></div><div class="card stat"><div class="num">${s.academic.max ? ui.fmt.num(s.academic.total) + "/" + ui.fmt.num(s.academic.max) : "—"}</div><div class="lbl">Academic score so far</div></div><div class="card stat accent"><div class="num">${esc(s.academic.grade)}</div><div class="lbl">Current grade</div></div></div>${s.attendance != null && s.attendance < s.rules.attendance.minimumPercent ? `<div class="notice warn" style="margin-top:1rem">Your attendance is below this course's ${s.rules.attendance.minimumPercent}% requirement.</div>` : ""}`,
        attendance: d.sessions.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Status</th><th>Verified at</th></tr></thead><tbody>${d.sessions.slice().reverse().map((x) => { const r = recBySession[x.$id]; return `<tr><td>${ui.fmt.dt(x.startTime)}</td><td>${r ? ui.badge(r.status) : "—"}</td><td>${r && r.verifiedAt ? ui.fmt.t(r.verifiedAt) : "—"}</td></tr>`; }).join("")}</tbody></table></div>` : ui.empty("No attendance yet", "Finalised sessions will appear here."),
        results: cols.length ? `<div class="table-wrap"><table><thead><tr><th>Assessment</th><th>Type</th><th>Score</th><th>Out of</th></tr></thead><tbody>${cols.map((c) => { const sc = scoreByCol[c.$id]; return `<tr><td>${esc(c.columnName)}</td><td>${esc(c.category)}</td><td>${sc ? (sc.status === "excused" ? "Excused" : ui.fmt.num(sc.score)) : "—"}</td><td>${ui.fmt.num(c.maximumScore)}</td></tr>`; }).join("")}</tbody></table></div><p class="muted small" style="margin-top:.6rem">Attendance is reported separately and is not included in the academic score.</p>` : ui.empty("No results yet", "Scores appear here once your lecturer enters them.")
      };
      m.body.innerHTML = `<div class="tabs">${Object.keys(panes).map((k, i) => `<button data-t="${k}" class="${i ? "" : "active"}">${{ details: "Details", attendance: "Attendance", results: "Results" }[k]}</button>`).join("")}</div><div id="pane">${panes.details}</div>`;
      m.body.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { m.body.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b)); m.body.querySelector("#pane").innerHTML = panes[b.dataset.t]; }));
    } catch (e) { m.body.innerHTML = `<div class="notice bad">${esc(util.errMsg(e))}</div>`; }
  }

  /* ---------- page: student/courses ---------- */
  async function studentCourses(root, ctx) {
    const sid = ctx.user.$id;
    async function draw() {
      const { members, groups } = await data.studentGroups(sid); const memOf = util.by(members, "groupID");
      root.innerHTML = ui.pageHead("My courses", "Enter the join code from your lecturer. You are added straight away.") +
        `<div class="card"><h2>Join a course</h2><form id="joinForm" class="row"><div class="grow"><input id="joinCode" type="text" placeholder="Join code, e.g. K7M2QX9P" maxlength="12" autocapitalize="characters" autocomplete="off" aria-label="Join code" required></div><button class="btn accent" type="submit">Join course</button></form><p class="muted small" style="margin:.6rem 0 0">Joining does not mark you present. Attendance is only recorded when you verify in the classroom with Bluetooth (and a face check when the lecturer requires it).</p></div>` +
        `<h2 style="margin:1.4rem 0 .6rem">Joined courses</h2>` + (groups.length ? `<div class="grid cols-2">${groups.map((g) => `<article class="card course-card"><span class="code">${esc(g.courseCode)}</span><h3>${esc(g.courseName)}</h3><p class="muted small">${esc(g.lecturerName)} · ${esc(g.department)}</p><div class="table-actions"><button class="btn sm" data-view="${g.$id}">View course</button><button class="btn sm ghost" data-leave="${g.$id}">Leave</button></div></article>`).join("")}</div>` : `<div class="card">${ui.empty("No courses yet", "Enter a join code above to join your first course.")}</div>`);
      root.querySelector("#joinForm").addEventListener("submit", async (e) => {
        e.preventDefault(); const btn = e.target.querySelector("button"); const code = root.querySelector("#joinCode").value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6,12}$/.test(code)) return ui.toast("Enter the join code exactly as given.", "warning");
        await ui.busy(btn, async () => {
          try {
            const g = await db.first("groups", [Query.equal("joinCode", code), Query.equal("isActive", true)]);
            if (!g) return ui.toast("No open course matches that code.", "error");
            const old = await db.first("groupMembers", [Query.equal("groupID", g.$id), Query.equal("studentID", sid)]);
            if (old && old.status === "active") return ui.toast("You are already in " + g.courseCode + ".", "warning");
            if (old) return ui.toast("You were removed from " + g.courseCode + ". Ask your lecturer to restore you.", "error");
            await db.create("groupMembers", null, { groupID: g.$id, studentID: sid, studentName: ctx.profile.fullName, matricNumber: ctx.student ? ctx.student.matricNumber : "", joinedAt: util.iso(), status: "active" }, perm.membership(sid, g.lecturerID));
            await M.audit(sid, "member.join", "group_members", g.$id, null, { courseCode: g.courseCode });
            M.notify(g.lecturerID, "Student joined " + g.courseCode, ctx.profile.fullName + " joined with the join code.", "course", g.$id);
            ui.toast("You joined " + g.courseCode + " · " + g.courseName + ".", "success"); draw();
          } catch (err) { ui.toast(err.code === 409 ? "You are already in this course." : util.errMsg(err), "error"); }
        });
      });
      root.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => courseDetail(groups.find((g) => g.$id === b.dataset.view), sid)));
      root.querySelectorAll("[data-leave]").forEach((b) => b.addEventListener("click", async () => {
        const g = groups.find((x) => x.$id === b.dataset.leave);
        if (!(await ui.confirm({ title: "Leave " + g.courseCode + "?", message: "You will stop seeing its attendance sessions. Your past records stay with the course. You can rejoin with the code.", confirmText: "Leave", danger: true }))) return;
        try { await db.remove("groupMembers", memOf[g.$id].$id); ui.toast("You left " + g.courseCode + ".", "success"); draw(); } catch (e) { ui.toast(util.errMsg(e), "error"); }
      }));
    }
    await draw();
  }

  M.data = data;
  M.courses = { removeMember, restoreMember, enrolmentModal, courseDetail, loadCourseData, summarise };
  M.pages = M.pages || {};
  M.pages["lecturer/courses"] = lecturerCourses;
  M.pages["student/courses"] = studentCourses;
})();
