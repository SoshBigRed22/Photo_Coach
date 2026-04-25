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
    return;
  }

  const landmarks  = results.multiFaceLandmarks[0];
  detectedLandmarks = landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z }));
  detectedFaceShape = classifyFaceShape(detectedLandmarks);
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
