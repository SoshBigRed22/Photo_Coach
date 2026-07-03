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

function pushDebugSample(buffer, value, maxSize = 120) {
  if (!Array.isArray(buffer) || !Number.isFinite(value)) return;
  buffer.push(value);
  if (buffer.length > maxSize) buffer.splice(0, buffer.length - maxSize);
}

function debugAverage(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function debugStableAverage(values, hardCeiling = 2000) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const filtered = values.filter((value) => Number.isFinite(value) && value > 0 && value <= hardCeiling);
  if (!filtered.length) return 0;
  const p95 = debugPercentile(filtered, 95);
  const capped = filtered.filter((value) => value <= (p95 * 1.25));
  if (!capped.length) return debugAverage(filtered);
  return debugAverage(capped);
}

function debugMax(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0);
}

function debugCountAbove(values, threshold) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((count, value) => count + ((Number.isFinite(value) && value > threshold) ? 1 : 0), 0);
}

function debugPercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((percentile / 100) * (sorted.length - 1))));
  return sorted[index];
}

function formatMetric(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function getCameraTrackStats() {
  const track = activeStream?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.() || {};
  return {
    width: settings.width || 0,
    height: settings.height || 0,
    frameRate: settings.frameRate || 0,
    facingMode: settings.facingMode || "unknown",
  };
}

function ensureDebugTrackingPanel() {
  if (debugTrackingState.panel && document.body.contains(debugTrackingState.panel)) {
    return debugTrackingState.panel;
  }

  const panel = document.createElement("aside");
  panel.id = "trackingDebugPanel";
  panel.style.position = "fixed";
  panel.style.right = "12px";
  panel.style.bottom = "12px";
  panel.style.zIndex = "9999";
  panel.style.width = "320px";
  panel.style.maxWidth = "calc(100vw - 24px)";
  panel.style.background = "rgba(11, 15, 20, 0.9)";
  panel.style.color = "#d8f0ff";
  panel.style.border = "1px solid rgba(79, 172, 254, 0.35)";
  panel.style.borderRadius = "10px";
  panel.style.padding = "10px 10px 8px";
  panel.style.fontFamily = "Consolas, Menlo, Monaco, 'Courier New', monospace";
  panel.style.fontSize = "12px";
  panel.style.lineHeight = "1.35";
  panel.style.backdropFilter = "blur(6px)";
  panel.style.boxShadow = "0 10px 30px rgba(0, 0, 0, 0.35)";

  const titleRow = document.createElement("div");
  titleRow.style.display = "flex";
  titleRow.style.alignItems = "center";
  titleRow.style.justifyContent = "space-between";
  titleRow.style.marginBottom = "8px";

  const title = document.createElement("strong");
  title.textContent = "Tracking Debug";
  title.style.fontSize = "12px";
  title.style.letterSpacing = "0.3px";

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.gap = "6px";

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.textContent = "Export";
  exportBtn.style.cssText = "font: inherit; color: #d8f0ff; background: rgba(79,172,254,0.2); border: 1px solid rgba(79,172,254,0.45); border-radius: 6px; padding: 2px 6px; cursor: pointer;";
  exportBtn.addEventListener("click", () => {
    const snapshot = {
      capturedAt: new Date().toISOString(),
      faceTrackingMode,
      supportsFaceDetector,
      camera: getCameraTrackStats(),
      overlay: {
        renderFps: debugTrackingState.renderFps,
        detectFps: debugTrackingState.detectFps,
        missedFrames: debugTrackingState.missedFrames,
      },
      timingsMs: {
        detectAvg: debugAverage(debugTrackingState.detectDurationsMs),
        detectStableAvg: debugStableAverage(debugTrackingState.detectDurationsMs),
        detectMedian: debugPercentile(debugTrackingState.detectDurationsMs, 50),
        detectP95: debugPercentile(debugTrackingState.detectDurationsMs, 95),
        detectMax: debugMax(debugTrackingState.detectDurationsMs),
        detectOver500ms: debugCountAbove(debugTrackingState.detectDurationsMs, 500),
        meshAvg: debugAverage(debugTrackingState.faceMeshDurationsMs),
        detectorAvg: debugAverage(debugTrackingState.faceDetectorDurationsMs),
        drawAvg: debugAverage(debugTrackingState.drawDurationsMs),
        serverRttAvg: debugAverage(debugTrackingState.serverRttMs),
        serverRttStableAvg: debugStableAverage(debugTrackingState.serverRttMs),
        serverRttMedian: debugPercentile(debugTrackingState.serverRttMs, 50),
        serverRttP95: debugPercentile(debugTrackingState.serverRttMs, 95),
        serverRttMax: debugMax(debugTrackingState.serverRttMs),
        serverRttOver500ms: debugCountAbove(debugTrackingState.serverRttMs, 500),
      },
      samples: {
        detectDurationsMs: [...debugTrackingState.detectDurationsMs],
        faceMeshDurationsMs: [...debugTrackingState.faceMeshDurationsMs],
        faceDetectorDurationsMs: [...debugTrackingState.faceDetectorDurationsMs],
        drawDurationsMs: [...debugTrackingState.drawDurationsMs],
        serverRttMs: [...debugTrackingState.serverRttMs],
        serverPayloadBytes: [...debugTrackingState.serverPayloadBytes],
      },
    };
    const text = JSON.stringify(snapshot, null, 2);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        exportBtn.textContent = "Copied";
        setTimeout(() => {
          exportBtn.textContent = "Export";
        }, 900);
      }).catch(() => {
        console.log("[TRACKING DEBUG] Snapshot:", snapshot);
      });
      return;
    }
    console.log("[TRACKING DEBUG] Snapshot:", snapshot);
  });

  const hideBtn = document.createElement("button");
  hideBtn.type = "button";
  hideBtn.textContent = "Hide";
  hideBtn.style.cssText = "font: inherit; color: #d8f0ff; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.25); border-radius: 6px; padding: 2px 6px; cursor: pointer;";
  hideBtn.addEventListener("click", () => setDebugTrackingEnabled(false));

  controls.appendChild(exportBtn);
  controls.appendChild(hideBtn);
  titleRow.appendChild(title);
  titleRow.appendChild(controls);

  const metrics = document.createElement("pre");
  metrics.id = "trackingDebugMetrics";
  metrics.style.margin = "0";
  metrics.style.whiteSpace = "pre-wrap";
  metrics.style.wordBreak = "break-word";
  metrics.textContent = "Collecting debug metrics...";

  panel.appendChild(titleRow);
  panel.appendChild(metrics);
  document.body.appendChild(panel);
  debugTrackingState.panel = panel;
  return panel;
}

