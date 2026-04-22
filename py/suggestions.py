from __future__ import annotations

import json
from pathlib import Path

from analyzer import AnalysisResult


def load_thresholds(config_path: Path) -> dict:
    with config_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def build_suggestions(result: AnalysisResult, thresholds: dict) -> list[str]:
    tips: list[str] = []

    brightness_min = thresholds.get("brightness_min", 80)
    brightness_max = thresholds.get("brightness_max", 190)
    contrast_min = thresholds.get("contrast_min", 35)
    blur_min = thresholds.get("blur_min", 120)
    noise_max = thresholds.get("noise_max", 12)
    min_width = thresholds.get("min_width", 1080)
    min_height = thresholds.get("min_height", 1080)
    face_area_ratio_min = thresholds.get("face_area_ratio_min", 0.08)
    face_center_offset_max = thresholds.get("face_center_offset_max", 0.22)
    face_sharpness_min = thresholds.get("face_sharpness_min", 180)

    if result.brightness < brightness_min:
        tips.append("Image is too dark: add front lighting or increase exposure slightly.")
    elif result.brightness > brightness_max:
        tips.append("Image is too bright: reduce exposure or move away from harsh light.")

    if result.contrast < contrast_min:
        tips.append("Low contrast: separate subject from background and improve directional light.")

    if result.blur_score < blur_min:
        tips.append("Photo appears blurry: steady the phone/camera and refocus before capture.")

    if result.noise_score > noise_max:
        tips.append("Visible grain/noise: use brighter light and lower ISO if possible.")

    if result.width < min_width or result.height < min_height:
        tips.append("Resolution is low: capture at a higher camera resolution for better quality.")

    if result.face_count == 0:
        tips.append("No clear face found: keep your face visible and avoid heavy backlighting.")
    else:
        if result.face_count > 1:
            tips.append("Multiple faces detected: move closer or switch to portrait framing for one subject.")

        if result.primary_face_area_ratio < face_area_ratio_min:
            tips.append("Face appears too small: move closer or crop tighter around the subject.")

        if result.primary_face_center_offset > face_center_offset_max:
            tips.append("Subject is off-center: align face closer to center for a cleaner selfie composition.")

        if result.face_sharpness < face_sharpness_min:
            tips.append("Face detail is soft: tap-to-focus on eyes and steady the camera before capture.")

    if not tips:
        tips.append("Great base photo quality. Try minor edits like crop and white balance tuning.")

    return tips


def calculate_quality_score(result: AnalysisResult, thresholds: dict) -> int:
    """Return a simple weighted quality score from 0 to 100."""
    brightness_min = thresholds.get("brightness_min", 80)
    brightness_max = thresholds.get("brightness_max", 190)
    contrast_min = thresholds.get("contrast_min", 35)
    blur_min = thresholds.get("blur_min", 120)
    noise_max = thresholds.get("noise_max", 12)
    min_width = thresholds.get("min_width", 1080)
    min_height = thresholds.get("min_height", 1080)
    face_area_ratio_min = thresholds.get("face_area_ratio_min", 0.08)
    face_center_offset_max = thresholds.get("face_center_offset_max", 0.22)
    face_sharpness_min = thresholds.get("face_sharpness_min", 180)

    score = 100.0

    if result.brightness < brightness_min:
        score -= min(20.0, (brightness_min - result.brightness) * 0.35)
    elif result.brightness > brightness_max:
        score -= min(15.0, (result.brightness - brightness_max) * 0.25)

    if result.contrast < contrast_min:
        score -= min(20.0, (contrast_min - result.contrast) * 0.5)

    if result.blur_score < blur_min:
        score -= min(30.0, (blur_min - result.blur_score) * 0.08)

    if result.noise_score > noise_max:
        score -= min(15.0, (result.noise_score - noise_max) * 1.5)

    if result.width < min_width or result.height < min_height:
        score -= 10.0

    if result.face_count == 0:
        score -= 20.0
    else:
        if result.face_count > 1:
            score -= 5.0

        if result.primary_face_area_ratio < face_area_ratio_min:
            score -= min(12.0, (face_area_ratio_min - result.primary_face_area_ratio) * 120.0)

        if result.primary_face_center_offset > face_center_offset_max:
            score -= min(8.0, (result.primary_face_center_offset - face_center_offset_max) * 25.0)

        if result.face_sharpness < face_sharpness_min:
            score -= min(15.0, (face_sharpness_min - result.face_sharpness) * 0.08)

    return int(max(0.0, min(100.0, round(score))))
