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
const PRODUCTION_API_URL = "https://photo-coach-j95a.onrender.com";  // TODO: replace with your Render URL after deploying

const IS_LOCALHOST = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

const API_BASE =
  IS_LOCALHOST
    ? ""               // local dev  — use relative paths (Flask serves everything)
    : PRODUCTION_API_URL; // GitHub Pages — point to Render backend

const startCameraBtn = document.getElementById("startCameraBtn");
const refreshCamerasBtn = document.getElementById("refreshCamerasBtn");
const cameraSelect = document.getElementById("cameraSelect");
const cameraStatus = document.getElementById("cameraStatus");
const filterSelect = document.getElementById("filterSelect");
const filterSize = document.getElementById("filterSize");
const filterSizeValue = document.getElementById("filterSizeValue");
const systemCaptureBtn = document.getElementById("systemCaptureBtn");
const systemCameraIndex = document.getElementById("systemCameraIndex");
const testSystemIndexBtn = document.getElementById("testSystemIndexBtn");
const autoProbeBtn = document.getElementById("autoProbeBtn");
const autoCaptureBtn = document.getElementById("autoCaptureBtn");
const captureBtn = document.getElementById("captureBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const uploadInput = document.getElementById("uploadInput");
const inspirationUrlInput = document.getElementById("inspirationUrlInput");
const inspirationNoteInput = document.getElementById("inspirationNoteInput");
const addInspirationBtn = document.getElementById("addInspirationBtn");
const clearInspirationBtn = document.getElementById("clearInspirationBtn");
const inspirationStatus = document.getElementById("inspirationStatus");
const inspirationList = document.getElementById("inspirationList");
const cameraFeed = document.getElementById("cameraFeed");
const faceOverlay = document.getElementById("faceOverlay");
const captureCanvas = document.getElementById("captureCanvas");
const previewImage = document.getElementById("previewImage");
const scorePill = document.getElementById("scorePill");
const piercingFitPanel = document.getElementById("piercingFitPanel");
const piercingFitScore = document.getElementById("piercingFitScore");
const piercingFitSummary = document.getElementById("piercingFitSummary");
const piercingFitList = document.getElementById("piercingFitList");
const tipsList = document.getElementById("tipsList");
const metricsGrid = document.getElementById("metricsGrid");

const supportsFaceDetector = typeof FaceDetector !== "undefined";
const faceDetector = supportsFaceDetector
  ? new FaceDetector({ maxDetectedFaces: 1, fastMode: true })
  : null;
const serverTrackingCanvas = document.createElement("canvas");
const INSPIRATION_STORAGE_KEY = "photoCoachPinterestInspirationV1";

// MediaPipe Face Mesh for landmark detection
let faceMesh = null;
let faceMeshInitializing = false;
let detectedLandmarks = null;
let detectedFaceShape = "oval";  // Default shape

let activeStream = null;
let selectedBlob = null;
let showedHardwareHint = false;
let faceTrackingActive = false;
let faceTrackingRafId = null;
let faceTrackingMode = "none";
let serverFaceTrackingTimer = null;
let serverFaceTrackingBusy = false;
let overlayRenderRafId = null;
let targetTrackedBox = null;
let renderedTrackedBox = null;
let missedTrackingFrames = 0;
let selectedFilter = "none";
let selectedFilterScale = 1.0;
let inspirationEntries = [];
let selectedPhotoContext = buildPhotoContext("empty");

const FILTER_LABELS = {
  none: "None",
  septum: "Septum Ring",
  "nose-stud-left": "Nose Stud (Left)",
  "brow-left": "Brow Ring (Left)",
  "earring-left": "Hoop Earring (Left)",
  "earring-right": "Hoop Earring (Right)",
};

const PIERCING_STYLE_GUIDE = {
  septum: {
    preferredShapes: ["oval", "diamond", "round"],
    flexibleShapes: ["heart"],
    alternatives: ["nose-stud-left", "brow-left"],
    note: "Septum rings usually read best when the face has soft center balance or strong cheekbone symmetry.",
  },
  "nose-stud-left": {
    preferredShapes: ["heart", "oval", "square"],
    flexibleShapes: ["diamond"],
    alternatives: ["brow-left", "septum"],
    note: "Nose studs are the safest everyday option and usually work well when you want a lighter accent.",
  },
  "brow-left": {
    preferredShapes: ["square", "diamond", "oval"],
    flexibleShapes: ["heart"],
    alternatives: ["nose-stud-left", "earring-left"],
    note: "Brow rings suit faces that can carry a stronger upper-face detail without overpowering the center.",
  },
  "earring-left": {
    preferredShapes: ["oval", "heart", "round"],
    flexibleShapes: ["square", "diamond"],
    alternatives: ["earring-right", "nose-stud-left"],
    note: "Hoops usually flatter balanced or longer silhouettes because they widen the outer frame nicely.",
  },
  "earring-right": {
    preferredShapes: ["oval", "heart", "round"],
    flexibleShapes: ["square", "diamond"],
    alternatives: ["earring-left", "nose-stud-left"],
    note: "Hoops usually flatter balanced or longer silhouettes because they widen the outer frame nicely.",
  },
};

const PINTEREST_TAG_MAP = {
  septum: ["septum", "bull", "horseshoe"],
  "nose-stud-left": ["nose stud", "nostril", "nostril stud", "nose pin", "tiny stud", "minimalist"],
  "brow-left": ["brow", "eyebrow", "brow ring", "eyebrow ring"],
  "earring-left": ["earring", "hoop", "huggie", "lobe", "cartilage"],
  "earring-right": ["earring", "hoop", "huggie", "lobe", "cartilage"],
};

function setCameraStatus(message) {
  cameraStatus.textContent = message;
}

function stopActiveStream() {
  stopFaceTracking();
  if (!activeStream) return;
  for (const track of activeStream.getTracks()) {
    track.stop();
  }
  activeStream = null;
  cameraFeed.srcObject = null;
}

function clearFaceOverlay() {
  if (!faceOverlay) return;
  const ctx = faceOverlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, faceOverlay.width, faceOverlay.height);
}