function updateDebugTrackingPanel(force = false) {
  if (!debugTrackingEnabled) return;
  const now = performance.now();
  if (!force && (now - debugTrackingState.lastPanelUpdateTick) < 250) return;
  debugTrackingState.lastPanelUpdateTick = now;

  const panel = ensureDebugTrackingPanel();
  const metricsEl = panel.querySelector("#trackingDebugMetrics");
  if (!metricsEl) return;

  const cameraStats = getCameraTrackStats();
  const detectAvg = debugAverage(debugTrackingState.detectDurationsMs);
  const detectStableAvg = debugStableAverage(debugTrackingState.detectDurationsMs);
  const detectMedian = debugPercentile(debugTrackingState.detectDurationsMs, 50);
  const detectP95 = debugPercentile(debugTrackingState.detectDurationsMs, 95);
  const detectMax = debugMax(debugTrackingState.detectDurationsMs);
  const detectOver500 = debugCountAbove(debugTrackingState.detectDurationsMs, 500);
  const meshAvg = debugAverage(debugTrackingState.faceMeshDurationsMs);
  const detectorAvg = debugAverage(debugTrackingState.faceDetectorDurationsMs);
  const drawAvg = debugAverage(debugTrackingState.drawDurationsMs);
  const serverRttAvg = debugAverage(debugTrackingState.serverRttMs);
  const serverRttStableAvg = debugStableAverage(debugTrackingState.serverRttMs);
  const serverRttMedian = debugPercentile(debugTrackingState.serverRttMs, 50);
  const serverRttP95 = debugPercentile(debugTrackingState.serverRttMs, 95);
  const serverRttMax = debugMax(debugTrackingState.serverRttMs);
  const serverRttOver500 = debugCountAbove(debugTrackingState.serverRttMs, 500);
  const payloadAvg = debugAverage(debugTrackingState.serverPayloadBytes);

  metricsEl.textContent = [
    `enabled: ${debugTrackingEnabled ? "yes" : "no"} | mode: ${faceTrackingMode}`,
    `render fps: ${formatMetric(debugTrackingState.renderFps)} | detect fps: ${formatMetric(debugTrackingState.detectFps)}`,
    `detect ms median/p95/max: ${formatMetric(detectMedian)} / ${formatMetric(detectP95)} / ${formatMetric(detectMax)}`,
    `detect ms avg/stable: ${formatMetric(detectAvg)} / ${formatMetric(detectStableAvg)} | >500ms: ${detectOver500}`,
    `mesh ms avg: ${formatMetric(meshAvg)} | detector ms avg: ${formatMetric(detectorAvg)}`,
    `draw ms avg: ${formatMetric(drawAvg)} | missed frames: ${debugTrackingState.missedFrames}`,
    `server rtt ms median/p95/max: ${formatMetric(serverRttMedian)} / ${formatMetric(serverRttP95)} / ${formatMetric(serverRttMax)}`,
    `server rtt ms avg/stable: ${formatMetric(serverRttAvg)} / ${formatMetric(serverRttStableAvg)} | >500ms: ${serverRttOver500}`,
    `server payload bytes avg: ${formatMetric(payloadAvg, 0)}`,
    `camera: ${cameraStats.width || "?"}x${cameraStats.height || "?"} @ ${formatMetric(cameraStats.frameRate)} fps (${cameraStats.facingMode})`,
  ].join("\n");
}

