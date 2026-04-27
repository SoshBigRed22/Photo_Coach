from __future__ import annotations

import json
from pathlib import Path

from analyzer import AnalysisResult


def load_thresholds(config_path: Path) -> dict:
    with config_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def build_suggestions(result: AnalysisResult, thresholds: dict) -> list[str]:
    tips: list[str] = []

    brightness_fail_min = thresholds.get("brightness_fail_min", 25)
    brightness_warn_min = thresholds.get("brightness_warn_min", 50)
    brightness_min = thresholds.get("brightness_min", 80)
    brightness_max = thresholds.get("brightness_max", 190)
    contrast_min = thresholds.get("contrast_min", 35)
    blur_min = thresholds.get("blur_min", 120)
    face_area_ratio_min = thresholds.get("face_area_ratio_min", 0.08)
    face_center_offset_max = thresholds.get("face_center_offset_max", 0.22)
    face_sharpness_min = thresholds.get("face_sharpness_min", 180)

    if result.brightness < brightness_fail_min:
        return [
            "Lighting is too dark to evaluate your face reliably. Move to a brighter area before taking a photo.",
            "Use front-facing light on your face so tracking and scoring can run accurately.",
        ]

    if result.brightness < brightness_warn_min:
        tips.append("Lighting is dim. Move to a brighter area for a more accurate face read and recommendations.")

    if result.brightness < brightness_min:
        tips.append("Image is too dark: add front lighting or increase exposure slightly.")
    elif result.brightness > brightness_max:
        tips.append("Image is too bright: reduce exposure or move away from harsh light.")

    if result.contrast < contrast_min:
        tips.append("Low contrast: separate subject from background and improve directional light.")

    if result.blur_score < blur_min:
        tips.append("Photo appears blurry: steady the phone/camera and refocus before capture.")

    if result.primary_face_box is None:
        tips.append("No clear face found: keep your face visible and avoid heavy backlighting.")
    else:
        if result.primary_face_area_ratio < face_area_ratio_min:
            tips.append("Face appears too small: move closer or crop tighter around the subject.")

        if result.primary_face_center_offset > face_center_offset_max:
            tips.append("Subject is off-center: align face closer to center for a cleaner selfie composition.")

        if result.face_sharpness < face_sharpness_min:
            tips.append("Face detail is soft: tap-to-focus on eyes and steady the camera before capture.")

    if not tips:
        tips.append("Great base photo quality. Try minor edits like crop and white balance tuning.")

    return tips


def calculate_quality_score(result: AnalysisResult, thresholds: dict) -> float:
    """Return a weighted quality score from 0.00 to 100.00."""
    brightness_fail_min = thresholds.get("brightness_fail_min", 25)
    brightness_warn_min = thresholds.get("brightness_warn_min", 50)
    brightness_min = thresholds.get("brightness_min", 80)
    brightness_max = thresholds.get("brightness_max", 190)
    contrast_min = thresholds.get("contrast_min", 35)
    blur_min = thresholds.get("blur_min", 120)
    face_area_ratio_min = thresholds.get("face_area_ratio_min", 0.08)
    face_center_offset_max = thresholds.get("face_center_offset_max", 0.22)
    face_sharpness_min = thresholds.get("face_sharpness_min", 180)

    if result.brightness < brightness_fail_min:
        return 0.0

    score = 100.0

    if result.brightness < brightness_warn_min:
        score -= min(22.0, (brightness_warn_min - result.brightness) * 0.88)

    if result.brightness < brightness_min:
        score -= min(20.0, (brightness_min - result.brightness) * 0.35)
    elif result.brightness > brightness_max:
        score -= min(15.0, (result.brightness - brightness_max) * 0.25)

    if result.contrast < contrast_min:
        score -= min(20.0, (contrast_min - result.contrast) * 0.5)

    if result.blur_score < blur_min:
        score -= min(30.0, (blur_min - result.blur_score) * 0.08)

    if result.primary_face_box is None:
        score -= 20.0
    else:
        if result.primary_face_area_ratio < face_area_ratio_min:
            score -= min(12.0, (face_area_ratio_min - result.primary_face_area_ratio) * 120.0)

        if result.primary_face_center_offset > face_center_offset_max:
            score -= min(8.0, (result.primary_face_center_offset - face_center_offset_max) * 25.0)

        if result.face_sharpness < face_sharpness_min:
            score -= min(15.0, (face_sharpness_min - result.face_sharpness) * 0.08)

    return round(max(0.0, min(100.0, score)), 2)