function resetTrackingVisualState() {
  targetTrackedBox = null;
  renderedTrackedBox = null;
  missedTrackingFrames = 0;
}

function stopFaceTracking() {
  faceTrackingActive = false;
  faceTrackingMode = "none";
  if (faceTrackingRafId !== null) {
    cancelAnimationFrame(faceTrackingRafId);
    faceTrackingRafId = null;
  }
  if (serverFaceTrackingTimer !== null) {
    clearInterval(serverFaceTrackingTimer);
    serverFaceTrackingTimer = null;
  }
  if (overlayRenderRafId !== null) {
    cancelAnimationFrame(overlayRenderRafId);
    overlayRenderRafId = null;
  }
  serverFaceTrackingBusy = false;
  resetTrackingVisualState();
  clearFaceOverlay();
}

function mapBoundingBoxToDisplay(box, srcWidth, srcHeight, displayWidth, displayHeight, mirrored) {
  const scale = Math.max(displayWidth / srcWidth, displayHeight / srcHeight);
  const renderedWidth = srcWidth * scale;
  const renderedHeight = srcHeight * scale;
  const offsetX = (displayWidth - renderedWidth) / 2;
  const offsetY = (displayHeight - renderedHeight) / 2;

  let x = (box.x * scale) + offsetX;
  const y = (box.y * scale) + offsetY;
  const width = box.width * scale;
  const height = box.height * scale;

  if (mirrored) {
    x = displayWidth - (x + width);
  }

  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(0, Math.min(width, displayWidth)),
    height: Math.max(0, Math.min(height, displayHeight)),
  };
}

function drawFaceBox(box) {
  const stabilized = targetTrackedBox
    ? {
        x: (targetTrackedBox.x * 0.45) + (box.x * 0.55),
        y: (targetTrackedBox.y * 0.45) + (box.y * 0.55),
        width: (targetTrackedBox.width * 0.45) + (box.width * 0.55),
        height: (targetTrackedBox.height * 0.45) + (box.height * 0.55),
      }
    : box;

  targetTrackedBox = stabilized;
  missedTrackingFrames = 0;
}

function drawOverlayBox(box) {
  if (!faceOverlay) return;
  const ctx = faceOverlay.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, faceOverlay.width, faceOverlay.height);
  
  // Draw dynamic face box based on detected shape
  drawDynamicFaceBox(ctx, box);
  
  // Draw filter overlays on top
  drawFilterOverlay(ctx, box);
}

