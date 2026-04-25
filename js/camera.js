// ---------------------------------------------------------------------------
// camera.js — Camera start/stop, device enumeration, fallback capture,
//             and hosted-mode UI gating.
//
// Depends on: state.js, tracking.js (stopFaceTracking, startFaceTracking)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Status helper
// ---------------------------------------------------------------------------
function setCameraStatus(message) {
  cameraStatus.textContent = message;
}

// ---------------------------------------------------------------------------
// Stream management
// ---------------------------------------------------------------------------
function stopActiveStream() {
  stopFaceTracking();
  if (!activeStream) return;
  for (const track of activeStream.getTracks()) {
    track.stop();
  }
  activeStream           = null;
  cameraFeed.srcObject   = null;
}

// ---------------------------------------------------------------------------
// Device label helpers
// ---------------------------------------------------------------------------
function isVirtualCameraLabel(label) {
  const text = label.toLowerCase();
  return (
    text.includes("virtual") ||
    text.includes("obs")      ||
    text.includes("meta quest") ||
    text.includes("snap camera")
  );
}

function buildDeviceLabel(device, index) {
  if (device.label) return device.label;
  return `Camera ${index + 1}`;
}

// ---------------------------------------------------------------------------
// Populate the camera <select>
// ---------------------------------------------------------------------------
async function populateCameraSelect() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    setCameraStatus("This browser cannot enumerate camera devices.");
    return;
  }

  const devices      = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((d) => d.kind === "videoinput");

  cameraSelect.innerHTML = "";

  if (videoDevices.length === 0) {
    const option       = document.createElement("option");
    option.value       = "";
    option.textContent = "No camera detected yet";
    cameraSelect.appendChild(option);
    cameraSelect.disabled = false;
    setCameraStatus("No camera listed yet. Click Start Camera to request permission, then Refresh.");
    return;
  }

  cameraSelect.disabled = false;

  const physicalFirst = [...videoDevices].sort((a, b) => {
    const aVirtual = isVirtualCameraLabel(a.label || "") ? 1 : 0;
    const bVirtual = isVirtualCameraLabel(b.label || "") ? 1 : 0;
    return aVirtual - bVirtual;
  });

  for (let i = 0; i < physicalFirst.length; i += 1) {
    const device       = physicalFirst[i];
    const option       = document.createElement("option");
    option.value       = device.deviceId;
    option.textContent = buildDeviceLabel(device, i);
    cameraSelect.appendChild(option);
  }

  const preferred = physicalFirst.find((d) => !isVirtualCameraLabel(d.label || ""));
  if (preferred) cameraSelect.value = preferred.deviceId;

  setCameraStatus(
    `Detected ${videoDevices.length} camera device(s). Selected: ${cameraSelect.options[cameraSelect.selectedIndex].text}`
  );
}

// ---------------------------------------------------------------------------
// Black-frame / blocked-camera detection
// ---------------------------------------------------------------------------
function showBlockedCameraHint(reason) {
  if (showedHardwareHint) return;
  showedHardwareHint = true;

  alert(
    "Camera stream started, but video looks blocked (" + reason + ").\n\n" +
    "This is usually a hardware/privacy block on HP laptops. Try:\n" +
    "1. Open the physical camera shutter if your model has one.\n" +
    "2. Press the keyboard camera privacy key (camera icon key, often F8/F10) to re-enable camera video.\n" +
    "3. Close Teams/Zoom/OBS virtual camera apps.\n" +
    "4. Test in the Windows Camera app. If it is black there too, it is a device/privacy issue, not this website."
  );
}

function diagnoseCameraFrames() {
  const track = activeStream?.getVideoTracks?.()[0];
  if (!track) return;

  console.log("[PhotoCoach] Track state:", {
    readyState: track.readyState,
    muted:      track.muted,
    label:      track.label,
  });

  if (track.muted) {
    showBlockedCameraHint("track muted");
    return;
  }

  setTimeout(() => {
    if (!cameraFeed.videoWidth || !cameraFeed.videoHeight) {
      showBlockedCameraHint("no video frames");
      return;
    }

    const probeCanvas  = document.createElement("canvas");
    probeCanvas.width  = Math.min(160, cameraFeed.videoWidth);
    probeCanvas.height = Math.min(120, cameraFeed.videoHeight);
    const probeCtx     = probeCanvas.getContext("2d");
    if (!probeCtx) return;

    probeCtx.drawImage(cameraFeed, 0, 0, probeCanvas.width, probeCanvas.height);
    const data = probeCtx.getImageData(0, 0, probeCanvas.width, probeCanvas.height).data;

    let sum = 0, sumSq = 0, count = 0;
    for (let i = 0; i < data.length; i += 16) {
      const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum   += gray;
      sumSq += gray * gray;
      count += 1;
    }

    const mean     = sum   / Math.max(1, count);
    const variance = (sumSq / Math.max(1, count)) - (mean * mean);
    console.log("[PhotoCoach] Frame probe:", { mean, variance });

    if (mean < 8 && variance < 25) {
      showBlockedCameraHint("black frames");
    }
  }, 1200);
}

// ---------------------------------------------------------------------------
// Hosted-mode UI gating (GitHub Pages cannot use system-capture routes)
// ---------------------------------------------------------------------------
function configureHostedModeUI() {
  if (!IS_LOCALHOST) {
    systemCaptureBtn.disabled   = true;
    testSystemIndexBtn.disabled = true;
    autoProbeBtn.disabled       = true;
    autoCaptureBtn.disabled     = true;
    systemCaptureBtn.title      = "Unavailable on hosted frontend. Use browser camera instead.";
    testSystemIndexBtn.title    = "Unavailable on hosted frontend. Use browser camera instead.";
    autoProbeBtn.title          = "Unavailable on hosted frontend. Use browser camera instead.";
    autoCaptureBtn.title        = "Unavailable on hosted frontend. Use browser camera instead.";
  }
}

// ---------------------------------------------------------------------------
// System-capture index helper
// ---------------------------------------------------------------------------
function getSelectedSystemIndex() {
  const idx = Number.parseInt(systemCameraIndex.value, 10);
  if (Number.isNaN(idx) || idx < 0) return 0;
  return idx;
}
