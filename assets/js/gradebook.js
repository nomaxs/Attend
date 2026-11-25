/* =========================
FILE OVERVIEW
========================= */
// Lecturer gradebook: spreadsheet-style grid per course.
// Attendance columns (created automatically when a session is finalised) always come first and are read-only here;
// corrections happen on the Attendance page so they are audited. Attendance % is calculated separately from academic
// marks. Grades come from rules the lecturer configures per course (no built-in grading scale is imposed).

(function () {
  const M = window.Attend;
  const { db, Query, util, perm, ui } = M;
  const esc = util.esc;
  const CATS = [["test", "Test"], ["assignment", "Assignment"], ["exam", "Examination"], ["custom", "Custom"]];
  const catLabel = (k) => (k === "attendance" ? "Attendance" : (CATS.find((c) => c[0] === k) || [0, k])[1]);
  const colSort = (a, b) => (a.category === "attendance" ? 0 : 1) - (b.category === "attendance" ? 0 : 1) || a.columnOrder - b.columnOrder;

  async function gradebook(root, ctx) {
    const lecturerId = ctx.user.$id;
    const groups = await M.data.lecturerGroups(lecturerId);
    if (!groups.length) { root.innerHTML = ui.pageHead("Gradebook") + `<div class="card">${ui.empty("Create a course first", "Each course has its own gradebook.")}<div class="center"><a class="btn" href="courses.html">Go to courses</a></div></div>`; return; }
    let gid = new URLSearchParams(location.search).get("group"); if (!groups.some((g) => g.$id === gid)) gid = groups[0].$id;
    let showArchived = false, unsub = null, refreshT = null, S = null;

    async function load() {
      const group = groups.find((g) => g.$id === gid);
      const [members, columns, scores, records, sessions] = await Promise.all([
        M.data.groupMembers(gid), db.all("columns", [Query.equal("groupID", gid)]), db.all("scores", [Query.equal("groupID", gid)]),
        db.all("records", [Query.equal("groupID", gid)]), M.data.finalisedSessions(gid)
      ]);
      S = { group, members, columns: columns.sort(colSort), scoreMap: M.data.scoresByCol(scores), records, sessions, rules: M.logic.rules(group) };
    }

    const studentCalc = (stu) => {
      const rs = S.records.filter((r) => r.studentID === stu);
      return { att: M.logic.attendancePercent(rs, S.sessions.length, S.rules), acad: M.logic.academic(S.columns, S.scoreMap, stu, S.rules) };
    };

    function draw() {
      const g = S.group; const cols = S.columns.filter((c) => showArchived || !c.isArchived);
      const attCols = cols.filter((c) => c.category === "attendance"), asCols = cols.filter((c) => c.category !== "attendance");
      const recKey = {}; S.records.forEach((r) => (recKey[r.sessionID + "|" + r.studentID] = r));
      const head1 = `<tr class="cat"><th class="stick"></th>${attCols.length ? `<th class="att" colspan="${attCols.length + 1}">Attendance</th>` : ""}${asCols.length ? `<th colspan="${asCols.length}">Assessments</th>` : ""}<th class="tot" colspan="3">Academic result</th></tr>`;
      const head2 = `<tr><th class="stick">Student</th>${attCols.map((c) => `<th class="att"><div class="col-head"><span title="${esc(c.columnName)}">${esc(c.columnName.length > 22 ? c.columnName.slice(0, 21) + "…" : c.columnName)}</span><button data-edit="${c.$id}" aria-label="Rename column">✎</button></div></th>`).join("")}${attCols.length ? '<th class="att">Attendance %</th>' : ""}${asCols.map((c) => `<th><div class="col-head"><span>${esc(c.columnName)}${c.isArchived ? " (archived)" : ""}<small>${esc(catLabel(c.category))} · /${ui.fmt.num(c.maximumScore)}</small></span><span><button data-edit="${c.$id}" aria-label="Edit column">✎</button><button data-arch="${c.$id}" aria-label="${c.isArchived ? "Restore" : "Archive"} column">${c.isArchived ? "↺" : "▣"}</button>${c.isArchived ? `<button data-del="${c.$id}" aria-label="Delete column permanently">✕</button>` : ""}</span></div></th>`).join("")}<th class="tot">Total</th><th class="tot">%</th><th class="tot">Grade</th></tr>`;
      const body = S.members.map((m) => { const k = studentCalc(m.studentID);
        return `<tr data-row="${m.studentID}"><td class="stick"><b>${esc(m.studentName)}</b><div class="muted small">${esc(m.matricNumber)}</div></td>${attCols.map((c) => { const r = recKey[c.sourceSessionID + "|" + m.studentID]; const s = r ? r.status : null; return `<td class="att ${s === "present" ? "cell-p" : s === "late" ? "cell-l" : s === "absent" ? "cell-a" : ""}">${s ? s[0].toUpperCase() : "–"}</td>`; }).join("")}${attCols.length ? `<td class="att" data-c="att"><b>${ui.fmt.pct(k.att)}</b></td>` : ""}${asCols.map((c) => { const s = (S.scoreMap[c.$id] || {})[m.studentID]; return `<td><input inputmode="decimal" data-col="${c.$id}" data-stu="${m.studentID}" value="${s ? (s.status === "excused" ? "ex" : s.score == null ? "" : s.score) : ""}" ${c.isArchived ? "disabled" : ""} aria-label="${esc(c.columnName)} score for ${esc(m.studentName)}"></td>`; }).join("")}<td class="tot" data-c="tot">${k.acad.max ? ui.fmt.num(k.acad.total) + "/" + ui.fmt.num(k.acad.max) : "—"}</td><td class="tot" data-c="pct">${ui.fmt.pct(k.acad.percent)}</td><td class="tot" data-c="grade">${esc(k.acad.grade)}</td></tr>`; }).join("");
      root.innerHTML = ui.pageHead("Gradebook", "Enter scores directly in the grid. Type ex to mark a score as excused.", `<button class="btn accent" id="addCol">Add column</button><button class="btn secondary" id="rules">Grading rules</button><button class="btn secondary" id="csv">Export CSV</button>`) +
        `<div class="card"><div class="row between"><div class="row"><label for="gSel" style="margin:0">Course</label><select id="gSel" style="max-width:340px">${groups.map((x) => `<option value="${x.$id}" ${x.$id === gid ? "selected" : ""}>${esc(x.courseCode)} · ${esc(x.courseName)}</option>`).join("")}</select></div><label style="font-weight:500;margin:0"><input type="checkbox" id="arch" ${showArchived ? "checked" : ""}>Show archived columns</label></div></div>
        <div style="margin-top:1rem">${S.members.length ? `<div class="sheet-wrap"><table class="sheet"><thead>${head1}${head2}</thead><tbody>${body}</tbody></table></div><p class="muted small" style="margin-top:.6rem">Attendance (${S.sessions.length} finalised session${S.sessions.length === 1 ? "" : "s"}) is shown separately and is not part of the academic total. To change an attendance mark, open the session on the Attendance page so the correction is logged.</p>` : `<div class="card">${ui.empty("No enrolled students", "Approve join requests on the Courses page.")}</div>`}</div>`;
      bind();
    }

    function updateRow(stu) {
      const tr = root.querySelector(`tr[data-row="${stu}"]`); if (!tr) return; const k = studentCalc(stu);
      const set = (c, v) => { const el = tr.querySelector(`[data-c="${c}"]`); if (el) el.textContent = v; };
      set("tot", k.acad.max ? ui.fmt.num(k.acad.total) + "/" + ui.fmt.num(k.acad.max) : "—"); set("pct", ui.fmt.pct(k.acad.percent)); set("grade", k.acad.grade);
    }

    async function saveScore(input) {
      const col = S.columns.find((c) => c.$id === input.dataset.col); const stu = input.dataset.stu; const raw = input.value.trim();
      const map = (S.scoreMap[col.$id] = S.scoreMap[col.$id] || {}); const ex = map[stu];
      const revert = () => { input.value = ex ? (ex.status === "excused" ? "ex" : ex.score == null ? "" : ex.score) : ""; };
      input.className = "saving";
      try {
        if (raw === "") { if (ex) { await db.remove("scores", ex.$id); delete map[stu]; } }
        else {
          const excused = /^ex(cused)?$/i.test(raw); const n = excused ? null : Number(raw);
          if (!excused && (isNaN(n) || n < 0 || n > Number(col.maximumScore))) { ui.toast("Enter a number from 0 to " + col.maximumScore + ", or ex.", "warning"); revert(); input.className = ""; return; }
          const d = { score: n, status: excused ? "excused" : "graded", updatedBy: lecturerId, updatedAt: util.iso() };
          if (ex) map[stu] = await db.update("scores", ex.$id, d);
          else { try { map[stu] = await db.create("scores", null, Object.assign({ groupID: gid, columnID: col.$id, studentID: stu }, d), perm.lecturerOwned(lecturerId, [stu])); } catch (e) { if (e.code !== 409) throw e; const cur = await db.first("scores", [Query.equal("columnID", col.$id), Query.equal("studentID", stu)]); map[stu] = await db.update("scores", cur.$id, d); } }
          if (excused) input.value = "ex";
        }
        input.className = "saved"; setTimeout(() => (input.className = ""), 900); updateRow(stu);
        M.audit(lecturerId, "score.set", "gradebook_scores", (map[stu] || ex || { $id: col.$id }).$id, ex ? { score: ex.score, status: ex.status } : null, raw === "" ? "cleared" : { score: raw });
      } catch (e) { input.className = "fail"; ui.toast(util.errMsg(e), "error"); revert(); }
    }

    function columnForm(c) {
      const isAtt = c && c.category === "attendance";
      return ui.formModal({ title: c ? "Edit column" : "Add column", submitText: c ? "Save" : "Add column",
        fields: [{ name: "columnName", label: "Column name", value: c && c.columnName, required: true, maxLength: 120 }].concat(isAtt ? [] : [{ name: "category", label: "Type", type: "select", value: (c && c.category) || "test", options: CATS }, { name: "maximumScore", label: "Maximum score", type: "number", value: c ? c.maximumScore : 20, min: 0.5, max: 1000, step: "any", required: true }]),
        async onSubmit(v) {
          if (!c) {
            const order = Math.max(0, ...S.columns.filter((x) => x.category !== "attendance").map((x) => x.columnOrder)) + 1;
            const nc = await db.create("columns", null, { groupID: gid, columnName: v.columnName, category: v.category, maximumScore: v.maximumScore, columnOrder: order, createdBy: lecturerId, createdAt: util.iso(), isArchived: false }, perm.publicToUsers(lecturerId));
            await M.audit(lecturerId, "column.create", "gradebook_columns", nc.$id, null, v);
          } else {
            const d = { columnName: v.columnName }; if (!isAtt) { d.category = v.category; d.maximumScore = v.maximumScore; }
            if (!isAtt) { const over = Object.values(S.scoreMap[c.$id] || {}).filter((s) => s.score != null && s.score > v.maximumScore).length; if (over && !(await ui.confirm({ title: "Some scores exceed the new maximum", message: over + " existing score(s) are higher than " + v.maximumScore + ". Keep them anyway?", confirmText: "Keep and save" }))) throw new Error("Cancelled."); }
            await db.update("columns", c.$id, d); await M.audit(lecturerId, "column.edit", "gradebook_columns", c.$id, { columnName: c.columnName, category: c.category, maximumScore: c.maximumScore }, d);
          }
          ui.toast("Saved.", "success"); await reload();
        } });
    }

    function rulesModal() {
      const r = S.rules; const w = r.categoryWeights || {};
      const m = ui.modal({ title: "Grading rules", wide: true, body: `<div class="notice info small">Attend does not assume a grading scale. Set the bands your institution uses. The bands below are only a starting point.</div>
        <h3>Grade bands</h3><div id="bands"></div><button class="btn sm secondary" id="addBand" type="button">Add band</button>
        <h3 style="margin-top:1.2rem">Category weights (optional)</h3><p class="muted small">Leave all blank to grade on total marks. If you fill any in, each category's percentage is weighted by these numbers.</p><div class="form-grid">${CATS.map(([k, l]) => `<div class="field"><label>${l}</label><input type="number" min="0" step="any" data-w="${k}" value="${w[k] == null ? "" : w[k]}"></div>`).join("")}</div>
        <h3 style="margin-top:1.2rem">Attendance</h3><div class="form-grid"><div class="field"><label>Late counts as (0–1)</label><input type="number" id="lw" min="0" max="1" step="0.1" value="${r.attendance.lateWeight}"><div class="hint">1 = same as present, 0 = same as absent.</div></div><div class="field"><label>Minimum attendance %</label><input type="number" id="mp" min="0" max="100" value="${r.attendance.minimumPercent}"><div class="hint">Students below this are flagged on their dashboard.</div></div></div>`,
        buttons: [{ text: "Cancel" }, { text: "Save rules", cls: "accent", async onClick(api) {
          const bands = [...api.body.querySelectorAll(".band-row")].map((row) => ({ min: Number(row.children[0].value), grade: row.children[1].value.trim() })).filter((b) => b.grade);
          if (!bands.length || bands.some((b) => isNaN(b.min) || b.min < 0 || b.min > 100)) return ui.toast("Each band needs a grade and a minimum between 0 and 100.", "warning");
          const cw = {}; api.body.querySelectorAll("[data-w]").forEach((i) => { if (i.value !== "" && Number(i.value) > 0) cw[i.dataset.w] = Number(i.value); });
          const lw = Number(api.body.querySelector("#lw").value), mp = Number(api.body.querySelector("#mp").value);
          if (isNaN(lw) || lw < 0 || lw > 1 || isNaN(mp) || mp < 0 || mp > 100) return ui.toast("Check the attendance settings.", "warning");
          const next = { bands, categoryWeights: Object.keys(cw).length ? cw : null, attendance: { lateWeight: lw, minimumPercent: mp } };
          try { const prev = S.group.gradingRules; await db.update("groups", gid, { gradingRules: JSON.stringify(next) }); await M.audit(lecturerId, "rules.update", "groups", gid, prev, next); const g = groups.find((x) => x.$id === gid); g.gradingRules = JSON.stringify(next); ui.toast("Grading rules saved.", "success"); api.close(); await reload(); } catch (e) { ui.toast(util.errMsg(e), "error"); }
        } }] });
      const bw = m.body.querySelector("#bands"); const add = (b) => { const d = document.createElement("div"); d.className = "band-row"; d.innerHTML = `<input type="number" min="0" max="100" step="any" value="${b ? b.min : ""}" placeholder="Min %" aria-label="Minimum percent"><input type="text" maxlength="12" value="${b ? esc(b.grade) : ""}" placeholder="Grade" aria-label="Grade"><button class="btn sm ghost" type="button" aria-label="Remove band">✕</button>`; d.querySelector("button").addEventListener("click", () => d.remove()); bw.appendChild(d); };
      r.bands.forEach(add); m.body.querySelector("#addBand").addEventListener("click", () => add());
    }

    function bind() {
      root.querySelector("#gSel").addEventListener("change", (e) => { gid = e.target.value; history.replaceState(null, "", "?group=" + gid); reload(); });
      root.querySelector("#arch").addEventListener("change", (e) => { showArchived = e.target.checked; draw(); });
      root.querySelector("#addCol").addEventListener("click", () => columnForm(null));
      root.querySelector("#rules").addEventListener("click", rulesModal);
      root.querySelector("#csv").addEventListener("click", exportCsv);
      root.querySelectorAll("input[data-col]").forEach((i) => { i.addEventListener("change", () => saveScore(i)); i.addEventListener("keydown", (e) => { if (e.key === "Enter") { const all = [...root.querySelectorAll(`input[data-col="${i.dataset.col}"]`)]; const n = all[all.indexOf(i) + 1]; if (n) n.focus(); } }); });
      root.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => columnForm(S.columns.find((c) => c.$id === b.dataset.edit))));
      root.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
        const c = S.columns.find((x) => x.$id === b.dataset.del); const n = Object.keys(S.scoreMap[c.$id] || {}).length;
        if (!(await ui.confirm({ title: "Delete column permanently?", message: `"${c.columnName}" and its ${n} score(s) will be deleted. This cannot be undone. Archive it instead if you may need it again.`, confirmText: "Delete", danger: true }))) return;
        ui.loading(true);
        try { for (const s of Object.values(S.scoreMap[c.$id] || {})) await db.remove("scores", s.$id); await db.remove("columns", c.$id); await M.audit(lecturerId, "column.delete", "gradebook_columns", c.$id, { columnName: c.columnName, scores: n }, null); ui.toast("Column deleted.", "success"); await reload(); } catch (e) { ui.toast(util.errMsg(e), "error"); } finally { ui.loading(false); }
      }));
      root.querySelectorAll("[data-arch]").forEach((b) => b.addEventListener("click", async () => {
        const c = S.columns.find((x) => x.$id === b.dataset.arch);
        const choice = await ui.confirm({ title: c.isArchived ? "Restore column?" : "Archive column?", message: c.isArchived ? "It will count towards totals again." : "Archived columns are hidden and excluded from totals. Scores are kept. You can restore it later.", confirmText: c.isArchived ? "Restore" : "Archive" });
        if (!choice) return;
        try { await db.update("columns", c.$id, { isArchived: !c.isArchived }); await M.audit(lecturerId, "column.archive", "gradebook_columns", c.$id, { isArchived: c.isArchived }, { isArchived: !c.isArchived }); await reload(); } catch (e) { ui.toast(util.errMsg(e), "error"); }
      }));
    }

    function exportCsv() {
      const cols = S.columns.filter((c) => !c.isArchived); const att = cols.filter((c) => c.category === "attendance"), as = cols.filter((c) => c.category !== "attendance");
      const recKey = {}; S.records.forEach((r) => (recKey[r.sessionID + "|" + r.studentID] = r));
      const rows = [["Student", "Matric no.", ...att.map((c) => c.columnName), "Attendance %", ...as.map((c) => c.columnName + " (/" + c.maximumScore + ")"), "Total", "Max", "Percent", "Grade"]];
      S.members.forEach((m) => { const k = studentCalc(m.studentID); rows.push([m.studentName, m.matricNumber, ...att.map((c) => (recKey[c.sourceSessionID + "|" + m.studentID] || {}).status || ""), k.att == null ? "" : k.att.toFixed(1), ...as.map((c) => { const s = (S.scoreMap[c.$id] || {})[m.studentID]; return s ? (s.status === "excused" ? "excused" : s.score) : ""; }), k.acad.total, k.acad.max, k.acad.percent == null ? "" : k.acad.percent.toFixed(1), k.acad.grade]); });
      ui.download("gradebook-" + S.group.courseCode.replace(/\W+/g, "") + ".csv", ui.toCSV(rows));
    }

    async function reload() { await load(); draw(); }
    await reload();
    unsub = db.subscribe(["scores", "columns", "records"], () => { clearTimeout(refreshT); refreshT = setTimeout(() => { const a = document.activeElement; if ((a && a.tagName === "INPUT" && a.closest(".sheet")) || document.querySelector(".modal-back")) return; reload().catch(() => {}); }, 1200); });
  }

  M.pages = M.pages || {};
  M.pages["lecturer/gradebook"] = gradebook;
})();