function drawFilterOverlay(ctx, box) {
  if (selectedFilter === "none") return;

  const ringColor = "#cfd6df";
  const strokeColor = "#9099a4";
  const shadowColor = "rgba(0, 0, 0, 0.18)";

  const cx = box.x + (box.width * 0.5);
  const cy = box.y + (box.height * 0.5);
  const scale = selectedFilterScale;
  const displayWidth = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = 6;

  if (selectedFilter === "septum") {
    let sx = cx;
    let sy = box.y + (box.height * 0.63);

    // Use landmark if available (nose tip landmark #1)
    if (detectedLandmarks) {
      const noseTip = getLandmarkCoordinate(detectedLandmarks, 1, box, displayWidth, displayHeight);
      if (noseTip) {
        sx = noseTip.x;
        sy = noseTip.y + (box.height * 0.08);
      }
    }

    const r = Math.max(6, box.width * 0.06 * scale);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = Math.max(2, box.width * 0.012 * scale);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0.15 * Math.PI, 0.85 * Math.PI, false);
    ctx.stroke();
    ctx.fillStyle = ringColor;
    ctx.beginPath();
    ctx.arc(sx - (r * 0.7), sy + (r * 0.2), Math.max(1.8, r * 0.14), 0, Math.PI * 2);
    ctx.arc(sx + (r * 0.7), sy + (r * 0.2), Math.max(1.8, r * 0.14), 0, Math.PI * 2);
    ctx.fill();
  } else if (selectedFilter === "nose-stud-left") {
    let sx = box.x + (box.width * 0.41);
    let sy = box.y + (box.height * 0.6);

    // Use landmark if available (nose left landmark #130)
    if (detectedLandmarks) {
      const noseLeft = getLandmarkCoordinate(detectedLandmarks, 130, box, displayWidth, displayHeight);
      if (noseLeft) {
        sx = noseLeft.x - (box.width * 0.08);
        sy = noseLeft.y;
      }
    }

    const r = Math.max(2, box.width * 0.014 * scale);
    ctx.fillStyle = ringColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (selectedFilter === "brow-left") {
    let sx = box.x + (box.width * 0.35);
    let sy = box.y + (box.height * 0.35);

    // Use landmark if available (left eyebrow landmark #285)
    if (detectedLandmarks) {
      const eyebrow = getLandmarkCoordinate(detectedLandmarks, 285, box, displayWidth, displayHeight);
      if (eyebrow) {
        sx = eyebrow.x;
        sy = eyebrow.y - (box.height * 0.05);
      }
    }

    const rx = Math.max(5, box.width * 0.032 * scale);
    const ry = Math.max(3, box.height * 0.018 * scale);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = Math.max(2, box.width * 0.01 * scale);
    ctx.beginPath();
    ctx.ellipse(sx, sy, rx, ry, -0.18, 0.1 * Math.PI, 1.1 * Math.PI);
    ctx.stroke();
  } else if (selectedFilter === "earring-left" || selectedFilter === "earring-right") {
    const isLeft = selectedFilter === "earring-left";
    let sx = box.x + (box.width * (isLeft ? 0.06 : 0.94));
    let sy = box.y + (box.height * 0.68);

    // Use landmark if available (ear landmarks #234 for left, #454 for right)
    if (detectedLandmarks) {
      const earIndex = isLeft ? 234 : 454;
      const ear = getLandmarkCoordinate(detectedLandmarks, earIndex, box, displayWidth, displayHeight);
      if (ear) {
        sx = ear.x + (isLeft ? -box.width * 0.05 : box.width * 0.05);
        sy = ear.y;
      }
    }

    const r = Math.max(8, box.width * 0.055 * scale);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth = Math.max(2.2, box.width * 0.012 * scale);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0.08 * Math.PI, 1.92 * Math.PI);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Facial Landmark Detection & Face Shape Classification
// ---------------------------------------------------------------------------

async function initializeFaceMesh() {
  if (faceMesh || faceMeshInitializing) return;
  if (typeof window.FaceMesh === "undefined") {
    console.warn("[PhotoCoach] MediaPipe FaceMesh not available yet. Skipping landmark detection.");
    return;
  }

  faceMeshInitializing = true;
  try {
    faceMesh = new window.FaceMesh({
      locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
      }
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    faceMesh.onResults(onFaceMeshResults);
    console.log("[PhotoCoach] MediaPipe FaceMesh initialized successfully.");
  } catch (e) {
    console.warn("[PhotoCoach] Failed to initialize FaceMesh:", e);
    faceMesh = null;
  } finally {
    faceMeshInitializing = false;
  }
}

function onFaceMeshResults(results) {
  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    detectedLandmarks = null;
    return;
  }

  const landmarks = results.multiFaceLandmarks[0];
  detectedLandmarks = landmarks.map(l => ({ x: l.x, y: l.y, z: l.z }));
  
  // Classify face shape from landmarks
  detectedFaceShape = classifyFaceShape(detectedLandmarks);
}

function classifyFaceShape(landmarks) {
  if (!landmarks || landmarks.length < 300) return "oval";

  // Key landmark indices for face shape classification
  const jawlineLeft = landmarks[234];      // Left jaw corner
  const jawlineRight = landmarks[454];     // Right jaw corner
  const foreheadTop = landmarks[10];       // Top of forehead
  const chin = landmarks[152];             // Chin tip
  const cheekLeft = landmarks[205];        // Left cheekbone
  const cheekRight = landmarks[425];       // Right cheekbone

  if (!jawlineLeft || !jawlineRight || !foreheadTop || !chin || !cheekLeft || !cheekRight) {
    return "oval";
  }

  // Calculate proportions
  const faceWidth = Math.abs(jawlineRight.x - jawlineLeft.x);
  const faceHeight = Math.abs(chin.y - foreheadTop.y);
  const cheekWidth = Math.abs(cheekRight.x - cheekLeft.x);
  
  const heightToWidthRatio = faceHeight / faceWidth;
  const cheekToJawRatio = cheekWidth / faceWidth;

  // Classification logic based on proportions
  if (heightToWidthRatio > 1.3) {
    // Long face
    if (cheekToJawRatio > 0.75) return "round";  // Soft, rounded
    return "heart";  // Longer with defined cheeks
  } else if (heightToWidthRatio > 1.1) {
    // Moderate height
    if (cheekToJawRatio > 0.85) return "round";
    if (cheekToJawRatio > 0.75) return "oval";
    return "square";
  } else if (heightToWidthRatio > 0.95) {
    // Balanced
    if (cheekToJawRatio > 0.8) return "round";
    return "oval";
  } else {
    // Wide face
    if (cheekToJawRatio > 0.9) return "round";
    if (Math.abs(jawlineLeft.y - jawlineRight.y) < faceHeight * 0.1) return "square";
    return "diamond";
  }
}

function getLandmarkCoordinate(landmarks, index, box, displayWidth, displayHeight) {
  if (!landmarks || index >= landmarks.length) return null;
  const landmark = landmarks[index];
  
  // Scale landmark from [0, 1] to display coordinates
  let x = landmark.x * displayWidth;
  let y = landmark.y * displayHeight;
  
  // Account for video mirroring (horizontal flip)
  x = displayWidth - x;
  
  return { x, y, z: landmark.z };
}

function drawDynamicFaceBox(ctx, box) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(19, 111, 99, 0.95)";
  ctx.fillStyle = "rgba(19, 111, 99, 0.14)";

  const centerX = box.x + box.width * 0.5;
  const centerY = box.y + box.height * 0.5;
  const w = box.width * 0.5;
  const h = box.height * 0.5;

  // Draw different shapes based on detected face shape
  switch (detectedFaceShape) {
    case "round":
      // Circular shape
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, w, h, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      break;

    case "oval":
      // Oval shape (slightly taller than wide)
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, w * 0.9, h, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      break;

    case "square":
      // Square/rectangular shape with rounded corners
      ctx.beginPath();
      const radius = 12;
      ctx.moveTo(box.x + radius, box.y);
      ctx.lineTo(box.x + box.width - radius, box.y);
      ctx.quadraticCurveTo(box.x + box.width, box.y, box.x + box.width, box.y + radius);
      ctx.lineTo(box.x + box.width, box.y + box.height - radius);
      ctx.quadraticCurveTo(box.x + box.width, box.y + box.height, box.x + box.width - radius, box.y + box.height);
      ctx.lineTo(box.x + radius, box.y + box.height);
      ctx.quadraticCurveTo(box.x, box.y + box.height, box.x, box.y + box.height - radius);
      ctx.lineTo(box.x, box.y + radius);
      ctx.quadraticCurveTo(box.x, box.y, box.x + radius, box.y);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      break;

    case "heart":
      // Heart shape (wider at top)
      ctx.beginPath();
      const heartCp = box.height * 0.35;
      ctx.moveTo(centerX, box.y + heartCp);
      ctx.bezierCurveTo(
        box.x, box.y,
        box.x, box.y + heartCp,
        centerX, box.y + heartCp + 15
      );
      ctx.bezierCurveTo(
        box.x + box.width, box.y + heartCp,
        box.x + box.width, box.y,
        centerX, box.y + heartCp
      );
      ctx.bezierCurveTo(
        centerX - 8, box.y + heartCp + 20,
        box.x, box.y + box.height - 20,
        centerX, box.y + box.height
      );
      ctx.bezierCurveTo(
        box.x + box.width, box.y + box.height - 20,
        centerX + 8, box.y + heartCp + 20,
        centerX, box.y + heartCp
      );
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      break;

    case "diamond":
      // Diamond shape
      ctx.beginPath();
      ctx.moveTo(centerX, box.y);
      ctx.lineTo(box.x + box.width, centerY);
      ctx.lineTo(centerX, box.y + box.height);
      ctx.lineTo(box.x, centerY);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      break;

    default:
      // Fallback to rectangle
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.fillRect(box.x, box.y, box.width, box.height);
  }

  ctx.restore();
}

