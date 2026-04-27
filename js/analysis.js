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

const METRIC_LABELS = {
  brightness_score:     "Brightness quality",
  contrast_score:       "Contrast quality",
  blur_quality_score:   "Blur quality",
  face_area_score:      "Face area quality",
  face_centering_score: "Face centering quality",
  face_sharpness_score: "Face sharpness quality",
  facial_hair_presence: "Facial hair presence",
  eyebrow_symmetry_score: "Eyebrow symmetry",
  eyebrow_size_score:   "Eyebrow size balance",
  eye_symmetry_score:   "Eye symmetry",
  eye_size_score:       "Eye size balance",
  nose_symmetry_score:  "Nose symmetry",
  nose_size_score:      "Nose size balance",
  mouth_symmetry_score: "Mouth symmetry",
  mouth_size_score:     "Mouth size balance",
  chin_symmetry_score:  "Chin symmetry",
  chin_size_score:      "Chin size balance",
};

const PERCENT_METRIC_KEYS = new Set([
  "brightness_score",
  "contrast_score",
  "blur_quality_score",
  "face_area_score",
  "face_centering_score",
  "face_sharpness_score",
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

const METRIC_ACTION_TIPS = {
  brightness_score: "Use brighter front-facing light so your face reads clearly.",
  contrast_score: "Increase separation from the background to improve contrast.",
  blur_quality_score: "Hold still and tap to focus before capture to reduce blur.",
  face_area_score: "Move slightly closer so your face fills more of the frame.",
  face_centering_score: "Align the nose tracker with the center target before capture.",
  face_sharpness_score: "Keep your face in focus and avoid motion right before capture.",
  eyebrow_symmetry_score: "Keep your head level and face the camera straight-on for better eyebrow symmetry.",
  eyebrow_size_score: "Keep equal distance from the camera on both sides to stabilize eyebrow size balance.",
  eye_symmetry_score: "Square your face to the camera and avoid head tilt for cleaner eye symmetry.",
  eye_size_score: "Keep a neutral expression and stay centered to improve eye size balance.",
  nose_symmetry_score: "Align your nose box with the center target to improve nose symmetry score.",
  nose_size_score: "Maintain consistent distance to the camera to stabilize nose size balance.",
  mouth_symmetry_score: "Use a relaxed, neutral mouth position and keep your face straight.",
  mouth_size_score: "Avoid exaggerated expressions so mouth size balance reads accurately.",
  chin_symmetry_score: "Keep your chin level and avoid turning your head for better chin symmetry.",
  chin_size_score: "Hold a natural head angle and steady distance to improve chin size balance.",
};

function scoreBand(score) {
  const normalized = Number.isFinite(Number(score)) ? Number(score) : 0;
  if (normalized >= 85) return "Excellent";
  if (normalized >= 70) return "Good";
  return "Needs Work";
}

function buildPriorityTips(metrics) {
  const ranked = Object.entries(metrics)
    .filter(([key, value]) => PERCENT_METRIC_KEYS.has(key) && key !== "facial_hair_presence" && Number.isFinite(Number(value)))
    .map(([key, value]) => ({ key, score: Number(value) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);

  return ranked.map((item) => {
    const label = METRIC_LABELS[item.key] || item.key;
    const action = METRIC_ACTION_TIPS[item.key] || "Retake with steadier alignment and lighting.";
    return `Priority fix — ${label} (${item.score.toFixed(2)}%): ${action}`;
  });
}

function renderTips(tips) {
  tipsList.innerHTML = "";
  for (const tip of tips) {
    const li      = document.createElement("li");
    li.textContent = tip;
    tipsList.appendChild(li);
  }
}

function renderMetrics(metrics) {
  metricsGrid.innerHTML = "";
  for (const [key, value] of Object.entries(metrics)) {
    const dt         = document.createElement("dt");
    dt.textContent   = METRIC_LABELS[key] || key;
    const dd         = document.createElement("dd");
    if (PERCENT_METRIC_KEYS.has(key) && Number.isFinite(Number(value))) {
      const normalized = Number(value);
      dd.textContent = `${normalized.toFixed(2)}% (${scoreBand(normalized)})`;
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
  const priorityTips = buildPriorityTips(mergedMetrics);

  setScore(payload.score);
  renderTips([...priorityTips, ...(payload.tips || [])]);
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