function recordDebugRenderTick() {
  if (!debugTrackingEnabled) return;
  const now = performance.now();
  if (!debugTrackingState.lastRenderTick) {
    debugTrackingState.lastRenderTick = now;
    return;
  }
  debugTrackingState.renderFrames += 1;
  const elapsed = now - debugTrackingState.lastRenderTick;
  if (elapsed >= 1000) {
    debugTrackingState.renderFps = (debugTrackingState.renderFrames * 1000) / elapsed;
    debugTrackingState.renderFrames = 0;
    debugTrackingState.lastRenderTick = now;
  }
}

function recordDebugDetectTick(totalMs, meshMs, detectorMs) {
  if (!debugTrackingEnabled) return;
  const now = performance.now();
  if (!debugTrackingState.lastDetectTick) {
    debugTrackingState.lastDetectTick = now;
  }
  debugTrackingState.detectFrames += 1;
  const elapsed = now - debugTrackingState.lastDetectTick;
  if (elapsed >= 1000) {
    debugTrackingState.detectFps = (debugTrackingState.detectFrames * 1000) / elapsed;
    debugTrackingState.detectFrames = 0;
    debugTrackingState.lastDetectTick = now;
  }
  pushDebugSample(debugTrackingState.detectDurationsMs, totalMs);
  if (Number.isFinite(meshMs) && meshMs > 0) pushDebugSample(debugTrackingState.faceMeshDurationsMs, meshMs);
  if (Number.isFinite(detectorMs) && detectorMs > 0) pushDebugSample(debugTrackingState.faceDetectorDurationsMs, detectorMs);
}

function setDebugTrackingEnabled(enabled) {
  debugTrackingEnabled = Boolean(enabled);
  if (debugTrackingEnabled) {
    ensureDebugTrackingPanel().style.display = "block";
    updateDebugTrackingPanel(true);
    return;
  }
  if (debugTrackingState.panel) {
    debugTrackingState.panel.style.display = "none";
  }
}

function toggleDebugTracking() {
  setDebugTrackingEnabled(!debugTrackingEnabled);
}

