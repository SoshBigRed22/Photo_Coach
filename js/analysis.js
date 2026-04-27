// ---------------------------------------------------------------------------
// analysis.js — Score/tips/metrics rendering, piercing-fit assessment,
//               photo context builder, and the main analyzeBlob pipeline.
//
// Depends on: state.js, filters.js (applyFilterControlState sets selectedFilter)
//             pinterest.js (inferInspirationPreference)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Score helpers
// ---------------------------------------------------------------------------
function scoreClass(score) {
  const normalized = Number.isFinite(Number(score)) ? Number(score) : 0;
  if (normalized >= 80) return "good";
  if (normalized >= 60) return "mid";
  return "low";
}

function filterLabel(filterKey) {
  return FILTER_LABELS[filterKey] || "Selected Piercing";
}

// ---------------------------------------------------------------------------
// Photo-context snapshot (used to capture state at moment of capture/upload)
// ---------------------------------------------------------------------------
function buildPhotoContext(source) {
  const activeBox    = renderedTrackedBox || targetTrackedBox;
  const overlayWidth = faceOverlay?.width || faceOverlay?.clientWidth || 0;
  const inspiration  = inferInspirationPreference(inspirationEntries);

  return {
    source,
    filter:          selectedFilter,
    filterScale:     selectedFilterScale,
    faceShape:       detectedLandmarks ? detectedFaceShape : null,
    faceDetected:    Boolean(detectedLandmarks || activeBox),
    faceWidthRatio:  activeBox && overlayWidth ? activeBox.width / overlayWidth : null,
    featureMetrics:  liveFeatureMetrics ? { ...liveFeatureMetrics } : null,
    inspiration,
  };
}

