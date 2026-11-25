/* =========================
FILE OVERVIEW
========================= */
// Lecturer reports: attendance per course (date filter, student search, individual histories, CSV export, optional
// save to a private Appwrite bucket) and an academic performance summary.

(function () {
  const M = window.Muster;
  const { db, Query, util, ui } = M;
  const esc = util.esc;

  async function reports(root, ctx) {
    const lecturerId = ctx.user.$id;
    const groups = await M.data.lecturerGroups(lecturerId);
    if (!groups.length) { root.innerHTML = ui.pageHead("Reports") + `<div class="card">${ui.empty("Create a course first", "Reports are generated per course.")}</div>`; return; }
    let gid = groups[0].$id, tab = "attendance", from = "", to = "", q = "", S = null;

    async function load() {
      const group = groups.find((g) => g.$id === gid);
      const [members, sessions, records, columns, scores] = await Promise.all([M.data.groupMembers(gid), M.data.finalisedSessions(gid), db.all("records", [Query.equal("groupID", gid)]), db.all("columns", [Query.equal("groupID", gid)]), db.all("scores", [Query.equal("groupID", gid)])]);
      S = { group, members, sessions, records, columns, scoreMap: M.data.scoresByCol(scores), rules: M.logic.rules(group) };
    }
    const inRange = (s) => { const t = +new Date(s.startTime); return (!from || t >= +new Date(from + "T00:00:00")) && (!to || t <= +new Date(to + "T23:59:59")); };
    const calc = () => {
      const sess = S.sessions.filter(inRange); const ids = new Set(sess.map((s) => s.$id)); const recs = S.records.filter((r) => ids.has(r.sessionID));
      const byKey = {}; recs.forEach((r) => (byKey[r.sessionID + "|" + r.studentID] = r));
      const rows = S.members.map((m) => { const rs = recs.filter((r) => r.studentID === m.studentID); return { m, rs, pct: M.logic.attendancePercent(rs, sess.length, S.rules), p: rs.filter((r) => r.status === "present").length, l: rs.filter((r) => r.status === "late").length, a: 0 }; });
      rows.forEach((r) => { r.a = sess.length - r.p - r.l; });
      return { sess, byKey, rows };
    };
    const match = (m) => !q || (m.studentName + " " + m.matricNumber).toLowerCase().includes(q.toLowerCase());

    function attendanceCsv() { const { sess, byKey, rows } = calc(); const out = [["Student", "Matric no.", ...sess.map((s) => ui.fmt.d(s.startTime)), "Present", "Late", "Absent", "Attendance %"]]; rows.filter((r) => match(r.m)).forEach((r) => out.push([r.m.studentName, r.m.matricNumber, ...sess.map((s) => (byKey[s.$id + "|" + r.m.studentID] || {}).status || "absent"), r.p, r.l, r.a, r.pct == null ? "" : r.pct.toFixed(1)])); return out; }
    function perfRows() { return S.members.map((m) => { const rs = S.records.filter((r) => r.studentID === m.studentID); return { m, att: M.logic.attendancePercent(rs, S.sessions.length, S.rules), ac: M.logic.academic(S.columns, S.scoreMap, m.studentID, S.rules) }; }); }
    function perfCsv() { const out = [["Student", "Matric no.", "Attendance %", "Total", "Max", "Percent", "Grade"]]; perfRows().forEach((r) => out.push([r.m.studentName, r.m.matricNumber, r.att == null ? "" : r.att.toFixed(1), r.ac.total, r.ac.max, r.ac.percent == null ? "" : r.ac.percent.toFixed(1), r.ac.grade])); return out; }

    function history(row) {
      const sess = S.sessions.slice().reverse(); const rec = util.by(S.records.filter((r) => r.studentID === row.m.studentID), "sessionID");
      ui.modal({ title: row.m.studentName, wide: true, body: `<p class="muted">${esc(row.m.matricNumber)} · attendance ${ui.fmt.pct(M.logic.attendancePercent(S.records.filter((r) => r.studentID === row.m.studentID), S.sessions.length, S.rules))}</p>${sess.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Status</th><th>Verified</th><th>Method</th><th>Note</th></tr></thead><tbody>${sess.map((s) => { const r = rec[s.$id]; return `<tr><td>${ui.fmt.dt(s.startTime)}</td><td>${ui.badge(r ? r.status : "absent")}</td><td>${r && r.verifiedAt ? ui.fmt.t(r.verifiedAt) : "—"}</td><td>${esc(r ? r.verificationMethod : "—")}${r && r.referenceDepth ? " (depth " + r.referenceDepth + ")" : ""}</td><td class="small">${r && r.manuallyModified ? "Corrected: " + esc(r.modificationReason || "") : ""}</td></tr>`; }).join("")}</tbody></table></div>` : ui.empty("No finalised sessions")}` });
    }

    async function saveToStorage(rows, name) {
      const b = M.cfg.buckets.exports; if (/REPLACE/.test(b)) return ui.toast("Set buckets.exports in config.js to save reports to private storage.", "warning");
      try { const file = new File([ui.toCSV(rows)], name, { type: "text/csv" }); await M.storage.createFile(b, M.ID.unique(), file, [M.Permission.read(M.Role.user(lecturerId)), M.Permission.delete(M.Role.user(lecturerId))]); ui.toast("Saved to your private storage bucket.", "success"); } catch (e) { ui.toast(util.errMsg(e), "error"); }
    }

    function draw() {
      const slug = S.group.courseCode.replace(/\W+/g, "");
      let html = ui.pageHead("Reports", "Attendance and academic summaries, per course.") +
        `<div class="card"><div class="search-row"><select id="rg">${groups.map((g) => `<option value="${g.$id}" ${g.$id === gid ? "selected" : ""}>${esc(g.courseCode)} · ${esc(g.courseName)}</option>`).join("")}</select><input type="search" id="rq" placeholder="Search name or matric no." value="${esc(q)}"><input type="date" id="rf" value="${from}" aria-label="From date"><input type="date" id="rt" value="${to}" aria-label="To date"></div><div class="tabs"><button data-t="attendance" class="${tab === "attendance" ? "active" : ""}">Attendance</button><button data-t="performance" class="${tab === "performance" ? "active" : ""}">Academic performance</button></div><div id="rbody"></div></div>`;
      root.innerHTML = html;
      const body = root.querySelector("#rbody");
      if (tab === "attendance") {
        const { sess, byKey, rows } = calc(); const shown = rows.filter((r) => match(r.m));
        body.innerHTML = `<div class="row between" style="margin-bottom:.8rem"><span class="muted small">${sess.length} finalised session(s) in range · ${S.members.length} students</span><span class="row"><button class="btn sm secondary" id="exp">Export CSV</button><button class="btn sm secondary" id="sav">Save to private storage</button></span></div>${shown.length && sess.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th>${sess.map((s) => `<th title="${ui.fmt.dt(s.startTime)}">${ui.fmt.d(s.startTime).replace(/ \d{4}$/, "")}</th>`).join("")}<th>P</th><th>L</th><th>A</th><th>%</th></tr></thead><tbody>${shown.map((r, i) => `<tr><td><a href="#" data-h="${i}"><b>${esc(r.m.studentName)}</b></a><div class="muted small">${esc(r.m.matricNumber)}</div></td>${sess.map((s) => { const x = byKey[s.$id + "|" + r.m.studentID]; const st = x ? x.status : "absent"; return `<td class="${st === "present" ? "cell-p" : st === "late" ? "cell-l" : "cell-a"}">${st[0].toUpperCase()}</td>`; }).join("")}<td>${r.p}</td><td>${r.l}</td><td>${r.a}</td><td><b>${ui.fmt.pct(r.pct)}</b></td></tr>`).join("")}</tbody></table></div>` : ui.empty("Nothing to show", sess.length ? "No students match your search." : "Finalise a session, or widen the date range.")}`;
        body.querySelectorAll("[data-h]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); history(shown[Number(a.dataset.h)]); }));
        const exp = body.querySelector("#exp"), sav = body.querySelector("#sav");
        exp.addEventListener("click", () => ui.download("attendance-" + slug + ".csv", ui.toCSV(attendanceCsv()))); sav.addEventListener("click", () => saveToStorage(attendanceCsv(), "attendance-" + slug + "-" + Date.now() + ".csv"));
      } else {
        const rows = perfRows().filter((r) => match(r.m)); const graded = rows.filter((r) => r.ac.percent != null);
        const pcts = graded.map((r) => r.ac.percent); const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
        const dist = {}; S.rules.bands.forEach((b) => (dist[b.grade] = 0)); graded.forEach((r) => { dist[r.ac.grade] = (dist[r.ac.grade] || 0) + 1; });
        const maxC = Math.max(1, ...Object.values(dist));
        body.innerHTML = `<div class="grid cols-4"><div class="card stat"><div class="num">${graded.length}</div><div class="lbl">Students graded</div></div><div class="card stat"><div class="num">${ui.fmt.pct(avg)}</div><div class="lbl">Class average</div></div><div class="card stat"><div class="num">${pcts.length ? ui.fmt.pct(Math.max(...pcts)) : "—"}</div><div class="lbl">Highest</div></div><div class="card stat"><div class="num">${pcts.length ? ui.fmt.pct(Math.min(...pcts)) : "—"}</div><div class="lbl">Lowest</div></div></div>
          <div class="card" style="margin-top:1rem"><h3>Grade distribution</h3>${Object.entries(dist).map(([g, n]) => `<div class="row" style="margin:.35rem 0"><b style="width:2rem">${esc(g)}</b><div class="progress grow"><i style="width:${(n / maxC) * 100}%"></i></div><span style="width:2rem" class="right">${n}</span></div>`).join("")}</div>
          <div class="row between" style="margin:1rem 0 .6rem"><span class="muted small">Attendance is shown separately and is not part of the academic percent.</span><button class="btn sm secondary" id="exp">Export CSV</button></div>
          ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th>Attendance</th><th>Total</th><th>Percent</th><th>Grade</th></tr></thead><tbody>${rows.map((r) => `<tr><td><b>${esc(r.m.studentName)}</b><div class="muted small">${esc(r.m.matricNumber)}</div></td><td>${ui.fmt.pct(r.att)}</td><td>${r.ac.max ? ui.fmt.num(r.ac.total) + "/" + ui.fmt.num(r.ac.max) : "—"}</td><td>${ui.fmt.pct(r.ac.percent)}</td><td><b>${esc(r.ac.grade)}</b></td></tr>`).join("")}</tbody></table></div>` : ui.empty("No students")}`;
        body.querySelector("#exp").addEventListener("click", () => ui.download("performance-" + slug + ".csv", ui.toCSV(perfCsv())));
      }
      root.querySelector("#rg").addEventListener("change", async (e) => { gid = e.target.value; await load(); draw(); });
      root.querySelector("#rq").addEventListener("input", (e) => { q = e.target.value; const pos = e.target.selectionStart; draw(); const n = root.querySelector("#rq"); n.focus(); n.setSelectionRange(pos, pos); });
      root.querySelector("#rf").addEventListener("change", (e) => { from = e.target.value; draw(); }); root.querySelector("#rt").addEventListener("change", (e) => { to = e.target.value; draw(); });
      root.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.t; draw(); }));
    }
    await load(); draw();
  }

  M.pages = M.pages || {};
  M.pages["lecturer/reports"] = reports;
})();
