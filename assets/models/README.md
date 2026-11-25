# Face recognition model (downloaded by you, runs on the phone)

Attend verifies faces **on the device** with a real embedding model: the camera image becomes a 128-number face embedding and two embeddings are compared against a threshold. No server, no Appwrite Function, no third-party API. This is the same family of technique (embedding match plus a liveness challenge) as the face checks used in fintech apps, with one honest difference: commercial SDKs (the vendor kits banks and fintechs integrate) also run proprietary passive liveness and server-side matching and need the vendor's keys and backend, which your no-Functions rule rules out. Attend's liveness is a blink + head-turn challenge only.

## Install (one command)
From the `AttendBackend` folder, on any machine with internet (Termux works):

    node fetch-face-model.mjs

It downloads into this project:
- `assets/vendor/face-api.min.js`  (runtime, @vladmandic/face-api)
- `assets/models/tiny_face_detector_model.(json|bin)`
- `assets/models/face_landmark_68_tiny_model.(json|bin)`  (drives the liveness challenge)
- `assets/models/face_recognition_model.(json|bin)`  (the ResNet embedding that identifies people)

Then redeploy the site. Until the files exist, Profile shows "model not installed", enrolment is disabled, and a face-required session cannot be passed. **Nothing is ever marked verified without a real comparison.**

The model files are not bundled in the zip because this build environment had no internet access to fetch them. Check each model's licence before production use.

## Tuning (config.js, `face`)
`threshold` (euclidean distance, lower is stricter), `blinkClosedEar` / `blinkOpenEar`, `turnDelta`. Tune on your own phones and users with at least 20 genuine and 20 impostor attempts. The defaults are starting points, not guarantees.

## What this does and does not protect against
- Does: wrong person, a still photo held to the camera (liveness challenge), a different model version.
- Does not: a pre-recorded video, a 3D mask, or a modified client. The check runs on the student's phone; the lecturer's browser re-compares the submitted face embedding with the enrolled one, but cannot see the camera.
- Use it as one layer next to the Bluetooth proof and the lecturer's approval, not as the only gate.

## Using a different model
`Attend.face.registerAdapter({ name, version, load(), embed(canvas), landmarks(video) })` before first use. `embed` returns a `Float32Array` for exactly one face, `null` for none, or `"multiple"`. Change `version` whenever you change the model (students must re-enrol).
