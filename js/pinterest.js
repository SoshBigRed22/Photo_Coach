// ---------------------------------------------------------------------------
// pinterest.js — Inspiration entries (local), Pinterest OAuth flow,
//                board/pin loader, and inspiration-preference inference.
//
// Depends on: state.js, analysis.js (filterLabel, buildPhotoContext)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// URL normalizer
// ---------------------------------------------------------------------------
function normalizePinterestUrl(rawUrl) {
  try {
    const url      = new URL(rawUrl.trim());
    const hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (!hostname.includes("pinterest.")) return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Style-token extraction from URL + note text
// ---------------------------------------------------------------------------
function parseStyleTokens(text) {
  if (!text) return [];
  const lower  = text.toLowerCase();
  const tokens = new Set();

  for (const [filterKey, keywords] of Object.entries(PINTEREST_TAG_MAP)) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      tokens.add(filterKey);
    }
  }

  return [...tokens];
}

// ---------------------------------------------------------------------------
// Placement inference from style tokens
// ---------------------------------------------------------------------------
const TOKEN_TO_PLACEMENT = {
  "septum":           "septum",
  "nose-stud-left":   "nostril-left",
  "brow-left":        "brow-left",
  "earring-left":     "ear-left",
  "earring-right":    "ear-right",
};

function inferPlacement(styleTokens) {
  for (const token of (styleTokens || [])) {
    if (TOKEN_TO_PLACEMENT[token]) return TOKEN_TO_PLACEMENT[token];
  }
  return "septum"; // default
}

// ---------------------------------------------------------------------------
// Inspiration-entry CRUD
// ---------------------------------------------------------------------------
function addInspirationEntry(rawUrl, note = "") {
  const normalizedUrl = normalizePinterestUrl(rawUrl);
  if (!normalizedUrl) throw new Error("Please paste a valid Pinterest link.");

  if (inspirationEntries.some((entry) => entry.url === normalizedUrl)) {
    throw new Error("That Pinterest link is already in your inspiration list.");
  }

  const combined    = `${normalizedUrl} ${note}`;
  const styleTokens = parseStyleTokens(combined);
  const entry       = {
    id:               `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceType:       "pin-url",
    url:              normalizedUrl,
    note:             note.trim(),
    styleTokens,
    addedAt:          Date.now(),
    placement:        inferPlacement(styleTokens),
    processedImage:   null,
    processingStatus: "loading",
    processingError:  null,
  };

  inspirationEntries = [entry, ...inspirationEntries].slice(0, 12);
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext?.source || "empty");

  // Kick off background-removal fetch (fire-and-forget; errors stored in entry)
  processPinImage(entry.id, normalizedUrl);
}

async function addInspirationImageEntry(file, note = "") {
  if (!file || !file.type || !file.type.startsWith("image/")) {
    throw new Error("Please choose a valid image file.");
  }

  const safeName = String(file.name || "uploaded-image").trim();
  const combined = `${safeName} ${note}`;
  const styleTokens = parseStyleTokens(combined);
  const entry = {
    id:               `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceType:       "upload",
    url:              `upload://${safeName}`,
    note:             note.trim() || safeName,
    styleTokens,
    addedAt:          Date.now(),
    placement:        inferPlacement(styleTokens),
    processedImage:   null,
    processingStatus: "loading",
    processingError:  null,
  };

  inspirationEntries = [entry, ...inspirationEntries].slice(0, 12);
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext?.source || "empty");

  if (overlayUploadStatus) {
    overlayUploadStatus.textContent = "Processing uploaded image...";
  }
  await processUploadedImage(entry.id, file);

  const readyEntry = inspirationEntries.find((e) => e && e.id === entry.id && e.processedImage);
  if (readyEntry) {
    applyInspirationOverlay(readyEntry);
  }
}

function removeInspirationEntry(id) {
  inspirationEntries = inspirationEntries.filter((entry) => entry.id !== id);
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext?.source || "empty");
}

function clearInspirationEntries() {
  inspirationEntries = [];
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext?.source || "empty");
}

// ---------------------------------------------------------------------------
// Async image fetch + background removal
// ---------------------------------------------------------------------------
async function processPinImage(entryId, url) {
  try {
    const resp = await fetch(`${API_BASE}/api/fetch-pin-image`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);

    const idx = inspirationEntries.findIndex((e) => e.id === entryId);
    if (idx !== -1) {
      inspirationEntries[idx].processedImage   = data.image;
      inspirationEntries[idx].processingStatus = "done";
      inspirationEntries[idx].processingError  = null;
    }
  } catch (err) {
    const idx = inspirationEntries.findIndex((e) => e.id === entryId);
    if (idx !== -1) {
      inspirationEntries[idx].processingStatus = "failed";
      inspirationEntries[idx].processingError  = err.message || "Processing failed.";
    }
  } finally {
    persistInspirationEntries();
    renderInspirationEntries();
  }
}

