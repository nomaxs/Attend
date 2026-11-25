/* =========================
FILE OVERVIEW
========================= */
// The one place the Appwrite client is created. Everything else uses Attend.db / Attend.account / Attend.perm.
// Uses the Appwrite Web SDK 13 CDN global (same as the X-Redro project): Appwrite.Client, Account, Databases, Storage, Teams.

(function () {
  const C = window.ATTEND_CONFIG;
  if (!C) throw new Error("config.js must be loaded before appwrite.js");
  if (!window.Appwrite) { document.body.innerHTML = "<p style='padding:1rem'>The Appwrite SDK failed to load. Check your internet connection.</p>"; throw new Error("Appwrite SDK missing"); }
  if (window.Attend && window.Attend.client) return; // avoid duplicate initialisation

  const client = new Appwrite.Client().setEndpoint(C.endpoint).setProject(C.projectId);
  const account = new Appwrite.Account(client);
  const databases = new Appwrite.Databases(client);
  const storage = new Appwrite.Storage(client);
  const teams = new Appwrite.Teams(client);
  const { Query, ID, Permission, Role } = Appwrite;
  const DB = C.databaseId;
  const M = (window.Attend = window.Attend || {});

  const isConfigured = () => !/REPLACE/i.test(C.projectId) && !/REPLACE/i.test(C.databaseId);
  const colId = (key) => { const id = C.collections[key]; if (!id) throw new Error("Unknown collection key: " + key); return id; };
  const iso = (d) => (d instanceof Date ? d : new Date(d || Date.now())).toISOString();

  /* ---------- reusable database functions ---------- */
  const db = {
    get: (key, id) => databases.getDocument(DB, colId(key), id),
    list: (key, queries) => databases.listDocuments(DB, colId(key), queries || []),
    create: (key, id, data, perms) => databases.createDocument(DB, colId(key), id || ID.unique(), data, perms),
    update: (key, id, data, perms) => databases.updateDocument(DB, colId(key), id, data, perms),
    remove: (key, id) => databases.deleteDocument(DB, colId(key), id),
    async first(key, queries) { const r = await db.list(key, [...(queries || []), Query.limit(1)]); return r.documents[0] || null; },
    async tryGet(key, id) { try { return await db.get(key, id); } catch (e) { if (e && e.code === 404) return null; throw e; } },
    // Pages through every matching document (Appwrite returns at most 100 per request).
    async all(key, queries) {
      const out = []; let cursor = null;
      for (;;) {
        const q = [...(queries || []), Query.limit(100)];
        if (cursor) q.push(Query.cursorAfter(cursor));
        const r = await db.list(key, q);
        out.push(...r.documents);
        if (r.documents.length < 100) break;
        cursor = r.documents[r.documents.length - 1].$id;
      }
      return out;
    },
    // Query.equal with many values, split to stay within Appwrite limits.
    async allIn(key, field, values, extra) {
      const out = []; const vals = [...new Set(values)];
      for (let i = 0; i < vals.length; i += 50) out.push(...await db.all(key, [Query.equal(field, vals.slice(i, i + 50)), ...(extra || [])]));
      return out;
    },
    // Realtime: returns an unsubscribe function. Appwrite only delivers documents the signed-in user may read.
    subscribe(keys, cb) {
      const chans = keys.map((k) => `databases.${DB}.collections.${colId(k)}.documents`);
      return client.subscribe(chans, cb);
    }
  };

  /* ---------- document permissions ---------- */
  // Students never get update/delete on official records. Only the lecturer (and, for Tier B, only team members who can create them).
  const u = (id) => Role.user(id);
  const perm = {
    self: (id) => [Permission.read(u(id)), Permission.update(u(id)), Permission.delete(u(id))],
    lecturerOwned: (lecturerId, readers) => [Permission.read(u(lecturerId)), Permission.update(u(lecturerId)), Permission.delete(u(lecturerId)), ...(readers || []).map((r) => Permission.read(u(r)))],
    publicToUsers: (lecturerId) => [Permission.read(Role.users()), Permission.update(u(lecturerId)), Permission.delete(u(lecturerId))],
    request: (studentId, lecturerId) => [Permission.read(u(studentId)), Permission.read(u(lecturerId)), Permission.update(u(lecturerId)), Permission.delete(u(lecturerId)), Permission.delete(u(studentId))],
    evidence: (studentId, lecturerId) => [Permission.read(u(studentId)), Permission.read(u(lecturerId)), Permission.update(u(lecturerId)), Permission.delete(u(lecturerId))],
    readOnlyBy: (id) => [Permission.read(u(id))],
    recipient: (id) => [Permission.read(u(id)), Permission.update(u(id)), Permission.delete(u(id))]
  };

  /* ---------- small utilities ---------- */
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
  const util = {
    iso,
    esc: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    hex: (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""),
    randomHex: (n) => util.hex(util.randomBytes(n)),
    joinCode(len) { len = len || 8; const r = util.randomBytes(len); return Array.from(r).map((b) => ALPHABET[b % ALPHABET.length]).join(""); },
    initials: (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join(""),
    clamp: (n, a, b) => Math.min(b, Math.max(a, n)),
    json(str, fallback) { try { const v = JSON.parse(str); return v == null ? fallback : v; } catch (_) { return fallback; } },
    by: (arr, key) => Object.fromEntries(arr.map((x) => [x[key], x])),
    group(arr, key) { const o = {}; arr.forEach((x) => { (o[x[key]] = o[x[key]] || []).push(x); }); return o; },
    errMsg(e) {
      if (!e) return "Something went wrong.";
      if (e.code === 401) return "Your session has expired. Please log in again.";
      if (e.code === 403) return "You do not have permission to do that.";
      if (e.code === 409) return "That record already exists.";
      if (e.code === 429) return "Too many requests. Wait a moment and try again.";
      if (e.type === "general_unauthorized_scope") return "You do not have permission to do that.";
      return e.message || "Something went wrong.";
    }
  };

  /* ---------- audit + notifications ---------- */
  async function audit(userID, action, recordType, recordID, previousValue, newValue) {
    const clip = (v) => (v == null ? undefined : String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 950));
    const data = { userID, action, recordType, recordID: String(recordID).slice(0, 36), createdAt: iso() };
    if (previousValue != null) data.previousValue = clip(previousValue);
    if (newValue != null) data.newValue = clip(newValue);
    try { await db.create("audit", null, data, perm.readOnlyBy(userID)); } catch (e) { console.warn("Audit log failed:", e); }
  }
  async function notify(userID, title, message, type, refID) {
    const data = { userID, title: String(title).slice(0, 120), message: String(message).slice(0, 500), type: type || "info", isRead: false, createdAt: iso() };
    if (refID) data.refID = String(refID).slice(0, 36);
    try { await db.create("notifications", null, data, perm.recipient(userID)); } catch (e) { console.warn("Notification failed:", e); }
  }

  /* ---------- lecturer team ---------- */
  async function inLecturerTeam() {
    if (!C.lecturerTeamId) return null; // null = not enforced
    try { const r = await teams.list(); return r.teams.some((t) => t.$id === C.lecturerTeamId); } catch (_) { return false; }
  }

  Object.assign(M, { cfg: C, client, account, databases, storage, teams, Query, ID, Permission, Role, db, perm, util, audit, notify, inLecturerTeam, isConfigured, colId });
})();
