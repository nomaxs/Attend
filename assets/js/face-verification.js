/* =========================
FILE OVERVIEW
========================= */
// Facial enrolment and verification, built around a pluggable recognition-model adapter.
//
// WHAT THIS FILE DOES NOT DO: it does not contain a face recognition model. Ordinary face DETECTION (finding a face in
// a picture) is not identity verification, so this module refuses to enrol or verify unless a real embedding model is loaded.
// WHAT YOU MUST INSTALL: see assets/models/README.md (default adapter: face-api.js + its ResNet-128 recognition weights).
// TRUST LIMIT: with no server-side code, the comparison on the student's phone is evidence, not proof. The lecturer's browser
// re-compares the submitted probe against the enrolled template (Attend.face.compare) before accepting it.
// There is NO liveness / anti-spoofing check here (a photo of a face can fool most embedding models).

(function () {
  const M = window.Attend;
  const C = M.cfg.face;
  const base = () => document.body.dataset.base || "";
  let adapter = null; let loadError = null; let stream = null;

  /* ---------- adapter contract ----------
     { name, version, load(): Promise, embed(imageOrCanvas): Promise<Float32Array|null>  // null when no single face is found
     } */
  function registerAdapter(a) {
    if (!a || typeof a.embed !== "function" || typeof a.load !== "function" || !a.version) throw new Error("Invalid face adapter");
    adapter = a;
  }

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src)); document.head.appendChild(s); });
  }

  const faceApiAdapter = {
    name: "face-api.js", version: C.modelVersion,
    async load() {
      if (!window.faceapi) await loadScript(base() + C.scriptPath);
      if (!window.faceapi) throw new Error("face-api.js did not initialise.");
      const url = base() + C.modelPath;
      await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(url), faceapi.nets.faceLandmark68TinyNet.loadFromUri(url), faceapi.nets.faceRecognitionNet.loadFromUri(url)]);
    },
    async landmarks(input) {
      const r = await faceapi.detectSingleFace(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })).withFaceLandmarks(true);
      return r ? r.landmarks.positions.map((p) => ({ x: p.x, y: p.y })) : null;
    },
    async embed(input) {
      const all = await faceapi.detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks(true).withFaceDescriptors();
      if (all.length !== 1) return all.length === 0 ? null : "multiple";
      return Float32Array.from(all[0].descriptor);
    }
  };

  // Loads the model once. Resolves { ready, reason }.
  let initPromise = null;
  function init() {
    if (!initPromise) initPromise = (async () => {
      try { if (!adapter) registerAdapter(faceApiAdapter); await adapter.load(); return { ready: true }; }
      catch (e) { loadError = e; adapter = null; return { ready: false, reason: "No face recognition model is installed. " + (e && e.message ? e.message : "") + " See assets/models/README.md." }; }
    })();
    return initPromise;
  }

  /* ---------- vector helpers ---------- */
  const toB64 = (vec) => { const b = new Uint8Array(new Float32Array(vec).buffer); let s = ""; b.forEach((x) => (s += String.fromCharCode(x))); return btoa(s); };
  const fromB64 = (str) => { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new Float32Array(b.buffer); };
  const mean = (vs) => { const o = new Float32Array(vs[0].length); vs.forEach((v) => v.forEach((x, i) => (o[i] += x / vs.length))); return o; };

  // Returns { ok, score, metric, threshold }. score is a distance (euclidean) or a similarity (cosine).
  function compare(templateB64, probeB64) {
    const a = fromB64(templateB64), b = fromB64(probeB64);
    if (a.length !== b.length || !a.length) return { ok: false, score: null, metric: C.metric, threshold: C.threshold, reason: "Template and probe are not comparable (different model or size)." };
    if (C.metric === "cosine") {
      let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      const s = d / (Math.sqrt(na) * Math.sqrt(nb) || 1); return { ok: s >= C.threshold, score: s, metric: "cosine", threshold: C.threshold };
    }
    let sum = 0; for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    const dist = Math.sqrt(sum); return { ok: dist <= C.threshold, score: dist, metric: "euclidean", threshold: C.threshold };
  }

  /* ---------- camera (only after a user tap; never auto-captures) ---------- */
  async function startCamera(videoEl) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser cannot access the camera.");
    stopCamera();
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); }
    catch (e) { throw new Error(e && e.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access and try again." : "Could not start the camera: " + (e.message || e.name)); }
    videoEl.srcObject = stream; videoEl.setAttribute("playsinline", ""); videoEl.muted = true; await videoEl.play();
  }
  function stopCamera() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
  function capture(videoEl) {
    const c = document.createElement("canvas"); c.width = videoEl.videoWidth || 640; c.height = videoEl.videoHeight || 480;
    c.getContext("2d").drawImage(videoEl, 0, 0, c.width, c.height); return c;
  }

  async function embedOne(canvas) {
    const st = await init(); if (!st.ready) throw new Error(st.reason);
    const v = await adapter.embed(canvas);
    if (v === "multiple") throw new Error("More than one face was found. Only you should be in the frame.");
    if (!v) throw new Error("No face found. Face the camera in good light and retake the photo.");
    return v;
  }

  /* ---------- active liveness (challenge-response) ----------
     The person must blink and turn their head, in a random order, while the camera watches facial landmarks.
     This stops a still photo being held up to the camera. It does NOT stop a pre-recorded video or a 3D mask, it runs on the
     phone, and it is not equivalent to the passive liveness in commercial bank-grade SDKs. Treat it as one layer of evidence. */
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ear = (p, i) => (dist(p[i + 1], p[i + 5]) + dist(p[i + 2], p[i + 4])) / (2 * dist(p[i], p[i + 3]));
  const eyeEar = (p) => (ear(p, 36) + ear(p, 42)) / 2;                       // 68-point model: eyes are points 36-41 and 42-47
  const noseRatio = (p) => (p[30].x - p[0].x) / (p[16].x - p[0].x || 1);     // ~0.5 when facing the camera
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const livenessAvailable = () => !!(adapter && typeof adapter.landmarks === "function");

  async function until(video, ms, test) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const p = await adapter.landmarks(video).catch(() => null); if (p && p.length === 68 && test(p)) return true; await wait(100); }
    return false;
  }

  // onPrompt(text) shows instructions. Resolves { ok, reason }.
  async function liveness(video, onPrompt) {
    const st = await init(); if (!st.ready) return { ok: false, reason: st.reason };
    if (!livenessAvailable()) return { ok: false, reason: "This face model cannot run a liveness check." };
    const ms = C.livenessStepMs || 8000;
    const steps = [
      { name: "blink", prompt: "Blink once", run: async () => { if (!(await until(video, ms, (p) => eyeEar(p) > C.blinkOpenEar))) return false; if (!(await until(video, ms, (p) => eyeEar(p) < C.blinkClosedEar))) return false; return until(video, ms, (p) => eyeEar(p) > C.blinkOpenEar); } },
      { name: "turn", prompt: "Slowly turn your head to one side", run: () => until(video, ms, (p) => Math.abs(noseRatio(p) - 0.5) > C.turnDelta) }
    ];
    if (crypto.getRandomValues(new Uint8Array(1))[0] & 1) steps.reverse();
    for (const s of steps) { onPrompt && onPrompt(s.prompt); if (!(await s.run())) return { ok: false, reason: "Liveness check not completed (" + s.name + "). Try again in good light." }; }
    onPrompt && onPrompt("Now look straight at the camera");
    if (!(await until(video, ms, (p) => Math.abs(noseRatio(p) - 0.5) < 0.07 && eyeEar(p) > C.blinkOpenEar))) return { ok: false, reason: "Please look straight at the camera." };
    await wait(250);
    return { ok: true };
  }

  /* ---------- enrolment / verification ---------- */
  const getEnrolment = async (userId) => M.db.first("faceProfiles", [M.Query.equal("userID", userId)]);

  async function enrol(userId, canvases) {
    const vecs = []; for (const c of canvases) vecs.push(await embedOne(c));
    const template = toB64(mean(vecs));
    const now = M.util.iso(); const existing = await getEnrolment(userId);
    const data = { userID: userId, templateData: template, modelVersion: adapter.version, enrolledAt: now, status: "enrolled" };
    if (existing) await M.db.update("faceProfiles", existing.$id, data); else await M.db.create("faceProfiles", null, data, M.perm.self(userId));
    try { await M.db.update("studentProfiles", userId, { faceEnrolled: true }); } catch (_) {}
    await M.audit(userId, "face.enrol", "face_profiles", existing ? existing.$id : userId, null, { modelVersion: adapter.version });
    return { modelVersion: adapter.version };
  }

  async function removeEnrolment(userId) {
    const e = await getEnrolment(userId); if (!e) return;
    await M.db.remove("faceProfiles", e.$id);
    try { await M.db.update("studentProfiles", userId, { faceEnrolled: false }); } catch (_) {}
    await M.audit(userId, "face.remove", "face_profiles", e.$id);
  }

  // Student-side check. Returns { ok, score, metric, threshold, probe, modelVersion }. NEVER returns ok without a real comparison.
  async function verify(userId, canvas) {
    const enrol = await getEnrolment(userId);
    if (!enrol || enrol.status !== "enrolled" || !enrol.templateData) throw new Error("You have not enrolled your face yet. Enrol on your Profile page first.");
    const probeVec = await embedOne(canvas);
    if (enrol.modelVersion !== adapter.version) throw new Error("Your enrolment used a different model version. Re-enrol on your Profile page.");
    const probe = toB64(probeVec); const r = compare(enrol.templateData, probe);
    return Object.assign(r, { probe, modelVersion: adapter.version });
  }

  // Lets one lecturer read this student's face profile so the lecturer can re-compare the probe. Student-initiated, with consent.
  async function shareWithLecturer(userId, lecturerId) {
    const e = await getEnrolment(userId); if (!e) return;
    const want = M.Permission.read(M.Role.user(lecturerId));
    const perms = e.$permissions || [];
    if (perms.includes(want)) return;
    await M.db.update("faceProfiles", e.$id, {}, [...perms, want]);
  }

  M.face = { registerAdapter, init, liveness, livenessAvailable, status: async () => init(), compare, startCamera, stopCamera, capture, enrol, removeEnrolment, verify, getEnrolment, shareWithLecturer, get adapterVersion() { return adapter ? adapter.version : null; }, get loadError() { return loadError; } };
})();
