// ---------------------------------------------------------------------------
// tracking.js — MediaPipe Face Mesh init, face tracking loops, shape
//               classification, bounding-box helpers, and tracking control.
//
// Depends on: state.js, filters.js (drawOverlayBox)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Utility: clear the overlay canvas
// ---------------------------------------------------------------------------
function clearFaceOverlay() {
  if (!faceOverlay) return;
  const ctx = faceOverlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, faceOverlay.width, faceOverlay.height);
}

function resetTrackingVisualState() {
  targetTrackedBox    = null;
  renderedTrackedBox  = null;
  missedTrackingFrames = 0;
  noseAlignmentReady  = false;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function distance2d(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a, b) {
  if (!a || !b) return null;
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

function symmetryScore(left, right, centerX, faceWidthNorm) {
  if (!left || !right || !Number.isFinite(centerX) || faceWidthNorm <= 0) return 0;
  const leftDist = Math.abs(centerX - left.x);
  const rightDist = Math.abs(right.x - centerX);
  const mirrorDelta = Math.abs(leftDist - rightDist) / faceWidthNorm;
  const heightDelta = Math.abs(left.y - right.y) / faceWidthNorm;
  return clampPercent(100 - ((mirrorDelta * 220) + (heightDelta * 120)));
}

function rangeSizeScore(value, minIdeal, maxIdeal) {
  if (!Number.isFinite(value)) return 0;
  if (value >= minIdeal && value <= maxIdeal) return 100;
  const gap = value < minIdeal ? (minIdeal - value) : (value - maxIdeal);
  const window = Math.max(0.0001, maxIdeal - minIdeal);
  return clampPercent(100 - ((gap / window) * 130));
}

function computeLandmarkFeatureMetrics(landmarks) {
  if (!landmarks || landmarks.length < 455) return null;

  const jawLeft = landmarks[234];
  const jawRight = landmarks[454];
  const forehead = landmarks[10];
  const chin = landmarks[152];
  const noseTip = landmarks[1];
  const lowerLipCenter = landmarks[17];
  if (!jawLeft || !jawRight || !forehead || !chin || !noseTip || !lowerLipCenter) return null;

  const faceWidth = Math.max(0.0001, Math.abs(jawRight.x - jawLeft.x));
  const faceHeight = Math.max(0.0001, Math.abs(chin.y - forehead.y));
  const centerX = (jawLeft.x + jawRight.x) * 0.5;

  const browLeftMid = midpoint(landmarks[70], landmarks[105]);
  const browRightMid = midpoint(landmarks[336], landmarks[334]);
  const eyeLeftInner = landmarks[133];
  const eyeLeftOuter = landmarks[33];
  const eyeRightInner = landmarks[362];
  const eyeRightOuter = landmarks[263];
  const mouthLeft = landmarks[61];
  const mouthRight = landmarks[291];
  const noseLeft = landmarks[129];
  const noseRight = landmarks[358];
  const noseBridge = landmarks[6];
  const chinLeft = landmarks[172];
  const chinRight = landmarks[397];
  const lowerFaceLeft = landmarks[149];
  const lowerFaceRight = landmarks[378];

  const browSymmetry = symmetryScore(browLeftMid, browRightMid, centerX, faceWidth);
  const browSize = rangeSizeScore((distance2d(landmarks[70], landmarks[105]) + distance2d(landmarks[336], landmarks[334])) / (2 * faceWidth), 0.08, 0.2);

  const eyeLeftSpan = distance2d(eyeLeftOuter, eyeLeftInner);
  const eyeRightSpan = distance2d(eyeRightOuter, eyeRightInner);
  const eyeSymmetry = clampPercent((symmetryScore(eyeLeftOuter, eyeRightOuter, centerX, faceWidth) * 0.6) + (100 - (Math.abs(eyeLeftSpan - eyeRightSpan) / faceWidth) * 220) * 0.4);
  const eyeSize = rangeSizeScore(((eyeLeftSpan + eyeRightSpan) * 0.5) / faceWidth, 0.12, 0.3);

  const noseSymmetry = clampPercent(100 - (Math.abs(noseTip.x - centerX) / faceWidth) * 300);
  const noseSize = rangeSizeScore(((distance2d(noseLeft, noseRight) / faceWidth) + (distance2d(noseBridge, landmarks[2]) / faceHeight)) * 0.5, 0.1, 0.28);

  const mouthSymmetry = symmetryScore(mouthLeft, mouthRight, centerX, faceWidth);
  const mouthSize = rangeSizeScore(distance2d(mouthLeft, mouthRight) / faceWidth, 0.24, 0.52);

  const chinSymmetry = symmetryScore(lowerFaceLeft, lowerFaceRight, centerX, faceWidth);
  const chinSize = rangeSizeScore(((distance2d(chinLeft, chinRight) / faceWidth) + (distance2d(chin, lowerLipCenter) / faceHeight)) * 0.5, 0.12, 0.35);

  return {
    eyebrow_symmetry_score: Number(browSymmetry.toFixed(2)),
    eyebrow_size_score: Number(browSize.toFixed(2)),
    eye_symmetry_score: Number(eyeSymmetry.toFixed(2)),
    eye_size_score: Number(eyeSize.toFixed(2)),
    nose_symmetry_score: Number(noseSymmetry.toFixed(2)),
    nose_size_score: Number(noseSize.toFixed(2)),
    mouth_symmetry_score: Number(mouthSymmetry.toFixed(2)),
    mouth_size_score: Number(mouthSize.toFixed(2)),
    chin_symmetry_score: Number(chinSymmetry.toFixed(2)),
    chin_size_score: Number(chinSize.toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Stop face tracking completely
// ---------------------------------------------------------------------------
function stopFaceTracking() {
  faceTrackingActive = false;
  faceTrackingMode   = "none";

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

// ---------------------------------------------------------------------------
// Bounding-box mapping
// ---------------------------------------------------------------------------
function mapBoundingBoxToDisplay(box, srcWidth, srcHeight, displayWidth, displayHeight, mirrored) {
  const scale        = Math.max(displayWidth / srcWidth, displayHeight / srcHeight);
  const renderedWidth  = srcWidth  * scale;
  const renderedHeight = srcHeight * scale;
  const offsetX      = (displayWidth  - renderedWidth)  / 2;
  const offsetY      = (displayHeight - renderedHeight) / 2;

  let x        = (box.x * scale) + offsetX;
  const y      = (box.y * scale) + offsetY;
  const width  = box.width  * scale;
  const height = box.height * scale;

  if (mirrored) {
    x = displayWidth - (x + width);
  }

  return {
    x:      Math.max(0, x),
    y:      Math.max(0, y),
    width:  Math.max(0, Math.min(width,  displayWidth)),
    height: Math.max(0, Math.min(height, displayHeight)),
  };
}

// ---------------------------------------------------------------------------
// Smoothed face-box update
// ---------------------------------------------------------------------------
function drawFaceBox(box) {
  const stabilized = targetTrackedBox
    ? {
        x:      (targetTrackedBox.x      * 0.45) + (box.x      * 0.55),
        y:      (targetTrackedBox.y      * 0.45) + (box.y      * 0.55),
        width:  (targetTrackedBox.width  * 0.45) + (box.width  * 0.55),
        height: (targetTrackedBox.height * 0.45) + (box.height * 0.55),
      }
    : box;

  targetTrackedBox     = stabilized;
  missedTrackingFrames = 0;
}

// ---------------------------------------------------------------------------
// Render loop (smooth interpolation → drawOverlayBox in filters.js)
// ---------------------------------------------------------------------------
function runOverlayRenderLoop() {
  if (!faceTrackingActive || !faceOverlay) {
    overlayRenderRafId = null;
    return;
  }

  const displayWidth  = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);

  if (displayWidth <= 0 || displayHeight <= 0) {
    overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
    return;
  }

  if (faceOverlay.width !== displayWidth || faceOverlay.height !== displayHeight) {
    faceOverlay.width  = displayWidth;
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
        x:      (renderedTrackedBox.x      * 0.72) + (targetTrackedBox.x      * 0.28),
        y:      (renderedTrackedBox.y      * 0.72) + (targetTrackedBox.y      * 0.28),
        width:  (renderedTrackedBox.width  * 0.72) + (targetTrackedBox.width  * 0.28),
        height: (renderedTrackedBox.height * 0.72) + (targetTrackedBox.height * 0.28),
      }
    : { ...targetTrackedBox };

  drawOverlayBox(renderedTrackedBox);
  overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
}

// ---------------------------------------------------------------------------
// Local FaceDetector tracking loop
// ---------------------------------------------------------------------------
async function runFaceTrackingLoop() {
  if (!faceTrackingActive || !faceDetector || !activeStream || !faceOverlay) {
    faceTrackingRafId = null;
    return;
  }

  const displayWidth  = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);

  if (displayWidth <= 0 || displayHeight <= 0 || cameraFeed.readyState < 2) {
    clearFaceOverlay();
    faceTrackingRafId = requestAnimationFrame(runFaceTrackingLoop);
    return;
  }

  if (faceOverlay.width !== displayWidth || faceOverlay.height !== displayHeight) {
    faceOverlay.width  = displayWidth;
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

// ---------------------------------------------------------------------------
// Server-side tracking fallback
// ---------------------------------------------------------------------------
async function pollServerFaceTracking() {
  if (!faceTrackingActive || faceTrackingMode !== "server" || !activeStream || !faceOverlay) return;
  if (serverFaceTrackingBusy || cameraFeed.readyState < 2 || !cameraFeed.videoWidth || !cameraFeed.videoHeight) return;

  const displayWidth  = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);
  if (displayWidth <= 0 || displayHeight <= 0) return;

  if (faceOverlay.width !== displayWidth || faceOverlay.height !== displayHeight) {
    faceOverlay.width  = displayWidth;
    faceOverlay.height = displayHeight;
  }

  const sampleWidth  = Math.min(480, cameraFeed.videoWidth);
  const sampleHeight = Math.round((sampleWidth / cameraFeed.videoWidth) * cameraFeed.videoHeight);
  serverTrackingCanvas.width  = sampleWidth;
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
      if (missedTrackingFrames > 3) targetTrackedBox = null;
      return;
    }

    const payload = await response.json();
    if (!payload.face_detected || !payload.face_box) {
      missedTrackingFrames += 1;
      if (missedTrackingFrames > 3) targetTrackedBox = null;
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
    if (missedTrackingFrames > 3) targetTrackedBox = null;
  } finally {
    serverFaceTrackingBusy = false;
  }
}

function startServerFaceTracking() {
  stopFaceTracking();
  faceTrackingActive = true;
  faceTrackingMode   = "server";
  resetTrackingVisualState();
  overlayRenderRafId    = requestAnimationFrame(runOverlayRenderLoop);
  void pollServerFaceTracking();
  serverFaceTrackingTimer = setInterval(() => void pollServerFaceTracking(), 160);
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
    faceTrackingMode   = "local";
    resetTrackingVisualState();
    overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
    faceTrackingRafId  = requestAnimationFrame(runFaceTrackingLoop);
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

// ---------------------------------------------------------------------------
// MediaPipe Face Mesh init & results callback
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
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });

    faceMesh.setOptions({
      maxNumFaces:            1,
      refineLandmarks:        true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence:  0.5,
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
    liveFeatureMetrics = null;
    return;
  }

  const landmarks  = results.multiFaceLandmarks[0];
  detectedLandmarks = landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z }));
  detectedFaceShape = classifyFaceShape(detectedLandmarks);
  liveFeatureMetrics = computeLandmarkFeatureMetrics(detectedLandmarks);
}

