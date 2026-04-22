// ---------------------------------------------------------------------------
// API base URL configuration
// ---------------------------------------------------------------------------
// When running locally via Flask (http://127.0.0.1:5000), the frontend and
// backend are on the same server, so relative paths work fine (API_BASE = "").
//
// When hosted on GitHub Pages the frontend is served from GitHub but the
// Python backend lives on Render.  Replace the placeholder below with your
// actual Render service URL after deploying, e.g.:
//   "https://photo-coach-api.onrender.com"
//
// Leave PRODUCTION_API_URL as an empty string until you have a Render URL.
// ---------------------------------------------------------------------------
const https://photo-coach-j95a.onrender.com = "";  // TODO: replace with your Render URL after deploying

const API_BASE =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? ""               // local dev  — use relative paths (Flask serves everything)
    : PRODUCTION_API_URL; // GitHub Pages — point to Render backend

const startCameraBtn = document.getElementById("startCameraBtn");
const refreshCamerasBtn = document.getElementById("refreshCamerasBtn");
const cameraSelect = document.getElementById("cameraSelect");
const cameraStatus = document.getElementById("cameraStatus");
const systemCaptureBtn = document.getElementById("systemCaptureBtn");
const systemCameraIndex = document.getElementById("systemCameraIndex");
const testSystemIndexBtn = document.getElementById("testSystemIndexBtn");
const autoProbeBtn = document.getElementById("autoProbeBtn");
const autoCaptureBtn = document.getElementById("autoCaptureBtn");
const captureBtn = document.getElementById("captureBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const uploadInput = document.getElementById("uploadInput");
const cameraFeed = document.getElementById("cameraFeed");
const captureCanvas = document.getElementById("captureCanvas");
const previewImage = document.getElementById("previewImage");
const scorePill = document.getElementById("scorePill");
const tipsList = document.getElementById("tipsList");
const metricsGrid = document.getElementById("metricsGrid");

let activeStream = null;
let selectedBlob = null;
let showedHardwareHint = false;

function setCameraStatus(message) {
  cameraStatus.textContent = message;
}

function stopActiveStream() {
  if (!activeStream) return;
  for (const track of activeStream.getTracks()) {
    track.stop();
  }
  activeStream = null;
  cameraFeed.srcObject = null;
}

function isVirtualCameraLabel(label) {
  const text = label.toLowerCase();
  return text.includes("virtual") || text.includes("obs") || text.includes("meta quest") || text.includes("snap camera");
}

function buildDeviceLabel(device, index) {
  if (device.label) return device.label;
  return `Camera ${index + 1}`;
}

async function populateCameraSelect() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    setCameraStatus("This browser cannot enumerate camera devices.");
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((d) => d.kind === "videoinput");

  cameraSelect.innerHTML = "";

  if (videoDevices.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No camera devices found";
    cameraSelect.appendChild(option);
    cameraSelect.disabled = true;
    setCameraStatus("No camera devices detected.");
    return;
  }

  cameraSelect.disabled = false;

  const physicalFirst = [...videoDevices].sort((a, b) => {
    const aVirtual = isVirtualCameraLabel(a.label || "") ? 1 : 0;
    const bVirtual = isVirtualCameraLabel(b.label || "") ? 1 : 0;
    return aVirtual - bVirtual;
  });

  for (let i = 0; i < physicalFirst.length; i += 1) {
    const device = physicalFirst[i];
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = buildDeviceLabel(device, i);
    cameraSelect.appendChild(option);
  }

  const preferred = physicalFirst.find((d) => !isVirtualCameraLabel(d.label || ""));
  if (preferred) {
    cameraSelect.value = preferred.deviceId;
  }

  setCameraStatus(`Detected ${videoDevices.length} camera device(s). Selected: ${cameraSelect.options[cameraSelect.selectedIndex].text}`);
}

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
    muted: track.muted,
    label: track.label
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

    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = Math.min(160, cameraFeed.videoWidth);
    probeCanvas.height = Math.min(120, cameraFeed.videoHeight);
    const probeCtx = probeCanvas.getContext("2d");
    if (!probeCtx) return;

    probeCtx.drawImage(cameraFeed, 0, 0, probeCanvas.width, probeCanvas.height);
    const data = probeCtx.getImageData(0, 0, probeCanvas.width, probeCanvas.height).data;

    let sum = 0;
    let sumSq = 0;
    let count = 0;

    for (let i = 0; i < data.length; i += 16) {
      const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += gray;
      sumSq += gray * gray;
      count += 1;
    }

    const mean = sum / Math.max(1, count);
    const variance = (sumSq / Math.max(1, count)) - (mean * mean);
    console.log("[PhotoCoach] Frame probe:", { mean, variance });

    if (mean < 8 && variance < 25) {
      showBlockedCameraHint("black frames");
    }
  }, 1200);
}