function runOverlayRenderLoop() {
  if (!faceTrackingActive || !faceOverlay) {
    overlayRenderRafId = null;
    return;
  }

  const displayWidth = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);

  if (displayWidth <= 0 || displayHeight <= 0) {
    overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
    return;
  }

  if (faceOverlay.width !== displayWidth || faceOverlay.height !== displayHeight) {
    faceOverlay.width = displayWidth;
    faceOverlay.height = displayHeight;
  }

  if (!targetTrackedBox) {
    if (missedTrackingFrames > 3) {
      renderedTrackedBox = null;
      clearFaceOverlay();
    }
    overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
    return;
  }

  renderedTrackedBox = renderedTrackedBox
    ? {
        x: (renderedTrackedBox.x * 0.72) + (targetTrackedBox.x * 0.28),
        y: (renderedTrackedBox.y * 0.72) + (targetTrackedBox.y * 0.28),
        width: (renderedTrackedBox.width * 0.72) + (targetTrackedBox.width * 0.28),
        height: (renderedTrackedBox.height * 0.72) + (targetTrackedBox.height * 0.28),
      }
    : { ...targetTrackedBox };

  drawOverlayBox(renderedTrackedBox);
  overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
}

async function runFaceTrackingLoop() {
  if (!faceTrackingActive || !faceDetector || !activeStream || !faceOverlay) {
    faceTrackingRafId = null;
    return;
  }

  const displayWidth = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);

  if (displayWidth <= 0 || displayHeight <= 0 || cameraFeed.readyState < 2) {
    clearFaceOverlay();
    faceTrackingRafId = requestAnimationFrame(runFaceTrackingLoop);
    return;
  }

  if (faceOverlay.width !== displayWidth || faceOverlay.height !== displayHeight) {
    faceOverlay.width = displayWidth;
    faceOverlay.height = displayHeight;
  }

  try {
    // Process frame through MediaPipe Face Mesh for landmarks
    if (faceMesh && !faceMeshInitializing) {
      try {
        await faceMesh.send({ image: cameraFeed });
      } catch {
        // FaceMesh processing may fail intermittently; continue anyway
      }
    }

    const faces = await faceDetector.detect(cameraFeed);
    if (!faces.length || !faces[0].boundingBox || !cameraFeed.videoWidth || !cameraFeed.videoHeight) {
      missedTrackingFrames += 1;
      if (missedTrackingFrames > 3) {
        targetTrackedBox = null;
      }
    } else {
      const box = mapBoundingBoxToDisplay(
        faces[0].boundingBox,
        cameraFeed.videoWidth,
        cameraFeed.videoHeight,
        displayWidth,
        displayHeight,
        true
      );
      drawFaceBox(box);
    }
  } catch {
    // Some browsers intermittently throw during track state transitions.
    missedTrackingFrames += 1;
    if (missedTrackingFrames > 3) {
      targetTrackedBox = null;
    }
  }

  faceTrackingRafId = requestAnimationFrame(runFaceTrackingLoop);
}