async function processUploadedImage(entryId, file) {
  try {
    const formData = new FormData();
    formData.append("image", file, file.name || "overlay-image.png");

    const resp = await fetch(`${API_BASE}/api/process-overlay-upload`, {
      method: "POST",
      body: formData,
    });
    const raw = await resp.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: raw || `HTTP ${resp.status}` };
    }
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);

    const idx = inspirationEntries.findIndex((e) => e && e.id === entryId);
    if (idx !== -1) {
      inspirationEntries[idx].processedImage = data.image;
      inspirationEntries[idx].processingStatus = "done";
      inspirationEntries[idx].processingError = null;
    }
    if (overlayUploadStatus) {
      overlayUploadStatus.textContent = "Uploaded image is ready. Click Apply Overlay on the entry.";
    }
  } catch (err) {
    // Fallback: if backend processing fails, build a transparent overlay client-side.
    try {
      const fallbackImage = await createOverlayDataUrlFromFile(file);
      const idx = inspirationEntries.findIndex((e) => e && e.id === entryId);
      if (idx !== -1) {
        inspirationEntries[idx].processedImage = fallbackImage;
        inspirationEntries[idx].processingStatus = "done";
        inspirationEntries[idx].processingError = null;
      }
      if (overlayUploadStatus) {
        overlayUploadStatus.textContent = "Server processing failed; local fallback succeeded. Click Apply Overlay on the entry.";
      }
    } catch (fallbackErr) {
      // Final fallback: keep the original uploaded image as an overlay source.
      try {
        const rawImage = await readFileAsDataUrl(file);
        const idx = inspirationEntries.findIndex((e) => e && e.id === entryId);
        if (idx !== -1) {
          inspirationEntries[idx].processedImage = rawImage;
          inspirationEntries[idx].processingStatus = "done";
          inspirationEntries[idx].processingError = null;
        }
        if (overlayUploadStatus) {
          overlayUploadStatus.textContent = "Server cleanup failed; using original uploaded image as overlay.";
        }
      } catch (rawErr) {
        const idx = inspirationEntries.findIndex((e) => e && e.id === entryId);
        if (idx !== -1) {
          inspirationEntries[idx].processingStatus = "failed";
          inspirationEntries[idx].processingError = err.message || "Processing failed.";
        }
        if (overlayUploadStatus) {
          overlayUploadStatus.textContent = `Upload processing failed: ${err.message || "unknown error"}`;
        }
        console.error("[Inspiration] Local fallback failed:", fallbackErr);
        console.error("[Inspiration] Raw-image fallback failed:", rawErr);
      }
    }
  } finally {
    persistInspirationEntries();
    renderInspirationEntries();
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read uploaded file."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load overlay image."));
    img.src = src;
  });
}

function isLikelySkinPixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (
    r > 95 &&
    g > 40 &&
    b > 20 &&
    (max - min) > 15 &&
    Math.abs(r - g) > 15 &&
    r > g &&
    r > b
  );
}

function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === rn) {
      h = 60 * (((gn - bn) / delta) % 6);
    } else if (max === gn) {
      h = 60 * (((bn - rn) / delta) + 2);
    } else {
      h = 60 * (((rn - gn) / delta) + 4);
    }
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : (delta / max);
  const v = max;
  return { h, s, v };
}

