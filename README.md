# Quick Photo Improvement App (MVP)

This starter app captures a photo (or loads an existing one), analyzes quality, and suggests how to improve it.

## Features

- Webcam capture with SPACE key
- Basic quality analysis:
  - Brightness
  - Contrast
  - Blur estimate
  - Noise estimate
  - Resolution check
- Selfie checks:
  - Face detection count
  - Face framing size
  - Face centering
  - Face-region sharpness
- Quality score from 0 to 100
- Human-readable improvement suggestions
- Preview window with score, top tips, and primary face box overlay

## Setup

1. Create and activate a virtual environment (optional but recommended).
2. Install dependencies:

```bash
pip install -r requirements.txt
```

## Run

Capture from camera:

```bash
python py/main.py
```

Analyze an existing image:

```bash
python py/main.py --image path/to/photo.jpg
```

Use a custom config:

```bash
python py/main.py --config js/config.json
```

Run without opening the preview window:

```bash
python py/main.py --no-preview
```

## Browser App (Recommended for Demo)

This project now includes a browser UI served by Flask.

Start the web app:

```bash
python py/web_app.py
```

Open this URL in your browser:

```text
http://127.0.0.1:5000
```

Notes:

- You do not need VS Code Live Server for this app.
- The browser entry page is `index.html`, but it should be opened through Flask at the URL above.
- Camera capture in browser requires camera permission in your browser.

## Next Improvements

- Add aesthetic scoring model.
- Build a mobile frontend (Flutter/React Native) with this Python backend.

## Pinterest OAuth Setup (Phase 2)

To enable Pinterest account connect and board/pin import, configure these Render env vars on the Flask service:

- `PINTEREST_APP_ID`
- `PINTEREST_APP_SECRET`
- `PINTEREST_REDIRECT_URI`

Use a redirect URI that exactly matches the URI configured in your Pinterest developer app, for example:

```text
https://your-render-service.onrender.com/api/pinterest/callback
```

Pinterest API access also requires an approved developer app with the scopes used here:

- `boards:read`
- `pins:read`
- `user_accounts:read`

## Pinterest Fallback Mode (No OAuth Yet)

If Pinterest app trial/approval is still pending, the app still supports a manual inspiration workflow:

- Paste Pinterest pin URLs directly in the Inspiration panel.
- Add optional notes (for style hints like "septum", "hoop", "minimalist").
- Imported links still influence recommendation weighting.

This lets demo and portfolio use continue without waiting for OAuth approval.

## Production Hardening Notes

### CORS Origin Allowlist

Set `CORS_ORIGIN` to the frontend origin(s) that call your backend API.

For this project, include your GitHub Pages origin and optionally your Render origin in one comma-separated value:

```text
CORS_ORIGIN=https://yourusername.github.io,https://photo-coach-j95a.onrender.com
```

Rules:

- Use one env var value, not multiple `CORS_ORIGIN` keys.
- Use origins only (scheme + host), no path.
- Avoid trailing slashes.

### Privacy Policy Routing

- GitHub Pages serves the static page at `privacy-policy.html`.
- Flask route `/privacy-policy` redirects to `/privacy-policy.html` for backend-hosted access.

### Pinterest Session Limitation (Current MVP)

Pinterest auth handles/tokens are currently kept in server memory.

Implication:

- After backend restart/redeploy, users may need to reconnect Pinterest.

This is expected for the current MVP scope and can be upgraded later to persistent storage.
