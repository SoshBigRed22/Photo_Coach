// ---------------------------------------------------------------------------
// app.js — Entry point
//
// All shared state, DOM refs, and helper functions live in the module files
// loaded before this one (see index.html script tags):
//
//   state.js      — constants, DOM refs, mutable state, look-up tables
//   tracking.js   — MediaPipe, face tracking loops, shape classification
//   filters.js    — filter overlay drawing, face-box shapes, landmark coords
//   camera.js     — camera start/stop, device enumeration, hosted-mode UI
//   analysis.js   — score/tips/metrics rendering, piercing fit, analyzeBlob
//   pinterest.js  — inspiration entries, Pinterest OAuth, board/pin loading
//
// This file only wires up event listeners and calls the initialisation
// functions that bootstrap the page on first load.
// ---------------------------------------------------------------------------

// Initialise selectedPhotoContext now that buildPhotoContext is available.
selectedPhotoContext = buildPhotoContext("empty");

// ---------------------------------------------------------------------------
// Event listeners — Camera
// ---------------------------------------------------------------------------

startCameraBtn.addEventListener("click", async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert(
      "Your browser cannot access the camera on this page.\n\n" +
      "Make sure you are opening the app at http://127.0.0.1:5000 (not a file:// path).\n" +
      "You can still upload a photo using the Upload section."
    );
    return;
  }

  if (!window.isSecureContext) {
    alert("Camera access requires a secure context (HTTPS). Open the app over https://.");
    return;
  }

  try {
    stopActiveStream();
    showedHardwareHint = false;
    console.log("[PhotoCoach] Requesting camera...");

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === "videoinput");
    console.log("[PhotoCoach] Video devices found:", videoDevices.length, videoDevices.map(d => d.label || d.deviceId));

    if (videoDevices.length === 0) {
      console.warn("[PhotoCoach] No cameras reported by enumerateDevices. Attempting default camera start anyway.");
      setCameraStatus("No camera listed yet. Attempting to start default camera...");
    }

    if (!cameraSelect.options.length) {
      await populateCameraSelect();
    }

    const selectedDeviceId = cameraSelect.value;
    const selectedName = cameraSelect.options[cameraSelect.selectedIndex]?.text || "camera";
    setCameraStatus(
      selectedDeviceId
        ? `Starting ${selectedName}...`
        : "Requesting camera permission and starting default camera..."
    );

    const videoConstraints = {
      width:     { ideal: 1920 },
      height:    { ideal: 1080 },
      frameRate: { ideal: 30 },
    };

    activeStream = await navigator.mediaDevices.getUserMedia({
      video: selectedDeviceId ? { ...videoConstraints, deviceId: { exact: selectedDeviceId } } : videoConstraints,
      audio: false,
    });
    console.log("[PhotoCoach] Stream acquired:", activeStream.getVideoTracks().map(t => t.label));

    await populateCameraSelect();
    const activeTrack    = activeStream.getVideoTracks()[0];
    const activeDeviceId = activeTrack?.getSettings?.().deviceId;
    if (activeDeviceId) cameraSelect.value = activeDeviceId;

    cameraFeed.srcObject = activeStream;

    try {
      await cameraFeed.play();
      console.log("[PhotoCoach] Video playback started.");
      startFaceTracking();
      diagnoseCameraFrames();
      const liveName = activeTrack?.label || cameraSelect.options[cameraSelect.selectedIndex]?.text || "camera";
      setCameraStatus(`Live: ${liveName}`);
    } catch (playErr) {
      stopFaceTracking();
      console.warn("[PhotoCoach] play() failed:", playErr);
      setCameraStatus("Stream opened, but playback did not start. Try Start / Restart Camera again.");
    }

    startCameraBtn.textContent = "Start / Restart Camera";
    captureBtn.disabled = false;
  } catch (error) {
    console.error("[PhotoCoach] Camera error:", error.name, error.message);

    let message = `Camera error: ${error.name}\n\n`;

    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      message +=
        "The browser was denied permission.\n\n" +
        "Fix steps:\n" +
        "1. In your browser address bar, click the camera/lock icon and choose Allow.\n" +
        "2. Reload the page, then try again.\n" +
        "3. If it still fails, check Windows Settings \u2192 Privacy & Security \u2192 Camera and make sure your browser is listed and toggled On.";
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      message += "No usable camera was found. Try the Upload section instead.";
    } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      message +=
        "The camera is already being used by another app (e.g. Teams, Zoom, Snap Camera).\n" +
        "Close those apps, then reload this page and try again.";
    } else if (error.name === "OverconstrainedError") {
      message += "Camera rejected the requested settings. This should not happen \u2014 please reload and retry.";
    } else {
      message += error.message + "\n\nOpen browser DevTools (F12 \u2192 Console) and look for [PhotoCoach] lines for more detail.";
    }

    setCameraStatus(`Failed to start camera: ${error.name}`);
    alert(message);
  }
});