function scoreClass(score) {
  if (score >= 80) return "good";
  if (score >= 60) return "mid";
  return "low";
}

function setScore(score) {
  scorePill.textContent = `Score: ${score}/100`;
  const cls = scoreClass(score);
  scorePill.style.background = cls === "good"
    ? "rgba(19, 111, 99, 0.14)"
    : cls === "mid"
      ? "rgba(207, 106, 50, 0.18)"
      : "rgba(154, 31, 31, 0.16)";
}

function renderTips(tips) {
  tipsList.innerHTML = "";
  for (const tip of tips) {
    const li = document.createElement("li");
    li.textContent = tip;
    tipsList.appendChild(li);
  }
}

function renderMetrics(metrics) {
  const labels = {
    brightness: "Brightness",
    contrast: "Contrast",
    blur_score: "Blur",
    noise_score: "Noise",
    width: "Width",
    height: "Height",
    face_count: "Faces",
    face_area_ratio: "Face area",
    face_center_offset: "Face offset",
    face_sharpness: "Face sharpness"
  };

  metricsGrid.innerHTML = "";
  for (const [key, value] of Object.entries(metrics)) {
    const dt = document.createElement("dt");
    dt.textContent = labels[key] || key;

    const dd = document.createElement("dd");
    dd.textContent = String(value);

    metricsGrid.appendChild(dt);
    metricsGrid.appendChild(dd);
  }
}

function applyAnalysisPayload(payload) {
  setScore(payload.score);
  renderTips(payload.tips || []);
  renderMetrics(payload.metrics || {});
}

function getSelectedSystemIndex() {
  const idx = Number.parseInt(systemCameraIndex.value, 10);
  if (Number.isNaN(idx) || idx < 0) return 0;
  return idx;
}

async function analyzeBlob(blob) {
  const formData = new FormData();
  formData.append("photo", blob, "photo.jpg");

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing...";

  try {
    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      body: formData
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Analyze request failed.");
    }

    applyAnalysisPayload(payload);
  } catch (error) {
    alert(error.message);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze Photo";
  }
}

startCameraBtn.addEventListener("click", async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert(
      "Your browser cannot access the camera on this page.\n\n" +
      "Make sure you are opening the app at http://127.0.0.1:5000 (not a file:// path).\n" +
      "You can still upload a photo using the Upload section."
    );
    return;
  }

  try {
    stopActiveStream();
    showedHardwareHint = false;
    console.log("[PhotoCoach] Requesting camera...");

    // Enumerate devices first so we can report exactly what is found.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === "videoinput");
    console.log("[PhotoCoach] Video devices found:", videoDevices.length, videoDevices.map(d => d.label || d.deviceId));

    if (videoDevices.length === 0) {
      alert("No camera was detected on this device.\nUse the Upload section to select a photo from your files instead.");
      return;
    }

    if (!cameraSelect.options.length || cameraSelect.disabled) {
      await populateCameraSelect();
    }

    const selectedDeviceId = cameraSelect.value;
    if (!selectedDeviceId) {
      setCameraStatus("No camera selected. Pick a camera source and try again.");
      return;
    }

    const selectedName = cameraSelect.options[cameraSelect.selectedIndex]?.text || "Selected camera";
    setCameraStatus(`Starting ${selectedName}...`);

    activeStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: selectedDeviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });
    console.log("[PhotoCoach] Stream acquired:", activeStream.getVideoTracks().map(t => t.label));

    cameraFeed.srcObject = activeStream;

    // Explicitly call play() — some browsers need this even with autoplay attribute.
    try {
      await cameraFeed.play();
      console.log("[PhotoCoach] Video playback started.");
      diagnoseCameraFrames();
      setCameraStatus(`Live: ${selectedName}`);
    } catch (playErr) {
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
        "3. If it still fails, check Windows Settings → Privacy & Security → Camera and make sure your browser is listed and toggled On.";
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      message += "No usable camera was found. Try the Upload section instead.";
    } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      message +=
        "The camera is already being used by another app (e.g. Teams, Zoom, Snap Camera).\n" +
        "Close those apps, then reload this page and try again.";
    } else if (error.name === "OverconstrainedError") {
      message += "Camera rejected the requested settings. This should not happen — please reload and retry.";
    } else {
      message += error.message + "\n\nOpen browser DevTools (F12 → Console) and look for [PhotoCoach] lines for more detail.";
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_index: selectedIndex })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Fallback capture failed.");
    }

    if (payload.captured_image_base64) {
      previewImage.src = `data:image/jpeg;base64,${payload.captured_image_base64}`;
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
    systemCaptureBtn.disabled = false;
    systemCaptureBtn.textContent = "Capture via System Camera (Fallback)";
  }
});

