/* =========================
FILE OVERVIEW
========================= */
// Central configuration for Attend. This is the ONLY file you edit to connect the website to your Appwrite project.
// No secrets belong here: never put an Appwrite API key in any website file.

window.ATTEND_CONFIG = {
  appName: "Attend",
  tagline: "Attendance and performance tracking for tertiary institutions",

  /* ---- Appwrite connection ---- */
  endpoint: "https://nyc.cloud.appwrite.io/v1",
  projectId: "REPLACE_WITH_YOUR_PROJECT_ID",
  databaseId: "REPLACE_WITH_YOUR_DATABASE_ID",

  // Collection IDs. These default to the IDs created by AttendBackend/setup-appwrite.mjs.
  // If you create collections by hand with other IDs, change the values (not the keys).
  collections: {
    userProfiles: "user_profiles",
    studentProfiles: "student_profiles",
    lecturerProfiles: "lecturer_profiles",
    faceProfiles: "face_profiles",
    groups: "groups",
    groupMembers: "group_members",
    sessions: "attendance_sessions",
    sessionSecrets: "session_secrets",
    records: "attendance_records",
    proximity: "proximity_records",
    columns: "gradebook_columns",
    scores: "gradebook_scores",
    notifications: "notifications",
    audit: "audit_logs"
  },

  // Storage bucket IDs (all private). Only needed for the optional features noted beside each one.
  buckets: {
    faceReference: "REPLACE_WITH_FACE_REFERENCE_BUCKET_ID",   // optional: retained enrolment photos (off by default)
    faceTemplates: "REPLACE_WITH_FACE_TEMPLATES_BUCKET_ID",   // optional: template files (templates are stored in the face_profiles document by default)
    exports: "REPLACE_WITH_EXPORTS_BUCKET_ID"                 // optional: "Save to private storage" in Reports
  },

  /* ---- Lecturer authority (see AttendBackend/README.md, section "Why a Lecturers team") ----
     Without Appwrite Functions, the only server-enforced way to stop a student from creating "official" records
     is to restrict collection CREATE permission to an Appwrite Team that you control.
     1) Create a Team called "Lecturers" in the Appwrite console and copy its ID here.
     2) Add each verified lecturer to that team.
     3) Re-run setup-appwrite.mjs (or edit collection permissions) so lecturer collections use team:<id>.
     Leave empty for a pilot where every registered lecturer is trusted (NOT safe for production). */
  lecturerTeamId: "",

  /* ---- Attendance rules ---- */
  attendance: {
    minMinutes: 8,
    maxMinutes: 15,
    defaultMinutes: 10,
    defaultLateAfterMinutes: 5,
    defaultMaxReferenceDepth: 2,   // 1 = heard the lecturer's beacon directly; 2 = heard a student who did; ...
    maxReferenceDepthLimit: 3,
    minRssi: -95,                  // weak-signal noise floor only. RSSI is NOT a distance measurement.
    claimGraceSeconds: 20,         // server time ($createdAt) tolerance after the session end
    reviewAfterEndMinutes: 60      // how long a closed session can still be reviewed in the UI
  },

  /* ---- Facial verification ---- */
  face: {
    // Attend does not ship a face recognition model. See AttendWebsite/assets/models/README.md.
    // Until a model adapter is installed, face enrolment/verification is switched off and the UI says so.
    // Where to load the face runtime and model weights from. Tried in order; the first that works is used and the browser caches it.
    // 1) a local copy (only if you ran AttendBackend/fetch-face-model.mjs), 2) a pinned CDN copy, 3) the CDN's latest copy.
    sources: [
      { script: "assets/vendor/face-api.min.js", models: "assets/models" },
      { script: "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.js", models: "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model" },
      { script: "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js", models: "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model" }
    ],
    metric: "euclidean",                              // "euclidean" (pass when distance <= threshold) or "cosine" (pass when similarity >= threshold)
    threshold: 0.55,                                  // face-api.js suggests 0.6 as an upper bound; 0.55 is stricter. Tune on YOUR test data.
    modelVersion: "face-api-resnet128-v1",
    enrolFrames: 3,                                   // frames captured and averaged at enrolment
    livenessRequired: true,                           // blink + head-turn challenge before any enrolment or verification capture
    blinkClosedEar: 0.21,                             // eye-aspect-ratio below this = eye closed (tune on real phones)
    blinkOpenEar: 0.26,                               // above this = eye open again
    turnDelta: 0.12,                                  // how far the nose must move from centre (0-1 of face width) to count as a head turn
    livenessStepMs: 8000                              // time allowed per challenge step
  }
};