systemCaptureBtn.addEventListener("click", async () => {
  systemCaptureBtn.disabled = true;
  systemCaptureBtn.textContent = "Capturing...";
  const selectedIndex = getSelectedSystemIndex();
  setCameraStatus(`Using backend DirectShow capture fallback (index ${selectedIndex})...`);

  try {
    const response = await fetch(`${API_BASE}/api/capture-system`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ camera_index: selectedIndex }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Fallback capture failed.");

    if (payload.captured_image_base64) {
      previewImage.src          = `data:image/jpeg;base64,${payload.captured_image_base64}`;
      previewImage.style.display = "block";
    }

    applyAnalysisPayload(payload);
    analyzeBtn.disabled = false;
    const probe = payload.frame_probe || {};
    setCameraStatus(`Fallback capture succeeded at index ${payload.camera_index}. Probe mean=${probe.mean}, var=${probe.variance}`);
  } catch (error) {
    console.error("[PhotoCoach] Fallback capture error:", error);
    setCameraStatus("Fallback capture failed.");
    alert(
      "Fallback capture failed.\n\n" +
      "Please close apps using the webcam (Teams/Zoom/OBS/virtual cams), then try again.\n" +
      "Error: " + error.message
    );
  } finally {
    systemCaptureBtn.disabled    = false;
    systemCaptureBtn.textContent = "Capture via System Camera (Fallback)";
  }
});

testSystemIndexBtn.addEventListener("click", async () => {
  const selectedIndex = getSelectedSystemIndex();
  testSystemIndexBtn.disabled    = true;
  testSystemIndexBtn.textContent = "Testing...";
  setCameraStatus(`Testing system camera index ${selectedIndex}...`);

  try {
    const response = await fetch(`${API_BASE}/api/system-preview`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ camera_index: selectedIndex }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "System preview failed.");

    if (payload.preview_image_base64) {
      previewImage.src          = `data:image/jpeg;base64,${payload.preview_image_base64}`;
      previewImage.style.display = "block";
    }

    const probe = payload.frame_probe || {};
    setCameraStatus(`Index ${payload.camera_index} preview OK. Probe mean=${probe.mean}, var=${probe.variance}`);
  } catch (error) {
    setCameraStatus(`Index ${selectedIndex} failed.`);
    alert("System index test failed.\n\n" + error.message);
  } finally {
    testSystemIndexBtn.disabled    = false;
    testSystemIndexBtn.textContent = "Test Index";
  }
});

autoProbeBtn.addEventListener("click", async () => {
  autoProbeBtn.disabled    = true;
  autoProbeBtn.textContent = "Scanning...";
  setCameraStatus("Scanning camera indices/backends for a non-black feed...");

  try {
    const response = await fetch(`${API_BASE}/api/system-autoprobe`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ max_index: 10 }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Auto probe failed.");

    if (!payload.best) {
      setCameraStatus("No usable camera feed found. Feeds appear blocked/black.");
      alert(
        "Auto probe found no usable feed.\n\n" +
        "This strongly suggests a hardware/privacy camera block. Try toggling your HP camera privacy key and close all apps using camera."
      );
      return;
    }

    const best = payload.best;
    if (best.backend === "DSHOW") systemCameraIndex.value = String(best.camera_index);
    setCameraStatus(`Best feed: ${best.backend} index ${best.camera_index} (var=${best.probe.variance}). Ready to auto capture.`);
  } catch (error) {
    setCameraStatus("Auto probe failed.");
    alert("Auto probe error:\n\n" + error.message);
  } finally {
    autoProbeBtn.disabled    = false;
    autoProbeBtn.textContent = "Auto Find Working Camera";
  }
});