async function pollServerFaceTracking() {
  if (!faceTrackingActive || faceTrackingMode !== "server" || !activeStream || !faceOverlay) return;
  if (serverFaceTrackingBusy || cameraFeed.readyState < 2 || !cameraFeed.videoWidth || !cameraFeed.videoHeight) return;

  const displayWidth = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);
  if (displayWidth <= 0 || displayHeight <= 0) return;

  if (faceOverlay.width !== displayWidth || faceOverlay.height !== displayHeight) {
    faceOverlay.width = displayWidth;
    faceOverlay.height = displayHeight;
  }

  const sampleWidth = Math.min(480, cameraFeed.videoWidth);
  const sampleHeight = Math.round((sampleWidth / cameraFeed.videoWidth) * cameraFeed.videoHeight);
  serverTrackingCanvas.width = sampleWidth;
  serverTrackingCanvas.height = sampleHeight;

  const ctx = serverTrackingCanvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(cameraFeed, 0, 0, sampleWidth, sampleHeight);

  const blob = await new Promise((resolve) => {
    serverTrackingCanvas.toBlob(resolve, "image/jpeg", 0.65);
  });
  if (!blob) return;

  const formData = new FormData();
  formData.append("photo", blob, "frame.jpg");

  serverFaceTrackingBusy = true;
  try {
    const response = await fetch(`${API_BASE}/api/track-face`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      missedTrackingFrames += 1;
      if (missedTrackingFrames > 3) {
        targetTrackedBox = null;
      }
      return;
    }

    const payload = await response.json();
    if (!payload.face_detected || !payload.face_box) {
      missedTrackingFrames += 1;
      if (missedTrackingFrames > 3) {
        targetTrackedBox = null;
      }
      return;
    }

    const mapped = mapBoundingBoxToDisplay(
      payload.face_box,
      payload.frame_width,
      payload.frame_height,
      displayWidth,
      displayHeight,
      true
    );
    drawFaceBox(mapped);
  } catch {
    missedTrackingFrames += 1;
    if (missedTrackingFrames > 3) {
      targetTrackedBox = null;
    }
  } finally {
    serverFaceTrackingBusy = false;
  }
}

function startServerFaceTracking() {
  stopFaceTracking();
  faceTrackingActive = true;
  faceTrackingMode = "server";
  resetTrackingVisualState();
  overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
  void pollServerFaceTracking();
  serverFaceTrackingTimer = setInterval(() => {
    void pollServerFaceTracking();
  }, 160);
}

function startFaceTracking() {
  if (!faceOverlay) {
    clearFaceOverlay();
    return;
  }

  // Initialize MediaPipe Face Mesh for landmark detection
  void initializeFaceMesh();

  if (supportsFaceDetector) {
    stopFaceTracking();
    faceTrackingActive = true;
    faceTrackingMode = "local";
    resetTrackingVisualState();
    overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
    faceTrackingRafId = requestAnimationFrame(runFaceTrackingLoop);
    return;
  }

  if (!API_BASE) {
    console.warn("[PhotoCoach] Face tracking unavailable: FaceDetector not supported and no API base configured for fallback.");
    clearFaceOverlay();
    return;
  }

  console.warn("[PhotoCoach] FaceDetector unavailable. Using backend face tracking fallback.");
  startServerFaceTracking();
}

function isVirtualCameraLabel(label) {
  const text = label.toLowerCase();
  return text.includes("virtual") || text.includes("obs") || text.includes("meta quest") || text.includes("snap camera");
}

function buildDeviceLabel(device, index) {
  if (device.label) return device.label;
  return `Camera ${index + 1}`;
}