// ---------------------------------------------------------------------------
// Cover-fit video frame draw helper (used during capture)
// ---------------------------------------------------------------------------
function drawVideoCoverFrame(ctx, source, sourceWidth, sourceHeight, destWidth, destHeight) {
  const scale      = Math.max(destWidth / sourceWidth, destHeight / sourceHeight);
  const drawWidth  = sourceWidth  * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX    = (destWidth  - drawWidth)  / 2;
  const offsetY    = (destHeight - drawHeight) / 2;

  ctx.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------
function setScore(score) {
  const normalizedScore = Number.isFinite(Number(score)) ? Number(score) : 0;
  scorePill.textContent = `Score: ${normalizedScore.toFixed(2)}%`;
  const cls             = scoreClass(score);
  scorePill.style.background = cls === "good"
    ? "rgba(19, 111, 99, 0.14)"
    : cls === "mid"
      ? "rgba(207, 106, 50, 0.18)"
      : "rgba(154, 31, 31, 0.16)";
}

function renderTips(tips) {
  tipsList.innerHTML = "";
  for (const tip of tips) {
    const li     = document.createElement("li");
    li.textContent = tip;
    tipsList.appendChild(li);
  }
}

function renderMetrics(metrics) {
  const labels = {
    brightness:          "Brightness",
    contrast:            "Contrast",
    blur_score:          "Blur",
    height:              "Height",
    face_area_ratio:     "Face area (how much of frame your face fills)",
    face_center_offset:  "Face offset (distance from center target)",
    face_sharpness:      "Face sharpness (detail clarity on the face)",
    facial_hair_presence: "Facial hair presence",
    eyebrow_symmetry_score: "Eyebrow symmetry",
    eyebrow_size_score:  "Eyebrow size balance",
    eye_symmetry_score:  "Eye symmetry",
    eye_size_score:      "Eye size balance",
    nose_symmetry_score: "Nose symmetry",
    nose_size_score:     "Nose size balance",
    mouth_symmetry_score: "Mouth symmetry",
    mouth_size_score:    "Mouth size balance",
    chin_symmetry_score: "Chin symmetry",
    chin_size_score:     "Chin size balance",
  };
  const featurePercentKeys = new Set([
    "eyebrow_symmetry_score",
    "eyebrow_size_score",
    "eye_symmetry_score",
    "eye_size_score",
    "nose_symmetry_score",
    "nose_size_score",
    "mouth_symmetry_score",
    "mouth_size_score",
    "chin_symmetry_score",
    "chin_size_score",
    "facial_hair_presence",
  ]);

  metricsGrid.innerHTML = "";
  for (const [key, value] of Object.entries(metrics)) {
    const dt         = document.createElement("dt");
    dt.textContent   = labels[key] || key;
    const dd         = document.createElement("dd");
    if (key === "face_area_ratio" && Number.isFinite(Number(value))) {
      dd.textContent = `${(Number(value) * 100).toFixed(2)}%`;
    } else if (key === "face_center_offset" && Number.isFinite(Number(value))) {
      dd.textContent = `${(Number(value) * 100).toFixed(2)}%`;
    } else if (featurePercentKeys.has(key) && Number.isFinite(Number(value))) {
      dd.textContent = `${Number(value).toFixed(2)}%`;
    } else {
      dd.textContent = String(value);
    }
    metricsGrid.appendChild(dt);
    metricsGrid.appendChild(dd);
  }
}

function applyAnalysisPayload(payload, localAssessment = null, context = selectedPhotoContext) {
  const contextFeatureMetrics = context?.featureMetrics || null;
  const mergedMetrics = contextFeatureMetrics
    ? { ...(payload.metrics || {}), ...contextFeatureMetrics }
    : (payload.metrics || {});

  setScore(payload.score);
  renderTips(payload.tips || []);
  renderMetrics(mergedMetrics);
  renderPiercingFitAssessment(localAssessment);
}

// ---------------------------------------------------------------------------
// Piercing fit panel rendering
// ---------------------------------------------------------------------------
function renderPiercingFitAssessment(assessment) {
  if (!piercingFitPanel || !piercingFitScore || !piercingFitSummary || !piercingFitList) return;

  if (!assessment) {
    piercingFitPanel.hidden  = true;
    piercingFitList.innerHTML = "";
    return;
  }

  piercingFitPanel.hidden       = false;
  piercingFitScore.textContent  = `Piercing Fit: ${assessment.score}/100`;

  const fitClass = scoreClass(assessment.score);
  piercingFitScore.style.background = fitClass === "good"
    ? "rgba(19, 111, 99, 0.14)"
    : fitClass === "mid"
      ? "rgba(207, 106, 50, 0.18)"
      : "rgba(154, 31, 31, 0.16)";
  piercingFitScore.style.color = fitClass === "low" ? "var(--danger)" : "var(--accent-strong)";

  piercingFitSummary.textContent = assessment.summary;
  piercingFitList.innerHTML      = "";
  for (const item of assessment.details) {
    const li     = document.createElement("li");
    li.textContent = item;
    piercingFitList.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Piercing fit assessment logic
// ---------------------------------------------------------------------------
function assessPiercingFit(context) {
  if (!context || !context.filter || context.filter === "none") return null;

  const guide   = PIERCING_STYLE_GUIDE[context.filter];
  const label   = filterLabel(context.filter);
  const details = [];
  let   score   = 72;

  if (!context.faceDetected) {
    return {
      score:   58,
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

  return { score, summary, details };
}

// ---------------------------------------------------------------------------
// Send blob to backend analysis endpoint
// ---------------------------------------------------------------------------
async function analyzeBlob(blob, context = selectedPhotoContext) {
  const formData = new FormData();
  formData.append("photo", blob, "photo.jpg");

  analyzeBtn.disabled   = true;
  analyzeBtn.textContent = "Analyzing...";

  try {
    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      body:   formData,
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Analyze request failed.");

    applyAnalysisPayload(payload, assessPiercingFit(context), context);
  } catch (error) {
    alert(error.message);
  } finally {
    analyzeBtn.disabled   = false;
    analyzeBtn.textContent = "Analyze Photo";
  }
}