testSystemIndexBtn.addEventListener("click", async () => {
  const selectedIndex = getSelectedSystemIndex();
  testSystemIndexBtn.disabled = true;
  testSystemIndexBtn.textContent = "Testing...";
  setCameraStatus(`Testing system camera index ${selectedIndex}...`);

  try {
    const response = await fetch(`${API_BASE}/api/system-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_index: selectedIndex })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "System preview failed.");
    }

    if (payload.preview_image_base64) {
      previewImage.src = `data:image/jpeg;base64,${payload.preview_image_base64}`;
      previewImage.style.display = "block";
    }

    const probe = payload.frame_probe || {};
    setCameraStatus(`Index ${payload.camera_index} preview OK. Probe mean=${probe.mean}, var=${probe.variance}`);
  } catch (error) {
    setCameraStatus(`Index ${selectedIndex} failed.`);
    alert("System index test failed.\n\n" + error.message);
  } finally {
    testSystemIndexBtn.disabled = false;
    testSystemIndexBtn.textContent = "Test Index";
  }
});

autoProbeBtn.addEventListener("click", async () => {
  autoProbeBtn.disabled = true;
  autoProbeBtn.textContent = "Scanning...";
  setCameraStatus("Scanning camera indices/backends for a non-black feed...");

  try {
    const response = await fetch(`${API_BASE}/api/system-autoprobe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_index: 10 })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Auto probe failed.");
    }

    if (!payload.best) {
      setCameraStatus("No usable camera feed found. Feeds appear blocked/black.");
      alert(
        "Auto probe found no usable feed.\n\n" +
        "This strongly suggests a hardware/privacy camera block. Try toggling your HP camera privacy key and close all apps using camera."
      );
      return;
    }

    const best = payload.best;
    if (best.backend === "DSHOW") {
      systemCameraIndex.value = String(best.camera_index);
    }

    setCameraStatus(`Best feed: ${best.backend} index ${best.camera_index} (var=${best.probe.variance}). Ready to auto capture.`);
  } catch (error) {
    setCameraStatus("Auto probe failed.");
    alert("Auto probe error:\n\n" + error.message);
  } finally {
    autoProbeBtn.disabled = false;
    autoProbeBtn.textContent = "Auto Find Working Camera";
  }
});

autoCaptureBtn.addEventListener("click", async () => {
  autoCaptureBtn.disabled = true;
  autoCaptureBtn.textContent = "Auto Capturing...";
  setCameraStatus("Auto-selecting and capturing from best available feed...");

  try {
    const response = await fetch(`${API_BASE}/api/capture-system-auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_index: 10 })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Auto capture failed.");
    }

    if (payload.captured_image_base64) {
      previewImage.src = `data:image/jpeg;base64,${payload.captured_image_base64}`;
      previewImage.style.display = "block";
    }

    applyAnalysisPayload(payload);
    analyzeBtn.disabled = false;

    const sel = payload.auto_selected || {};
    const probe = sel.probe || {};
    setCameraStatus(`Auto capture succeeded with ${sel.backend} index ${sel.camera_index} (mean=${probe.mean}, var=${probe.variance}).`);
  } catch (error) {
    setCameraStatus("Auto capture failed. No usable feed found.");
    alert("Auto capture failed:\n\n" + error.message);
  } finally {
    autoCaptureBtn.disabled = false;
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

captureBtn.addEventListener("click", async () => {
  if (!cameraFeed.videoWidth || !cameraFeed.videoHeight) return;

  captureCanvas.width = cameraFeed.videoWidth;
  captureCanvas.height = cameraFeed.videoHeight;
  const ctx = captureCanvas.getContext("2d");
  
  // Flip camera horizontally (mirror image)
  ctx.scale(-1, 1);
  ctx.drawImage(cameraFeed, -captureCanvas.width, 0, captureCanvas.width, captureCanvas.height);

  const blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) return;

  selectedBlob = blob;
  previewImage.src = URL.createObjectURL(blob);
  previewImage.style.display = "block";
  analyzeBtn.disabled = false;
});

uploadInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  selectedBlob = file;
  previewImage.src = URL.createObjectURL(file);
  previewImage.style.display = "block";
  analyzeBtn.disabled = false;
});

analyzeBtn.addEventListener("click", async () => {
  if (!selectedBlob) {
    alert("Capture or upload a photo first.");
    return;
  }
  await analyzeBlob(selectedBlob);
});

populateCameraSelect().catch((error) => {
  console.error("[PhotoCoach] initial camera scan error:", error);
  setCameraStatus("Could not scan camera devices yet. Click Refresh.");
});

window.addEventListener("beforeunload", () => {
  stopActiveStream();
});