function configureHostedModeUI() {
  // These controls require a server that has direct access to the user's webcam,
  // which is not possible when frontend is hosted remotely (GitHub Pages).
  if (!IS_LOCALHOST) {
    systemCaptureBtn.disabled = true;
    testSystemIndexBtn.disabled = true;
    autoProbeBtn.disabled = true;
    autoCaptureBtn.disabled = true;
    systemCaptureBtn.title = "Unavailable on hosted frontend. Use browser camera instead.";
    testSystemIndexBtn.title = "Unavailable on hosted frontend. Use browser camera instead.";
    autoProbeBtn.title = "Unavailable on hosted frontend. Use browser camera instead.";
    autoCaptureBtn.title = "Unavailable on hosted frontend. Use browser camera instead.";
  }
}

function applyFilterControlState() {
  selectedFilter = filterSelect ? filterSelect.value : "none";
  selectedFilterScale = filterSize ? Number.parseInt(filterSize.value, 10) / 100 : 1.0;
  if (filterSizeValue) {
    filterSizeValue.textContent = `${Math.round(selectedFilterScale * 100)}%`;
  }
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

function filterLabel(filterKey) {
  return FILTER_LABELS[filterKey] || "Selected Piercing";
}

function buildPhotoContext(source) {
  const activeBox = renderedTrackedBox || targetTrackedBox;
  const overlayWidth = faceOverlay?.width || faceOverlay?.clientWidth || 0;
  const inspiration = inferInspirationPreference(inspirationEntries);

  return {
    source,
    filter: selectedFilter,
    filterScale: selectedFilterScale,
    faceShape: detectedLandmarks ? detectedFaceShape : null,
    faceDetected: Boolean(detectedLandmarks || activeBox),
    faceWidthRatio: activeBox && overlayWidth ? activeBox.width / overlayWidth : null,
    inspiration,
  };
}

function normalizePinterestUrl(rawUrl) {
  try {
    const url = new URL(rawUrl.trim());
    const hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (!hostname.includes("pinterest.")) return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parseStyleTokens(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens = new Set();

  for (const [filterKey, keywords] of Object.entries(PINTEREST_TAG_MAP)) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      tokens.add(filterKey);
    }
  }

  return [...tokens];
}

function addInspirationEntry(rawUrl, note = "") {
  const normalizedUrl = normalizePinterestUrl(rawUrl);
  if (!normalizedUrl) {
    throw new Error("Please paste a valid Pinterest link.");
  }

  if (inspirationEntries.some((entry) => entry.url === normalizedUrl)) {
    throw new Error("That Pinterest link is already in your inspiration list.");
  }

  const combined = `${normalizedUrl} ${note}`;
  const entry = {
    id: `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: normalizedUrl,
    note: note.trim(),
    styleTokens: parseStyleTokens(combined),
    addedAt: Date.now(),
  };

  inspirationEntries.unshift(entry);
  inspirationEntries = inspirationEntries.slice(0, 12);
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext.source || "empty");
}

function removeInspirationEntry(id) {
  inspirationEntries = inspirationEntries.filter((entry) => entry.id !== id);
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext.source || "empty");
}

function clearInspirationEntries() {
  inspirationEntries = [];
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext.source || "empty");
}

function persistInspirationEntries() {
  try {
    localStorage.setItem(INSPIRATION_STORAGE_KEY, JSON.stringify(inspirationEntries));
  } catch {
    // Ignore persistence failures for private mode or restricted storage.
  }
}

function loadInspirationEntries() {
  try {
    const raw = localStorage.getItem(INSPIRATION_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    inspirationEntries = parsed
      .filter((entry) => entry && typeof entry.url === "string")
      .map((entry) => ({
        id: String(entry.id || `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        url: normalizePinterestUrl(entry.url) || entry.url,
        note: typeof entry.note === "string" ? entry.note : "",
        styleTokens: Array.isArray(entry.styleTokens) ? entry.styleTokens : parseStyleTokens(`${entry.url} ${entry.note || ""}`),
        addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now(),
      }))
      .filter((entry) => entry.url && entry.url.includes("pinterest"))
      .slice(0, 12);
  } catch {
    inspirationEntries = [];
  }
}

function inferInspirationPreference(entries) {
  if (!entries.length) {
    return {
      dominantFilter: null,
      confidence: 0,
      totalPins: 0,
    };
  }

  const scores = {
    septum: 0,
    "nose-stud-left": 0,
    "brow-left": 0,
    "earring-left": 0,
    "earring-right": 0,
  };

  for (const entry of entries) {
    const tokens = Array.isArray(entry.styleTokens) ? entry.styleTokens : [];
    for (const token of tokens) {
      if (scores[token] !== undefined) {
        scores[token] += 1;
      }
    }
  }

  const dominant = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const dominantFilter = dominant && dominant[1] > 0 ? dominant[0] : null;
  const confidence = dominantFilter ? dominant[1] / Math.max(1, entries.length) : 0;

  return {
    dominantFilter,
    confidence,
    totalPins: entries.length,
  };
}

