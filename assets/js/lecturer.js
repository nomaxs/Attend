/* =========================
FILE OVERVIEW
========================= */
// Lecturer pages: dashboard (stats, recent activity, student search), students directory, profile.

(function () {
  const M = window.Attend;
  const { db, Query, util, ui } = M;
  const esc = util.esc;

  async function loadAll(lecturerId) {
    const groups = await M.data.lecturerGroups(lecturerId); const gids = groups.map((g) => g.$id);
    const [members, sessions] = await Promise.all([
      gids.length ? db.allIn("groupMembers", "groupID", gids, [Query.equal("status", "active")]) : [],
      gids.length ? db.allIn("sessions", "groupID", gids, [Query.orderDesc("startTime")]) : []
    ]);
    return { groups, members, sessions: sessions.sort((a, b) => +new Date(b.startTime) - +new Date(a.startTime)) };
  }

  async function dashboard(root, ctx) {
    const lid = ctx.user.$id; let unsub = null, q = "";
    async function draw() {
      const d = await loadAll(lid); const gmap = util.by(d.groups, "$id");
      const active = d.sessions.filter((s) => s.status === "active" && +new Date(s.endTime) > Date.now());
      const distinct = new Set(d.members.map((m) => m.studentID)).size; const recent = d.sessions.slice(0, 6);
      const hits = q.length >= 2 ? d.members.filter((m) => (m.studentName + " " + m.matricNumber).toLowerCase().includes(q.toLowerCase())).slice(0, 12) : [];
      root.innerHTML = ui.pageHead("Welcome, " + ctx.profile.fullName.split(" ")[0], ctx.profile.institution + " · " + ctx.profile.department) +
        (active.length ? active.map((s) => `<div class="card session-banner" style="margin-bottom:1rem"><div><b>Live now: ${esc(gmap[s.groupID].courseCode)}</b><div class="muted small">Ends ${ui.fmt.t(s.endTime)}</div></div><a class="btn accent" href="attendance.html?group=${s.groupID}">Open session</a></div>`).join("") : "") +
        `<div class="grid cols-4"><div class="card stat"><div class="num">${d.groups.length}</div><div class="lbl">Courses</div></div><div class="card stat"><div class="num">${distinct}</div><div class="lbl">Registered students</div></div><div class="card stat accent"><div class="num">${active.length}</div><div class="lbl">Active attendance sessions</div></div><div class="card stat"><div class="num">${d.sessions.filter((s) => s.status === "finalised").length}</div><div class="lbl">Finalised sessions</div></div></div>
        <div class="grid split" style="margin-top:1rem"><div>
          <div class="card"><h2>Recent attendance activity</h2>${recent.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Started</th><th>Status</th><th></th></tr></thead><tbody>${recent.map((s) => `<tr><td><b>${esc(gmap[s.groupID].courseCode)}</b></td><td>${ui.fmt.dt(s.startTime)}</td><td>${ui.badge(s.status)}</td><td><a class="btn sm secondary" href="attendance.html?group=${s.groupID}">Open</a></td></tr>`).join("")}</tbody></table></div>` : ui.empty("No sessions yet", "Start one from the Attendance page.")}</div>
          <div class="card"><h2>Find a student</h2><input type="search" id="sq" placeholder="Name or matric number (min. 2 letters)" value="${esc(q)}">${q.length >= 2 ? (hits.length ? `<ul class="list">${hits.map((m) => `<li><div class="row"><span class="avatar">${esc(util.initials(m.studentName))}</span><div><b>${esc(m.studentName)}</b><div class="muted small">${esc(m.matricNumber)} · ${esc((gmap[m.groupID] || {}).courseCode || "")}</div></div></div></li>`).join("")}</ul>` : ui.empty("No match")) : ""}</div>
        </div><div class="card"><h2>Quick links</h2><ul class="list"><li><a href="courses.html">Course management</a></li><li><a href="attendance.html">Start or review attendance</a></li><li><a href="gradebook.html">Gradebook</a></li><li><a href="reports.html">Attendance reports</a></li><li><a href="profile.html">Account settings</a></li></ul></div></div>`;
      const sq = root.querySelector("#sq"); sq.addEventListener("input", () => { q = sq.value.trim(); const pos = sq.selectionStart; draw().then(() => { const n = root.querySelector("#sq"); n.focus(); n.setSelectionRange(pos, pos); }); });
    }
    await draw();
    let t; unsub = db.subscribe(["sessions", "groupMembers"], () => { clearTimeout(t); t = setTimeout(() => { if (document.activeElement && document.activeElement.id === "sq") return; draw().catch(() => {}); }, 1200); });
  }

  async function students(root, ctx) {
    const lid = ctx.user.$id; const d = await loadAll(lid); const gmap = util.by(d.groups, "$id");
    const [records, fin] = await Promise.all([d.groups.length ? db.allIn("records", "groupID", d.groups.map((g) => g.$id)) : [], d.groups.length ? db.allIn("sessions", "groupID", d.groups.map((g) => g.$id), [Query.equal("status", "finalised")]) : []]);
    let q = "", cf = "";
    function draw() {
      const rows = d.members.filter((m) => (!cf || m.groupID === cf) && (!q || (m.studentName + " " + m.matricNumber).toLowerCase().includes(q.toLowerCase()))).sort((a, b) => a.studentName.localeCompare(b.studentName));
      root.innerHTML = ui.pageHead("Students", "Everyone enrolled in your courses.") +
        `<div class="notice info small">Students join a course themselves with its join code. If someone should not be in a course, open <a href="courses.html">Courses</a>, then Students, and remove them.</div>` +
        `<div class="card"><div class="search-row"><input type="search" id="q" placeholder="Search name or matric number" value="${esc(q)}"><select id="cf"><option value="">All courses</option>${d.groups.map((g) => `<option value="${g.$id}" ${g.$id === cf ? "selected" : ""}>${esc(g.courseCode)}</option>`).join("")}</select></div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Matric no.</th><th>Course</th><th>Attendance</th><th>Joined</th></tr></thead><tbody>${rows.map((m) => { const g = gmap[m.groupID]; const n = fin.filter((s) => s.groupID === m.groupID).length; const p = M.logic.attendancePercent(records.filter((r) => r.groupID === m.groupID && r.studentID === m.studentID), n, M.logic.rules(g)); return `<tr><td><div class="row"><span class="avatar">${esc(util.initials(m.studentName))}</span><b>${esc(m.studentName)}</b></div></td><td>${esc(m.matricNumber)}</td><td>${esc(g.courseCode)}</td><td>${ui.fmt.pct(p)}</td><td>${ui.fmt.d(m.joinedAt)}</td></tr>`; }).join("")}</tbody></table></div>` : ui.empty("No students found")}</div>`;
      const qi = root.querySelector("#q"); qi.addEventListener("input", () => { q = qi.value; const pos = qi.selectionStart; draw(); const n = root.querySelector("#q"); n.focus(); n.setSelectionRange(pos, pos); });
      root.querySelector("#cf").addEventListener("change", (e) => { cf = e.target.value; draw(); });
    }
    draw();
  }

  M.pages = M.pages || {};
  M.pages["lecturer/dashboard"] = dashboard;
  M.pages["lecturer/students"] = students;
  M.pages["lecturer/profile"] = (r, c) => M.profile(r, c, "lecturer");
})();
