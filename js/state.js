// ---------------------------------------------------------------------------
// state.js — Shared constants, DOM references, and mutable state variables
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// API base URL configuration
// ---------------------------------------------------------------------------
const PRODUCTION_API_URL = "https://photo-coach-j95a.onrender.com";

const IS_LOCALHOST =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

const API_BASE = IS_LOCALHOST
  ? ""                   // local dev  — relative paths (Flask serves everything)
  : PRODUCTION_API_URL;  // GitHub Pages — point to Render backend

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const startCameraBtn          = document.getElementById("startCameraBtn");
const refreshCamerasBtn       = document.getElementById("refreshCamerasBtn");
const cameraSelect            = document.getElementById("cameraSelect");
const cameraStatus            = document.getElementById("cameraStatus");
const filterSelect            = document.getElementById("filterSelect");
const filterSize              = document.getElementById("filterSize");
const filterSizeValue         = document.getElementById("filterSizeValue");
const systemCaptureBtn        = document.getElementById("systemCaptureBtn");
const systemCameraIndex       = document.getElementById("systemCameraIndex");
const testSystemIndexBtn      = document.getElementById("testSystemIndexBtn");
const autoProbeBtn            = document.getElementById("autoProbeBtn");
const autoCaptureBtn          = document.getElementById("autoCaptureBtn");
const captureBtn              = document.getElementById("captureBtn");
const analyzeBtn              = document.getElementById("analyzeBtn");
const uploadInput             = document.getElementById("uploadInput");
const inspirationUrlInput     = document.getElementById("inspirationUrlInput");
const inspirationNoteInput    = document.getElementById("inspirationNoteInput");
const addInspirationBtn       = document.getElementById("addInspirationBtn");
const clearInspirationBtn     = document.getElementById("clearInspirationBtn");
const inspirationStatus       = document.getElementById("inspirationStatus");
const inspirationList         = document.getElementById("inspirationList");
const connectPinterestBtn     = document.getElementById("connectPinterestBtn");
const disconnectPinterestBtn  = document.getElementById("disconnectPinterestBtn");
const pinterestConnectStatus  = document.getElementById("pinterestConnectStatus");
const pinterestBoardSelect    = document.getElementById("pinterestBoardSelect");
const refreshPinterestBoardsBtn = document.getElementById("refreshPinterestBoardsBtn");
const loadPinterestPinsBtn    = document.getElementById("loadPinterestPinsBtn");
const pinterestPinsList       = document.getElementById("pinterestPinsList");
const cameraFeed              = document.getElementById("cameraFeed");
const faceOverlay             = document.getElementById("faceOverlay");
const captureCanvas           = document.getElementById("captureCanvas");
const previewImage            = document.getElementById("previewImage");
const scorePill               = document.getElementById("scorePill");
const piercingFitPanel        = document.getElementById("piercingFitPanel");
const piercingFitScore        = document.getElementById("piercingFitScore");
const piercingFitSummary      = document.getElementById("piercingFitSummary");
const piercingFitList         = document.getElementById("piercingFitList");
const tipsList                = document.getElementById("tipsList");
const metricsGrid             = document.getElementById("metricsGrid");

// ---------------------------------------------------------------------------
// Face detection helpers
// ---------------------------------------------------------------------------
const supportsFaceDetector = typeof FaceDetector !== "undefined";
const faceDetector = supportsFaceDetector
  ? new FaceDetector({ maxDetectedFaces: 1, fastMode: true })
  : null;
const serverTrackingCanvas = document.createElement("canvas");

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------
const INSPIRATION_STORAGE_KEY    = "photoCoachPinterestInspirationV1";
const PINTEREST_AUTH_STORAGE_KEY = "photoCoachPinterestAuthHandleV1";

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------
let faceMesh             = null;
let faceMeshInitializing = false;
let detectedLandmarks    = null;
let detectedFaceShape    = "oval";  // Default shape
let liveFeatureMetrics   = null;
let noseAlignmentReady   = false;
let customOverlayImage     = null;    // HTMLImageElement of the processed pin PNG
let customOverlayPlacement = "septum"; // landmark anchor key for the custom overlay

let activeStream             = null;
let selectedBlob             = null;
let showedHardwareHint       = false;
let faceTrackingActive       = false;
let faceTrackingRafId        = null;
let faceTrackingMode         = "none";
let serverFaceTrackingTimer  = null;
let serverFaceTrackingBusy   = false;
let overlayRenderRafId       = null;
let targetTrackedBox         = null;
let renderedTrackedBox       = null;
let missedTrackingFrames     = 0;
let selectedFilter           = "none";
let selectedFilterScale      = 1.0;
let inspirationEntries       = [];
let pinterestAuthHandle      = null;
let pinterestConfig          = null;

// Initialized to null here; set to a real value in app.js after all modules load.
let selectedPhotoContext = null;

// ---------------------------------------------------------------------------
// Look-up tables
// ---------------------------------------------------------------------------
const FILTER_LABELS = {
  none:                  "None",
  septum:                "Septum Ring",
  "nose-stud-left":      "Nose Stud (Left)",
  "brow-left":           "Brow Ring (Left)",
  "earring-left":        "Hoop Earring (Left)",
  "earring-right":       "Hoop Earring (Right)",
  "custom-inspiration":  "Custom (from Inspiration)",
};

const PIERCING_STYLE_GUIDE = {
  septum: {
    preferredShapes: ["oval", "diamond", "round"],
    flexibleShapes:  ["heart"],
    alternatives:    ["nose-stud-left", "brow-left"],
    note: "Septum rings usually read best when the face has soft center balance or strong cheekbone symmetry.",
  },
  "nose-stud-left": {
    preferredShapes: ["heart", "oval", "square"],
    flexibleShapes:  ["diamond"],
    alternatives:    ["brow-left", "septum"],
    note: "Nose studs are the safest everyday option and usually work well when you want a lighter accent.",
  },
  "brow-left": {
    preferredShapes: ["square", "diamond", "oval"],
    flexibleShapes:  ["heart"],
    alternatives:    ["nose-stud-left", "earring-left"],
    note: "Brow rings suit faces that can carry a stronger upper-face detail without overpowering the center.",
  },
  "earring-left": {
    preferredShapes: ["oval", "heart", "round"],
    flexibleShapes:  ["square", "diamond"],
    alternatives:    ["earring-right", "nose-stud-left"],
    note: "Hoops usually flatter balanced or longer silhouettes because they widen the outer frame nicely.",
  },
  "earring-right": {
    preferredShapes: ["oval", "heart", "round"],
    flexibleShapes:  ["square", "diamond"],
    alternatives:    ["earring-left", "nose-stud-left"],
    note: "Hoops usually flatter balanced or longer silhouettes because they widen the outer frame nicely.",
  },
};

const PINTEREST_TAG_MAP = {
  septum:           ["septum", "bull", "horseshoe"],
  "nose-stud-left": ["nose stud", "nostril", "nostril stud", "nose pin", "tiny stud", "minimalist"],
  "brow-left":      ["brow", "eyebrow", "brow ring", "eyebrow ring"],
  "earring-left":   ["earring", "hoop", "huggie", "lobe", "cartilage"],
  "earring-right":  ["earring", "hoop", "huggie", "lobe", "cartilage"],
};