function renderInspirationEntries() {
  if (!inspirationList || !inspirationStatus) return;

  inspirationList.innerHTML = "";

  if (!inspirationEntries.length) {
    inspirationStatus.textContent = "No inspiration pins added yet.";
    return;
  }

  const preference = inferInspirationPreference(inspirationEntries);
  if (preference.dominantFilter) {
    inspirationStatus.textContent = `Loaded ${preference.totalPins} pin(s). Current vibe leans toward ${filterLabel(preference.dominantFilter)}.`;
  } else {
    inspirationStatus.textContent = `Loaded ${preference.totalPins} pin(s). Add notes like \"septum\" or \"hoop\" for sharper matching.`;
  }

  for (const entry of inspirationEntries) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = entry.note || entry.url;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.className = "inspiration-remove-btn";
    removeBtn.addEventListener("click", () => {
      removeInspirationEntry(entry.id);
    });

    li.appendChild(link);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(removeBtn);
    inspirationList.appendChild(li);
  }
}

function renderPiercingFitAssessment(assessment) {
  if (!piercingFitPanel || !piercingFitScore || !piercingFitSummary || !piercingFitList) return;

  if (!assessment) {
    piercingFitPanel.hidden = true;
    piercingFitList.innerHTML = "";
    return;
  }

  piercingFitPanel.hidden = false;
  piercingFitScore.textContent = `Piercing Fit: ${assessment.score}/100`;

  const fitClass = scoreClass(assessment.score);
  piercingFitScore.style.background = fitClass === "good"
    ? "rgba(19, 111, 99, 0.14)"
    : fitClass === "mid"
      ? "rgba(207, 106, 50, 0.18)"
      : "rgba(154, 31, 31, 0.16)";
  piercingFitScore.style.color = fitClass === "low" ? "var(--danger)" : "var(--accent-strong)";

  piercingFitSummary.textContent = assessment.summary;
  piercingFitList.innerHTML = "";
  for (const item of assessment.details) {
    const li = document.createElement("li");
    li.textContent = item;
    piercingFitList.appendChild(li);
  }
}

function assessPiercingFit(context) {
  if (!context || !context.filter || context.filter === "none") {
    return null;
  }

  const guide = PIERCING_STYLE_GUIDE[context.filter];
  const label = filterLabel(context.filter);
  const details = [];
  let score = 72;

  if (!context.faceDetected) {
    return {
      score: 58,
      summary: `${label} was kept in the captured image, but I could not read enough face geometry to judge the fit confidently.`,
      details: [
        "Try capturing with your full face centered and well lit for a stronger fit reading.",
        `If you want a safer default instead, start with ${filterLabel("nose-stud-left")}.`,
      ],
    };
  }

  if (context.faceShape) {
    if (guide.preferredShapes.includes(context.faceShape)) {
      score += 16;
      details.push(`${label} suits ${context.faceShape} faces well, so the shape match is strong.`);
    } else if (guide.flexibleShapes.includes(context.faceShape)) {
      score += 6;
      details.push(`${label} can work on a ${context.faceShape} face, but placement and size matter more.`);
    } else {
      score -= 12;
      const alt = guide.alternatives[0] || "nose-stud-left";
      details.push(`${label} is a weaker match for a ${context.faceShape} face shape.`);
      details.push(`A better starting point would be ${filterLabel(alt)}.`);
    }
  } else {
    details.push("Face shape was not locked at capture time, so this fit score is based on the live overlay only.");
  }

  if (context.filterScale > 1.22) {
    score -= 8;
    details.push("The selected size reads a little large, so the piercing pulls focus more than it should.");
  } else if (context.filterScale < 0.82) {
    score -= 5;
    details.push("The selected size is slightly understated, which can make the piercing disappear in the frame.");
  } else {
    score += 5;
    details.push("The current size is close to a natural fit for the tracked face width.");
  }

  if (context.faceWidthRatio !== null) {
    if (context.filter.startsWith("earring") && context.faceWidthRatio < 0.26) {
      score -= 6;
      details.push("The face reads narrow in frame, so the hoop can feel oversized unless scaled down a bit.");
    } else if (context.filter === "septum" && context.faceWidthRatio > 0.34) {
      score += 4;
      details.push("The stronger face presence in frame helps the septum ring hold visual balance.");
    }
  }

  if (context.inspiration && context.inspiration.dominantFilter) {
    if (context.inspiration.dominantFilter === context.filter) {
      score += 7;
      details.push(`Your saved inspiration leans toward ${filterLabel(context.filter)}, so this pick matches your personal style direction.`);
    } else {
      score -= 4;
      details.push(`Your saved inspiration leans toward ${filterLabel(context.inspiration.dominantFilter)}, which differs from this selection.`);
      if (context.inspiration.confidence >= 0.45) {
        details.push(`Style-forward alternative: ${filterLabel(context.inspiration.dominantFilter)}.`);
      }
    }
  }

  details.push(guide.note);
  score = Math.max(40, Math.min(96, Math.round(score)));

  const recommendedFilter = (score >= 70 ? context.filter : guide.alternatives[0]) || context.filter;
  const summary = score >= 82
    ? `${label} looks like a strong match for this face and frame.`
    : score >= 68
      ? `${label} works reasonably well, but a small sizing or style change could improve it.`
      : `${label} is probably not the best match here.`;

  if (recommendedFilter !== context.filter) {
    details.push(`Recommended instead: ${filterLabel(recommendedFilter)}.`);
  }

  if (context.inspiration && context.inspiration.dominantFilter && context.inspiration.confidence >= 0.45 && score < 84) {
    details.push(`Inspiration-first option: ${filterLabel(context.inspiration.dominantFilter)}.`);
  }

  return {
    score,
    summary,
    details,
  };
}

