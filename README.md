# Attend website

HTML5, CSS3 and vanilla JavaScript. No framework, no build step. Appwrite Web SDK 13 from a CDN (same as X-Redro). Responsive and mobile-first; designed to also run inside the Attend Android WebView.

## Run it
1. Edit `assets/js/config.js` (projectId, databaseId, lecturerTeamId). See `../AttendBackend/README.md`.
2. Serve the folder over HTTPS (Cloudflare Pages static hosting works: no build command, no `functions/` folder). For local testing: `npx serve .` or any static server, with `localhost` added as an Appwrite Web platform.

## Structure
```
index.html  login.html  register.html
student/    dashboard, courses, attendance, performance, profile
lecturer/   dashboard, courses, students, attendance, gradebook, reports, profile
assets/css/ style (design system), auth, dashboard, attendance, gradebook
assets/js/
  config.js            only file you edit
  appwrite.js          the single Appwrite client + reusable db / permission / audit helpers
  auth.js              register, login, logout, session persistence, role guards, login/register pages
  app.js               toasts, modals, confirmations, loaders, form dialogs, page shell, grading + attendance maths, boot
  android-bridge.js    window.Android wrapper + native callbacks (onBluetoothDevicesFound, onBluetoothError, onBluetoothStatusChanged)
  face-verification.js pluggable face model adapter, enrolment, verification (needs an external model)
  courses.js  attendance.js  gradebook.js  reports.js  student.js  lecturer.js   page logic
assets/models/ assets/vendor/   where you place the face model (not included)
_headers               CSP and security headers for Cloudflare Pages / Netlify
```
Every page loads the same script set in the same order, and each page file registers itself under `Attend.pages["role/page"]`.

## What needs something outside this folder
- **Bluetooth attendance:** the Attend Android app. In a normal browser the site says so and does not pretend.
- **Face verification:** run `node ../AttendBackend/fetch-face-model.mjs` once (`assets/models/README.md`). Until then it is switched off, never faked.
- **Lecturer authority in production:** the Lecturers team (`../AttendBackend/README.md`, section E).

## Conventions
IDs: group = `groups.$id`, session = `attendance_sessions.$id` (also carried in BLE session data), student = Appwrite user ID everywhere. Times are ISO strings. Statuses are lowercase (`present`, `late`, `absent`).