function buildSeptumForegroundMask(data, width, height) {
  const total = width * height;
  const candidates = new Uint8Array(total);

  const focusLeft = Math.floor(width * 0.18);
  const focusRight = Math.ceil(width * 0.82);
  const focusTop = Math.floor(height * 0.14);
  const focusBottom = Math.ceil(height * 0.66);
  const centerX = width * 0.5;
  const centerY = height * 0.42;

  for (let y = focusTop; y < focusBottom; y += 1) {
    for (let x = focusLeft; x < focusRight; x += 1) {
      const pi = (y * width) + x;
      const di = pi * 4;
      const alpha = data[di + 3];
      if (alpha < 20) continue;

      const r = data[di];
      const g = data[di + 1];
      const b = data[di + 2];
      const { h, s, v } = rgbToHsv(r, g, b);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const brightness = (r + g + b) / 3;
      const chroma = max - min;
      const isSkin = isLikelySkinPixel(r, g, b);

      const isRedFamily = ((h <= 20 || h >= 340) && s > 0.18 && v > 0.12);
      const isSilverLike = s < 0.22 && v > 0.20;
      const isGoldLike = h >= 24 && h <= 62 && s >= 0.15 && v > 0.18;
      const isRoseGoldLike = h >= 8 && h <= 28 && s >= 0.14 && s <= 0.75 && v > 0.20;
      const isBlackMetalLike = v < 0.24 && s < 0.38;
      const isMetalPalette = isSilverLike || isGoldLike || isRoseGoldLike || isBlackMetalLike;

      const likelyMetal = brightness > 42 && brightness < 225 && chroma < 58;
      const likelyShadowJewelry = brightness < 90 && chroma < 75;
      if (!isSkin && !isRedFamily && (isMetalPalette || likelyMetal || likelyShadowJewelry)) {
        candidates[pi] = 1;
      }
    }
  }

  let bestPixels = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const stack = [];

  for (let idx = 0; idx < total; idx += 1) {
    if (!candidates[idx]) continue;

    candidates[idx] = 0;
    stack.push(idx);

    let size = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    const pixels = [];

    while (stack.length) {
      const cur = stack.pop();
      pixels.push(cur);
      size += 1;

      const y = Math.floor(cur / width);
      const x = cur - (y * width);
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      const left = x > 0 ? cur - 1 : -1;
      const right = x < width - 1 ? cur + 1 : -1;
      const up = y > 0 ? cur - width : -1;
      const down = y < height - 1 ? cur + width : -1;

      if (left !== -1 && candidates[left]) { candidates[left] = 0; stack.push(left); }
      if (right !== -1 && candidates[right]) { candidates[right] = 0; stack.push(right); }
      if (up !== -1 && candidates[up]) { candidates[up] = 0; stack.push(up); }
      if (down !== -1 && candidates[down]) { candidates[down] = 0; stack.push(down); }
    }

    if (size < 12) continue;

    const cx = sumX / size;
    const cy = sumY / size;
    const dist = Math.hypot(cx - centerX, cy - centerY);
    const spanX = maxX - minX + 1;
    const spanY = maxY - minY + 1;
    const aspect = spanX / Math.max(1, spanY);
    const compactPenalty = Math.max(0, (spanX * spanY) - (size * 8));
    const verticalPenalty = spanY > (spanX * 1.55) ? (spanY - (spanX * 1.55)) * 2.5 : 0;
    const aspectBonus = Math.max(0, Math.min(3.0, aspect) - 0.8) * 12;
    const score = (size * 4.2) + aspectBonus - (dist * 5.5) - (compactPenalty * 0.03) - verticalPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestPixels = pixels;
    }
  }

  if (!bestPixels || !bestPixels.length) return null;

  const keep = new Uint8Array(total);
  for (const px of bestPixels) keep[px] = 1;

  // Dilate by 1px so thin jewelry details survive alpha cut.
  const dilated = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (!keep[i]) continue;
    dilated[i] = 1;
    const y = Math.floor(i / width);
    const x = i - (y * width);
    if (x > 0) dilated[i - 1] = 1;
    if (x < width - 1) dilated[i + 1] = 1;
    if (y > 0) dilated[i - width] = 1;
    if (y < height - 1) dilated[i + width] = 1;
  }

  return dilated;
}

async function normalizeOverlayDataUrl(src, placement = "septum") {
  const img = await loadImageElement(src);
  const maxDim = 600;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not initialize overlay canvas.");

  ctx.drawImage(img, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const brightness = (r + g + b) / 3;
    const maxChannelDelta = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));

    if (alpha > 0 && brightness >= 240 && maxChannelDelta <= 20) {
      data[i + 3] = 0;
    }
  }

  if (placement === "septum") {
    const keepMask = buildSeptumForegroundMask(data, width, height);
    if (keepMask) {
      for (let i = 0; i < keepMask.length; i += 1) {
        if (!keepMask[i]) data[(i * 4) + 3] = 0;
      }
    }
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = ((y * width) + x) * 4;
      if (data[idx + 3] > 24) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);

  if (maxX < minX || maxY < minY) {
    return canvas.toDataURL("image/png");
  }

  const padX = Math.max(2, Math.round((maxX - minX + 1) * 0.12));
  const padY = Math.max(2, Math.round((maxY - minY + 1) * 0.12));
  const cropX = Math.max(0, minX - padX);
  const cropY = Math.max(0, minY - padY);
  const cropW = Math.min(width - cropX, (maxX - minX + 1) + (padX * 2));
  const cropH = Math.min(height - cropY, (maxY - minY + 1) + (padY * 2));

  const trimmedCanvas = document.createElement("canvas");
  trimmedCanvas.width = cropW;
  trimmedCanvas.height = cropH;
  const trimmedCtx = trimmedCanvas.getContext("2d");
  if (!trimmedCtx) throw new Error("Could not initialize trimmed overlay canvas.");

  trimmedCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return trimmedCanvas.toDataURL("image/png");
}

function createOverlayDataUrlFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the uploaded file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode uploaded image."));
      img.onload = () => {
        const maxDim = 600;
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const width = Math.max(1, Math.round(img.naturalWidth * scale));
        const height = Math.max(1, Math.round(img.naturalHeight * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          reject(new Error("Could not initialize image canvas."));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        // Simple white-screen removal fallback for product shots on bright backgrounds.
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const brightness = (r + g + b) / 3;
          const maxChannelDelta = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));

          if (brightness >= 240 && maxChannelDelta <= 20) {
            data[i + 3] = 0;
          }
        }

        ctx.putImageData(imageData, 0, 0);
        normalizeOverlayDataUrl(canvas.toDataURL("image/png"), "septum").then(resolve).catch(reject);
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Crop Modal — lets the user drag-select just the jewelry from an uploaded image
// ---------------------------------------------------------------------------
let _cropPendingFile = null;
let _cropPendingNote = null;
let _cropOriginalImage = null;
let _cropSel = null;
let _cropDragging = false;
let _cropStart = null;

function openCropModal(file, note) {
  _cropPendingFile = file;
  _cropPendingNote = note || "";
  _cropSel = null;
  _cropDragging = false;
  _cropStart = null;

  const modal = document.getElementById("cropModal");
  const canvas = document.getElementById("cropCanvas");
  if (!modal || !canvas) {
    addInspirationImageEntry(file, note || "");
    return;
  }

  const img = new Image();
  img.onload = () => {
    _cropOriginalImage = img;
    const maxW = Math.min(500, window.innerWidth - 80);
    const scale = Math.min(1, maxW / img.naturalWidth);
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    _drawCropCanvas();
    _initCropEvents();
    modal.hidden = false;
    modal.focus();
  };
  img.onerror = () => {
    addInspirationImageEntry(file, note || "");
  };

  const reader = new FileReader();
  reader.onload = (e) => { img.src = String(e.target.result || ""); };
  reader.readAsDataURL(file);
}

function _drawCropCanvas() {
  const canvas = document.getElementById("cropCanvas");
  if (!canvas || !_cropOriginalImage) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(_cropOriginalImage, 0, 0, canvas.width, canvas.height);

  if (_cropSel && _cropSel.w > 2 && _cropSel.h > 2) {
    const { x, y, w, h } = _cropSel;
    // Dim areas outside selection
    ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
    ctx.fillRect(0, 0, canvas.width, y);
    ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, canvas.width - x - w, h);
    // Dashed white border
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
    // Corner handles
    const hs = 8;
    ctx.fillStyle = "#ffffff";
    [[x, y], [x + w - hs, y], [x, y + h - hs], [x + w - hs, y + h - hs]].forEach(([cx, cy]) => {
      ctx.fillRect(cx, cy, hs, hs);
    });
  }
}

function _getCanvasPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const src = e.touches ? e.touches[0] : e;
  return {
    x: Math.max(0, Math.min(canvas.width, (src.clientX - rect.left) * sx)),
    y: Math.max(0, Math.min(canvas.height, (src.clientY - rect.top) * sy)),
  };
}

function _initCropEvents() {
  const canvas = document.getElementById("cropCanvas");
  if (!canvas || canvas._cropEventsAttached) return;
  canvas._cropEventsAttached = true;

  function onStart(e) {
    e.preventDefault();
    _cropDragging = true;
    _cropStart = _getCanvasPos(e, canvas);
    _cropSel = { x: _cropStart.x, y: _cropStart.y, w: 0, h: 0 };
  }

  function onMove(e) {
    if (!_cropDragging) return;
    e.preventDefault();
    const pos = _getCanvasPos(e, canvas);
    _cropSel = {
      x: Math.min(_cropStart.x, pos.x),
      y: Math.min(_cropStart.y, pos.y),
      w: Math.abs(pos.x - _cropStart.x),
      h: Math.abs(pos.y - _cropStart.y),
    };
    _drawCropCanvas();
  }

  function onEnd() {
    _cropDragging = false;
    _drawCropCanvas();
  }

  canvas.addEventListener("mousedown",  onStart);
  canvas.addEventListener("mousemove",  onMove);
  canvas.addEventListener("mouseup",    onEnd);
  canvas.addEventListener("mouseleave", onEnd);
  canvas.addEventListener("touchstart", onStart, { passive: false });
  canvas.addEventListener("touchmove",  onMove,  { passive: false });
  canvas.addEventListener("touchend",   onEnd);
}

