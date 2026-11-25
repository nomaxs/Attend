/* =========================
FILE OVERVIEW
========================= */
// Attendance sessions.
//  Lecturer: start a session (8-15 min), live roll (verified / awaiting / not verified), review evidence,
//            manual corrections, finalise (creates official records + the gradebook attendance column).
//  Student:  verify attendance (Android BLE + optional face check), submit a claim, view attendance history.
//
// TRUST MODEL (no server-side code): students can only CREATE evidence documents (a claim and detections). Official
// attendance_records can only be created by the lecturer. The lecturer's browser validates the evidence with
// Muster.logic.resolveSession before anything becomes official. A student's phone never decides its own attendance.

(function () {
  const M = window.Muster;
  const { db, Query, util, perm, ui } = M;
  const esc = util.esc; const A = M.cfg.attendance;

  /* =====================================================================
     Pure validation logic (no network, unit-testable)
     ===================================================================== */
  // Depth 1 = the student's phone heard the lecturer's beacon. Depth 2 = it heard a student who is depth 1, and so on up
  // to session.maxReferenceDepth. Only students whose own claim is valid (and face-checked when required) can be a reference.
  // RSSI is used only as a weak-signal noise floor. It is NOT a distance.
  function resolveSession(o) {
    const { session, beaconID, members, cfg } = o;
    const start = +new Date(session.startTime), end = +new Date(session.endTime);
    const grace = (cfg.claimGraceSeconds || 0) * 1000; const minRssi = cfg.minRssi;
    const maxDepth = Math.min(Number(session.maxReferenceDepth) || 2, cfg.maxReferenceDepthLimit || 3);
    const memberIds = new Set(members.map((m) => m.studentID));
    const claim = {}, det = {};
    (o.claims || []).forEach((c) => { if (memberIds.has(c.studentID)) claim[c.studentID] = c; });
    (o.detections || []).forEach((d) => { if (memberIds.has(d.studentID) && d.detectedDeviceID) (det[d.studentID] = det[d.studentID] || []).push(d); });
    const ephCount = {}; Object.values(claim).forEach((c) => { if (c.ephemeralID) ephCount[c.ephemeralID] = (ephCount[c.ephemeralID] || 0) + 1; });
    const ephOwner = {}; Object.values(claim).forEach((c) => { if (c.ephemeralID && ephCount[c.ephemeralID] === 1) ephOwner[c.ephemeralID] = c.studentID; });
    const strong = (d) => typeof d.signalStrength === "number" && d.signalStrength >= minRssi;

    const out = {};
    members.forEach((m) => { out[m.studentID] = { studentID: m.studentID, suggested: "absent", method: null, depth: null, ref: null, verifiedAt: null, reasons: [], eligible: false, face: null, hasClaim: !!claim[m.studentID], hasEvidence: !!(claim[m.studentID] || det[m.studentID]) }; });

    Object.entries(claim).forEach(([sid, c]) => {
      const r = out[sid]; const t = +new Date(c.$createdAt); // server time, not the phone's clock
      if (t < start || t > end + grace) { r.reasons.push("Claim was submitted outside the session window."); return; }
      if (c.ephemeralID && ephCount[c.ephemeralID] > 1) { r.reasons.push("Another student claimed the same device identifier."); return; }
      r.verifiedAt = c.$createdAt;
      const prof = (o.faces || {})[sid]; let recheck = null;
      if (c.faceProbe && prof && prof.templateData && prof.status === "enrolled" && o.compareFace) recheck = o.compareFace(prof.templateData, c.faceProbe);
      r.face = { submittedScore: c.faceScore == null ? null : c.faceScore, modelVersion: c.faceModelVersion || null, recheck };
      if (session.requireFace) {
        if (!recheck) { r.reasons.push("Face evidence could not be re-checked (no probe, or no access to the enrolled template)."); return; }
        if (!recheck.ok) { r.reasons.push("Face did not match the enrolled template on re-check."); return; }
      }
      r.eligible = true;
    });

    if (beaconID) {
      Object.entries(out).forEach(([sid, r]) => {
        if (!r.eligible) return;
        if ((det[sid] || []).some((d) => d.detectedDeviceID === beaconID && strong(d))) { r.depth = 1; r.ref = null; }
      });
      for (let d = 1; d < maxDepth; d++) {
        const atD = new Set(Object.values(out).filter((r) => r.depth === d).map((r) => r.studentID));
        Object.entries(out).forEach(([sid, r]) => {
          if (!r.eligible || r.depth != null) return;
          const hit = (det[sid] || []).find((x) => strong(x) && ephOwner[x.detectedDeviceID] && ephOwner[x.detectedDeviceID] !== sid && atD.has(ephOwner[x.detectedDeviceID]));
          if (hit) { r.depth = d + 1; r.ref = ephOwner[hit.detectedDeviceID]; }
        });
      }
    }

    Object.values(out).forEach((r) => {
      if (!r.eligible) return;
      if (r.depth != null) {
        const lateMs = (Number(session.lateAfterMinutes) || 0) * 60000;
        r.suggested = lateMs && +new Date(r.verifiedAt) - start > lateMs ? "late" : "present";
        r.method = r.depth === 1 ? "ble-direct" : "ble-chain";
        r.reasons.push(r.depth === 1 ? "Heard the lecturer's beacon directly." : "Heard a verified student (depth " + r.depth + ").");
      } else if (!beaconID) r.reasons.push("This session had no Bluetooth beacon, so proximity could not be checked. Decide manually.");
      else r.reasons.push("Lecturer beacon not heard, and no verified student within " + maxDepth + " hop(s).");
    });
    return out;
  }

  M.logic.resolveSession = resolveSession;

  /* =====================================================================
     Lecturer page
     ===================================================================== */
  const STATUS_ORDER = ["present", "late", "absent"];

  async function lecturerAttendance(root, ctx) {
    const lecturerId = ctx.user.$id;
    const groups = await M.data.lecturerGroups(lecturerId);
    if (!groups.length) { root.innerHTML = ui.pageHead("Attendance") + `<div class="card">${ui.empty("Create a course first", "Attendance sessions belong to a course group.")}<div class="center"><a class="btn" href="courses.html">Go to courses</a></div></div>`; return; }
    let gid = new URLSearchParams(location.search).get("group"); if (!groups.some((g) => g.$id === gid)) gid = groups[0].$id;
    let openId = null, timer = null, unsub = null, refreshT = null;
    const overrides = {}; // studentID -> { status, reason }  (unsaved decisions for the open session)

    const stopTimers = () => { clearInterval(timer); if (unsub) { try { unsub(); } catch (_) {} unsub = null; } };

    async function drawGroup() {
      stopTimers(); openId = null;
      const group = groups.find((g) => g.$id === gid);
      const sessions = await db.all("sessions", [Query.equal("groupID", gid), Query.orderDesc("startTime"), Query.limit(100)]);
      const active = sessions.find((s) => s.status === "active");
      root.innerHTML = ui.pageHead("Attendance", "Start sessions, watch verification live, and finalise the register.") +
        `<div class="card"><div class="row"><label for="grpSel" style="margin:0">Course</label><select id="grpSel" style="max-width:380px">${groups.map((g) => `<option value="${g.$id}" ${g.$id === gid ? "selected" : ""}>${esc(g.courseCode)} · ${esc(g.courseName)}</option>`).join("")}</select></div></div>
        <div id="startBox"></div><div id="sessionBox"></div>
        <div class="card"><h2>Sessions</h2>${sessions.length ? `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Title</th><th>Length</th><th>Status</th><th></th></tr></thead><tbody>${sessions.map((s) => `<tr><td>${ui.fmt.dt(s.startTime)}</td><td>${esc(s.title || "—")}</td><td>${s.durationMinutes} min</td><td>${ui.badge(s.status)}</td><td><button class="btn sm secondary" data-open="${s.$id}">${s.status === "finalised" ? "View / correct" : s.status === "cancelled" ? "View" : "Open"}</button></td></tr>`).join("")}</tbody></table></div>` : ui.empty("No sessions yet")}</div>`;
      root.querySelector("#grpSel").addEventListener("change", (e) => { gid = e.target.value; history.replaceState(null, "", "?group=" + gid); drawGroup(); });
      root.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openSession(sessions.find((s) => s.$id === b.dataset.open), group)));
      if (active) openSession(active, group); else drawStart(group, sessions);
    }

    /* ---------- start session ---------- */
    function drawStart(group) {
      const box = root.querySelector("#startBox"); const android = M.android.isAvailable();
      box.innerHTML = `<div class="card"><h2>Start an attendance session</h2>${android ? '<div class="notice ok small">This phone can broadcast the lecturer beacon. Keep the app open during the session.</div>' : M.android.notice() + '<div class="notice warn small">Without the Android app no beacon is broadcast. Students cannot be proximity-verified, so every record would need manual review.</div>'}
        <form id="startForm" class="form-grid"><div class="field full"><label>Title (optional)</label><input name="title" type="text" maxlength="120" placeholder="Week 5 lecture"></div>
        <div class="field"><label>Duration (minutes)</label><input name="duration" type="number" min="${A.minMinutes}" max="${A.maxMinutes}" value="${A.defaultMinutes}" required><div class="hint">Between ${A.minMinutes} and ${A.maxMinutes}.</div></div>
        <div class="field"><label>Late after (minutes)</label><input name="late" type="number" min="1" max="${A.maxMinutes}" value="${A.defaultLateAfterMinutes}" required><div class="hint">Verified after this point counts as Late.</div></div>
        <div class="field"><label>Maximum reference depth</label><input name="depth" type="number" min="1" max="${A.maxReferenceDepthLimit}" value="${A.defaultMaxReferenceDepth}" required><div class="hint">1 = must hear the lecturer; 2 = may hear a verified student.</div></div>
        <div class="field"><label>&nbsp;</label><label style="font-weight:500"><input type="checkbox" name="face"> Require face verification</label><div class="hint">Needs a face model installed on student phones.</div></div>
        <div class="full"><button class="btn accent" type="submit">Start session</button></div></form></div>`;
      box.querySelector("#startForm").addEventListener("submit", async (e) => {
        e.preventDefault(); const f = e.target; const btn = f.querySelector("button");
        const mins = Number(f.duration.value), late = Number(f.late.value), depth = Number(f.depth.value);
        if (!(mins >= A.minMinutes && mins <= A.maxMinutes)) return ui.toast("Duration must be " + A.minMinutes + "–" + A.maxMinutes + " minutes.", "warning");
        if (!(depth >= 1 && depth <= A.maxReferenceDepthLimit)) return ui.toast("Reference depth must be 1–" + A.maxReferenceDepthLimit + ".", "warning");
        if (!(late >= 1 && late <= mins)) return ui.toast("Late-after must be within the session length.", "warning");
        await ui.busy(btn, async () => {
          try {
            const live = await db.first("sessions", [Query.equal("groupID", group.$id), Query.equal("status", "active")]);
            if (live) return ui.toast("This course already has an active session.", "warning");
            const start = new Date(), end = new Date(+start + mins * 60000);
            const sessionTag = util.randomHex(4), beaconID = util.randomHex(6);
            const s = await db.create("sessions", null, { groupID: group.$id, lecturerID: lecturerId, startTime: start.toISOString(), endTime: end.toISOString(), durationMinutes: mins, status: "active", maxReferenceDepth: depth, createdAt: start.toISOString(), sessionTag, lateAfterMinutes: late, requireFace: f.face.checked, title: f.title.value.trim() || undefined }, perm.publicToUsers(lecturerId));
            await db.create("sessionSecrets", null, { sessionID: s.$id, lecturerID: lecturerId, beaconID, createdAt: start.toISOString() }, perm.lecturerOwned(lecturerId));
            await M.audit(lecturerId, "session.start", "attendance_sessions", s.$id, null, { groupID: group.$id, mins, depth });
            M.data.groupMembers(group.$id).then((ms) => ms.slice(0, 300).forEach((m) => M.notify(m.studentID, "Attendance is open", group.courseCode + ": verify within " + mins + " minutes.", "session", s.$id)));
            ui.toast("Session started.", "success");
            await drawGroup();
          } catch (err) { ui.toast(util.errMsg(err), "error"); }
        });
      });
    }

    /* ---------- open session (live roll / review / finalised) ---------- */
    async function loadBundle(session, group) {
      const [members, prox, secret, records] = await Promise.all([
        M.data.groupMembers(group.$id), db.all("proximity", [Query.equal("sessionID", session.$id)]),
        db.first("sessionSecrets", [Query.equal("sessionID", session.$id)]), db.all("records", [Query.equal("sessionID", session.$id)])
      ]);
      const claimants = prox.filter((p) => p.kind === "claim").map((p) => p.studentID);
      const faceDocs = claimants.length ? await db.allIn("faceProfiles", "userID", claimants).catch(() => []) : [];
      return { session, group, members, claims: prox.filter((p) => p.kind === "claim"), detections: prox.filter((p) => p.kind === "detection"), secret, records, faces: util.by(faceDocs, "userID") };
    }
    const resolve = (b) => resolveSession({ session: b.session, beaconID: b.secret && b.secret.beaconID, members: b.members, claims: b.claims, detections: b.detections, faces: b.faces, cfg: A, compareFace: (t, p) => { try { return M.face.compare(t, p); } catch (_) { return null; } } });

    async function openSession(session, group) {
      openId = session.$id; stopTimers();
      const box = root.querySelector("#sessionBox"); const start = root.querySelector("#startBox"); if (start) start.innerHTML = "";
      box.innerHTML = ui.spinner("Loading session…");
      async function render() {
        if (openId !== session.$id) return;
        let fresh; try { fresh = await db.get("sessions", session.$id); } catch (_) { fresh = session; } Object.assign(session, fresh);
        const b = await loadBundle(session, group); const res = resolve(b);
        const nameOf = util.by(b.members, "studentID"); const recOf = util.by(b.records, "studentID");
        const ended = Date.now() >= +new Date(session.endTime);
        const finalised = session.status === "finalised";
        const eff = (sid) => (finalised && recOf[sid] ? { status: recOf[sid].status } : overrides[sid] || { status: res[sid].suggested });
        const verified = [], waiting = [], missing = [];
        b.members.forEach((m) => { const r = res[m.studentID]; const st = eff(m.studentID).status; if (st === "present" || st === "late") verified.push(m); else if (r.hasEvidence && !finalised) waiting.push(m); else missing.push(m); });
        const li = (m) => { const r = res[m.studentID]; const st = eff(m.studentID).status; const ov = !finalised && overrides[m.studentID]; const rec = recOf[m.studentID];
          return `<li><span>${esc(m.studentName)}<br><span class="muted small">${esc(m.matricNumber)}${ov ? " · manual" : ""}${rec && rec.manuallyModified ? " · corrected" : ""}</span></span><span class="row">${ui.badge(st)}<button class="btn sm secondary" data-rev="${m.studentID}">${finalised ? "Correct" : "Review"}</button></span></li>`; };
        box.innerHTML = `<div class="card"><div class="countdown ${ended ? "ended" : ""}" id="cd"><div class="time" id="cdTime">--:--</div><div class="sub" id="cdSub"></div></div>
          <div class="row between" style="margin-top:1rem"><div><b>${esc(session.title || "Attendance session")}</b> ${ui.badge(session.status)}<div class="muted small">${ui.fmt.dt(session.startTime)} · ${session.durationMinutes} min · late after ${session.lateAfterMinutes} min · max depth ${session.maxReferenceDepth}${session.requireFace ? " · face required" : ""}</div></div><div class="table-actions" id="sessBtns"></div></div>
          ${!b.secret && session.status !== "finalised" ? '<div class="notice warn small" style="margin-top:.8rem">No beacon record exists for this session, so proximity cannot be validated.</div>' : ""}</div>
          <div class="roll"><section class="roll-col verified"><header>Verified <span>${verified.length}</span></header><ul>${verified.map(li).join("") || '<li class="muted">Nobody yet</li>'}</ul></section>
          <section class="roll-col waiting"><header>Awaiting verification <span>${waiting.length}</span></header><ul>${waiting.map(li).join("") || '<li class="muted">Nobody</li>'}</ul></section>
          <section class="roll-col missing"><header>Not verified <span>${missing.length}</span></header><ul>${missing.map(li).join("") || '<li class="muted">Nobody</li>'}</ul></section></div>`;
        const btns = box.querySelector("#sessBtns");
        const add = (text, cls, fn) => { const x = document.createElement("button"); x.className = "btn sm " + cls; x.textContent = text; x.addEventListener("click", () => ui.busy(x, fn)); btns.appendChild(x); };
        if (session.status === "active") {
          if (M.android.isAvailable() && b.secret) add("Resume beacon", "secondary", () => advertise(session, b.secret).then(() => ui.toast("Beacon running.", "success")).catch((e) => ui.toast(util.errMsg(e), "error")));
          add("End now", "secondary", async () => { if (await ui.confirm({ title: "End the session now?", message: "Students can no longer submit verification. You can then review and finalise.", confirmText: "End session" })) { await closeSession(session); render(); } });
          add("Cancel", "ghost", async () => { if (await ui.confirm({ title: "Cancel this session?", message: "No attendance will be recorded.", confirmText: "Cancel session", danger: true })) { await setStatus(session, "cancelled"); await drawGroup(); } });
        } else if (session.status === "closed") add("Finalise attendance", "accent", () => finalise(b, res, eff).then((ok) => ok && drawGroup()));
        const cdTime = box.querySelector("#cdTime"), cdSub = box.querySelector("#cdSub"), cd = box.querySelector("#cd");
        const tick = async () => {
          const left = +new Date(session.endTime) - Date.now();
          if (session.status === "active") { if (left <= 0) { cdTime.textContent = "00:00"; cdSub.textContent = "Time is up. Closing session…"; clearInterval(timer); await closeSession(session); render(); } else { cdTime.textContent = ui.fmt.mmss(left); cdSub.textContent = "Students can verify until this reaches zero"; } }
          else { cdTime.textContent = session.status === "finalised" ? "Finalised" : session.status === "cancelled" ? "Cancelled" : "Ended"; cdSub.textContent = session.status === "closed" ? "Review the register, then finalise." : ""; cd.classList.add("ended"); }
        };
        clearInterval(timer); tick(); timer = setInterval(tick, 1000);
        box.querySelectorAll("[data-rev]").forEach((x) => x.addEventListener("click", () => review(b, res, nameOf[x.dataset.rev], finalised, recOf[x.dataset.rev], render)));
      }
      await render();
      const later = () => { clearTimeout(refreshT); refreshT = setTimeout(() => { if (!document.querySelector(".modal-back")) render().catch(() => {}); }, 900); };
      unsub = db.subscribe(["proximity", "sessions", "records"], later);
      if (session.status === "active" && M.android.isAvailable()) { const sec = await db.first("sessionSecrets", [Query.equal("sessionID", session.$id)]); if (sec) advertise(session, sec).catch((e) => ui.toast(util.errMsg(e), "warning")); }
    }

    function advertise(session, secret) {
      return M.android.readiness(true).then((r) => { if (!r.ok) throw new Error(r.problems.join(" ")); return M.android.startAdvertising({ sessionId: session.$id, sessionTag: session.sessionTag, ephemeralId: secret.beaconID, role: "lecturer", endsAt: +new Date(session.endTime) }); });
    }
    async function setStatus(session, status, extra) { await db.update("sessions", session.$id, Object.assign({ status }, extra || {})); session.status = status; if (M.android.isAvailable()) { try { await M.android.stopAdvertising(); } catch (_) {} } }
    async function closeSession(session) { if (session.status !== "active") return; await setStatus(session, "closed"); await M.audit(lecturerId, "session.close", "attendance_sessions", session.$id); }

    /* ---------- evidence review + manual decision ---------- */
    function review(b, res, member, finalised, rec, rerender) {
      const r = res[member.studentID]; const dets = b.detections.filter((d) => d.studentID === member.studentID); const claim = b.claims.find((c) => c.studentID === member.studentID);
      const ephOwner = {}; b.claims.forEach((c) => { if (c.ephemeralID) ephOwner[c.ephemeralID] = c.studentID; }); const nm = util.by(b.members, "studentID");
      const cur = finalised ? (rec ? rec.status : "absent") : (overrides[member.studentID] || { status: r.suggested }).status;
      const detRows = dets.map((d) => `<tr><td class="mono">${esc(d.detectedDeviceID)}</td><td>${b.secret && d.detectedDeviceID === b.secret.beaconID ? "Lecturer beacon" : ephOwner[d.detectedDeviceID] ? esc((nm[ephOwner[d.detectedDeviceID]] || {}).studentName || "Student") : "Unknown device"}</td><td>${d.signalStrength == null ? "—" : d.signalStrength + " dBm"}</td><td>${ui.fmt.t(d.detectedAt)}</td></tr>`).join("");
      const f = r.face && r.face.recheck;
      const html = `<p><b>${esc(member.studentName)}</b> <span class="muted">${esc(member.matricNumber)}</span></p>
        <div class="evidence stack"><div>System suggestion: ${ui.badge(r.suggested)} ${r.depth ? `<span class="badge info">depth ${r.depth}</span>` : ""}</div>
        <ul>${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No verification was submitted.</li>"}</ul>
        <div>Claim received (server time): <b>${claim ? ui.fmt.dt(claim.$createdAt) : "none"}</b></div>
        <div>Face: ${f ? (f.ok ? '<span class="badge ok">match</span>' : '<span class="badge bad">no match</span>') + ` <span class="muted">${esc(f.metric)} ${f.score == null ? "" : f.score.toFixed(3)} (threshold ${f.threshold})</span>` : '<span class="muted">not re-checked</span>'}${r.face && r.face.submittedScore != null ? ` <span class="muted">· phone reported ${Number(r.face.submittedScore).toFixed(3)}</span>` : ""}</div>
        ${dets.length ? `<div class="table-wrap"><table><thead><tr><th>Device ID</th><th>Resolved as</th><th>Signal</th><th>Seen</th></tr></thead><tbody>${detRows}</tbody></table></div><div class="muted small">Signal strength is only a rough hint. It is not a distance.</div>` : ""}</div>
        <hr style="border:0;border-top:1px solid var(--grey-200);margin:1rem 0"><div class="form-grid"><div class="field"><label>${finalised ? "Corrected status" : "Decision"}</label><select id="decSel">${STATUS_ORDER.map((s) => `<option value="${s}" ${s === cur ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></div><div class="field"><label>Reason ${finalised ? "(required)" : "(required if you change the suggestion)"}</label><input id="decWhy" type="text" maxlength="300" value="${esc((rec && rec.modificationReason) || (overrides[member.studentID] || {}).reason || "")}"></div></div>`;
      ui.modal({ title: finalised ? "Correct attendance" : "Review verification", wide: true, body: html, buttons: [{ text: "Cancel" }, { text: finalised ? "Save correction" : "Apply decision", cls: "accent", async onClick(api) {
        const status = api.body.querySelector("#decSel").value; const why = api.body.querySelector("#decWhy").value.trim();
        if (finalised) {
          if (!rec) return ui.toast("This student has no record for this session.", "error");
          if (status === rec.status) return ui.toast("Status is unchanged.", "warning"); if (!why) return ui.toast("Enter a reason for the correction.", "warning");
          try {
            const now = util.iso();
            await db.update("records", rec.$id, { status, manuallyModified: true, modifiedBy: lecturerId, modificationReason: why });
            await M.audit(lecturerId, "attendance.correct", "attendance_records", rec.$id, { status: rec.status }, { status, reason: why, lecturerID: lecturerId, at: now });
            await M.notify(member.studentID, "Attendance corrected", "Your attendance for " + ui.fmt.d(b.session.startTime) + " is now " + status + ".", "attendance", rec.$id);
            ui.toast("Correction saved.", "success"); api.close(); rerender();
          } catch (e) { ui.toast(util.errMsg(e), "error"); }
          return;
        }
        if (status === r.suggested) delete overrides[member.studentID]; else { if (!why) return ui.toast("Enter a reason for overriding the suggestion.", "warning"); overrides[member.studentID] = { status, reason: why }; }
        api.close(); rerender();
      } }] });
    }

    /* ---------- finalise ---------- */
    async function finalise(b, res, eff) {
      const { session, group, members } = b;
      if (session.status !== "closed") { ui.toast("End the session before finalising.", "warning"); return false; }
      const counts = { present: 0, late: 0, absent: 0 }; members.forEach((m) => counts[eff(m.studentID).status]++);
      if (!(await ui.confirm({ title: "Finalise attendance?", message: `Present ${counts.present}, Late ${counts.late}, Absent ${counts.absent}. This creates official records and a new attendance column in the gradebook. You can correct individual records afterwards, with a reason.`, confirmText: "Finalise" }))) return false;
      ui.loading(true);
      try {
        const have = util.by(b.records, "studentID"); let made = 0;
        for (const m of members) {
          if (have[m.studentID]) continue; // already written by an earlier attempt: idempotent
          const r = res[m.studentID]; const e = eff(m.studentID); const ov = overrides[m.studentID];
          const data = { sessionID: session.$id, groupID: group.$id, studentID: m.studentID, status: e.status, verificationMethod: ov ? "manual" : e.status === "absent" ? "none" : r.method || "manual", manuallyModified: !!ov };
          if (r.verifiedAt && e.status !== "absent") data.verifiedAt = r.verifiedAt;
          if (r.depth != null && !ov && e.status !== "absent") data.referenceDepth = r.depth;
          if (ov) { data.modifiedBy = lecturerId; data.modificationReason = ov.reason; }
          try { await db.create("records", null, data, perm.lecturerOwned(lecturerId, [m.studentID])); made++; } catch (err) { if (err.code !== 409) throw err; } // unique (session, student) blocks duplicates
        }
        const cols = await db.all("columns", [Query.equal("groupID", group.$id), Query.equal("category", "attendance")]);
        if (!cols.some((c) => c.sourceSessionID === session.$id)) {
          await db.create("columns", null, { groupID: group.$id, columnName: "Attendance " + ui.fmt.d(session.startTime) + (session.title ? " – " + session.title : ""), category: "attendance", maximumScore: 1, columnOrder: cols.length + 1, createdBy: lecturerId, createdAt: util.iso(), isArchived: false, sourceSessionID: session.$id }, perm.publicToUsers(lecturerId));
        }
        await db.update("sessions", session.$id, { status: "finalised", finalisedAt: util.iso() }); session.status = "finalised";
        await M.audit(lecturerId, "session.finalise", "attendance_sessions", session.$id, { status: "closed" }, { counts, recordsCreated: made });
        members.forEach((m) => M.notify(m.studentID, "Attendance recorded", group.courseCode + ": " + eff(m.studentID).status + ".", "attendance", session.$id));
        Object.keys(overrides).forEach((k) => delete overrides[k]);
        ui.toast("Attendance finalised.", "success"); return true;
      } catch (e) { ui.toast("Finalising stopped part-way: " + util.errMsg(e) + " Press Finalise again to continue safely.", "error"); return false; }
      finally { ui.loading(false); }
    }

    await drawGroup();
  }

  /* =====================================================================
     Student page: verify + history
     ===================================================================== */
  async function studentAttendance(root, ctx) {
    const sid = ctx.user.$id; let panelOpen = false, unsub = null, refreshT = null;
    async function draw() {
      const { groups } = await M.data.studentGroups(sid); const gids = groups.map((g) => g.$id); const gmap = util.by(groups, "$id");
      const [sessions, records] = await Promise.all([gids.length ? db.allIn("sessions", "groupID", gids, [Query.orderDesc("startTime")]) : [], db.all("records", [Query.equal("studentID", sid)])]);
      const live = sessions.filter((s) => s.status === "active" && +new Date(s.endTime) > Date.now()); const sOf = util.by(sessions, "$id");
      const fin = sessions.filter((s) => s.status === "finalised");
      let filter = (root.querySelector("#hFilter") || {}).value || "";
      const sum = groups.map((g) => { const rs = records.filter((r) => r.groupID === g.$id); const n = fin.filter((s) => s.groupID === g.$id).length; const p = M.logic.attendancePercent(rs, n, M.logic.rules(g)); return { g, n, p, present: rs.filter((r) => r.status === "present").length, late: rs.filter((r) => r.status === "late").length, absent: rs.filter((r) => r.status === "absent").length }; });
      const rows = records.filter((r) => (!filter || r.groupID === filter) && sOf[r.sessionID]).sort((a, b) => +new Date(sOf[b.sessionID].startTime) - +new Date(sOf[a.sessionID].startTime));
      root.innerHTML = ui.pageHead("Attendance", "Verify attendance when a session is open, and review your history.") +
        `<div id="liveBox">${live.length ? live.map((s) => `<div class="card session-banner"><div><b>${esc(gmap[s.groupID].courseCode)} · ${esc(gmap[s.groupID].courseName)}</b><div class="muted small">${esc(s.title || "Attendance session")} · closes ${ui.fmt.t(s.endTime)}</div></div><button class="btn accent" data-verify="${s.$id}">Verify attendance</button></div><div id="panel_${s.$id}"></div>`).join("") : `<div class="card">${ui.empty("No session is open", "When a lecturer starts attendance for one of your courses it will appear here.")}</div>`}</div>
        <div class="card"><h2>Attendance by course</h2>${sum.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Sessions</th><th>Present</th><th>Late</th><th>Absent</th><th>Attendance</th></tr></thead><tbody>${sum.map((x) => `<tr><td>${esc(x.g.courseCode)}</td><td>${x.n}</td><td>${x.present}</td><td>${x.late}</td><td>${x.absent}</td><td><b>${ui.fmt.pct(x.p)}</b></td></tr>`).join("")}</tbody></table></div>` : ui.empty("No courses joined")}</div>
        <div class="card"><div class="row between"><h2>History</h2><select id="hFilter" style="max-width:260px"><option value="">All courses</option>${groups.map((g) => `<option value="${g.$id}" ${g.$id === filter ? "selected" : ""}>${esc(g.courseCode)}</option>`).join("")}</select></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Date</th><th>Status</th><th>Verification time</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc((gmap[r.groupID] || {}).courseName || "")}</td><td>${ui.fmt.dt(sOf[r.sessionID].startTime)}</td><td>${ui.badge(r.status)}${r.manuallyModified ? ' <span class="muted small">corrected</span>' : ""}</td><td>${r.verifiedAt ? ui.fmt.t(r.verifiedAt) : "—"}</td></tr>`).join("")}</tbody></table></div>` : ui.empty("No records yet", "Finalised sessions show up here.")}</div>`;
      root.querySelector("#hFilter").addEventListener("change", draw);
      root.querySelectorAll("[data-verify]").forEach((b) => b.addEventListener("click", () => { const s = live.find((x) => x.$id === b.dataset.verify); panelOpen = true; b.disabled = true; verifyPanel(root.querySelector("#panel_" + s.$id), ctx, s, gmap[s.groupID]); }));
    }
    await draw();
    unsub = db.subscribe(["sessions", "records"], (ev) => { clearTimeout(refreshT); refreshT = setTimeout(() => { if (!panelOpen) draw().catch(() => {}); else if ((ev.events || []).some((e) => /records/.test(e))) ui.toast("Your attendance record was updated.", "info"); }, 800); });
  }

  /* ---------- the verification flow ---------- */
  function verifyPanel(el, ctx, session, group) {
    const sid = ctx.user.$id; const key = "muster.eph." + session.$id;
    let eph = sessionStorage.getItem(key); if (!/^[0-9a-f]{12}$/.test(eph || "")) { eph = util.randomHex(6); sessionStorage.setItem(key, eph); }
    const st = { device: null, ble: false, face: null, submitted: false, heard: new Map(), posted: new Set(), lecturerHeard: false };
    const needFace = !!session.requireFace; const endsAt = +new Date(session.endTime);
    let flushT = null, offDev = null;

    el.innerHTML = `<div class="card"><div class="row between"><h2>Verify attendance</h2><span class="badge info" id="vLeft"></span></div>${M.android.isAvailable() ? "" : M.android.notice()}
      <ol class="steps"><li id="s1"><div><b>Check this phone</b><span class="muted small" id="s1t">Bluetooth must be on and permissions granted.</span><div class="table-actions" style="margin-top:.4rem"><button class="btn sm" id="b1">Check phone</button></div></div></li>
      <li id="s2"><div><b>Turn on Bluetooth verification</b><span class="muted small" id="s2t">Your phone shares a temporary code (no name or matric number) and listens for nearby verified phones.</span><div class="table-actions" style="margin-top:.4rem"><button class="btn sm" id="b2" disabled>Start</button></div></div></li>
      ${needFace ? `<li id="s3"><div><b>Verify your face</b><span class="muted small" id="s3t">This session requires a face check. Your face template is shared with the course lecturer for this check.</span><div class="table-actions" style="margin-top:.4rem"><button class="btn sm" id="b3" disabled>Open camera</button></div></div></li>` : ""}
      <li id="s4"><div><b>Submit for lecturer review</b><span class="muted small" id="s4t">The lecturer confirms your attendance. Being detected alone does not mark you present.</span><div class="table-actions" style="margin-top:.4rem"><button class="btn accent sm" id="b4" disabled>Submit</button></div></div></li></ol></div>`;
    const $ = (id) => el.querySelector("#" + id); const mark = (id, cls) => { const li = $(id); li.className = cls || ""; };
    const left = setInterval(() => { const ms = endsAt - Date.now(); $("vLeft").textContent = ms > 0 ? ui.fmt.mmss(ms) + " left" : "Session ended"; if (ms <= 0) { clearInterval(left); clearInterval(flushT); $("b4").disabled = true; } }, 1000);

    $("b1").addEventListener("click", () => ui.busy($("b1"), async () => {
      let r = await M.android.readiness(true);
      if (!r.ok && M.android.isAvailable() && r.problems.some((p) => /permission/i.test(p))) { try { await M.android.requestPermissions(); r = await M.android.readiness(true); } catch (_) {} }
      $("s1t").textContent = r.ok ? "This phone is ready." : r.problems.join(" "); mark("s1", r.ok ? "done" : "fail"); st.device = r.ok; $("b2").disabled = !r.ok; if (r.ok) mark("s2", "now");
    }));
    $("b2").addEventListener("click", () => ui.busy($("b2"), async () => {
      try {
        const base = { sessionId: session.$id, sessionTag: session.sessionTag, ephemeralId: eph, endsAt };
        await M.android.startAdvertising(Object.assign({ role: "student" }, base)); await M.android.startScan(Object.assign({ role: "student" }, base));
        st.ble = true; mark("s2", "done"); if (needFace) { $("b3").disabled = false; mark("s3", "now"); } else { $("b4").disabled = false; mark("s4", "now"); }
        offDev = M.android.on("devices", (arr) => { arr.forEach((d) => { if (d.ephemeralId !== eph) { st.heard.set(d.ephemeralId, d); if (d.role === "lecturer") st.lecturerHeard = true; } }); $("s2t").textContent = `Listening. ${st.heard.size} nearby device(s) heard${st.lecturerHeard ? ", including the lecturer's phone" : ""}.`; });
        M.android.on("error", (e) => ui.toast("Bluetooth: " + (e.message || e.code || "error"), "error"));
        flushT = setInterval(flush, 10000);
      } catch (e) { ui.toast(util.errMsg(e), "error"); mark("s2", "fail"); }
    }));
    if (needFace) $("b3").addEventListener("click", () => faceStep());

    function faceStep() {
      const m = ui.modal({ title: "Verify your face", body: `<p class="muted small">Look at the camera in good light. Only you should be in the frame. This model has no liveness check.</p><div class="cam-box"><video id="cv" autoplay muted playsinline></video><div class="oval"></div></div><div id="fres" class="notice info small">Starting camera…</div>`, onClose: M.face.stopCamera, buttons: [{ text: "Close" }, { text: "Capture and verify", cls: "accent", id: "cap", async onClick() {
        const out = m.body.querySelector("#fres"); out.className = "notice info small"; out.textContent = "Checking…";
        try { const canvas = M.face.capture(m.body.querySelector("#cv")); const r = await M.face.verify(sid, canvas); st.face = r;
          if (r.ok) { out.className = "notice ok small"; out.textContent = "Face matched on this phone. The lecturer will re-check it."; mark("s3", "done"); $("b4").disabled = false; mark("s4", "now"); setTimeout(m.close, 900); }
          else { out.className = "notice bad small"; out.textContent = "Face did not match. Retake in better light, facing the camera."; }
        } catch (e) { out.className = "notice bad small"; out.textContent = util.errMsg(e); }
      } }] });
      M.face.startCamera(m.body.querySelector("#cv")).then(() => (m.body.querySelector("#fres").textContent = "Camera ready.")).catch((e) => { m.body.querySelector("#fres").className = "notice bad small"; m.body.querySelector("#fres").textContent = util.errMsg(e); });
    }

    async function flush() {
      if (Date.now() > endsAt + 15000) return;
      const fresh = [...st.heard.values()].filter((d) => !st.posted.has(d.ephemeralId)); if (!fresh.length) return;
      await Promise.allSettled(fresh.map((d) => { st.posted.add(d.ephemeralId); return db.create("proximity", null, { sessionID: session.$id, groupID: group.$id, studentID: sid, kind: "detection", detectedDeviceID: d.ephemeralId, signalStrength: Math.round(Number(d.rssi)) || -100, detectedAt: new Date(d.detectedAt || Date.now()).toISOString(), verificationStatus: "unreviewed" }, perm.evidence(sid, group.lecturerID)).catch((e) => { if (e.code !== 409) st.posted.delete(d.ephemeralId); }); }));
    }

    $("b4").addEventListener("click", () => ui.busy($("b4"), async () => {
      if (Date.now() > endsAt) return ui.toast("The session has ended.", "error");
      if (needFace && !(st.face && st.face.ok)) return ui.toast("Complete the face check first.", "warning");
      try {
        const dup = await db.first("proximity", [Query.equal("sessionID", session.$id), Query.equal("studentID", sid), Query.equal("kind", "claim")]);
        if (dup) { done(dup); return; }
        if (needFace) await M.face.shareWithLecturer(sid, group.lecturerID);
        await flush();
        const data = { sessionID: session.$id, groupID: group.$id, studentID: sid, kind: "claim", detectedDeviceID: "claim", ephemeralID: eph, detectedAt: util.iso(), verificationStatus: "unreviewed" };
        if (st.face) { data.faceScore = st.face.score; data.faceModelVersion = st.face.modelVersion; data.faceProbe = st.face.probe; }
        const c = await db.create("proximity", null, data, perm.evidence(sid, group.lecturerID));
        await M.audit(sid, "attendance.claim", "proximity_records", c.$id);
        done(c);
      } catch (e) { ui.toast(e.code === 409 ? "You already submitted for this session." : util.errMsg(e), "error"); }
    }));
    function done(c) { st.submitted = true; mark("s4", "done"); $("s4t").textContent = "Submitted at " + ui.fmt.t(c.$createdAt) + ". Keep Bluetooth on and the app open until the session ends so others can use you as a reference."; $("b4").disabled = true; ui.toast("Submitted. Waiting for the lecturer.", "success"); }
  }

  M.pages = M.pages || {};
  M.pages["lecturer/attendance"] = lecturerAttendance;
  M.pages["student/attendance"] = studentAttendance;
})();
