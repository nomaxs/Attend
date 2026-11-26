# Face recognition model

**Nothing to download for the normal setup.** `config.js` (`face.sources`) tells Attend to load the face runtime and model weights from a link (jsDelivr, package `@vladmandic/face-api`) the first time face verification is used. It tries, in order: a local copy in this project, the pinned CDN copy, the CDN's latest copy. The browser/WebView caches the files after the first load (about 6 MB total).

Requirements: the phone must be online on first use, and `_headers` must allow the CDN (it already does: `https://cdn.jsdelivr.net` in `script-src` and `connect-src`). If the browser console shows a Content-Security-Policy error mentioning `eval`, add `'unsafe-eval'` to `script-src` in `_headers` and redeploy.

## To host it yourself (offline, or if you do not want a CDN)
Download these 7 files and put them exactly here:

| File | Put it in | Direct link |
|---|---|---|
| `face-api.js` (save as **`face-api.min.js`**) | `AttendWebsite/assets/vendor/` | https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/dist/face-api.js |
| `tiny_face_detector_model.json` | `AttendWebsite/assets/models/` | https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/tiny_face_detector_model.json |
| `tiny_face_detector_model.bin` | `AttendWebsite/assets/models/` | https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/tiny_face_detector_model.bin |
| `face_landmark_68_tiny_model.json` | `AttendWebsite/assets/models/` | https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/face_landmark_68_tiny_model.json |
| `face_landmark_68_tiny_model.bin` | `AttendWebsite/assets/models/` | https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/face_landmark_68_tiny_model.bin |
| `face_recognition_model.json` | `AttendWebsite/assets/models/` | https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/face_recognition_model.json |
| `face_recognition_model.bin` | `AttendWebsite/assets/models/` | https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/face_recognition_model.bin |

Or run `node AttendBackend/fetch-face-model.mjs`, which downloads all seven for you. Then redeploy. The local copy is tried first.

The `face_recognition_model` files are the ResNet network that produces the 128-number face embedding. The other two (detector, landmarks) find the face and drive the blink / head-turn liveness check. Check the licences before production use. The links above were written from the package's documented layout and could not be test-downloaded from the build environment; if one 404s, browse https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/ and copy the file from `dist/` or `model/`.

## Tuning (config.js, `face`)
`threshold` (euclidean distance, lower is stricter), `blinkClosedEar` / `blinkOpenEar`, `turnDelta`. Tune with at least 20 genuine and 20 impostor attempts on your own phones.

## Limits
Liveness is a blink + head-turn challenge, not bank-grade. It stops a still photo, not a recorded video or a modified app. The lecturer's browser re-compares the submitted embedding with the enrolled one. Use it as one layer next to the Bluetooth proof and the lecturer's approval.