function confirmCrop() {
  if (!_cropSel || _cropSel.w < 8 || _cropSel.h < 8) {
    alert("Please drag to select the jewelry area first.");
    return;
  }

  const canvas = document.getElementById("cropCanvas");
  if (!_cropOriginalImage || !canvas) {
    closeCropModal();
    if (_cropPendingFile) addInspirationImageEntry(_cropPendingFile, _cropPendingNote || "");
    return;
  }

  // Map display coords → original image coords
  const scaleX = _cropOriginalImage.naturalWidth  / canvas.width;
  const scaleY = _cropOriginalImage.naturalHeight / canvas.height;
  const srcX = Math.round(_cropSel.x * scaleX);
  const srcY = Math.round(_cropSel.y * scaleY);
  const srcW = Math.max(1, Math.round(_cropSel.w * scaleX));
  const srcH = Math.max(1, Math.round(_cropSel.h * scaleY));

  // Draw cropped region into a temp canvas
  const tmp = document.createElement("canvas");
  tmp.width  = srcW;
  tmp.height = srcH;
  const tmpCtx = tmp.getContext("2d");
  tmpCtx.drawImage(_cropOriginalImage, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

  // Remove near-white background (helps if the crop includes a white background around the jewelry)
  const imgData = tmpCtx.getImageData(0, 0, srcW, srcH);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const brightness = (d[i] + d[i + 1] + d[i + 2]) / 3;
    const maxDelta = Math.max(Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2]), Math.abs(d[i] - d[i + 2]));
    if (brightness >= 230 && maxDelta <= 25) d[i + 3] = 0;
  }
  tmpCtx.putImageData(imgData, 0, 0);

  const croppedDataUrl = tmp.toDataURL("image/png");

  const file = _cropPendingFile;
  const note = _cropPendingNote || "";
  closeCropModal();
  _cropPendingFile = null;
  _cropPendingNote = null;

  // Build the entry with the cropped image directly — no server, no heuristics
  const safeName    = String(file.name || "cropped-image").trim();
  const styleTokens = parseStyleTokens(`${safeName} ${note}`);
  const entry = {
    id:               `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceType:       "upload",
    url:              `upload://${safeName}`,
    note:             note.trim() || safeName,
    styleTokens,
    addedAt:          Date.now(),
    placement:        inferPlacement(styleTokens),
    processedImage:   croppedDataUrl,
    processingStatus: "done",
    processingError:  null,
  };

  inspirationEntries = [entry, ...inspirationEntries].slice(0, 12);
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext?.source || "empty");

  if (overlayUploadStatus) {
    overlayUploadStatus.textContent = "Cropped image ready. Applying overlay...";
  }

  applyInspirationOverlay(entry);
}

function skipCrop() {
  const file = _cropPendingFile;
  const note = _cropPendingNote || "";
  closeCropModal();
  _cropPendingFile = null;
  _cropPendingNote = null;
  if (file) addInspirationImageEntry(file, note);
}

function closeCropModal() {
  const modal = document.getElementById("cropModal");
  if (modal) modal.hidden = true;
  _cropSel = null;
  _cropDragging = false;
  _cropStart = null;
  _cropOriginalImage = null;
}

// ---------------------------------------------------------------------------
// Apply a processed pin as the live overlay
// ---------------------------------------------------------------------------
function applyInspirationOverlay(entryOrId) {
  const entry = typeof entryOrId === "string"
    ? inspirationEntries.find((item) => item && item.id === entryOrId)
    : entryOrId;
  if (!entry || !entry.processedImage) return;

  normalizeOverlayDataUrl(entry.processedImage, entry.placement || "septum")
    .then((normalizedSrc) => loadImageElement(normalizedSrc).then((img) => ({ img, normalizedSrc })))
    .then(({ img, normalizedSrc }) => {
      customOverlayImage = img;
      customOverlayPlacement = entry.placement || "septum";

      const idx = inspirationEntries.findIndex((item) => item && item.id === entry.id);
      if (idx !== -1 && inspirationEntries[idx].processedImage !== normalizedSrc) {
        inspirationEntries[idx].processedImage = normalizedSrc;
        persistInspirationEntries();
        renderInspirationEntries();
      }

      if (filterSelect) filterSelect.value = "custom-inspiration";
      applyFilterControlState();
    })
    .catch((error) => {
      console.error("[Inspiration] Could not apply custom overlay:", error);
    });
}