function resetTrackingVisualState() {
  targetTrackedBox    = null;
  renderedTrackedBox  = null;
  missedTrackingFrames = 0;
  noseAlignmentReady  = false;
  debugTrackingState.missedFrames = 0;
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
    clearTimeout(serverFaceTrackingTimer);
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

function getServerTrackingProfile() {
  const isCompactViewport = window.matchMedia && window.matchMedia("(max-width: 860px)").matches;
  let maxSampleWidth = isCompactViewport ? 320 : 420;
  let jpegQuality = isCompactViewport ? 0.5 : 0.58;

  if (serverTrackingLastRttMs > 360) {
    maxSampleWidth = Math.min(maxSampleWidth, 260);
    jpegQuality = Math.min(jpegQuality, 0.42);
  } else if (serverTrackingLastRttMs > 300) {
    maxSampleWidth = Math.min(maxSampleWidth, 300);
    jpegQuality = Math.min(jpegQuality, 0.48);
  }

  return {
    maxSampleWidth,
    jpegQuality,
  };
}

function computeNextServerTrackingInterval(lastRttMs) {
  // Keep one active request at a time.
  // This value is the post-response pause, not total cycle time.
  // Small pauses improve responsiveness while avoiding request storms.
  const rtt = Number.isFinite(lastRttMs) ? lastRttMs : 240;
  if (rtt >= 420) return 40;
  if (rtt >= 320) return 28;
  if (rtt >= 240) return 20;
  if (rtt >= 170) return 14;
  return 10;
}

function scheduleNextServerFaceTrackingPoll(delayMs = 0) {
  if (!faceTrackingActive || faceTrackingMode !== "server") return;
  if (serverFaceTrackingTimer !== null) {
    clearTimeout(serverFaceTrackingTimer);
    serverFaceTrackingTimer = null;
  }

  const clampedDelay = Math.max(0, Math.min(500, Math.round(delayMs)));
  serverFaceTrackingTimer = setTimeout(async () => {
    serverFaceTrackingTimer = null;
    await pollServerFaceTracking();
    if (!faceTrackingActive || faceTrackingMode !== "server") return;
    scheduleNextServerFaceTrackingPoll(serverTrackingIntervalMs);
  }, clampedDelay);
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

function deriveFaceBoxFromLandmarks(landmarks, displayWidth, displayHeight) {
  if (!landmarks || landmarks.length < 10 || !Number.isFinite(displayWidth) || !Number.isFinite(displayHeight)) {
    return null;
  }

  const faceContourIndices = [
    10, 338, 297, 332, 284, 251, 389, 356,
    454, 323, 361, 288, 397, 365, 379, 378,
    400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21,
    54, 103, 67, 109,
  ];

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const index of faceContourIndices) {
    const landmark = landmarks[index];
    if (!landmark) continue;
    const x = displayWidth - (landmark.x * displayWidth);
    const y = landmark.y * displayHeight;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const padX = Math.max(8, width * 0.08);
  const padTop = Math.max(10, height * 0.08);
  const padBottom = Math.max(10, height * 0.06);

  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padTop);
  const right = Math.min(displayWidth, maxX + padX);
  const bottom = Math.min(displayHeight, maxY + padBottom);

  const boxWidth = Math.max(1, right - x);
  const boxHeight = Math.max(1, bottom - y);
  const aspect = boxWidth / boxHeight;

  // Auto-calibrate width so the oval better follows cheeks across front and angled poses.
  const targetAspect = 0.76;
  const baseScale = aspect < targetAspect ? (targetAspect / Math.max(0.01, aspect)) : 1;

  const jawLeft = landmarks[234];
  const jawRight = landmarks[454];
  const noseTip = landmarks[1];
  let yawNorm = 0;
  if (jawLeft && jawRight && noseTip) {
    const faceWidthNorm = Math.max(0.0001, Math.abs(jawRight.x - jawLeft.x));
    const centerNorm = (jawLeft.x + jawRight.x) * 0.5;
    yawNorm = Math.abs(noseTip.x - centerNorm) / faceWidthNorm;
  }
  const yawBoost = 1 + Math.min(0.38, yawNorm * 1.2);
  const horizontalCalibration = Math.min(1.7, Math.max(1.08, baseScale * yawBoost));

  const centerX = (x + right) * 0.5;
  const halfWidth = (right - x) * 0.5;
  const calibratedHalfWidth = halfWidth * horizontalCalibration;

  let calibratedLeft = Math.max(0, centerX - calibratedHalfWidth);
  let calibratedRight = Math.min(displayWidth, centerX + calibratedHalfWidth);

  if (jawLeft && jawRight) {
    const jawLeftX = displayWidth - (jawLeft.x * displayWidth);
    const jawRightX = displayWidth - (jawRight.x * displayWidth);
    const jawSpan = Math.abs(jawRightX - jawLeftX);
    const jawCenterX = (jawLeftX + jawRightX) * 0.5;
    const currentWidth = Math.max(1, calibratedRight - calibratedLeft);
    const minWidthFromJaw = jawSpan * 1.18;
    const minWidthFromAspect = boxHeight * 0.76;
    const targetWidth = Math.max(currentWidth, minWidthFromJaw, minWidthFromAspect);
    const halfTarget = targetWidth * 0.5;

    calibratedLeft = Math.max(0, jawCenterX - halfTarget);
    calibratedRight = Math.min(displayWidth, jawCenterX + halfTarget);
  }

  return {
    x: calibratedLeft,
    y,
    width: Math.max(1, calibratedRight - calibratedLeft),
    height: Math.max(1, bottom - y),
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
  debugTrackingState.missedFrames = 0;
}

// ---------------------------------------------------------------------------
// Render loop (smooth interpolation → drawOverlayBox in filters.js)
// ---------------------------------------------------------------------------
function runOverlayRenderLoop() {
  if (!faceTrackingActive || !faceOverlay) {
    if (!faceTrackingActive && overlayRenderRafId) {
      console.warn("[TRACKING] Render loop stopped: faceTrackingActive=", faceTrackingActive);
    }
    overlayRenderRafId = null;
    return;
  }

  const displayWidth  = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);
  recordDebugRenderTick();

  if (displayWidth <= 0 || displayHeight <= 0) {
    console.warn("[TRACKING] Invalid canvas size:", displayWidth, displayHeight);
    overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
    return;
  }

  if (faceOverlay.width !== displayWidth || faceOverlay.height !== displayHeight) {
    faceOverlay.width  = displayWidth;
    faceOverlay.height = displayHeight;
  }

  if (!targetTrackedBox) {
    if (missedTrackingFrames > 3) {
      console.log("[TRACKING] Clearing face - no face detected");
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

  const drawStart = debugTrackingEnabled ? performance.now() : 0;
  drawOverlayBox(renderedTrackedBox);
  if (debugTrackingEnabled) {
    pushDebugSample(debugTrackingState.drawDurationsMs, performance.now() - drawStart);
    updateDebugTrackingPanel();
  }
  overlayRenderRafId = requestAnimationFrame(runOverlayRenderLoop);
}

// ---------------------------------------------------------------------------
// Local FaceDetector tracking loop
// ---------------------------------------------------------------------------
async function runFaceTrackingLoop() {
  if (!faceTrackingActive || !activeStream || !faceOverlay) {
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

  const loopStart = debugTrackingEnabled ? performance.now() : 0;
  let meshMs = 0;
  let detectorMs = 0;
  let landmarkBoxUsed = false;

  try {
    // Process frame through MediaPipe Face Mesh for landmarks
    if (faceMesh && !faceMeshInitializing) {
      try {
        const meshStart = debugTrackingEnabled ? performance.now() : 0;
        await faceMesh.send({ image: cameraFeed });
        if (debugTrackingEnabled) meshMs = performance.now() - meshStart;
      } catch {
        // FaceMesh processing may fail intermittently; continue anyway
      }
    }

    let box = null;

    if (faceDetector) {
      const detectorStart = debugTrackingEnabled ? performance.now() : 0;
      const faces = await faceDetector.detect(cameraFeed);
      if (debugTrackingEnabled) detectorMs = performance.now() - detectorStart;
      if (faces.length && faces[0].boundingBox && cameraFeed.videoWidth && cameraFeed.videoHeight) {
        box = mapBoundingBoxToDisplay(
          faces[0].boundingBox,
          cameraFeed.videoWidth,
          cameraFeed.videoHeight,
          displayWidth,
          displayHeight,
          true
        );
      }
    }

    if (!box && detectedLandmarks) {
      box = deriveFaceBoxFromLandmarks(detectedLandmarks, displayWidth, displayHeight);
      landmarkBoxUsed = Boolean(box);
    }

    if (box) {
      drawFaceBox(box);
    } else {
      missedTrackingFrames += 1;
      debugTrackingState.missedFrames = missedTrackingFrames;
      if (missedTrackingFrames > 3) {
        targetTrackedBox = null;
      }
    }
  } catch {
    // Some browsers intermittently throw during track state transitions.
    missedTrackingFrames += 1;
    debugTrackingState.missedFrames = missedTrackingFrames;
    if (missedTrackingFrames > 3) {
      targetTrackedBox = null;
    }
  }

  if (debugTrackingEnabled) {
    recordDebugDetectTick(performance.now() - loopStart, meshMs, detectorMs);
    updateDebugTrackingPanel();
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

  const profile = getServerTrackingProfile();
  const sampleWidth  = Math.min(profile.maxSampleWidth, cameraFeed.videoWidth);
  const sampleHeight = Math.round((sampleWidth / cameraFeed.videoWidth) * cameraFeed.videoHeight);
  serverTrackingCanvas.width  = sampleWidth;
  serverTrackingCanvas.height = sampleHeight;

  const ctx = serverTrackingCanvas.getContext("2d");
  if (!ctx) return;
  ctx.drawImage(cameraFeed, 0, 0, sampleWidth, sampleHeight);

  const blob = await new Promise((resolve) => {
    serverTrackingCanvas.toBlob(resolve, "image/jpeg", profile.jpegQuality);
  });
  if (!blob) return;

  const formData = new FormData();
  formData.append("photo", blob, "frame.jpg");

  serverFaceTrackingBusy = true;
  const requestStart = debugTrackingEnabled ? performance.now() : 0;
  try {
    const response = await fetch(`${API_BASE}/api/track-face`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      missedTrackingFrames += 1;
      debugTrackingState.missedFrames = missedTrackingFrames;
      if (missedTrackingFrames > 3) targetTrackedBox = null;
      return;
    }

    const payload = await response.json();
    if (!payload.face_detected || !payload.face_box) {
      missedTrackingFrames += 1;
      debugTrackingState.missedFrames = missedTrackingFrames;
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
    debugTrackingState.missedFrames = missedTrackingFrames;
    if (missedTrackingFrames > 3) targetTrackedBox = null;
  } finally {
    if (debugTrackingEnabled) {
      const requestDurationMs = performance.now() - requestStart;
      serverTrackingLastRttMs = requestDurationMs;
      serverTrackingIntervalMs = computeNextServerTrackingInterval(requestDurationMs);
      pushDebugSample(debugTrackingState.serverRttMs, requestDurationMs);
      // In server mode, request round-trip time is the effective detection latency.
      recordDebugDetectTick(requestDurationMs, 0, 0);
      pushDebugSample(debugTrackingState.serverPayloadBytes, blob.size || 0);
      updateDebugTrackingPanel();
    } else {
      const requestDurationMs = performance.now() - requestStart;
      serverTrackingLastRttMs = requestDurationMs;
      serverTrackingIntervalMs = computeNextServerTrackingInterval(requestDurationMs);
    }
    serverFaceTrackingBusy = false;
  }
}

function startServerFaceTracking() {
  stopFaceTracking();
  faceTrackingActive = true;
  faceTrackingMode   = "server";
  serverTrackingIntervalMs = 160;
  resetTrackingVisualState();
  overlayRenderRafId    = requestAnimationFrame(runOverlayRenderLoop);
  scheduleNextServerFaceTrackingPoll(0);
}

function startFaceTracking() {
  console.log("[TRACKING] startFaceTracking called, faceOverlay exists?", !!faceOverlay);
  if (!faceOverlay) {
    console.warn("[TRACKING] No faceOverlay - cannot start");
    clearFaceOverlay();
    return;
  }

  // Initialize MediaPipe Face Mesh for landmark detection
  void initializeFaceMesh();

  const canUseLocalTracking = supportsFaceDetector || typeof window.FaceMesh !== "undefined" || faceMesh || faceMeshInitializing;
  if (canUseLocalTracking) {
    console.log("[TRACKING] Using local tracking (FaceDetector or FaceMesh)");
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

  console.warn("[PhotoCoach] FaceDetector/FaceMesh unavailable. Using backend face tracking fallback.");
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