// ---------------------------------------------------------------------------
// Face-shape classification from landmarks
// ---------------------------------------------------------------------------
function classifyFaceShape(landmarks) {
  if (!landmarks || landmarks.length < 300) return "oval";

  const jawlineLeft  = landmarks[234];
  const jawlineRight = landmarks[454];
  const foreheadTop  = landmarks[10];
  const chin         = landmarks[152];
  const cheekLeft    = landmarks[205];
  const cheekRight   = landmarks[425];

  if (!jawlineLeft || !jawlineRight || !foreheadTop || !chin || !cheekLeft || !cheekRight) {
    return "oval";
  }

  const faceWidth         = Math.abs(jawlineRight.x - jawlineLeft.x);
  const faceHeight        = Math.abs(chin.y - foreheadTop.y);
  const cheekWidth        = Math.abs(cheekRight.x - cheekLeft.x);
  const heightToWidthRatio = faceHeight / faceWidth;
  const cheekToJawRatio   = cheekWidth  / faceWidth;

  if (heightToWidthRatio > 1.3) {
    if (cheekToJawRatio > 0.75) return "round";
    return "heart";
  } else if (heightToWidthRatio > 1.1) {
    if (cheekToJawRatio > 0.85) return "round";
    if (cheekToJawRatio > 0.75) return "oval";
    return "square";
  } else if (heightToWidthRatio > 0.95) {
    if (cheekToJawRatio > 0.8) return "round";
    return "oval";
  } else {
    if (cheekToJawRatio > 0.9) return "round";
    if (Math.abs(jawlineLeft.y - jawlineRight.y) < faceHeight * 0.1) return "square";
    return "diamond";
  }
}