// ---------------------------------------------------------------------------
// Local-storage persistence
// ---------------------------------------------------------------------------
function persistInspirationEntries() {
  try {
    localStorage.setItem(INSPIRATION_STORAGE_KEY, JSON.stringify(inspirationEntries));
  } catch {
    // Ignore persistence failures (private mode / restricted storage).
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
      .map((entry) => {
        const styleTokens = Array.isArray(entry.styleTokens)
          ? entry.styleTokens
          : parseStyleTokens(`${entry.url} ${entry.note || ""}`);
        return {
          id:               String(entry.id || `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          sourceType:       entry.sourceType === "upload" ? "upload" : "pin-url",
          url:              entry.sourceType === "upload"
            ? String(entry.url || "")
            : (normalizePinterestUrl(entry.url) || entry.url),
          note:             typeof entry.note === "string" ? entry.note : "",
          styleTokens,
          addedAt:          Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now(),
          placement:        entry.placement || inferPlacement(styleTokens),
          processedImage:   entry.processedImage || null,
          processingStatus: entry.processedImage ? "done" : (entry.processingStatus || "idle"),
          processingError:  entry.processingError || null,
        };
      })
      .filter((entry) => entry && typeof entry.id === "string")
      .slice(0, 12);
  } catch {
    inspirationEntries = [];
  }
}

// ---------------------------------------------------------------------------
// Preference inference (used by buildPhotoContext in analysis.js)
// ---------------------------------------------------------------------------
function inferInspirationPreference(entries) {
  if (!entries.length) {
    return { dominantFilter: null, confidence: 0, totalPins: 0 };
  }

  const scores = {
    septum:           0,
    "nose-stud-left": 0,
    "brow-left":      0,
    "earring-left":   0,
    "earring-right":  0,
  };

  for (const entry of entries) {
    for (const token of (Array.isArray(entry.styleTokens) ? entry.styleTokens : [])) {
      if (scores[token] !== undefined) scores[token] += 1;
    }
  }

  const dominant       = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const dominantFilter = dominant && dominant[1] > 0 ? dominant[0] : null;
  const confidence     = dominantFilter ? dominant[1] / Math.max(1, entries.length) : 0;

  return { dominantFilter, confidence, totalPins: entries.length };
}

// ---------------------------------------------------------------------------
// Inspiration list UI
// ---------------------------------------------------------------------------
function renderInspirationEntries() {
  if (!inspirationList || !inspirationStatus) return;

  inspirationList.innerHTML = "";

  if (!inspirationEntries.length) {
    inspirationStatus.textContent = "No inspiration pins added yet.";
    return;
  }

  const preference = inferInspirationPreference(inspirationEntries);
  inspirationStatus.textContent = preference.dominantFilter
    ? `Loaded ${preference.totalPins} pin(s). Current vibe leans toward ${filterLabel(preference.dominantFilter)}.`
    : `Loaded ${preference.totalPins} pin(s). Add notes like "septum" or "hoop" for sharper matching.`;

  const PLACEMENT_OPTIONS = [
    { value: "septum",       label: "Septum / Nose Bridge" },
    { value: "nostril-left", label: "Left Nostril" },
    { value: "brow-left",    label: "Left Eyebrow" },
    { value: "ear-left",     label: "Left Ear" },
    { value: "ear-right",    label: "Right Ear" },
  ];

  for (const entry of inspirationEntries.filter(Boolean)) {
    const li      = document.createElement("li");
    li.className  = "inspiration-entry-card";

    // — Thumbnail area —
    const thumbWrap     = document.createElement("div");
    thumbWrap.className = "inspiration-thumb-wrap";

    if (entry.processedImage) {
      const img    = document.createElement("img");
      img.className = "inspiration-thumb";
      img.src      = entry.processedImage;
      img.alt      = entry.note || "Inspiration image";
      thumbWrap.appendChild(img);
    } else if (entry.processingStatus === "loading") {
      const loading     = document.createElement("span");
      loading.className = "inspiration-loading";
      loading.textContent = "Processing...";
      thumbWrap.appendChild(loading);
    } else if (entry.processingStatus === "failed") {
      const fail     = document.createElement("span");
      fail.className = "inspiration-failed";
      fail.title     = entry.processingError || "Failed";
      fail.textContent = "X";
      thumbWrap.appendChild(fail);

      if (entry.sourceType !== "upload") {
        const retryBtn       = document.createElement("button");
        retryBtn.type        = "button";
        retryBtn.className   = "inspiration-retry-btn";
        retryBtn.textContent = "Retry";
        retryBtn.addEventListener("click", () => {
          const idx = inspirationEntries.findIndex((e) => e && e.id === entry.id);
          if (idx !== -1) {
            inspirationEntries[idx].processingStatus = "loading";
            inspirationEntries[idx].processingError  = null;
            persistInspirationEntries();
            renderInspirationEntries();
            processPinImage(entry.id, entry.url);
          }
        });
        thumbWrap.appendChild(retryBtn);
      }
    } else {
      const noImg     = document.createElement("span");
      noImg.className = "inspiration-no-image";
      noImg.textContent = "—";
      thumbWrap.appendChild(noImg);
    }

    li.appendChild(thumbWrap);

    // — Info area —
    const infoDiv     = document.createElement("div");
    infoDiv.className = "inspiration-info";

    if (entry.sourceType === "upload") {
      const title = document.createElement("span");
      title.className = "inspiration-upload-title";
      title.textContent = entry.note || "Uploaded overlay image";
      infoDiv.appendChild(title);
    } else {
      const link         = document.createElement("a");
      link.href          = entry.url;
      link.target        = "_blank";
      link.rel           = "noopener noreferrer";
      link.textContent   = entry.note || entry.url;
      infoDiv.appendChild(link);
    }

    // Placement selector
    const placementLabel     = document.createElement("label");
    placementLabel.className = "inspiration-placement-label";
    placementLabel.textContent = "Place at: ";

    const placementSel     = document.createElement("select");
    placementSel.className = "inspiration-placement-sel";
    for (const opt of PLACEMENT_OPTIONS) {
      const option       = document.createElement("option");
      option.value       = opt.value;
      option.textContent = opt.label;
      if (opt.value === (entry.placement || "septum")) option.selected = true;
      placementSel.appendChild(option);
    }
    placementSel.addEventListener("change", () => {
      const idx = inspirationEntries.findIndex((e) => e.id === entry.id);
      if (idx !== -1) {
        inspirationEntries[idx].placement = placementSel.value;
        persistInspirationEntries();
      }
    });
    placementLabel.appendChild(placementSel);
    infoDiv.appendChild(placementLabel);

    // Action buttons
    const actionsDiv     = document.createElement("div");
    actionsDiv.className = "inspiration-actions";

    if (entry.processedImage) {
      const applyBtn       = document.createElement("button");
      applyBtn.type        = "button";
      applyBtn.className   = "inspiration-apply-btn";
      applyBtn.textContent = "Apply Overlay";
      applyBtn.addEventListener("click", () => applyInspirationOverlay(entry.id));
      actionsDiv.appendChild(applyBtn);
    }

    const removeBtn       = document.createElement("button");
    removeBtn.type        = "button";
    removeBtn.textContent = "Remove";
    removeBtn.className   = "inspiration-remove-btn";
    removeBtn.addEventListener("click", () => removeInspirationEntry(entry.id));
    actionsDiv.appendChild(removeBtn);

    infoDiv.appendChild(actionsDiv);

    if (entry.processingStatus === "failed" && entry.processingError) {
      const errText = document.createElement("div");
      errText.className = "inspiration-error-text";
      errText.textContent = entry.processingError;
      infoDiv.appendChild(errText);
    }

    li.appendChild(infoDiv);
    inspirationList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Pinterest API URL builder
// ---------------------------------------------------------------------------
function getPinterestApiUrl(path, params = {}) {
  const url = new URL(`${API_BASE}/api/pinterest${path}`, window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Auth handle storage
// ---------------------------------------------------------------------------
function savePinterestAuthHandle() {
  try {
    if (pinterestAuthHandle) {
      localStorage.setItem(PINTEREST_AUTH_STORAGE_KEY, pinterestAuthHandle);
    } else {
      localStorage.removeItem(PINTEREST_AUTH_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

function loadPinterestAuthHandle() {
  try {
    pinterestAuthHandle = localStorage.getItem(PINTEREST_AUTH_STORAGE_KEY);
  } catch {
    pinterestAuthHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Pinterest UI helpers
// ---------------------------------------------------------------------------
function clearPinterestPinsList(message = "") {
  if (pinterestPinsList) {
    pinterestPinsList.innerHTML = "";
    if (message) {
      const li     = document.createElement("li");
      li.textContent = message;
      pinterestPinsList.appendChild(li);
    }
  }
}

function updatePinterestConnectionUi(status) {
  const connected = Boolean(status?.connected && pinterestAuthHandle);

  if (connectPinterestBtn)       connectPinterestBtn.disabled      = pinterestConfig ? !pinterestConfig.enabled : false;
  if (disconnectPinterestBtn)    disconnectPinterestBtn.hidden      = !connected;
  if (pinterestBoardSelect)      pinterestBoardSelect.disabled      = !connected;
  if (refreshPinterestBoardsBtn) refreshPinterestBoardsBtn.disabled = !connected;
  if (loadPinterestPinsBtn)      loadPinterestPinsBtn.disabled      = !connected || !pinterestBoardSelect?.value;

  if (!pinterestConnectStatus) return;

  if (!pinterestConfig?.enabled) {
    pinterestConnectStatus.textContent = "Pinterest OAuth is not configured on the backend yet. Set the Pinterest app env vars in Render first.";
    return;
  }

  if (!connected) {
    pinterestConnectStatus.textContent = "Pinterest account not connected.";
    return;
  }

  const username = status.profile?.username || "Pinterest user";
  pinterestConnectStatus.textContent = `Connected as ${username}. Choose a board to import saved inspiration pins.`;
}

// ---------------------------------------------------------------------------
// Pinterest config & session sync
// ---------------------------------------------------------------------------
async function loadPinterestConfig() {
  if (!API_BASE) return;
  try {
    const response = await fetch(getPinterestApiUrl("/config"));
    pinterestConfig = await response.json();
  } catch {
    pinterestConfig = { enabled: false };
  }
  updatePinterestConnectionUi({ connected: Boolean(pinterestAuthHandle) });
}

async function syncPinterestStatus() {
  if (!API_BASE || !pinterestAuthHandle) {
    updatePinterestConnectionUi({ connected: false });
    return;
  }

  try {
    const response = await fetch(getPinterestApiUrl("/status", { auth_handle: pinterestAuthHandle }));
    const payload  = await response.json();

    if (!response.ok || !payload.connected) {
      pinterestAuthHandle = null;
      savePinterestAuthHandle();
      clearPinterestPinsList();
      updatePinterestConnectionUi({ connected: false });
      return;
    }

    updatePinterestConnectionUi(payload);
  } catch {
    updatePinterestConnectionUi({ connected: false });
  }
}

// ---------------------------------------------------------------------------
// Board / pin loading
// ---------------------------------------------------------------------------
async function loadPinterestBoards() {
  if (!pinterestAuthHandle || !pinterestBoardSelect) return;

  pinterestBoardSelect.innerHTML = "<option value=\"\">Loading boards...</option>";
  try {
    const response = await fetch(
      getPinterestApiUrl("/boards", { auth_handle: pinterestAuthHandle, page_size: 25 })
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load Pinterest boards.");

    pinterestBoardSelect.innerHTML = "<option value=\"\">Select a Pinterest board</option>";
    for (const board of payload.items || []) {
      const option       = document.createElement("option");
      option.value       = board.id;
      option.textContent = board.name;
      pinterestBoardSelect.appendChild(option);
    }
    updatePinterestConnectionUi({ connected: true, profile: {} });
  } catch (error) {
    pinterestBoardSelect.innerHTML = "<option value=\"\">Could not load boards</option>";
    clearPinterestPinsList(error.message || "Could not load Pinterest boards.");
  }
}

function renderPinterestPins(items) {
  if (!pinterestPinsList) return;

  pinterestPinsList.innerHTML = "";
  if (!items.length) {
    clearPinterestPinsList("No pins found in this board.");
    return;
  }

  for (const pin of items) {
    const li        = document.createElement("li");
    const link      = document.createElement("a");
    link.href        = pin.pinterest_url;
    link.target      = "_blank";
    link.rel         = "noopener noreferrer";
    link.textContent = pin.title || "Untitled pin";

    const importBtn        = document.createElement("button");
    importBtn.type         = "button";
    importBtn.textContent  = "Use Pin";
    importBtn.className    = "inspiration-remove-btn";
    importBtn.addEventListener("click", () => {
      try {
        addInspirationEntry(
          pin.pinterest_url,
          [pin.title, pin.description].filter(Boolean).join(" - ")
        );
      } catch (error) {
        alert(error.message || "Could not import Pinterest pin.");
      }
    });

    li.appendChild(link);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(importBtn);
    pinterestPinsList.appendChild(li);
  }
}

async function loadPinterestPins() {
  if (!pinterestAuthHandle) return;
  const boardId = pinterestBoardSelect?.value || "";
  clearPinterestPinsList("Loading Pinterest pins...");

  try {
    const response = await fetch(
      getPinterestApiUrl("/pins", { auth_handle: pinterestAuthHandle, board_id: boardId, page_size: 25 })
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load Pinterest pins.");
    renderPinterestPins(payload.items || []);
  } catch (error) {
    clearPinterestPinsList(error.message || "Could not load Pinterest pins.");
  }
}

// ---------------------------------------------------------------------------
// OAuth connect / disconnect
// ---------------------------------------------------------------------------
function startPinterestConnectFlow() {
  if (!pinterestConfig?.enabled) {
    alert("Pinterest OAuth is not configured on the backend yet. Add the Pinterest app env vars in Render first.");
    return;
  }

  const origin   = window.location.origin;
  const popupUrl = `${API_BASE}/api/pinterest/connect?origin=${encodeURIComponent(origin)}`;
  window.open(popupUrl, "pinterest-auth", "popup=yes,width=720,height=820");
}

async function disconnectPinterest() {
  if (pinterestAuthHandle && API_BASE) {
    try {
      await fetch(`${API_BASE}/api/pinterest/disconnect`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ auth_handle: pinterestAuthHandle }),
      });
    } catch {
      // Ignore disconnect network failures; clear local state anyway.
    }
  }

  pinterestAuthHandle = null;
  savePinterestAuthHandle();

  if (pinterestBoardSelect) {
    pinterestBoardSelect.innerHTML = "<option value=\"\">Select a Pinterest board</option>";
  }
  clearPinterestPinsList();
  updatePinterestConnectionUi({ connected: false });
}
