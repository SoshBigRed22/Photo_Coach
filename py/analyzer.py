from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class AnalysisResult:
    brightness: float
    contrast: float
    blur_score: float
    noise_score: float
    width: int
    height: int
    face_count: int
    primary_face_area_ratio: float
    primary_face_center_offset: float
    face_sharpness: float
    primary_face_box: tuple[int, int, int, int] | None


def _load_face_cascade() -> cv2.CascadeClassifier:
    cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    classifier = cv2.CascadeClassifier(str(cascade_path))
    if classifier.empty():
        raise RuntimeError(f"Failed to load face cascade at {cascade_path}")
    return classifier


def analyze_image(image_path: Path) -> AnalysisResult:
    image = cv2.imread(str(image_path))
    if image is None:
        raise ValueError(f"Unable to read image: {image_path}")

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    brightness = float(np.mean(gray))
    contrast = float(np.std(gray))

    # Laplacian variance is a simple and effective blur estimate.
    blur_score = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    # High-frequency residual approximates visible noise.
    denoised = cv2.GaussianBlur(gray, (3, 3), 0)
    noise = cv2.absdiff(gray, denoised)
    noise_score = float(np.mean(noise))

    height, width = gray.shape

    face_cascade = _load_face_cascade()
    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(60, 60),
    )

    face_count = int(len(faces))
    primary_face_area_ratio = 0.0
    primary_face_center_offset = 0.0
    face_sharpness = 0.0
    primary_face_box: tuple[int, int, int, int] | None = None

    if face_count > 0:
        x, y, w, h = max(faces, key=lambda box: box[2] * box[3])
        primary_face_box = (int(x), int(y), int(w), int(h))

        face_area = float(w * h)
        frame_area = float(width * height)
        primary_face_area_ratio = face_area / frame_area if frame_area > 0 else 0.0

        cx = x + (w / 2.0)
        cy = y + (h / 2.0)
        dx = abs(cx - (width / 2.0)) / max(width / 2.0, 1.0)
        dy = abs(cy - (height / 2.0)) / max(height / 2.0, 1.0)
        primary_face_center_offset = float(max(dx, dy))

        face_roi = gray[y : y + h, x : x + w]
        if face_roi.size > 0:
            face_sharpness = float(cv2.Laplacian(face_roi, cv2.CV_64F).var())

    return AnalysisResult(
        brightness=brightness,
        contrast=contrast,
        blur_score=blur_score,
        noise_score=noise_score,
        width=width,
        height=height,
        face_count=face_count,
        primary_face_area_ratio=primary_face_area_ratio,
        primary_face_center_offset=primary_face_center_offset,
        face_sharpness=face_sharpness,
        primary_face_box=primary_face_box,
    )