function drawVideoCoverFrame(ctx, source, sourceWidth, sourceHeight, destWidth, destHeight) {
  const scale = Math.max(destWidth / sourceWidth, destHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = (destWidth - drawWidth) / 2;
  const offsetY = (destHeight - drawHeight) / 2;

  ctx.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
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

function applyAnalysisPayload(payload, localAssessment = null) {
  setScore(payload.score);
  renderTips(payload.tips || []);
  renderMetrics(payload.metrics || {});
  renderPiercingFitAssessment(localAssessment);
}

function getSelectedSystemIndex() {
  const idx = Number.parseInt(systemCameraIndex.value, 10);
  if (Number.isNaN(idx) || idx < 0) return 0;
  return idx;
}

async function analyzeBlob(blob, context = selectedPhotoContext) {
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

    applyAnalysisPayload(payload, assessPiercingFit(context));
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

  if (!window.isSecureContext) {
    alert("Camera access requires a secure context (HTTPS). Open the app over https://.");
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
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    };

    activeStream = await navigator.mediaDevices.getUserMedia({
      video: selectedDeviceId ? { ...videoConstraints, deviceId: { exact: selectedDeviceId } } : videoConstraints,
      audio: false
    });
    console.log("[PhotoCoach] Stream acquired:", activeStream.getVideoTracks().map(t => t.label));

    await populateCameraSelect();
    const activeTrack = activeStream.getVideoTracks()[0];
    const activeDeviceId = activeTrack?.getSettings?.().deviceId;
    if (activeDeviceId) {
      cameraSelect.value = activeDeviceId;
    }

    cameraFeed.srcObject = activeStream;

    // Explicitly call play() — some browsers need this even with autoplay attribute.
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

if (filterSelect) {
  filterSelect.addEventListener("change", () => {
    applyFilterControlState();
    selectedPhotoContext = buildPhotoContext(selectedPhotoContext.source || "empty");
  });
}

if (filterSize) {
  filterSize.addEventListener("input", () => {
    applyFilterControlState();
    selectedPhotoContext = buildPhotoContext(selectedPhotoContext.source || "empty");
  });
}

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

if (clearInspirationBtn) {
  clearInspirationBtn.addEventListener("click", () => {
    clearInspirationEntries();
  });
}

captureBtn.addEventListener("click", async () => {
  if (!cameraFeed.videoWidth || !cameraFeed.videoHeight) return;

  const displayWidth = Math.round(cameraFeed.clientWidth || faceOverlay?.clientWidth || cameraFeed.videoWidth);
  const displayHeight = Math.round(cameraFeed.clientHeight || faceOverlay?.clientHeight || cameraFeed.videoHeight);

  captureCanvas.width = displayWidth;
  captureCanvas.height = displayHeight;
  const ctx = captureCanvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, captureCanvas.width, captureCanvas.height);

  // Match the mirrored, cover-fitted live preview so the saved image keeps the visible overlay alignment.
  ctx.save();
  ctx.scale(-1, 1);
  ctx.translate(-captureCanvas.width, 0);
  drawVideoCoverFrame(
    ctx,
    cameraFeed,
    cameraFeed.videoWidth,
    cameraFeed.videoHeight,
    captureCanvas.width,
    captureCanvas.height
  );
  ctx.restore();

  if (faceOverlay && faceOverlay.width > 0 && faceOverlay.height > 0) {
    ctx.drawImage(faceOverlay, 0, 0, captureCanvas.width, captureCanvas.height);
  }

  const blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", 0.95));
  if (!blob) return;

  selectedPhotoContext = buildPhotoContext("camera-capture");
  selectedBlob = blob;
  previewImage.src = URL.createObjectURL(blob);
  previewImage.style.display = "block";
  analyzeBtn.disabled = false;
});

uploadInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  selectedPhotoContext = buildPhotoContext("upload");
  selectedBlob = file;
  previewImage.src = URL.createObjectURL(file);
  previewImage.style.display = "block";
  analyzeBtn.disabled = false;
  renderPiercingFitAssessment(assessPiercingFit(selectedPhotoContext));
});

analyzeBtn.addEventListener("click", async () => {
  if (!selectedBlob) {
    alert("Capture or upload a photo first.");
    return;
  }
  await analyzeBlob(selectedBlob, selectedPhotoContext);
});

configureHostedModeUI();
applyFilterControlState();
loadInspirationEntries();
renderInspirationEntries();
populateCameraSelect().catch((error) => {
  console.error("[PhotoCoach] initial camera scan error:", error);
  setCameraStatus("Could not scan camera devices yet. Click Refresh.");
});

window.addEventListener("beforeunload", () => {
  stopActiveStream();
});
