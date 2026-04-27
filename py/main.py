from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path

import cv2

from analyzer import analyze_image
from camera import capture_photo
from suggestions import build_suggestions, calculate_quality_score, load_thresholds


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser(
		description="Capture or load a photo, then get quality improvement suggestions."
	)
	parser.add_argument(
		"--image",
		type=str,
		help="Optional path to an existing image. If omitted, webcam capture is used.",
	)
	parser.add_argument(
		"--config",
		type=str,
		default="js/config.json",
		help="Path to JSON thresholds configuration.",
	)
	parser.add_argument(
		"--no-preview",
		action="store_true",
		help="Skip the analysis preview window.",
	)
	return parser.parse_args()


def show_preview(image_path: Path, score: float, tips: list[str], face_box: tuple[int, int, int, int] | None) -> None:
	image = cv2.imread(str(image_path))
	if image is None:
		return

	if face_box is not None:
		x, y, w, h = face_box
		cv2.rectangle(image, (x, y), (x + w, y + h), (70, 230, 90), 2)
		cv2.putText(image, "Primary face", (x, max(18, y - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (70, 230, 90), 2, cv2.LINE_AA)

	height, width = image.shape[:2]
	overlay = image.copy()
	panel_height = min(220, max(150, int(height * 0.33)))
	cv2.rectangle(overlay, (0, 0), (width, panel_height), (18, 18, 18), -1)
	preview = cv2.addWeighted(overlay, 0.5, image, 0.5, 0)

	score_color = (60, 200, 90) if score >= 80 else (30, 180, 240) if score >= 60 else (45, 60, 220)
	cv2.putText(preview, f"Quality Score: {score:.2f}%", (20, 44), cv2.FONT_HERSHEY_SIMPLEX, 1.0, score_color, 2, cv2.LINE_AA)

	max_tips = 3
	for i, tip in enumerate(tips[:max_tips], start=1):
		text = f"{i}. {tip}"
		cv2.putText(preview, text, (20, 44 + i * 42), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (245, 245, 245), 2, cv2.LINE_AA)

	cv2.putText(
		preview,
		"Press any key to close",
		(20, panel_height - 14),
		cv2.FONT_HERSHEY_SIMPLEX,
		0.55,
		(210, 210, 210),
		1,
		cv2.LINE_AA,
	)

	window_name = "Photo Analysis Preview"
	cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
	cv2.imshow(window_name, preview)
	cv2.waitKey(0)
	cv2.destroyWindow(window_name)


def main() -> None:
	args = parse_args()
	config_path = Path(args.config)

	if not config_path.exists():
		raise FileNotFoundError(f"Config file not found: {config_path}")

	if args.image:
		image_path = Path(args.image)
		if not image_path.exists():
			raise FileNotFoundError(f"Image not found: {image_path}")
	else:
		stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
		image_path = Path("img") / f"photo_{stamp}.jpg"
		print("Opening camera...")
		capture_photo(image_path)
		print(f"Captured image: {image_path}")

	thresholds = load_thresholds(config_path)
	result = analyze_image(image_path)
	tips = build_suggestions(result, thresholds)
	score = calculate_quality_score(result, thresholds)

	print("\nAnalysis Summary")
	print(f"- Quality:    {score:.2f}%")
	print(f"- Brightness: {result.brightness:.1f}")
	print(f"- Contrast:   {result.contrast:.1f}")
	print(f"- Blur score: {result.blur_score:.1f}")
	if result.primary_face_box is not None:
		print(f"- Face area:  {result.primary_face_area_ratio:.3f}")
		print(f"- Face offset:{result.primary_face_center_offset:.3f}")
		print(f"- Face sharp: {result.face_sharpness:.1f}")
		print(f"- Facial hair presence: {result.facial_hair_presence:.1f}")
	else:
		print("- Face:       Not confidently detected")

	print("\nSuggestions")
	for i, tip in enumerate(tips, start=1):
		print(f"{i}. {tip}")

	if not args.no_preview:
		try:
			show_preview(image_path, score, tips, result.primary_face_box)
		except cv2.error:
			print("\nPreview window unavailable in this environment. Use --no-preview to silence this message.")


if __name__ == "__main__":
	main()
