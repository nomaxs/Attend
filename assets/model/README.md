# Face recognition model (NOT included)

Muster does **not** ship a face recognition model, and it will never report a face as "verified" without one. Plain face *detection* (finding a face) is not identity verification, so the module refuses to enrol or verify until a real embedding model is loaded.

## What to install (default adapter)
Library: **face-api.js** (community build `@vladmandic/face-api` also works). Download and place:

- `assets/vendor/face-api.min.js`  (the library script)
- in this `assets/models/` folder, the weight files (manifest + shard) for:
  - `tiny_face_detector_model`
  - `face_landmark_68_tiny_model`
  - `face_recognition_model`   <- the ResNet-128 embedding network that does the actual recognition

Check each model's licence before using it in production. If your CSP blocks TensorFlow.js, you may need to add `'wasm-unsafe-eval'` (or `'unsafe-eval'` for some builds) to `script-src` in `_headers`.

## Using a different model
Call `Muster.face.registerAdapter({ name, version, load(), embed(canvas) })` before the first use (for example from a small script loaded after `face-verification.js`). `embed` must return a `Float32Array` for exactly one face, `null` for no face, or `"multiple"`. Set `face.metric` and `face.threshold` in `config.js` to suit that model, and change `version` whenever you change the model (students must re-enrol).

## Known limits
- No liveness / anti-spoofing: a printed photo or a screen can fool most embedding models.
- Matching on the student's phone is evidence only. The lecturer's browser re-compares the submitted probe against the enrolled template.
- Tune `face.threshold` with your own genuine/impostor data. The defaults are starting points, not guarantees.
