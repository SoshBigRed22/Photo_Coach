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
// Inspiration-entry CRUD
// ---------------------------------------------------------------------------
function addInspirationEntry(rawUrl, note = "") {
  const normalizedUrl = normalizePinterestUrl(rawUrl);
  if (!normalizedUrl) throw new Error("Please paste a valid Pinterest link.");

  if (inspirationEntries.some((entry) => entry.url === normalizedUrl)) {
    throw new Error("That Pinterest link is already in your inspiration list.");
  }

  const combined = `${normalizedUrl} ${note}`;
  const entry    = {
    id:          `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url:         normalizedUrl,
    note:        note.trim(),
    styleTokens: parseStyleTokens(combined),
    addedAt:     Date.now(),
  };

  inspirationEntries = [entry, ...inspirationEntries].slice(0, 12);
  persistInspirationEntries();
  renderInspirationEntries();
  selectedPhotoContext = buildPhotoContext(selectedPhotoContext?.source || "empty");
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
      .map((entry) => ({
        id:          String(entry.id || `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        url:         normalizePinterestUrl(entry.url) || entry.url,
        note:        typeof entry.note === "string" ? entry.note : "",
        styleTokens: Array.isArray(entry.styleTokens)
          ? entry.styleTokens
          : parseStyleTokens(`${entry.url} ${entry.note || ""}`),
        addedAt:     Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now(),
      }))
      .filter((entry) => entry.url && entry.url.includes("pinterest"))
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

  for (const entry of inspirationEntries) {
    const li        = document.createElement("li");
    const link      = document.createElement("a");
    link.href        = entry.url;
    link.target      = "_blank";
    link.rel         = "noopener noreferrer";
    link.textContent = entry.note || entry.url;

    const removeBtn        = document.createElement("button");
    removeBtn.type         = "button";
    removeBtn.textContent  = "Remove";
    removeBtn.className    = "inspiration-remove-btn";
    removeBtn.addEventListener("click", () => removeInspirationEntry(entry.id));

    li.appendChild(link);
    li.appendChild(document.createTextNode(" "));
    li.appendChild(removeBtn);
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