autoCaptureBtn.addEventListener("click", async () => {
  autoCaptureBtn.disabled    = true;
  autoCaptureBtn.textContent = "Auto Capturing...";
  setCameraStatus("Auto-selecting and capturing from best available feed...");

  try {
    const response = await fetch(`${API_BASE}/api/capture-system-auto`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ max_index: 10 }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Auto capture failed.");

    if (payload.captured_image_base64) {
      previewImage.src          = `data:image/jpeg;base64,${payload.captured_image_base64}`;
      previewImage.style.display = "block";
    }

    applyAnalysisPayload(payload);
    analyzeBtn.disabled = false;

    const sel   = payload.auto_selected || {};
    const probe = sel.probe || {};
    setCameraStatus(`Auto capture succeeded with ${sel.backend} index ${sel.camera_index} (mean=${probe.mean}, var=${probe.variance}).`);
  } catch (error) {
    setCameraStatus("Auto capture failed. No usable feed found.");
    alert("Auto capture failed:\n\n" + error.message);
  } finally {
    autoCaptureBtn.disabled    = false;
    autoCaptureBtn.textContent = "Auto Capture Best Camera";
  }
});

refreshCamerasBtn.addEventListener("click", async () => {
  try {
    await populateCameraSelect();
  } catch (error) {
    console.error("[PhotoCoach] enumerateDevices error:", error);
    setCameraStatus("Could not list cameras. Check browser permissions and reload.");
  }
});

cameraSelect.addEventListener("change", () => {
  if (cameraSelect.selectedIndex >= 0) {
    setCameraStatus(`Selected: ${cameraSelect.options[cameraSelect.selectedIndex].text}`);
  }
});

// ---------------------------------------------------------------------------
// Event listeners — Filter controls
// ---------------------------------------------------------------------------

if (filterSelect) {
  filterSelect.addEventListener("change", () => {
    applyFilterControlState();
    selectedPhotoContext = buildPhotoContext(selectedPhotoContext?.source || "empty");
  });
}

if (filterSize) {
  filterSize.addEventListener("input", () => {
    applyFilterControlState();
    selectedPhotoContext = buildPhotoContext(selectedPhotoContext?.source || "empty");
  });
}

// ---------------------------------------------------------------------------
// Event listeners — Inspiration / Pinterest
// ---------------------------------------------------------------------------

if (addInspirationBtn && inspirationUrlInput) {
  addInspirationBtn.addEventListener("click", () => {
    try {
      addInspirationEntry(inspirationUrlInput.value, inspirationNoteInput?.value || "");
      inspirationUrlInput.value = "";
      if (inspirationNoteInput) inspirationNoteInput.value = "";
    } catch (error) {
      alert(error.message || "Could not add inspiration link.");
    }
  });

  inspirationUrlInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addInspirationBtn.click();
  });
}

if (addOverlayImageBtn && overlayImageInput) {
  addOverlayImageBtn.addEventListener("click", async () => {
    const file = overlayImageInput.files?.[0];
    if (!file) {
      alert("Choose a piercing image first.");
      return;
    }

    try {
      await addInspirationImageEntry(file, inspirationNoteInput?.value || "");
      overlayImageInput.value = "";
      if (inspirationNoteInput) inspirationNoteInput.value = "";
    } catch (error) {
      alert(error.message || "Could not add image overlay.");
    }
  });
}

if (clearInspirationBtn) {
  clearInspirationBtn.addEventListener("click", () => clearInspirationEntries());
}

