// ---------------------------------------------------------------------------
// filters.js — Filter overlay drawing, dynamic face-box shapes,
//              landmark coordinate mapping, and filter control state.
//
// Depends on: state.js
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Landmark coordinate helper
// ---------------------------------------------------------------------------
function getLandmarkCoordinate(landmarks, index, box, displayWidth, displayHeight) {
  if (!landmarks || index >= landmarks.length) return null;
  const landmark = landmarks[index];

  // Scale from [0, 1] to display coordinates, accounting for mirrored video
  let x = landmark.x * displayWidth;
  const y = landmark.y * displayHeight;
  x = displayWidth - x;  // horizontal flip to match live mirror

  return { x, y, z: landmark.z };
}

// ---------------------------------------------------------------------------
// Dynamic face box (shape varies by detected face shape)
// ---------------------------------------------------------------------------
function drawDynamicFaceBox(ctx, box) {
  ctx.save();
  ctx.lineWidth   = 3;
  ctx.strokeStyle = "rgba(19, 111, 99, 0.95)";
  ctx.fillStyle   = "rgba(19, 111, 99, 0.14)";

  const centerX = box.x + box.width  * 0.5;
  const centerY = box.y + box.height * 0.5;
  const w       = box.width  * 0.5;
  const h       = box.height * 0.5;

  switch (detectedFaceShape) {
    case "round":
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, w, h, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      break;

    case "oval":
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, w * 0.9, h, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
      break;

    case "square": {
      const radius = 12;
      ctx.beginPath();
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
    }

    case "heart": {
      const heartCp = box.height * 0.35;
      ctx.beginPath();
      ctx.moveTo(centerX, box.y + heartCp);
      ctx.bezierCurveTo(box.x, box.y, box.x, box.y + heartCp, centerX, box.y + heartCp + 15);
      ctx.bezierCurveTo(box.x + box.width, box.y + heartCp, box.x + box.width, box.y, centerX, box.y + heartCp);
      ctx.bezierCurveTo(centerX - 8, box.y + heartCp + 20, box.x, box.y + box.height - 20, centerX, box.y + box.height);
      ctx.bezierCurveTo(box.x + box.width, box.y + box.height - 20, centerX + 8, box.y + heartCp + 20, centerX, box.y + heartCp);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      break;
    }

    case "diamond":
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
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.fillRect(box.x, box.y, box.width, box.height);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Filter/piercing overlay (drawn on top of the face box)
// ---------------------------------------------------------------------------
function drawFilterOverlay(ctx, box) {
  if (selectedFilter === "none") return;

  // Custom overlay: draw the processed inspiration image at the chosen anchor
  if (selectedFilter === "custom-inspiration") {
    drawCustomImageOverlay(ctx, box);
    return;
  }

  const ringColor   = "#cfd6df";
  const strokeColor = "#9099a4";
  const shadowColor = "rgba(0, 0, 0, 0.18)";

  const cx           = box.x + (box.width * 0.5);
  const scale        = selectedFilterScale;
  const displayWidth  = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);

  ctx.save();
  ctx.lineCap    = "round";
  ctx.lineJoin   = "round";
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur  = 6;

  if (selectedFilter === "septum") {
    let sx = cx;
    let sy = box.y + (box.height * 0.63);

    if (detectedLandmarks) {
      const noseTip = getLandmarkCoordinate(detectedLandmarks, 1, box, displayWidth, displayHeight);
      if (noseTip) {
        sx = noseTip.x;
        sy = noseTip.y + (box.height * 0.08);
      }
    }

    const r = Math.max(6, box.width * 0.06 * scale);
    ctx.strokeStyle = ringColor;
    ctx.lineWidth   = Math.max(2, box.width * 0.012 * scale);
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

    if (detectedLandmarks) {
      const noseLeft = getLandmarkCoordinate(detectedLandmarks, 130, box, displayWidth, displayHeight);
      if (noseLeft) {
        sx = noseLeft.x - (box.width * 0.08);
        sy = noseLeft.y;
      }
    }

    const r = Math.max(2, box.width * 0.014 * scale);
    ctx.fillStyle   = ringColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth   = 1.4;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

  } else if (selectedFilter === "brow-left") {
    let sx = box.x + (box.width * 0.35);
    let sy = box.y + (box.height * 0.35);

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
    ctx.lineWidth   = Math.max(2, box.width * 0.01 * scale);
    ctx.beginPath();
    ctx.ellipse(sx, sy, rx, ry, -0.18, 0.1 * Math.PI, 1.1 * Math.PI);
    ctx.stroke();

  } else if (selectedFilter === "earring-left" || selectedFilter === "earring-right") {
    const isLeft = selectedFilter === "earring-left";
    let sx = box.x + (box.width * (isLeft ? 0.06 : 0.94));
    let sy = box.y + (box.height * 0.68);

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
    ctx.lineWidth   = Math.max(2.2, box.width * 0.012 * scale);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0.08 * Math.PI, 1.92 * Math.PI);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Custom inspiration image overlay
// ---------------------------------------------------------------------------
function getPlacementAnchor(placement, box) {
  const displayWidth  = Math.round(faceOverlay.clientWidth);
  const displayHeight = Math.round(faceOverlay.clientHeight);

  switch (placement) {
    case "septum": {
      let x = box.x + box.width * 0.5;
      let y = box.y + box.height * 0.63;
      if (detectedLandmarks) {
        const pt = getLandmarkCoordinate(detectedLandmarks, 1, box, displayWidth, displayHeight);
        if (pt) { x = pt.x; y = pt.y + box.height * 0.08; }
      }
      return { x, y };
    }
    case "nostril-left": {
      let x = box.x + box.width * 0.41;
      let y = box.y + box.height * 0.60;
      if (detectedLandmarks) {
        const pt = getLandmarkCoordinate(detectedLandmarks, 130, box, displayWidth, displayHeight);
        if (pt) { x = pt.x - box.width * 0.08; y = pt.y; }
      }
      return { x, y };
    }
    case "brow-left": {
      let x = box.x + box.width * 0.35;
      let y = box.y + box.height * 0.35;
      if (detectedLandmarks) {
        const pt = getLandmarkCoordinate(detectedLandmarks, 285, box, displayWidth, displayHeight);
        if (pt) { x = pt.x; y = pt.y - box.height * 0.05; }
      }
      return { x, y };
    }
    case "ear-left": {
      let x = box.x + box.width * 0.06;
      let y = box.y + box.height * 0.68;
      if (detectedLandmarks) {
        const pt = getLandmarkCoordinate(detectedLandmarks, 234, box, displayWidth, displayHeight);
        if (pt) { x = pt.x - box.width * 0.05; y = pt.y; }
      }
      return { x, y };
    }
    case "ear-right": {
      let x = box.x + box.width * 0.94;
      let y = box.y + box.height * 0.68;
      if (detectedLandmarks) {
        const pt = getLandmarkCoordinate(detectedLandmarks, 454, box, displayWidth, displayHeight);
        if (pt) { x = pt.x + box.width * 0.05; y = pt.y; }
      }
      return { x, y };
    }
    default:
      return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
  }
}

function drawCustomImageOverlay(ctx, box) {
  if (!customOverlayImage || !customOverlayImage.complete || customOverlayImage.naturalWidth === 0) return;
  const anchor  = getPlacementAnchor(customOverlayPlacement || "septum", box);
  const w       = box.width * 0.3 * selectedFilterScale;
  const h       = w * (customOverlayImage.naturalHeight / customOverlayImage.naturalWidth);
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.drawImage(customOverlayImage, anchor.x - w / 2, anchor.y - h / 2, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Nose alignment guide
// ---------------------------------------------------------------------------
function drawNoseAlignmentGuide(ctx, box) {
  const centerX = faceOverlay.width * 0.5;
  const centerY = faceOverlay.height * 0.5;
  const guideSize = Math.max(18, Math.min(faceOverlay.width, faceOverlay.height) * 0.08);
  const half = guideSize * 0.5;

  let noseX = box.x + (box.width * 0.5);
  let noseY = box.y + (box.height * 0.56);
  if (detectedLandmarks) {
    const noseTip = getLandmarkCoordinate(detectedLandmarks, 1, box, faceOverlay.width, faceOverlay.height);
    if (noseTip) {
      noseX = noseTip.x;
      noseY = noseTip.y;
    }
  }

  const dx = noseX - centerX;
  const dy = noseY - centerY;
  const distance = Math.hypot(dx, dy);
  noseAlignmentReady = distance <= (guideSize * 0.28);

  const centerColor = noseAlignmentReady ? "rgba(34, 138, 88, 0.95)" : "rgba(185, 42, 42, 0.95)";
  const noseColor = noseAlignmentReady ? "rgba(34, 138, 88, 0.95)" : "rgba(239, 172, 39, 0.96)";

  ctx.save();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = centerColor;
  ctx.fillStyle = "rgba(185, 42, 42, 0.14)";
  ctx.strokeRect(centerX - half, centerY - half, guideSize, guideSize);

  ctx.beginPath();
  ctx.moveTo(centerX - (half * 0.55), centerY);
  ctx.lineTo(centerX + (half * 0.55), centerY);
  ctx.moveTo(centerX, centerY - (half * 0.55));
  ctx.lineTo(centerX, centerY + (half * 0.55));
  ctx.stroke();

  ctx.strokeStyle = noseColor;
  ctx.fillStyle = noseAlignmentReady ? "rgba(34, 138, 88, 0.12)" : "rgba(239, 172, 39, 0.14)";
  ctx.strokeRect(noseX - half, noseY - half, guideSize, guideSize);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Composite overlay box (face shape + filter on top)
// ---------------------------------------------------------------------------
function drawOverlayBox(box) {
  if (!faceOverlay) return;
  const ctx = faceOverlay.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, faceOverlay.width, faceOverlay.height);
  drawNoseAlignmentGuide(ctx, box);
  drawDynamicFaceBox(ctx, box);
  drawFilterOverlay(ctx, box);
}

function drawAccessoryOnlyOverlay(ctx, box) {
  if (!ctx || !box) return;
  drawFilterOverlay(ctx, box);
}

// ---------------------------------------------------------------------------
// Sync filter state from control elements
// ---------------------------------------------------------------------------
function applyFilterControlState() {
  selectedFilter      = filterSelect ? filterSelect.value : "none";
  selectedFilterScale = filterSize ? Number.parseInt(filterSize.value, 10) / 100 : 1.0;
  if (filterSizeValue) {
    filterSizeValue.textContent = `${Math.round(selectedFilterScale * 100)}%`;
  }
}
