/* =========================
FILE OVERVIEW
========================= */
// Bridge between the website and the Muster Android app (WebView JavaScript interface named "Android").
// Native -> web callbacks are the global functions at the bottom: onBluetoothDevicesFound, onBluetoothError,
// onBluetoothStatusChanged (+ onDeviceCapabilities, onPermissionResult, onCameraPermissionStatus).
// In an ordinary browser none of the native calls exist: isAvailable() is false and notice() explains why.

(function () {
  const M = window.Muster;
  const listeners = {};
  const state = { capabilities: null, status: null, devices: new Map(), lastError: null, camera: null };

  const native = () => (typeof window.Android !== "undefined" && window.Android && typeof window.Android.checkDeviceCapabilities === "function" ? window.Android : null);
  const isAvailable = () => !!native();
  const parse = (v) => { if (typeof v === "string") { try { return JSON.parse(v); } catch (_) { return { raw: v }; } } return v; };
  function emit(evt, data) { (listeners[evt] || []).slice().forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return () => { listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn); }; }

  // Wait for the next native callback of a given event (native methods return void; results arrive as callbacks).
  function once(evt, ms) {
    return new Promise((resolve, reject) => {
      const off = on(evt, (d) => { clearTimeout(t); off(); resolve(d); });
      const t = setTimeout(() => { off(); reject(new Error("The Android app did not respond.")); }, ms || 5000);
    });
  }
  function call(method, arg, waitFor) {
    const a = native();
    if (!a) return Promise.reject(new Error(notice(true)));
    if (typeof a[method] !== "function") return Promise.reject(new Error("This version of the Android app does not support " + method + ". Please update the app."));
    const p = waitFor ? once(waitFor) : Promise.resolve();
    try { if (arg === undefined) a[method](); else a[method](typeof arg === "string" ? arg : JSON.stringify(arg)); } catch (e) { return Promise.reject(e); }
    return p;
  }

  const notice = (textOnly) => {
    const t = "BLE attendance verification requires the " + M.cfg.appName + " Android app. Install the app and open this site inside it. A normal browser cannot scan or advertise over Bluetooth.";
    return textOnly ? t : `<div class="notice info"><b>Android app required.</b> ${M.util.esc(t)}</div>`;
  };

  const api = {
    isAvailable, on, notice, state,
    checkDeviceCapabilities: () => call("checkDeviceCapabilities", undefined, "capabilities").then((c) => (state.capabilities = c)),
    checkBluetoothStatus: () => call("checkBluetoothStatus", undefined, "status").then((s) => (state.status = s)),
    requestPermissions: () => call("requestBluetoothPermissions", undefined, "permission"),
    // session = { sessionId, sessionTag (8 hex), ephemeralId (12 hex), role: "lecturer"|"student", endsAt (epoch ms) }
    setScanSession: (session) => call("setScanSession", session),
    startScan: async (session) => { if (session) await api.setScanSession(session); state.devices.clear(); return call("startBluetoothScan"); },
    stopScan: () => call("stopBluetoothScan"),
    startAdvertising: (session) => call("startBluetoothAdvertising", session),
    stopAdvertising: () => call("stopBluetoothAdvertising"),
    checkCameraPermission: () => (native() && typeof native().checkCameraPermission === "function" ? call("checkCameraPermission", undefined, "camera").then((c) => (state.camera = c)) : Promise.resolve({ supported: false })),
    // Convenience: is this phone ready to take part in BLE attendance? Resolves { ok, problems[] }.
    async readiness(needAdvertise) {
      if (!isAvailable()) return { ok: false, problems: [notice(true)] };
      const problems = [];
      try {
        const c = await api.checkDeviceCapabilities();
        if (!c.bleSupported) problems.push("This phone does not support Bluetooth Low Energy.");
        if (!c.scanSupported) problems.push("This phone cannot scan for BLE advertisements.");
        if (needAdvertise && !c.advertiseSupported) problems.push("This phone cannot advertise over BLE (needed to take part in attendance).");
        if (!c.bluetoothEnabled) problems.push("Bluetooth is turned off. Turn it on and try again.");
        if (!c.permissionsGranted) problems.push("Bluetooth permissions have not been granted yet.");
        if (c.locationRequired && !c.locationEnabled) problems.push("Turn on Location in your phone settings. Android 11 and older need it for Bluetooth scanning. Muster does not use your location.");
      } catch (e) { problems.push(M.util.errMsg(e)); }
      return { ok: problems.length === 0, problems };
    }
  };

  /* ---------- native -> web callbacks ---------- */
  window.onBluetoothDevicesFound = function (devices) {
    const list = parse(devices); const arr = Array.isArray(list) ? list : (list && list.devices) || [];
    arr.forEach((d) => { if (d && /^[0-9a-f]{12}$/.test(d.ephemeralId || "")) state.devices.set(d.ephemeralId, d); });
    emit("devices", arr);
  };
  window.onBluetoothError = function (error) { const e = parse(error) || {}; state.lastError = e; emit("error", e); };
  window.onBluetoothStatusChanged = function (status) { const s = parse(status) || {}; state.status = s; emit("status", s); emit("statusEvent", s); };
  window.onDeviceCapabilities = function (c) { emit("capabilities", parse(c)); };
  window.onPermissionResult = function (r) { emit("permission", parse(r)); };
  window.onCameraPermissionStatus = function (r) { emit("camera", parse(r)); };

  M.android = api;
})();