if (connectPinterestBtn) {
  connectPinterestBtn.addEventListener("click", () => startPinterestConnectFlow());
}

if (disconnectPinterestBtn) {
  disconnectPinterestBtn.addEventListener("click", async () => disconnectPinterest());
}

if (refreshPinterestBoardsBtn) {
  refreshPinterestBoardsBtn.addEventListener("click", async () => loadPinterestBoards());
}

if (pinterestBoardSelect) {
  pinterestBoardSelect.addEventListener("change", () => {
    updatePinterestConnectionUi({ connected: Boolean(pinterestAuthHandle), profile: {} });
  });
}

if (loadPinterestPinsBtn) {
  loadPinterestPinsBtn.addEventListener("click", async () => loadPinterestPins());
}

// OAuth callback message from Pinterest popup
window.addEventListener("message", async (event) => {
  if (event.origin !== API_BASE) return;
  const payload = event.data;
  if (!payload || payload.type !== "pinterest-auth-complete") return;

  if (!payload.success) {
    alert(payload.error || "Pinterest connection failed.");
    return;
  }

  pinterestAuthHandle = payload.authHandle;
  savePinterestAuthHandle();
  updatePinterestConnectionUi({ connected: true, profile: payload.profile || {} });
  await loadPinterestBoards();
});

// ---------------------------------------------------------------------------
// Event listeners — Capture & upload
// ---------------------------------------------------------------------------

captureBtn.addEventListener("click", async () => {
  if (!cameraFeed.videoWidth || !cameraFeed.videoHeight) return;

  const displayWidth  = Math.round(cameraFeed.clientWidth  || faceOverlay?.clientWidth  || cameraFeed.videoWidth);
  const displayHeight = Math.round(cameraFeed.clientHeight || faceOverlay?.clientHeight || cameraFeed.videoHeight);

  captureCanvas.width  = displayWidth;
  captureCanvas.height = displayHeight;
  const ctx = captureCanvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, captureCanvas.width, captureCanvas.height);

  // Mirror + cover-fit so the saved image matches the live preview exactly.
  ctx.save();
  ctx.scale(-1, 1);
  ctx.translate(-captureCanvas.width, 0);
  drawVideoCoverFrame(ctx, cameraFeed, cameraFeed.videoWidth, cameraFeed.videoHeight, captureCanvas.width, captureCanvas.height);
  ctx.restore();

  if (faceOverlay && faceOverlay.width > 0 && faceOverlay.height > 0) {
    const box = renderedTrackedBox || targetTrackedBox;
    if (box) {
      const scaleX = captureCanvas.width / faceOverlay.width;
      const scaleY = captureCanvas.height / faceOverlay.height;
      drawAccessoryOnlyOverlay(ctx, {
        x: box.x * scaleX,
        y: box.y * scaleY,
        width: box.width * scaleX,
        height: box.height * scaleY,
      });
    }
  }

  const blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) return;

  selectedPhotoContext        = buildPhotoContext("camera-capture");
  selectedBlob                = blob;
  previewImage.src            = URL.createObjectURL(blob);
  previewImage.style.display  = "block";
  analyzeBtn.disabled         = false;
});

uploadInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  selectedPhotoContext        = buildPhotoContext("upload");
  selectedBlob                = file;
  previewImage.src            = URL.createObjectURL(file);
  previewImage.style.display  = "block";
  analyzeBtn.disabled         = false;
  renderPiercingFitAssessment(assessPiercingFit(selectedPhotoContext));
});

analyzeBtn.addEventListener("click", async () => {
  if (!selectedBlob) {
    alert("Capture or upload a photo first.");
    return;
  }
  await analyzeBlob(selectedBlob, selectedPhotoContext);
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

configureHostedModeUI();
applyFilterControlState();
loadInspirationEntries();
renderInspirationEntries();
populateCameraSelect().catch((error) => {
  console.error("[PhotoCoach] initial camera scan error:", error);
  setCameraStatus("Could not scan camera devices yet. Click Refresh.");
});

window.addEventListener("beforeunload", () => stopActiveStream());
