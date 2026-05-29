const APP_VERSION = "v5.0.10";
const API_URL = "https://script.google.com/macros/s/AKfycbyYTU_I0zel50EKpB767LmQ2NjeKudS93yv8-DYSYnBxaFS5_I1TWily79rOkMdGTu5IA/exec";
const BACKEND_URL = API_URL;

// ── OpenWeatherMap ───────────────────────────────────────────────────────────
// API key is stored in Google Apps Script Script Properties (key: OWM_API_KEY).
// The frontend never holds the key — it requests weather via the backend proxy.
const weatherCache        = new Map(); // key: "lat,lon" → { iconClass, temp, fetchedAt }
const WEATHER_CACHE_TTL   = 30 * 60 * 1000; // 30 minutes

// --- GLOBAL SHARED APPLICATION ENGINE MEMORY STATE ---
let currentUser = localStorage.getItem('compass_user');
let registeredUsersList = []; // cached from get_users fetch; used for profile rename duplicate check
let deviceId = localStorage.getItem('compass_device_id') || generateAndSaveDeviceId();
let travelSpots = JSON.parse(localStorage.getItem('compass_cache')) || [];
let checkedFilterStateArray = JSON.parse(localStorage.getItem('compass_active_filters')) || [];
let checkedCitiesStateArray = JSON.parse(localStorage.getItem('compass_active_cities')) || [];
let showStarredOnly = JSON.parse(localStorage.getItem('compass_starred_only')) || false;
let hideCompletedSpotsStateBool = localStorage.getItem('compass_hide_completed') !== null ? JSON.parse(localStorage.getItem('compass_hide_completed')) : true;
let currentMapStyleKey = localStorage.getItem('compass_map_style') || 'dark';

if (currentMapStyleKey === 'street') {
    currentMapStyleKey = 'terrain';
    localStorage.setItem('compass_map_style', 'terrain');
}

// Seed from last session if available; overwritten by live GPS on first fix.
// Falls back to Lisbon city-centre so distance math never operates on undefined.
const _storedLat = parseFloat(localStorage.getItem('compass_user_live_lat'));
const _storedLon = parseFloat(localStorage.getItem('compass_user_live_lng'));
let userLat = (!isNaN(_storedLat) && _storedLat !== 0) ? _storedLat : 38.7223;
let userLon = (!isNaN(_storedLon) && _storedLon !== 0) ? _storedLon : -9.1393;
let cachedHardwareString = "Unknown Device Model";
let gpsStatusCachedBool = false; 
let activeTabID = 'map';

let liveGpsWatchId = null; 
let speechBubbleHideTimer = null;
let continuousGpsFailsafeIntervalId = null; 
let lastGpsSuccessTime = 0; 
// Pre-populate from the last session so recenter is instant on first load,
// even before the GPS stream delivers its first fix this session.
// GPS success callbacks overwrite these values with live coordinates.
let cachedUserCoords = (() => {
    const lat = parseFloat(localStorage.getItem('compass_user_live_lat'));
    const lng = parseFloat(localStorage.getItem('compass_user_live_lng'));
    return (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0)
        ? { lat, lon: lng }
        : null;
})();
let isCameraLocked = false;
let gpsLastKnownDenied = false; // true only after a PERMISSION_DENIED error — enables instant modal-show
let _gpsSyncingInProgress = false; // true while a GPS request is in-flight — prevents duplicate pings
let _gpsSyncTimeoutId     = null;  // handle for the hard-timeout that auto-resolves a stuck "Syncing…" HUD
let currentMapBearingAngle = 0;
let mapTileCleanupTimerId = null;
let hasInitialGpsLockRendered = false;

let leafletMapInstance = null;
let mapMarkersLayerGroup = null;
let userPositionPulseCircle = null;
let userAccuracyRadiusCircle = null;
let activeBaseTileLayer = null;
let proximityRippleMarker  = null;  // divIcon marker that hosts the pink ring animation
let proximityRippleActive  = false; // whether the user is currently within 100 m of a spot

let startY = 0; 
let isPulling = false;
let pullDelta = 0; 

let noteGestureTimerId = null;
let isNoteZoomActive = false;
let noteGestureStartX = 0;
let noteGestureStartY = 0;
let formPriorityState = "Normal";

const ENABLE_MAP_ROTATION = false;

function parseReadableDeviceHardware() {
    const ua = navigator.userAgent;
    let os = "Unknown OS";
    if (/Android/i.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
    const width = window.screen.width; const height = window.screen.height;
    let modelEstimate = "";
    if (os === "Android") {
        if ((width === 360 && height === 800) || (width === 412 && height === 915)) modelEstimate = " (Likely Samsung S-Series)";
        else if (width === 412 && height === 892) modelEstimate = " (Likely Pixel)";
        else modelEstimate = " Mobile";
    } else if (os === "iOS") {
        if (width === 393 && height === 852) modelEstimate = " (iPhone Pro)";
        else if (width === 430 && height === 932) modelEstimate = " (iPhone Pro Max)";
        else modelEstimate = " Phone";
    }
    return `${os}${modelEstimate}`;
}

function generateAndSaveDeviceId() {
    const newId = "DEV-" + Math.random().toString(36).substring(2, 7).toUpperCase();
    localStorage.setItem('compass_device_id', newId); return newId;
}

// ----------------- NOTES GESTURE ENGINE -----------------
function initializeNoteGestureEngine(clientX, clientY, textContent) {
    if (!textContent || textContent.trim() === "") return;
    killNoteGestureEngine();
    
    noteGestureStartX = clientX;
    noteGestureStartY = clientY;
    
    noteGestureTimerId = setTimeout(() => {
        isNoteZoomActive = true;
        const overlay = document.getElementById('noteExpandedOverlayHUD');
        const overlayCard = document.getElementById('noteExpandedOverlayCard');
        const overlayText = document.getElementById('noteExpandedOverlayText');
        const scrollBox = document.getElementById('noteExpandedOverlayScrollBox');
        
        overlayText.innerText = textContent;
        if(scrollBox) scrollBox.scrollTop = 0;
        
        overlay.classList.remove('hidden');
        if (overlayCard) {
            overlayCard.classList.remove('note-zoom-closing');
            overlayCard.classList.add('note-zoom-active');
        }
        
        if(navigator.vibrate) navigator.vibrate(15);
    }, 500);
}

function handleNoteTouchStartEvent(e, text) {
    // NOTE: Do NOT call e.stopPropagation() here.
    // iOS WebKit needs the touchstart to bubble up to gesture-touch-container so
    // the scroll container can register the touch and initiate a scroll gesture.
    // stopPropagation would silently kill all scroll attempts starting on a note.
    initializeNoteGestureEngine(e.touches[0].clientX, e.touches[0].clientY, text);
}
function handleNoteTouchMoveEvent(e) { evaluateNoteGestureMovement(e.touches[0].clientX, e.touches[0].clientY); }
function handleNoteTouchEndEvent(e) { killNoteGestureEngine(); }

function handleNoteMouseDownEvent(e, text) { e.stopPropagation(); initializeNoteGestureEngine(e.clientX, e.clientY, text); }
function handleNoteMouseMoveEvent(e) { evaluateNoteGestureMovement(e.clientX, e.clientY); }
function handleNoteMouseUpEvent(e) { killNoteGestureEngine(); }

function evaluateNoteGestureMovement(currentX, currentY) {
    if (!noteGestureStartX || isNoteZoomActive) return;
    if (Math.abs(currentX - noteGestureStartX) > 15 || Math.abs(currentY - noteGestureStartY) > 15) killNoteGestureEngine();
}
function killNoteGestureEngine() { if (noteGestureTimerId) { clearTimeout(noteGestureTimerId); noteGestureTimerId = null; } }
function manuallyCloseNoteOverlayHUD() {
    isNoteZoomActive = false;
    const overlay = document.getElementById('noteExpandedOverlayHUD');
    if(overlay) overlay.classList.add('hidden');
}

// ----------------- PULL TO REFRESH -----------------
function setupNativePullToRefreshGestures() {
    const GESTURE_CONTAINER = document.getElementById('gesture-touch-container');
    const PULL_INDICATOR = document.getElementById('pullToRefreshIndicatorHUD');
    if (!GESTURE_CONTAINER) return;

    GESTURE_CONTAINER.addEventListener('touchstart', (e) => {
        if (GESTURE_CONTAINER.scrollTop === 0) { 
            startY = e.touches[0].pageY; 
            isPulling = true; 
            pullDelta = 0; 
        }
    }, { passive: true });

    GESTURE_CONTAINER.addEventListener('touchmove', (e) => {
        if (!isPulling) return;
        const currentY = e.touches[0].pageY; 
        pullDelta = currentY - startY; 
        
        if (pullDelta > 0) { 
            const heightBound = Math.min(pullDelta * 0.4, 50); 
            if(PULL_INDICATOR) PULL_INDICATOR.style.height = `${heightBound}px`; 
        }
    }, { passive: true });

    GESTURE_CONTAINER.addEventListener('touchend', () => {
        if (!isPulling) return; 
        isPulling = false;
        if(PULL_INDICATOR) PULL_INDICATOR.style.height = '0px';
        
        if (pullDelta > 40) {
            syncData(true);
        }
        pullDelta = 0; 
    }, { passive: true });

    GESTURE_CONTAINER.addEventListener('touchcancel', () => {
        if (!isPulling) return; 
        isPulling = false;
        if(PULL_INDICATOR) PULL_INDICATOR.style.height = '0px';
        pullDelta = 0; 
    }, { passive: true });
}

// ----------------- AUTH & SYNC -----------------
/** Shared helper — renders a users array into both dropdowns at once */
function _fillUserDropdowns(users) {
    const optionsHTML = '<option value="">Select User</option>'
        + users.map(u => `<option value="${u}">${u}</option>`).join('');
    const loginDrop   = document.getElementById('user-dropdown-select');
    const settingsDrop = document.getElementById('settingsSwitchUserDropdown');
    if (loginDrop)    loginDrop.innerHTML    = optionsHTML;
    if (settingsDrop) {
        settingsDrop.innerHTML = optionsHTML;
        if (currentUser) settingsDrop.value = currentUser;
    }
}

async function populateUserDropdown() {
    // ── Step 1: instant synchronous paint from localStorage cache ──────────
    // This runs before the async fetch, so the settings dropdown is never
    // empty even if the user opens it the millisecond after app load.
    const cachedUsers = JSON.parse(localStorage.getItem('compass_registered_users') || '[]');
    if (cachedUsers.length > 0) {
        registeredUsersList = cachedUsers;
        _fillUserDropdowns(cachedUsers);
    }

    // ── Step 2: background fetch to refresh the list from the server ────────
    try {
        const response = await fetch(`${BACKEND_URL}?action=get_users`);
        if (!response.ok) throw new Error('Failed to reach server');
        const freshUsers = await response.json();

        registeredUsersList = freshUsers;
        localStorage.setItem('compass_registered_users', JSON.stringify(freshUsers));
        _fillUserDropdowns(freshUsers); // silently update both dropdowns
    } catch (err) {
        console.error('Failed to load users:', err);
        // If we had nothing from cache either, show the error state
        if (cachedUsers.length === 0) {
            const select = document.getElementById('user-dropdown-select');
            if (select) select.innerHTML = '<option value="">Error: Server Unreachable</option>';
        }
        // Settings dropdown keeps whatever cache populated — still usable
    }
}

async function handleInitialLoginSubmit() {
    const dropdown    = document.getElementById('user-dropdown-select');
    const newNameInput = document.getElementById('customUsernameInput');
    const newName     = newNameInput ? newNameInput.value.trim() : '';
    const dropdownVal = dropdown ? dropdown.value.trim() : '';

    let selectedUser = '';

    if (newName.length >= 3) {
        // ── NEW REGISTRATION PATH ──────────────────────────────────────────
        // Defensive duplicate guard (validation UI should have caught this already)
        const isDup = registeredUsersList.some(u => u.toLowerCase() === newName.toLowerCase());
        if (isDup) return;

        try {
            await fetch(BACKEND_URL, {
                method: 'POST',
                mode:   'cors',
                body: JSON.stringify({ action: 'register_new_user', new_name: newName })
            });
            // Keep in-memory and localStorage cache accurate for the rest of the session
            registeredUsersList.push(newName);
            localStorage.setItem('compass_registered_users', JSON.stringify(registeredUsersList));
        } catch (err) {
            console.error('Failed to register new user on server:', err);
            // Continue anyway — user still gets a local session
        }
        selectedUser = newName;

    } else if (dropdownVal !== '') {
        // ── EXISTING USER PATH ─────────────────────────────────────────────
        selectedUser = dropdownVal;

    } else {
        // Nothing valid selected — button should be disabled so we never reach here
        return;
    }

    localStorage.setItem('compass_user', selectedUser);
    currentUser = selectedUser;
    document.getElementById('userModal').classList.add('hidden');
    initializeSessionDashboard();
}

// ─── LANDING PAGE VALIDATION ───────────────────────────────────────────────────

// Called by the "Or Register New" input field on every keystroke.
function validateLandingRegisterInput() {
    const input        = document.getElementById('customUsernameInput');
    const minCharWarn  = document.getElementById('landingRegisterMinCharWarning');
    const nameTakenWarn = document.getElementById('landingRegisterNameTakenWarning');
    const beginBtn     = document.getElementById('beginSessionBtn');
    const dropdown     = document.getElementById('user-dropdown-select');
    if (!input || !minCharWarn || !nameTakenWarn || !beginBtn) return;

    const val = input.value.trim();

    // Reset dropdown whenever the user is typing a new name
    if (val.length > 0 && dropdown) dropdown.value = '';

    if (val.length === 0) {
        // Input cleared — re-evaluate based on dropdown alone
        minCharWarn.classList.add('hidden');
        nameTakenWarn.classList.add('hidden');
        const hasDropdown = dropdown && dropdown.value.trim() !== '';
        _setBeginBtnState(beginBtn, hasDropdown);
        return;
    }

    if (val.length < 3) {
        minCharWarn.classList.remove('hidden');
        nameTakenWarn.classList.add('hidden');
        _setBeginBtnState(beginBtn, false);
        return;
    }

    minCharWarn.classList.add('hidden');
    const nameTaken = registeredUsersList.some(u => u.toLowerCase() === val.toLowerCase());
    if (nameTaken) {
        nameTakenWarn.classList.remove('hidden');
        _setBeginBtnState(beginBtn, false);
    } else {
        nameTakenWarn.classList.add('hidden');
        _setBeginBtnState(beginBtn, true);
    }
}

// Called when the dropdown selection changes.
function handleLandingDropdownChange() {
    const dropdown     = document.getElementById('user-dropdown-select');
    const newNameInput = document.getElementById('customUsernameInput');
    const minCharWarn  = document.getElementById('landingRegisterMinCharWarning');
    const nameTakenWarn = document.getElementById('landingRegisterNameTakenWarning');
    const beginBtn     = document.getElementById('beginSessionBtn');
    if (!dropdown || !beginBtn) return;

    // Selecting an existing user clears the new-name field and all warnings
    if (newNameInput) newNameInput.value = '';
    if (minCharWarn)  minCharWarn.classList.add('hidden');
    if (nameTakenWarn) nameTakenWarn.classList.add('hidden');

    _setBeginBtnState(beginBtn, dropdown.value.trim() !== '');
}

// Resets the entire user modal form to its initial empty/disabled state.
// Called whenever the modal is shown (logout, first load).
function resetUserModalForm() {
    const input        = document.getElementById('customUsernameInput');
    const dropdown     = document.getElementById('user-dropdown-select');
    const minCharWarn  = document.getElementById('landingRegisterMinCharWarning');
    const nameTakenWarn = document.getElementById('landingRegisterNameTakenWarning');
    const beginBtn     = document.getElementById('beginSessionBtn');
    if (input)        input.value = '';
    if (dropdown)     dropdown.value = '';
    if (minCharWarn)  minCharWarn.classList.add('hidden');
    if (nameTakenWarn) nameTakenWarn.classList.add('hidden');
    if (beginBtn)     _setBeginBtnState(beginBtn, false);
}

// Small helper — sets the Begin button's enabled/disabled visual state.
function _setBeginBtnState(btn, enabled) {
    btn.disabled = !enabled;
    if (enabled) {
        btn.classList.remove('opacity-40', 'cursor-not-allowed');
    } else {
        btn.classList.add('opacity-40', 'cursor-not-allowed');
    }
}

function initializeSessionDashboard() {
    syncData(true);
    updateNetworkStatusHUD(); 
}

async function syncData(isManualForce) {
    const syncText = document.getElementById('syncText');
    const syncIconFrame = document.getElementById('syncButtonIconFrame');
    const PULL_INDICATOR = document.getElementById('pullToRefreshIndicatorHUD');
    
    if (PULL_INDICATOR) PULL_INDICATOR.style.height = '0px';

    if (syncText && isManualForce) syncText.innerText = "Checking cloud...";
    if (syncIconFrame && isManualForce) syncIconFrame.classList.add('animate-spin');
    
    try {
        const response = await fetch(API_URL);
        const cloudData = await response.json();
        if(Array.isArray(cloudData)) {
            travelSpots = cloudData;
            localStorage.setItem('compass_cache', JSON.stringify(travelSpots));
            calculateSmartCityDefaultFilters(); 
            renderList(); 
            
            // Only recalculate the viewport if the user has no saved position from a prior
            // session. Returning users already have the map at the right spot; calling
            // setView({ reset: true }) again causes an unnecessary black-screen flash.
            if (typeof triggerOptimalLandingViewportRecalculation === 'function') {
                const hasSavedPosition = localStorage.getItem('compass_map_state_lat')
                                      && localStorage.getItem('compass_map_state_lng');
                if (!hasSavedPosition) triggerOptimalLandingViewportRecalculation();
            }
            if (typeof plotDynamicMarkersOnCanvasMap === 'function') {
                plotDynamicMarkersOnCanvasMap();
            }
            if (typeof buildItinerarySubMenuChecklist === 'function') {
                buildItinerarySubMenuChecklist();
            }
            if (typeof loadUserItineraries === 'function') {
                await loadUserItineraries();
            }
            
            updateNetworkStatusHUD();

            if (typeof prefetchBordersCountryTilesMapEngine === 'function') {
                prefetchBordersCountryTilesMapEngine();
            }
        }
    } catch (e) { 
        if(syncText) syncText.innerText = "Offline Mode"; 
    } finally {
        if (syncIconFrame) {
            setTimeout(() => { syncIconFrame.classList.remove('animate-spin'); }, 400);
        }
    }
}

async function updateCloudAction(rowId, action, value) {
    // NOTE: spot name is intentionally NOT taken as a parameter — embedding
    // spot_name in inline onclick strings breaks on any name containing a
    // single-quote (e.g. "Jim's Bar"). We look it up from travelSpots instead.
    const target = travelSpots.find(s => s.rowid === rowId);
    const resolvedSpotName = target ? (target.spot_name || '') : '';

    if (target) {
        if (action === 'update_status') target.status = value;
        if (action === 'toggle_priority') target.priority = value;

        // Use the animated renderer so cards glide to their new sorted positions
        // instead of snapping instantly.  Falls back to a plain renderList() when
        // the list panel is not active (animation would have no visible effect).
        if (activeTabID === 'list') {
            renderListAnimated(rowId, action, value);
        } else {
            renderList();
        }
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    }
    if (typeof silentPassiveHardwareLocationPingRefresh === 'function') silentPassiveHardwareLocationPingRefresh();
    try {
        await fetch(API_URL, {
            method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowId, action, value, spot: resolvedSpotName, deviceMeta: cachedHardwareString })
        });
    } catch(err) {}
}

async function submitNewSpotToCloud() {
    const url = document.getElementById('new-url').value;
    const mapsUrl = document.getElementById('new-maps-url').value;
    const city = document.getElementById('new-city').value;
    const cat = document.getElementById('new-category').value;
    const keyword = document.getElementById('new-keyword').value;
    const notes = document.getElementById('new-notes').value;
    const submitBtn = document.getElementById('form-submit-btn');

    if(!keyword) { alert("Provide a keyword title for the spot asset."); return; }
    if(!url && !mapsUrl) { alert("Please provide at least a Reference Link or a Google Maps Link."); return; }
    
    submitBtn.innerHTML = "<i class='fa-solid fa-arrows-rotate animate-spin mr-2'></i> Injecting into Sheet Database..."; 
    submitBtn.disabled = true;

    try {
        await fetch(API_URL, {
            method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'append_new_spot', 
                city: city || 'Global', 
                spot_name: keyword, 
                category: cat || 'General', 
                instagram_url: url, 
                maps_url: mapsUrl, 
                notes: notes, 
                priority: formPriorityState, 
                deviceMeta: cachedHardwareString 
            })
        });
        document.getElementById('new-url').value = ''; 
        document.getElementById('new-maps-url').value = ''; 
        document.getElementById('new-city').value = ''; 
        document.getElementById('new-category').value = ''; 
        document.getElementById('new-keyword').value = ''; 
        document.getElementById('new-notes').value = '';
        toggleQuickAddModal(false); setTimeout(() => syncData(true), 1000);
    } catch(err) { alert("Submission timed out."); } 
    finally { submitBtn.innerHTML = "<i class='fa-solid fa-floppy-disk mr-2'></i> Save"; submitBtn.disabled = false; }
}

// ----------------- UI / TABS / MENUS -----------------
function switchMasterMenuDashboardTab(targetTabID) {
    killLiveSpeechBubbleHUDState();
    if(typeof dismissMapDetailTrayHUDCard === 'function') dismissMapDetailTrayHUDCard();

    if(targetTabID === activeTabID) return;
    
    const currentTabBtn = document.getElementById(`nav-tab-${activeTabID}`);
    currentTabBtn.className = "nav-tab-transition flex flex-col items-center gap-0.5 text-slate-500 opacity-50 scale-100 font-medium translate-y-0 brightness-100";
    document.getElementById(`view-${activeTabID}`).classList.remove('active-view');
    
    const nextTabBtn = document.getElementById(`nav-tab-${targetTabID}`);
    nextTabBtn.className = "nav-tab-transition flex flex-col items-center gap-0.5 text-pink-500 scale-110 font-black tracking-wide translate-y-[-2px] brightness-125";
    document.getElementById(`view-${targetTabID}`).classList.add('active-view');
    
    activeTabID = targetTabID;

    const priorityEl = document.getElementById('priorityFilterContainer');
    const typeEl = document.getElementById('filterMenuTriggerBtn');
    if (targetTabID === 'itinerary') {
        // The HUD "All / Starred" toggle is active on the itinerary tab too —
        // it filters itinerary master cards instead of saved spots.
        if (priorityEl) priorityEl.classList.remove('opacity-35', 'pointer-events-none');
        // Type/category filter is still saved-spots–only; keep it dimmed.
        if (typeEl) typeEl.classList.add('opacity-35', 'pointer-events-none');
        closeAllActiveHUDDropdownOverlays();
        // Reflect the remembered itinerary filter state in the shared toggle UI.
        syncPriorityFilterViewModeUI();

        const masterListView = document.getElementById('itineraryMasterListView');
        if (masterListView) masterListView.classList.remove('hidden');
        const detailView = document.getElementById('itineraryDetailView');
        if (detailView) detailView.classList.add('hidden');

        if(typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    } else {
        if (priorityEl) priorityEl.classList.remove('opacity-35', 'pointer-events-none');
        if (typeEl) typeEl.classList.remove('opacity-35', 'pointer-events-none');
        syncPriorityFilterViewModeUI();
        updateHeaderBadgeHUDCounters();
    }

    if(targetTabID === 'map' && typeof leafletMapInstance !== 'undefined' && leafletMapInstance) {
        setTimeout(() => {
            leafletMapInstance.invalidateSize();
            const savedLat = localStorage.getItem('compass_map_state_lat');
            const savedLng = localStorage.getItem('compass_map_state_lng');
            const savedZoom = localStorage.getItem('compass_map_state_zoom') || '12';
            if (savedLat && savedLng) {
                leafletMapInstance.setView([parseFloat(savedLat), parseFloat(savedLng)], parseInt(savedZoom), { animate: false });
            } else if(typeof gpsStatusCachedBool !== 'undefined' && gpsStatusCachedBool) {
                leafletMapInstance.setView([userLat, userLon], 18, { animate: false });
            }
            // Check for nearby hidden spots whenever the user lands on the map tab
            if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
            // Refresh map weather widget for the current viewport centre
            if (typeof refreshMapWeatherWidget === 'function') refreshMapWeatherWidget();
        }, 50);
    } else {
        // Navigating away from map — close drawer and clear HUD
        if (typeof closeHiddenPinsDrawer === 'function') closeHiddenPinsDrawer();
        if (typeof clearHiddenPinsSystemHUD === 'function') clearHiddenPinsSystemHUD();
    }
}

function killLiveSpeechBubbleHUDState() {
    const globalBubbleHUD = document.getElementById('globalToastSpeechBubbleHUD');
    if (globalBubbleHUD) {
        globalBubbleHUD.classList.add('hidden');
        globalBubbleHUD.classList.remove('bubble-popup-anim', 'bubble-popdown-anim');
    }
    if(speechBubbleHideTimer) clearTimeout(speechBubbleHideTimer);
}

/**
 * Show a speech-bubble tooltip anchored above a given element.
 *
 * @param {string}      message       - Text to display inside the bubble.
 * @param {HTMLElement} anchorElement - The button/element to point at.
 * @param {Event}       [event]       - Originating event (unused, kept for call-site compat).
 */
function triggerCuteSpeechBubbleHUD(message, anchorElement, event) {
    const hud      = document.getElementById('globalToastSpeechBubbleHUD');
    const textNode = document.getElementById('speechBubbleTextContainer');
    const pointer  = document.getElementById('bubblePointerNode');
    if (!hud || !textNode) return;

    // Tear down any currently-visible bubble / pending hide timer
    killLiveSpeechBubbleHUDState();

    textNode.textContent = message;

    if (anchorElement) {
        const rect          = anchorElement.getBoundingClientRect();
        const anchorCenterX = rect.left + rect.width / 2;
        const bubbleWidth   = 240;
        const margin        = 8;

        // Centre the bubble on the anchor horizontally, clamped to viewport edges
        let leftPos = anchorCenterX - bubbleWidth / 2;
        leftPos = Math.max(margin, Math.min(window.innerWidth - bubbleWidth - margin, leftPos));

        // The HUD origin sits at the TOP of the anchor button.
        // The CSS animation translates the inner div upward by 100% + 8 px gap,
        // so the bubble floats above the button with the pointer aimed at it.
        hud.style.left = leftPos + 'px';
        hud.style.top  = rect.top  + 'px';

        // Slide the pointer diamond so it lines up with the anchor's horizontal centre
        if (pointer) {
            const pLeft = Math.max(8, Math.min(bubbleWidth - 20, Math.round(anchorCenterX - leftPos - 6)));
            pointer.style.left  = pLeft + 'px';
            pointer.style.right = 'auto';
        }
    }

    // Reveal with pop-in animation (force reflow so re-triggering the same animation works)
    hud.classList.remove('hidden');
    hud.classList.remove('bubble-popup-anim');
    void hud.offsetWidth;
    hud.classList.add('bubble-popup-anim');

    // Auto-dismiss after 2.6 s
    speechBubbleHideTimer = setTimeout(() => {
        killLiveSpeechBubbleHUDState();
    }, 2600);
}

function toggleCityDropdownOverlayMenu(event) {
    event.stopPropagation();
    killLiveSpeechBubbleHUDState();
    
    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

    const box = document.getElementById('cityHUDDropdownPopupBox');
    const backdrop = document.getElementById('dropdownBlurBackdrop');
    document.getElementById('filterCategoryDropdownPopupBox').classList.add('hidden');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); backdrop.classList.add('hidden'); } 
    else { box.classList.remove('hidden'); backdrop.classList.remove('hidden'); calculateSmartCityDefaultFilters(); }
}

function toggleFilterDropdownOverlayMenu(event) {
    if (activeTabID === 'itinerary') return;
    event.stopPropagation();
    killLiveSpeechBubbleHUDState();
    
    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

    const box = document.getElementById('filterCategoryDropdownPopupBox');
    const backdrop = document.getElementById('dropdownBlurBackdrop');
    document.getElementById('cityHUDDropdownPopupBox').classList.add('hidden');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); backdrop.classList.add('hidden'); } 
    else { box.classList.remove('hidden'); backdrop.classList.remove('hidden'); buildDynamicShoppingCheckboxList(); }
}

function closeAllActiveHUDDropdownOverlays() {
    document.getElementById('cityHUDDropdownPopupBox').classList.add('hidden');
    document.getElementById('filterCategoryDropdownPopupBox').classList.add('hidden');
    document.getElementById('dropdownBlurBackdrop').classList.add('hidden');
}

function toggleQuickAddModal(show) { document.getElementById('quickAddModal').classList.toggle('hidden', !show); }

function toggleFormPriorityState() {
    const btn = document.getElementById('form-priority-btn');
    if(formPriorityState === "Normal") {
        formPriorityState = "Starred"; btn.innerHTML = '<i class="fa-solid fa-star mr-1"></i> Starred';
        btn.className = "px-4 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500 text-amber-400 font-extrabold";
    } else {
        formPriorityState = "Normal"; btn.innerHTML = 'Normal';
        btn.className = "px-4 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 font-bold";
    }
}

// ----------------- FILTERS & LIST VIEW -----------------
function setPriorityFilterState(shouldShowStarredOnly) {
    killLiveSpeechBubbleHUDState();
    if (activeTabID === 'itinerary') {
        // On the itinerary tab the toggle filters itinerary master cards,
        // not saved spots — delegate to the itinerary-specific setter.
        if (typeof setItinFilterState === 'function') setItinFilterState(shouldShowStarredOnly);
        syncPriorityFilterViewModeUI();
        return;
    }
    showStarredOnly = shouldShowStarredOnly;
    localStorage.setItem('compass_starred_only', JSON.stringify(showStarredOnly));
    syncPriorityFilterViewModeUI();
    renderList();
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

function syncPriorityFilterViewModeUI() {
    const showAllBtn = document.getElementById('toggleOptionShowAll');
    const starredBtn = document.getElementById('toggleOptionStarred');
    if (!showAllBtn || !starredBtn) return;
    // On the itinerary tab, reflect the itinerary-specific star filter;
    // on all other tabs, reflect the saved-spots star filter.
    const isStarred = (activeTabID === 'itinerary')
        ? (typeof itinShowStarredOnly !== 'undefined' ? itinShowStarredOnly : false)
        : showStarredOnly;
    if (isStarred) {
        showAllBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-slate-500 bg-transparent";
        starredBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-amber-400 bg-amber-500/10";
    } else {
        showAllBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-amber-400 bg-amber-500/10";
        starredBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-slate-500 bg-transparent";
    }
}

function calculateSmartCityDefaultFilters() {
    const container = document.getElementById('cityHUDChecklistContainer');
    if (!container) return; container.innerHTML = '';
    let citySet = new Set();
    // On the itinerary tab build the city list from itinerary data, not spots.
    if (activeTabID === 'itinerary') {
        if (typeof savedItineraries !== 'undefined') {
            savedItineraries.forEach(itin => {
                if (itin.city && String(itin.city).trim() !== '') citySet.add(itin.city.trim());
            });
        }
    } else {
        travelSpots.forEach(spot => { if (spot.city && String(spot.city).trim() !== "") citySet.add(spot.city.trim()); });
    }
    if (citySet.size === 0) {
        container.innerHTML = `<div class="text-slate-500 text-[11px] p-2">No cities recorded</div>`; return;
    }
    citySet.forEach(city => {
        const label = document.createElement('label');
        label.className = "flex items-center justify-between p-2 rounded-lg hover:bg-slate-800 cursor-pointer";
        const isChecked = checkedCitiesStateArray.includes(city);
        label.innerHTML = `<span class="truncate pr-2">${city}</span><input type="checkbox" value="${city}" ${isChecked ? 'checked' : ''} onchange="handleCityHUDCheckboxEventToggle(this)" class="w-3.5 h-3.5 accent-pink-500 rounded bg-slate-950">`;
        container.appendChild(label);
    });
    updateCityHUDTriggerButtonLabelText();
}

function handleCityHUDCheckboxEventToggle(checkboxElement) {
    const val = checkboxElement.value;
    if (checkboxElement.checked) { if(!checkedCitiesStateArray.includes(val)) checkedCitiesStateArray.push(val); }
    else { checkedCitiesStateArray = checkedCitiesStateArray.filter(c => c !== val); }
    localStorage.setItem('compass_active_cities', JSON.stringify(checkedCitiesStateArray));
    updateCityHUDTriggerButtonLabelText();
    if (activeTabID === 'itinerary') {
        // On the itinerary tab, re-render the itinerary master list
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    } else {
        renderList();
        if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        // City filter changed — re-evaluate hidden spot proximity
        if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
    }
}

function clearAllSelectedCityCheckboxes() {
    checkedCitiesStateArray = []; localStorage.setItem('compass_active_cities', JSON.stringify([]));
    const checkboxes = document.getElementById('cityHUDChecklistContainer').querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    updateCityHUDTriggerButtonLabelText();
    if (activeTabID === 'itinerary') {
        // On the itinerary tab, re-render the itinerary master list
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    } else {
        renderList();
        if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        // City filter cleared — no hidden spots possible, dismiss any active HUD
        if (typeof clearHiddenPinsSystemHUD === 'function') clearHiddenPinsSystemHUD();
    }
}

function updateCityHUDTriggerButtonLabelText() {
    const textNode = document.getElementById('cityHUDTriggerText');
    const btn = document.getElementById('cityFilterHUDTriggerBtn');
    const count = checkedCitiesStateArray.length;
    if (count === 0) {
        textNode.innerText = "All Cities";
        btn.className = "w-full bg-slate-950 border border-slate-800/80 rounded-xl h-[38px] px-2 text-center text-[11px] font-black text-slate-300 flex items-center justify-center gap-1 truncate shadow-inner";
    } else {
        textNode.innerText = count === 1 ? checkedCitiesStateArray[0] : `Cities (${count})`;
        btn.className = "w-full bg-pink-500/10 border border-pink-500/30 rounded-xl h-[38px] px-2 text-center text-[11px] font-black text-pink-400 flex items-center justify-center gap-1 truncate shadow-inner";
    }
}

function buildDynamicShoppingCheckboxList() {
    const scrollContainer = document.getElementById('checkboxScrollRegionContainer');
    const stickyPanel = document.getElementById('hideCompletedTargetRowContainer');
    if(!scrollContainer || !stickyPanel) return;
    scrollContainer.innerHTML = ''; stickyPanel.innerHTML = '';
    
    let uniqueCategories = new Set();
    travelSpots.forEach(spot => { if (spot.category) spot.category.split(',').forEach(c => uniqueCategories.add(c.trim())); });
    
    uniqueCategories.forEach(cat => {
        if(!cat) return;
        const label = document.createElement('label');
        label.className = "flex items-center justify-between p-2 rounded-lg hover:bg-slate-800 cursor-pointer";
        label.innerHTML = `<span class="truncate pr-2">${cat}</span><input type="checkbox" value="${cat}" ${checkedFilterStateArray.includes(cat) ? 'checked' : ''} onchange="handleCheckboxToggleEvent(this)" class="w-3.5 h-3.5 accent-pink-500 rounded bg-slate-950">`;
        scrollContainer.appendChild(label);
    });

    const hideCompletedLabel = document.createElement('label');
    hideCompletedLabel.className = "flex items-center justify-between p-2 rounded-lg bg-pink-500/5 hover:bg-pink-500/10 text-pink-400 cursor-pointer text-xs font-bold w-full";
    hideCompletedLabel.innerHTML = `<span class="truncate pr-2 font-black">Hide Completed</span><input type="checkbox" id="hideCompletedFilterSystemCheckbox" ${hideCompletedSpotsStateBool ? 'checked' : ''} onchange="handleHideCompletedStateToggleCheckboxEvent(this)" class="w-3.5 h-3.5 accent-pink-500 rounded bg-slate-950">`;
    stickyPanel.appendChild(hideCompletedLabel);
    updateHeaderBadgeHUDCounters();
}

function handleCheckboxToggleEvent(checkboxElement) {
    const val = checkboxElement.value;
    if (checkboxElement.checked) { if(!checkedFilterStateArray.includes(val)) checkedFilterStateArray.push(val); }
    else { checkedFilterStateArray = checkedFilterStateArray.filter(i => i !== val); }
    localStorage.setItem('compass_active_filters', JSON.stringify(checkedFilterStateArray));
    updateHeaderBadgeHUDCounters(); renderList();
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
    // If type filter changed, re-evaluate whether nearby hidden spots need alerting
    if (typeof checkForNearbyHiddenSpots === 'function') checkForNearbyHiddenSpots();
}

function handleHideCompletedStateToggleCheckboxEvent(checkboxElement) {
    hideCompletedSpotsStateBool = checkboxElement.checked;
    localStorage.setItem('compass_hide_completed', JSON.stringify(hideCompletedSpotsStateBool));
    renderList(); 
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

function clearAllFilterCheckboxes() {
    checkedFilterStateArray = [];
    localStorage.setItem('compass_active_filters', JSON.stringify([]));
    const checkboxes = document.getElementById('checkboxScrollRegionContainer').querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    updateHeaderBadgeHUDCounters(); renderList();
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
    // Type filter cleared — no hidden spots possible, dismiss any active HUD
    if (typeof clearHiddenPinsSystemHUD === 'function') clearHiddenPinsSystemHUD();
}

function updateHeaderBadgeHUDCounters() {
    const badge = document.getElementById('activeFilterBadgeCount');
    const btn = document.getElementById('filterMenuTriggerBtn');
    if(!btn) return;
    const count = checkedFilterStateArray.length;
    if(count > 0) {
        if(badge) { badge.innerText = count; badge.classList.remove('hidden'); }
        btn.className = "w-full bg-pink-500/10 border border-pink-500/30 rounded-xl h-[38px] text-center text-[11px] font-black text-pink-400 flex items-center justify-center gap-1 shadow-inner";
    } else {
        if(badge) badge.classList.add('hidden');
        btn.className = "w-full bg-slate-950 border border-slate-800/80 rounded-xl h-[38px] text-center text-[11px] font-black text-slate-300 flex items-center justify-center gap-1 shadow-inner";
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; const dLat = (lat2 - lat1) * Math.PI / 180; const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Hidden Pins Alert Banner ─────────────────────────────────────────────────
// Shows a sliding banner on the map tab when the user is within 500m of spots
// that are hidden because both a city filter AND a type filter are active.
// After dismissal the banner shrinks into a small red bubble with a periodic
// attention wiggle. Tapping the bubble re-opens the banner.
// ────────────────────────────────────────────────────────────────────────────

let hiddenPinsBannerIsVisible    = false;  // sliding banner currently shown
let hiddenPinsMiniBubbleVisible  = false;  // shrunken bubble currently shown
let hiddenPinsBubbleAttentionLoop = null;  // setInterval handle for icon wiggle
let hiddenPinsLastTriggeredCount  = 0;     // spot count when banner last opened

function checkForNearbyHiddenSpots() {
    // Only act when the user is on the map tab
    if (typeof activeTabID === 'undefined' || activeTabID !== 'map') return;

    // Feature only fires when BOTH a city AND a type filter are active
    if (!checkedCitiesStateArray.length || !checkedFilterStateArray.length) {
        clearHiddenPinsSystemHUD();
        return;
    }

    // Need a live GPS fix to know where the user is
    if (!gpsStatusCachedBool || typeof userLat === 'undefined' || typeof userLon === 'undefined') return;

    // Count spots that pass the city filter but FAIL the type filter and are within 500 m
    const hiddenNearbyCount = travelSpots.filter(spot => {
        if (!checkedCitiesStateArray.includes(spot.city)) return false;             // must match city
        const spotCats = spot.category
            ? spot.category.split(',').map(c => c.trim().toLowerCase())
            : [];
        const passesType = checkedFilterStateArray.some(f => spotCats.includes(f.toLowerCase()));
        if (passesType) return false;                                               // visible — skip
        const lat = parseFloat(spot.latitude);
        const lon = parseFloat(spot.longitude);
        if (!lat || !lon) return false;                                             // no coordinates
        return calculateDistance(userLat, userLon, lat, lon) <= 0.5;               // within 500 m
    }).length;

    if (hiddenNearbyCount > 0) {
        // Show or refresh the banner only when neither UI element is already up
        if (!hiddenPinsBannerIsVisible && !hiddenPinsMiniBubbleVisible) {
            showHiddenPinsBannerHUD(hiddenNearbyCount);
        } else {
            hiddenPinsLastTriggeredCount = hiddenNearbyCount;   // keep count in sync
        }
    } else {
        clearHiddenPinsSystemHUD();
    }
}

function showHiddenPinsBannerHUD(count) {
    const banner   = document.getElementById('hiddenPinsAlertBanner');
    const subtitle = document.getElementById('hiddenPinsAlertBannerSubtitle');
    if (!banner) return;

    hiddenPinsLastTriggeredCount = count;

    if (subtitle) {
        const word = count === 1 ? 'spot' : 'spots';
        const verb = count === 1 ? "it's" : "they're";
        subtitle.textContent = `You're near ${count} saved ${word}, but ${verb} hidden by the active type filter.`;
    }

    // Make sure the bubble is gone before showing the banner
    const bubble = document.getElementById('hiddenPinsMiniBubble');
    if (bubble) bubble.classList.add('hidden');
    hiddenPinsMiniBubbleVisible = false;
    stopHiddenPinsBubbleAttentionLoop();

    // Trigger slide-in animation (force reflow to replay it if already animated)
    banner.classList.remove('hidden-pins-banner-enter', 'hidden-pins-banner-exit');
    banner.classList.remove('hidden');
    void banner.offsetWidth;
    banner.classList.add('hidden-pins-banner-enter');
    hiddenPinsBannerIsVisible = true;
}

function dismissHiddenPinsBannerToMiniBubble() {
    const banner = document.getElementById('hiddenPinsAlertBanner');
    const bubble = document.getElementById('hiddenPinsMiniBubble');
    if (!banner) return;

    // Slide banner back up
    banner.classList.remove('hidden-pins-banner-enter');
    banner.classList.add('hidden-pins-banner-exit');

    setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('hidden-pins-banner-exit');
        hiddenPinsBannerIsVisible = false;

        // Reveal the mini bubble and start its attention loop
        if (bubble) {
            bubble.classList.remove('hidden');
            hiddenPinsMiniBubbleVisible = true;
            startHiddenPinsBubbleAttentionLoop();
        }
    }, 280);
}

function unhideHiddenPinsBannerAction() {
    // Clear the type filter so all pins in the active city become visible again
    clearAllFilterCheckboxes();
    clearHiddenPinsSystemHUD();
}

function clearHiddenPinsSystemHUD() {
    const banner = document.getElementById('hiddenPinsAlertBanner');
    const bubble = document.getElementById('hiddenPinsMiniBubble');

    if (banner && !banner.classList.contains('hidden')) {
        banner.classList.remove('hidden-pins-banner-enter');
        banner.classList.add('hidden-pins-banner-exit');
        setTimeout(() => {
            banner.classList.add('hidden');
            banner.classList.remove('hidden-pins-banner-exit');
        }, 260);
    }
    hiddenPinsBannerIsVisible = false;

    if (bubble) bubble.classList.add('hidden');
    hiddenPinsMiniBubbleVisible   = false;
    hiddenPinsLastTriggeredCount  = 0;
    stopHiddenPinsBubbleAttentionLoop();

    // Also close the drawer if it happens to be open
    if (typeof closeHiddenPinsDrawer === 'function') closeHiddenPinsDrawer();
}

function startHiddenPinsBubbleAttentionLoop() {
    stopHiddenPinsBubbleAttentionLoop();

    const fireWiggle = () => {
        if (!hiddenPinsMiniBubbleVisible) return;
        const icon = document.getElementById('hiddenPinsMiniBubbleIcon');
        if (!icon) return;
        icon.classList.remove('hidden-pins-bubble-attention');
        void icon.offsetWidth;
        icon.classList.add('hidden-pins-bubble-attention');
        // Clean up class once the animation finishes so it can replay next time
        setTimeout(() => icon.classList.remove('hidden-pins-bubble-attention'), 800);
    };

    // First wiggle after 2.5 s so the bubble has a moment to settle
    setTimeout(fireWiggle, 2500);
    // Then repeat every 6 s
    hiddenPinsBubbleAttentionLoop = setInterval(fireWiggle, 6000);
}

function stopHiddenPinsBubbleAttentionLoop() {
    if (hiddenPinsBubbleAttentionLoop !== null) {
        clearInterval(hiddenPinsBubbleAttentionLoop);
        hiddenPinsBubbleAttentionLoop = null;
    }
}

function reopenHiddenPinsBanner() {
    // Bubble tap now opens the detailed drawer instead of the simple banner
    openHiddenPinsDrawer();
}

// ── Hidden Pins Drawer ───────────────────────────────────────────────────────
// Left-side slide-in panel that lists every spot hidden by the active type
// filter, grouped into Starred and Unstarred sections.
// Each row shows the category icon, spot name, a reference link, and a
// per-spot Unhide button that adds that spot's category to the type filter.
// "Unhide All" at the bottom clears the type filter entirely.
// ────────────────────────────────────────────────────────────────────────────

// Maps a category string to a Font Awesome icon class + colour class pair.
// Used by the drawer rows, the list-card badges, and the map-tray badge.
// Mirrors the marker icon logic in map.js so all three views stay in sync.
function getCategoryIconClass(category) {
    const s = (category || "").toLowerCase();
    if (s.includes("photo"))     return "fa-camera-retro text-pink-500";
    if (s.includes("food"))      return "fa-utensils text-orange-500";
    if (s.includes("viewpoint")) return "fa-binoculars text-sky-500";
    if (s.includes("nature"))    return "fa-leaf text-emerald-500";
    if (s.includes("culture"))   return "fa-landmark text-violet-500";
    if (s.includes("shopping") || s.includes("shop")) return "fa-bag-shopping text-rose-500";
    if (s.includes("activity"))  return "fa-person-running text-amber-500";
    if (s.includes("relax"))     return "fa-spa text-teal-500";
    if (s.includes("nightlife") || s.includes("bar") || s.includes("drink")) return "fa-martini-glass text-indigo-500";
    return "fa-location-dot text-slate-400";
}
// Legacy alias — keeps the drawer code working without any other edits
const getCategoryIconClassForDrawer = getCategoryIconClass;

// ── Weather helpers ──────────────────────────────────────────────────────────
// Maps OpenWeatherMap icon codes (e.g. "01d", "10n") → Font Awesome 6 Free class strings.
function getWeatherFAIconClass(owmIconCode) {
    const c = (owmIconCode || '').substring(0, 2);
    if (c === '01') return 'fa-sun text-yellow-400';
    if (c === '02') return 'fa-cloud-sun text-yellow-300';
    if (c === '03') return 'fa-cloud text-slate-300';
    if (c === '04') return 'fa-cloud text-slate-400';
    if (c === '09') return 'fa-cloud-showers-heavy text-blue-400';
    if (c === '10') return 'fa-cloud-rain text-blue-300';
    if (c === '11') return 'fa-cloud-bolt text-amber-400';
    if (c === '13') return 'fa-snowflake text-sky-300';
    if (c === '50') return 'fa-smog text-slate-300';
    return 'fa-cloud text-slate-400';
}

// Fetches current weather for the given lat/lon. Results are cached for 30 min.
// Returns { iconClass, temp } on success, or null on network error.
async function fetchWeatherForCoords(lat, lon) {
    const key    = `${parseFloat(lat).toFixed(3)},${parseFloat(lon).toFixed(3)}`;
    const cached = weatherCache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < WEATHER_CACHE_TTL) return cached;
    try {
        // Route through the Apps Script backend — the OWM key never touches the client.
        const res  = await fetch(
            `${BACKEND_URL}?action=get_weather&lat=${lat}&lon=${lon}`
        );
        const data = await res.json();
        if (data.error) return null;
        const iconClass  = getWeatherFAIconClass(data.icon || '');
        const temp       = Math.round(data.temp       ?? 0);
        const feelsLike  = Math.round(data.feels_like ?? data.temp ?? 0);
        const result     = { iconClass, temp, feelsLike, fetchedAt: Date.now() };
        weatherCache.set(key, result);
        return result;
    } catch (e) {
        return null;
    }
}

// Walks all currently-rendered list cards and fills in their weather badges.
// Skips spots with no coordinates (they show the disabled state from render time).
async function refreshAllWeatherBadges() {
    for (const spot of travelSpots) {
        const latStr = spot.latitude  ? String(spot.latitude).trim()  : '';
        const lngStr = spot.longitude ? String(spot.longitude).trim() : '';
        if (!latStr || latStr === '0' || !lngStr || lngStr === '0') continue;
        const el = document.getElementById(`weather-badge-${spot.rowid}`);
        if (!el) continue;
        const w = await fetchWeatherForCoords(parseFloat(latStr), parseFloat(lngStr));
        if (w) {
            el.innerHTML = `<i class="fa-solid ${w.iconClass} text-[10px]"></i><span>${w.temp}°</span>`;
        }
    }
}

function openHiddenPinsDrawer() {
    const overlay = document.getElementById('hiddenPinsDrawerOverlay');
    const panel   = document.getElementById('hiddenPinsDrawerPanel');
    if (!overlay || !panel) return;

    // Stop the bubble's attention wiggle while the drawer is open
    stopHiddenPinsBubbleAttentionLoop();

    renderHiddenPinsDrawerContent();

    overlay.classList.remove('hidden');
    panel.classList.remove('hidden-pins-drawer-enter', 'hidden-pins-drawer-exit');
    void panel.offsetWidth;
    panel.classList.add('hidden-pins-drawer-enter');
}

function renderHiddenPinsDrawerContent() {
    const body       = document.getElementById('hiddenPinsDrawerBody');
    const countLabel = document.getElementById('hiddenPinsDrawerCount');
    if (!body) return;

    // Collect ALL spots hidden by the type filter (not just nearby ones —
    // the drawer gives the user the full picture)
    const hiddenSpots = travelSpots.filter(spot => {
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(spot.city)) return false;
        if (!checkedFilterStateArray.length) return false;
        const spotCats = spot.category
            ? spot.category.split(',').map(c => c.trim().toLowerCase())
            : [];
        return !checkedFilterStateArray.some(f => spotCats.includes(f.toLowerCase()));
    });

    if (countLabel) {
        const n = hiddenSpots.length;
        countLabel.textContent = n === 0 ? 'All spots are visible' : `${n} spot${n !== 1 ? 's' : ''} hidden by type filter`;
    }

    body.innerHTML = '';

    if (hiddenSpots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'flex flex-col items-center justify-center py-12 gap-3';
        empty.innerHTML = `
            <div class="w-11 h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                <i class="fa-solid fa-eye text-emerald-400 text-base"></i>
            </div>
            <p class="text-[11px] text-slate-400 font-bold">All spots are now visible!</p>`;
        body.appendChild(empty);
        return;
    }

    const isStarredFn = s => ['high', '🔥', 'must do', 'starred'].includes((s.priority || "").toLowerCase());
    const starred   = hiddenSpots.filter(isStarredFn);
    const unstarred = hiddenSpots.filter(s => !isStarredFn(s));

    if (starred.length > 0) {
        body.appendChild(buildDrawerSection(
            'Starred', 'fa-star text-amber-400', starred
        ));
    }
    if (unstarred.length > 0) {
        body.appendChild(buildDrawerSection(
            'Unstarred', 'fa-location-dot text-slate-500', unstarred
        ));
    }
}

function buildDrawerSection(title, titleIconClass, spots) {
    const section = document.createElement('div');
    section.className = 'space-y-2';

    // Section label
    const labelRow = document.createElement('div');
    labelRow.className = 'flex items-center gap-1.5 px-1 mb-1.5';
    labelRow.innerHTML = `
        <i class="fa-solid ${titleIconClass} text-[9px]"></i>
        <span class="text-[9px] font-black uppercase tracking-widest text-slate-500">${title}</span>
        <span class="text-[9px] font-mono text-slate-600">(${spots.length})</span>`;
    section.appendChild(labelRow);

    spots.forEach(spot => {
        section.appendChild(buildDrawerRow(spot));
    });

    return section;
}

function buildDrawerRow(spot) {
    // Use only the first category token so the unhide button targets exactly
    // one category, avoiding ambiguity on multi-category spots.
    const rawCat    = (spot.category || 'General').split(',')[0].trim();
    const iconClass = getCategoryIconClassForDrawer(rawCat);
    const isStarred = ['high', '🔥', 'must do', 'starred'].includes((spot.priority || "").toLowerCase());

    const row = document.createElement('div');
    row.className = `flex items-center gap-2.5 rounded-xl px-3 py-2.5 border ${isStarred ? 'bg-amber-500/5 border-amber-500/15' : 'bg-slate-950/50 border-slate-800/60'}`;

    // ── Category icon ────────────────────────────────────────────────────────
    const iconWrap = document.createElement('div');
    iconWrap.className = 'w-8 h-8 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0';
    iconWrap.innerHTML = `<i class="fa-solid ${iconClass} text-[13px]"></i>`;

    // ── Name + category label ────────────────────────────────────────────────
    const textWrap = document.createElement('div');
    textWrap.className = 'flex-1 min-w-0';

    const nameEl = document.createElement('p');
    nameEl.className = 'text-[11px] font-bold text-slate-200 truncate';
    nameEl.textContent = spot.spot_name || 'Unnamed';   // textContent is injection-safe

    const catEl = document.createElement('p');
    catEl.className = 'text-[9px] text-slate-500 truncate mt-0.5';
    catEl.textContent = rawCat;

    textWrap.appendChild(nameEl);
    textWrap.appendChild(catEl);

    // ── Action buttons ───────────────────────────────────────────────────────
    const btnWrap = document.createElement('div');
    btnWrap.className = 'flex items-center gap-1.5 shrink-0';

    // Reference link button
    const linkBtn = document.createElement('a');
    linkBtn.href      = spot.instagram_url || '#';
    linkBtn.target    = '_blank';
    linkBtn.className = 'w-7 h-7 bg-slate-800 border border-slate-700 rounded-lg flex items-center justify-center text-slate-400 active:bg-slate-700 text-[11px]';
    linkBtn.innerHTML = '<i class="fa-solid fa-link"></i>';

    // Unhide button — closure captures rawCat directly; no inline string injection
    const unhideBtn = document.createElement('button');
    unhideBtn.className = 'w-7 h-7 bg-pink-500/10 border border-pink-500/20 rounded-lg flex items-center justify-center text-pink-400 active:bg-pink-500/20 text-[11px]';
    unhideBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
    unhideBtn.title     = `Unhide "${rawCat}"`;
    unhideBtn.addEventListener('click', function() {
        unhideSpecificSpotCategory(rawCat);
    });

    btnWrap.appendChild(linkBtn);
    btnWrap.appendChild(unhideBtn);

    row.appendChild(iconWrap);
    row.appendChild(textWrap);
    row.appendChild(btnWrap);

    return row;
}

function closeHiddenPinsDrawer() {
    const overlay = document.getElementById('hiddenPinsDrawerOverlay');
    const panel   = document.getElementById('hiddenPinsDrawerPanel');
    if (!overlay || overlay.classList.contains('hidden')) return;

    panel.classList.remove('hidden-pins-drawer-enter');
    panel.classList.add('hidden-pins-drawer-exit');

    setTimeout(() => {
        overlay.classList.add('hidden');
        panel.classList.remove('hidden-pins-drawer-exit');
        // Restart bubble attention loop if the bubble is still on screen
        if (hiddenPinsMiniBubbleVisible) startHiddenPinsBubbleAttentionLoop();
    }, 240);
}

function unhideSpecificSpotCategory(categoryRaw) {
    const catLower = (categoryRaw || '').toLowerCase().trim();

    // Find canonical casing from the live travelSpots data
    const allCats = new Set();
    travelSpots.forEach(s => {
        if (s.category) s.category.split(',').forEach(c => allCats.add(c.trim()));
    });

    let canonical = categoryRaw; // fallback to whatever was passed
    allCats.forEach(c => {
        if (c.toLowerCase() === catLower) canonical = c;
    });

    // Add to the type filter if not already present
    if (!checkedFilterStateArray.map(c => c.toLowerCase()).includes(catLower)) {
        checkedFilterStateArray.push(canonical);
        localStorage.setItem('compass_active_filters', JSON.stringify(checkedFilterStateArray));

        // Keep the checkbox UI in sync with the filter state
        const checkboxes = document.getElementById('checkboxScrollRegionContainer')
            ? document.getElementById('checkboxScrollRegionContainer').querySelectorAll('input[type="checkbox"]')
            : [];
        checkboxes.forEach(cb => {
            if (cb.value.toLowerCase() === catLower) cb.checked = true;
        });

        updateHeaderBadgeHUDCounters();
        renderList();
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
    }

    // Refresh the drawer content to reflect the newly visible spot
    renderHiddenPinsDrawerContent();

    // If no more hidden spots exist, auto-close the drawer and clear the HUD
    if (!hiddenPinsDrawerHasRemainingSpots()) {
        closeHiddenPinsDrawer();
        setTimeout(() => clearHiddenPinsSystemHUD(), 260);
    }
}

function unhideAllAndCloseDrawer() {
    closeHiddenPinsDrawer();
    // Wait for the slide-out to finish before blowing away the filter state
    setTimeout(() => {
        clearAllFilterCheckboxes();
        clearHiddenPinsSystemHUD();
    }, 260);
}

// Returns true when at least one spot is still hidden by the type filter
function hiddenPinsDrawerHasRemainingSpots() {
    if (!checkedFilterStateArray.length) return false;
    return travelSpots.some(spot => {
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(spot.city)) return false;
        const spotCats = spot.category
            ? spot.category.split(',').map(c => c.trim().toLowerCase())
            : [];
        return !checkedFilterStateArray.some(f => spotCats.includes(f.toLowerCase()));
    });
}

// ── End Hidden Pins Drawer ────────────────────────────────────────────────────

// ── End Hidden Pins Alert Banner ─────────────────────────────────────────────

function getFilteredDatasetRows() {
    return travelSpots.map(spot => {
        const latStr = spot.latitude ? String(spot.latitude).trim() : "";
        const lngStr = spot.longitude ? String(spot.longitude).trim() : "";
        const hasLatLon = latStr !== "" && latStr !== "0" && lngStr !== "" && lngStr !== "0";
        
        let distanceOutputLabel = !hasLatLon ? "Missing Location" : (!gpsStatusCachedBool ? "<i class='fa-solid fa-location-dot mr-1'></i>GPS Off" : "");
        let rawDistanceValue = 99999;
        let stableDistanceZoneBucket = 4; 

        if (hasLatLon && gpsStatusCachedBool) {
            const dist = calculateDistance(userLat, userLon, parseFloat(spot.latitude), parseFloat(spot.longitude));
            rawDistanceValue = dist; 
            distanceOutputLabel = dist < 1 ? `${Math.round(dist * 1000)}m` : `${dist.toFixed(1)}km`;
            
            if (dist <= 0.5) stableDistanceZoneBucket = 1;       
            else if (dist <= 2.0) stableDistanceZoneBucket = 2;  
            else if (dist <= 10.0) stableDistanceZoneBucket = 3; 
            else stableDistanceZoneBucket = 4;                  
        }

        return { 
            ...spot, 
            distRaw: rawDistanceValue, 
            distStr: distanceOutputLabel,
            distZone: stableDistanceZoneBucket 
        };
    }).filter(s => {
        if (hideCompletedSpotsStateBool && (s.status || "").toLowerCase().trim() === "done") return false;
        if (showStarredOnly && !['high','🔥','must do','starred'].includes((s.priority || "").toLowerCase())) return false;
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(s.city)) return false;
        if (checkedFilterStateArray.length > 0) {
            if (!s.category) return false;
            const spotCats = s.category.split(',').map(item => item.trim().toLowerCase());
            return checkedFilterStateArray.some(checkedCat => spotCats.includes(checkedCat.toLowerCase()));
        }
        return true;
    }).sort((a, b) => {
        const aDone = (a.status || "").toLowerCase().trim() === "done" ? 1 : 0;
        const bDone = (b.status || "").toLowerCase().trim() === "done" ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;

        const aStarred = ['high','🔥','must do','starred'].includes((a.priority || "").toLowerCase()) ? 1 : 0;
        const bStarred = ['high','🔥','must do','starred'].includes((b.priority || "").toLowerCase()) ? 1 : 0;
        if (aStarred !== bStarred) return bStarred - aStarred; 

        if (a.distZone !== b.distZone) return a.distZone - b.distZone;

        const aRowId = parseInt(a.rowid) || 0;
        const bRowId = parseInt(b.rowid) || 0;
        return aRowId - bRowId;
    });
}

function updateLiveDistancesUI() {
    if (activeTabID !== 'list') return; 
    const processed = getFilteredDatasetRows();
    
    processed.forEach(spot => {
        const distHUD = document.getElementById(`dist-badge-${spot.rowid}`);
        if (distHUD) {
            distHUD.innerHTML = spot.distStr;
            const latVal = spot.latitude ? String(spot.latitude).trim() : "";
            const hasCoordinates = latVal !== "" && latVal !== "0";
            if (!hasCoordinates) {
                distHUD.className = "text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-amber-500/10 text-amber-400 border border-amber-500/20";
            } else {
                distHUD.className = "text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-pink-500/10 text-pink-400";
            }
        }
    });
}

function handleManualInlineCardFlipExecution(event, nodeWrapperId, operationDirection) {
    if(event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const targetElement = document.getElementById(nodeWrapperId);
    if(!targetElement) return;

    if(operationDirection === 'forward') {
        targetElement.classList.add('flipped');
    } else {
        targetElement.classList.remove('flipped');
    }
}

function handleAdaptiveDirectionClick(buttonElement, event) {
    if (event) event.stopPropagation();
    const rowId = buttonElement.getAttribute('data-row-id');
    const targetSpot = travelSpots.find(s => String(s.rowid) === String(rowId));
    if (!targetSpot) return;

    const mapsUrl = targetSpot.maps_url ? String(targetSpot.maps_url).trim() : "";
    const lat = targetSpot.latitude ? String(targetSpot.latitude).trim() : "";
    const lng = targetSpot.longitude ? String(targetSpot.longitude).trim() : "";
    
    if (mapsUrl !== "" && mapsUrl !== "N/A") {
        window.open(mapsUrl, '_blank');
    } else if (lat !== "" && lat !== "0" && lng !== "" && lng !== "0") {
        window.open(`https://maps.google.com/?q=${lat},${lng}`, '_blank');
    } else {
        triggerCuteSpeechBubbleHUD("Map data missing in database!", buttonElement, event);
    }
}

/**
 * Animated wrapper around renderList() — uses the FLIP technique so existing
 * cards glide to their new sorted positions instead of teleporting.
 *
 * Two special cases are handled:
 *  a) "Mark Done" with hideCompletedSpotsStateBool = true → card slides out
 *     and collapses before the list is rebuilt (card disappears from view).
 *  b) All other reorders → snapshot old positions, rebuild, then FLIP-animate
 *     each card from its snapshot position to its new position.
 *
 * A contextual flash animation runs on the card that triggered the action:
 *   • Mark Done  → slate ripple (card-flash-done)
 *   • Undo Done  → pink ripple  (card-flash-undo)
 *   • Star       → amber glow   (card-flash-star)
 *   • Unstar     → no flash (motion alone is sufficient feedback)
 *
 * @param {number|string} triggeredRowId  rowid of the spot that changed
 * @param {string}        action          'update_status' | 'toggle_priority'
 * @param {string}        value           new value passed to updateCloudAction
 */
function renderListAnimated(triggeredRowId, action, value) {
    const strId = String(triggeredRowId);

    // ── Case A: done card disappears (hide-completed mode) ───────────────────
    // Animate the card out first, THEN rebuild — avoids a jarring instant vanish.
    if (action === 'update_status' && value === 'Done' && hideCompletedSpotsStateBool) {
        const cardEl = document.querySelector(`.dynamic-card-node[data-rowid="${strId}"]`);
        if (cardEl) {
            const cardH = cardEl.offsetHeight;
            // Phase 1: slide right + fade out
            cardEl.style.transition = 'transform 0.26s ease-in, opacity 0.22s ease-in';
            cardEl.style.transform  = 'translateX(48px)';
            cardEl.style.opacity    = '0';
            cardEl.style.overflow   = 'hidden';
            // Phase 2: collapse height so the gap closes smoothly
            setTimeout(() => {
                cardEl.style.transition += ', max-height 0.22s ease-in, margin-bottom 0.22s ease-in, padding 0.22s ease-in';
                cardEl.style.maxHeight    = cardH + 'px';
                void cardEl.offsetHeight; // flush
                cardEl.style.maxHeight    = '0px';
                cardEl.style.marginBottom = '0px';
            }, 200);
            // Phase 3: rebuild after animation completes
            setTimeout(() => renderList(), 440);
            return;
        }
    }

    // ── Inner helper: FLIP snapshot → rebuild → slide animation ──────────────
    // skipFlash=true when the burst was already played in-place (star action)
    // so it doesn't fire a second time once the card arrives at its new position.
    function _doFlipReorder(skipFlash) {
        // 1. Snapshot every card's current Y position, keyed by rowid
        const snapBefore = new Map();
        document.querySelectorAll('.dynamic-card-node[data-rowid]').forEach(el => {
            snapBefore.set(el.dataset.rowid, el.getBoundingClientRect().top);
        });

        // 2. Rebuild the list DOM (synchronous)
        renderList();

        // 3. Animate — two rAF frames: first sets displaced initial state (no paint),
        //    second applies the transition so the browser animates from there to 0.
        requestAnimationFrame(() => {
            const allCards = [...document.querySelectorAll('.dynamic-card-node[data-rowid]')];

            // Batch reads first (avoid layout thrashing)
            const entries = allCards.map(el => ({
                el,
                rowid:  el.dataset.rowid,
                newTop: el.getBoundingClientRect().top,
            }));

            // Batch writes — set each card at its old visual position instantly
            entries.forEach(({ el, rowid, newTop }) => {
                const oldTop = snapBefore.get(rowid);
                if (oldTop !== undefined) {
                    const deltaY = oldTop - newTop;
                    if (Math.abs(deltaY) > 1) {
                        el.style.transition = 'none';
                        el.style.transform  = `translateY(${deltaY}px)`;
                        el.dataset.animMove = '1';
                    }
                } else {
                    // Card is newly visible (e.g. undo on a hidden done card)
                    el.style.opacity    = '0';
                    el.dataset.animFade = '1';
                }
            });

            // Force a synchronous layout pass so the browser registers the displaced
            // transforms before we apply the transition in the next frame
            void allCards[0]?.offsetHeight;

            requestAnimationFrame(() => {
                const EASE = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';

                entries.forEach(({ el }) => {
                    if (el.dataset.animMove) {
                        el.style.transition = `transform 0.42s ${EASE}`;
                        el.style.transform  = 'translateY(0)';
                        delete el.dataset.animMove;
                    } else if (el.dataset.animFade) {
                        el.style.transition = 'opacity 0.32s ease';
                        el.style.opacity    = '1';
                        delete el.dataset.animFade;
                    }
                });

                if (!skipFlash) {
                    // Contextual flash on the card that triggered the action
                    const tEl = document.querySelector(`.dynamic-card-node[data-rowid="${strId}"]`);
                    if (tEl) {
                        let flashClass = null;
                        if (action === 'update_status') {
                            flashClass = value === 'Done' ? 'card-flash-done' : 'card-flash-undo';
                        } else if (action === 'toggle_priority' && value === 'Starred') {
                            flashClass = 'card-flash-star';
                        }
                        if (flashClass) {
                            tEl.classList.add(flashClass);
                            // animationend fires on the child that holds the keyframe
                            const frontFace = tEl.querySelector('.flip-card-front-face');
                            (frontFace || tEl).addEventListener(
                                'animationend',
                                () => tEl.classList.remove(flashClass),
                                { once: true }
                            );
                        }
                    }
                }
            });
        });
    }

    // ── Case B-star: flash in-place first, THEN reorder ──────────────────────
    // Without this, the card jumps to the top and the amber burst fires there,
    // making the glow imperceptible at the position the user tapped.
    // Sequence: burst at current position → animationend → FLIP slide to top.
    if (action === 'toggle_priority' && value === 'Starred') {
        const cardEl = document.querySelector(`.dynamic-card-node[data-rowid="${strId}"]`);
        if (cardEl) {
            cardEl.classList.add('card-flash-star');
            const frontFace = cardEl.querySelector('.flip-card-front-face');
            (frontFace || cardEl).addEventListener('animationend', () => {
                cardEl.classList.remove('card-flash-star');
                _doFlipReorder(true); // skipFlash — burst already played in-place
            }, { once: true });
            return; // reorder deferred until after the flash
        }
        // Card not found in DOM — fall through to normal reorder below
    }

    // ── Case B: FLIP reorder for all other actions ────────────────────────────
    _doFlipReorder(false);
}

function renderList() {
    const scrollContainerFrame = document.getElementById('gesture-touch-container');
    const counterHUD = document.getElementById('vaultDensityHUDLabelCounter');
    if(!scrollContainerFrame) return;

    const dynamicOldCards = scrollContainerFrame.querySelectorAll('.dynamic-card-node, .dynamic-tailpiece-node, .dynamic-empty-node, .dynamic-spacer-node');
    dynamicOldCards.forEach(el => el.remove());

    const processed = getFilteredDatasetRows();
    if (counterHUD) counterHUD.innerText = `Showing ${processed.length} / ${travelSpots.length} Spots`;
    
    if (processed.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = "dynamic-empty-node w-full block shrink-0";
        if (showStarredOnly) {
            // Starred filter active but no starred spots — match the itinerary master empty state
            emptyDiv.innerHTML = `
                <div class="flex flex-col items-center justify-center py-16 text-center px-6">
                    <i class="fa-regular fa-star text-3xl text-slate-700 mb-4"></i>
                    <p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">No starred spots</p>
                    <p class="text-[11px] text-slate-600 font-medium">Star a spot to save it here.</p>
                    <button onclick="setPriorityFilterState(false)"
                            class="mt-5 px-5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-[10px] font-black text-slate-400 active:bg-slate-800 transition-colors">
                        Show All
                    </button>
                </div>`;
        } else {
            // Generic empty state (city filter, search, etc.)
            emptyDiv.innerHTML = `
                <div class="text-center text-slate-600 py-12 text-xs">
                    No entries loaded matching these selection profiles.
                </div>`;
        }
        scrollContainerFrame.appendChild(emptyDiv);
        return;
    }

    processed.forEach((spot, idx) => {
        const isDone = (spot.status || "").toLowerCase().trim() === "done";
        const isHigh = ['high','🔥','must do','starred'].includes((spot.priority || "").toLowerCase());
        const ticketLink = spot.ticket_url || "";
        
        const directMapsUrl = spot.maps_url ? String(spot.maps_url).trim() : "";
        const latVal = spot.latitude ? String(spot.latitude).trim() : "";
        const lngVal = spot.longitude ? String(spot.longitude).trim() : "";
        const hasCoordinates = latVal !== "" && latVal !== "0" && lngVal !== "" && lngVal !== "0";
        const hasValidMapDestination = (directMapsUrl !== "" && directMapsUrl !== "N/A") || hasCoordinates;

        const uniqueCardContainerId = `list-flip-wrapper-node-${idx}`;

        let hoursHTMLTokens = '';
        if(spot.opening_hours && spot.opening_hours !== "N/A" && spot.opening_hours.trim() !== "") {
            spot.opening_hours.split(/[\n;]+/).forEach(t => {
                if(t.trim()) hoursHTMLTokens += `<div class="flex justify-between border-b border-slate-950 last:border-0 py-0.5"><span>${t.trim()}</span></div>`;
            });
        } else {
            hoursHTMLTokens = `<div class="text-slate-600 italic text-[10px]">Schedule unpopulated.</div>`;
        }

        const cardWrapper = document.createElement('div');
        cardWrapper.id = uniqueCardContainerId;
        cardWrapper.dataset.rowid = String(spot.rowid); // used by renderListAnimated FLIP engine
        cardWrapper.className = "dynamic-card-node w-full min-h-[260px] h-auto flip-perspective-container transform transition-transform duration-200 shrink-0 block";

        // Category icon class for the badge (icon · category · city)
        const catIconClass = getCategoryIconClass(spot.category);

        // Weather badge — disabled placeholder when coordinates are missing;
        // refreshAllWeatherBadges() will fill in real data after render.
        // No-coords: visible grey box, same min-width as the live weather badge
        // so both states stay horizontally consistent regardless of content.
        const weatherBadgeClass = !hasCoordinates
            ? 'bg-slate-700/40 text-slate-500'
            : 'bg-sky-500/10 text-sky-300';
        const weatherBadgeInitHTML = !hasCoordinates
            ? `<i class="fa-solid fa-cloud text-[10px]" style="opacity:0.35"></i><i class="fa-solid fa-slash text-[7px]" style="margin-left:-0.55em;opacity:0.35"></i>`
            : `<i class="fa-solid fa-cloud text-[10px] opacity-40"></i>`;

        cardWrapper.innerHTML = `
            <div class="flip-card-inner-rotator w-full h-full">

                <div class="flip-card-front-face w-full h-full p-4 rounded-2xl border flex flex-col justify-between ${isDone ? 'itin-done-card' : 'bg-slate-900 ' + (isHigh ? 'starred-gold-glow' : 'border-slate-800')}">
                    <div>
                        <div class="flex justify-between items-start gap-2">
                            <div class="max-w-[70%]">
                                <span class="inline-flex items-center gap-1.5 text-[9px] px-2 py-1 rounded-lg bg-slate-950 text-slate-400 font-bold border border-slate-800 ${isDone ? 'opacity-40' : ''}"><i class="fa-solid ${catIconClass} text-[8px] shrink-0"></i><span class="uppercase tracking-wider">${spot.category || 'General'}</span><span class="text-slate-700 font-normal">•</span><span class="uppercase tracking-wider text-slate-500">${spot.city || 'Global'}</span></span>
                                <h3 class="text-base font-bold ${isDone ? 'text-slate-500 line-through' : 'text-slate-200'} mt-1.5 truncate">${spot.spot_name}</h3>
                            </div>
                            <div class="flex items-stretch gap-1.5 shrink-0">
                                <span id="weather-badge-${spot.rowid}" class="inline-flex items-center justify-center gap-1 text-xs font-mono font-bold px-2 py-1 rounded-lg min-w-[3.25rem] ${weatherBadgeClass} ${isDone ? 'opacity-30' : ''}">${weatherBadgeInitHTML}</span>
                                <span id="dist-badge-${spot.rowid}" class="text-xs font-mono font-bold px-2 py-1 rounded-lg h-fit ${isDone ? 'bg-slate-800/20 text-slate-600 opacity-40' : (!hasCoordinates ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-pink-500/10 text-pink-400')}">${spot.distStr}</span>
                            </div>
                        </div>
                        <div class="mt-3 bg-slate-950/40 p-2.5 rounded-xl border border-slate-900/60 min-h-[90px] overflow-hidden">
                            <p class="text-xs ${isDone ? 'text-slate-500 line-through' : 'text-slate-400'} leading-relaxed max-h-16 overflow-hidden pr-1" style="touch-action: pan-y;" ontouchstart="handleNoteTouchStartEvent(event, this.innerText)" ontouchmove="handleNoteTouchMoveEvent(event)" ontouchend="handleNoteTouchEndEvent(event)" onmousedown="handleNoteMouseDownEvent(event, this.innerText)" onmousemove="handleNoteMouseMoveEvent(event)" onmouseup="handleNoteMouseUpEvent(event)">${spot.notes || 'No custom notes.'}</p>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2 mt-3">
                        <div class="flex gap-2">
                            <a href="${spot.instagram_url || '#'}" target="_blank" class="flex-1 text-center text-xs font-bold py-3 rounded-xl flex items-center justify-center ${isDone ? 'bg-slate-800/40 border border-slate-700/30 text-slate-600 opacity-40 pointer-events-none' : 'bg-gradient-to-r from-pink-600 to-purple-600 text-white shadow-lg'}">Open Reference</a>
                            <button data-row-id="${spot.rowid}" onclick="handleAdaptiveDirectionClick(this, event)" class="px-4 flex items-center justify-center rounded-xl text-xs font-bold whitespace-nowrap h-12 ${isDone ? 'bg-slate-800/30 border border-slate-700/20 text-slate-600 flex-1 opacity-40 pointer-events-none' : (!hasValidMapDestination ? 'bg-slate-950 border border-slate-800 text-amber-400 text-sm font-black w-14 shrink-0' : 'bg-slate-950 border border-slate-800 text-slate-300 flex-1')}">
                                ${isDone ? '<i class="fa-solid fa-map mr-1.5 text-sm"></i> Directions' : (!hasValidMapDestination ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-map mr-1.5 text-sm"></i> Directions')}
                            </button>
                        </div>
                        ${ticketLink.trim() !== "" && !isDone ? `<a href="${ticketLink}" target="_blank" class="w-full mt-1 bg-emerald-600 text-center text-xs font-bold py-2.5 rounded-xl text-white block">📄 View Ticket Details</a>` : ''}
                        <div class="flex gap-2 mt-1 justify-end items-center">
                            <button onclick="handleManualInlineCardFlipExecution(event, '${uniqueCardContainerId}', 'forward')" class="px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto ${isDone ? 'text-slate-600 bg-slate-950/50 border border-slate-800/30 opacity-40 pointer-events-none' : 'text-sky-400 bg-sky-500/10 border border-sky-500/20 active:bg-sky-500/20'}">
                                <i class="fa-solid fa-circle-info mr-1"></i> Extra Info
                            </button>
                            <button onclick="updateCloudAction(${spot.rowid}, 'update_status', '${isDone ? 'Pending' : 'Done'}')" class="text-xs px-3 py-1.5 font-bold rounded-lg ${isDone ? 'bg-pink-600/10 border border-pink-600/20 text-pink-400 active:bg-pink-600/20' : 'bg-slate-950 border border-slate-800 text-slate-400 active:bg-slate-855'}">${isDone ? '<i class="fa-solid fa-arrow-rotate-left mr-1"></i> Undo' : '<i class="fa-solid fa-check mr-1"></i> Mark Done'}</button>
                            <button onclick="updateCloudAction(${spot.rowid}, 'toggle_priority', '${isHigh ? 'Normal' : 'Starred'}')" class="text-xs px-2 py-1.5 rounded-lg ${isDone ? 'bg-slate-950/50 border border-slate-800/30 text-slate-600 opacity-40 pointer-events-none' : 'bg-slate-950 border border-slate-800 text-amber-400'}">${isHigh ? '<i class="fa-solid fa-star-half-stroke mr-1"></i> Unstar' : '<i class="fa-solid fa-star mr-1"></i> Star'}</button>
                        </div>
                    </div>
                </div>
                <div class="flip-card-back-face w-full h-full p-4 rounded-2xl border bg-slate-900 ${isHigh ? 'starred-gold-glow' : 'border-slate-800'} flex flex-col justify-between overflow-hidden">
                    <div class="flex border-b border-slate-800/60 pb-1.5 shrink-0 items-center justify-between">
                        <span class="text-[10px] font-black uppercase text-slate-400 tracking-wider">Extra Info</span>
                        <span class="text-[8px] text-slate-600 font-mono">ID: #${spot.rowid}</span>
                    </div>
                    <div class="flex-1 overflow-y-auto subtle-scrollbar my-2 pr-0.5 space-y-3 text-[11px]">
                        <p class="text-slate-300 leading-relaxed font-medium bg-slate-950/50 border border-slate-950 p-2.5 rounded-xl">${(spot.long_description && spot.long_description !== "N/A") ? spot.long_description : 'No background summary recorded.'}</p>
                        
                        <div>
                            <span class="text-[8px] font-black uppercase tracking-widest text-slate-500 block mb-0.5">Schedule</span>
                            <div class="bg-slate-950/50 border border-slate-950 p-2.5 rounded-xl font-mono text-[10px] text-slate-400 space-y-0.5">${hoursHTMLTokens}</div>
                        </div>
                        ${(spot.booking_requirement && spot.booking_requirement !== "N/A" && spot.booking_requirement.toLowerCase() !== "none") ? `
                        <div class="p-2.5 bg-amber-500/5 border border-amber-500/20 rounded-xl">
                            <span class="text-[8px] font-black uppercase tracking-widest text-amber-400 block">Alert</span>
                            <span class="text-slate-300 leading-relaxed block mt-0.5">${spot.booking_requirement}</span>
                        </div>` : ''}
                    </div>
                    <div class="flex gap-2 justify-end pt-2 border-t border-slate-950 shrink-0 items-center">
                        <button onclick="handleManualInlineCardFlipExecution(event, '${uniqueCardContainerId}', 'backward')" class="text-slate-400 bg-slate-950 border border-slate-800/80 px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto active:bg-sky-500/20">
                            <i class="fa-solid fa-arrow-left mr-1"></i> Back
                        </button>
                    </div>
                </div>
            </div>
        `;
        scrollContainerFrame.appendChild(cardWrapper);
    });

    const tailEndLabelDeckNode = document.createElement('div');
    tailEndLabelDeckNode.className = "dynamic-tailpiece-node w-full py-4 flex items-center justify-center gap-4 shrink-0 block px-4";
    tailEndLabelDeckNode.innerHTML = `
        <div class="flex-grow border-t border-slate-900 max-w-[40px]"></div>
        <span class="text-[9px] font-bold tracking-[0.15em] uppercase text-slate-600 whitespace-nowrap">End of filtered list</span>
        <div class="flex-grow border-t border-slate-900 max-w-[40px]"></div>
    `;
    scrollContainerFrame.appendChild(tailEndLabelDeckNode);

    const physicalScrollSpacer = document.createElement('div');
    physicalScrollSpacer.className = "dynamic-spacer-node h-16 shrink-0 block w-full";
    scrollContainerFrame.appendChild(physicalScrollSpacer);

    // Kick off async weather fetches — runs after the DOM is painted
    setTimeout(refreshAllWeatherBadges, 0);
}

function toggleSettingsMenu(show) {
    const drawer = document.getElementById('settingsDrawer');
    if (drawer) drawer.classList.toggle('hidden', !show);

    if (show) {
        const switchUserBox    = document.getElementById('settingsSwitchUserDropdown');
        const mainSelectionBox = document.getElementById('user-dropdown-select');

        if (switchUserBox && mainSelectionBox) {
            // If the settings dropdown somehow still has no options (extremely rare —
            // cache was empty AND fetch not yet done), mirror the login dropdown as a
            // last-resort fallback.
            if (switchUserBox.options.length <= 1 && mainSelectionBox.options.length > 1) {
                switchUserBox.innerHTML = mainSelectionBox.innerHTML;
            }
            if (currentUser) switchUserBox.value = currentUser;
        }
        // Reset rename input and validation state each time settings opens
        resetProfileRenameValidationUI();
    }
}

function setupNetworkListeners() { 
    window.addEventListener('online', updateNetworkStatusHUD); 
    window.addEventListener('offline', updateNetworkStatusHUD); 
}

function updateNetworkStatusHUD() {
    const indicator = document.getElementById('networkIndicator'); 
    const syncText = document.getElementById('syncText');
    if(!indicator || !syncText) return;
    if (navigator.onLine) {
        indicator.className = "w-1.5 h-1.5 rounded-full bg-emerald-500"; 
        syncText.className = "text-[9px] font-mono text-slate-500"; 
        syncText.innerText = "Synced Live Data";
    } else {
        indicator.className = "w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"; 
        syncText.className = "text-[9px] font-mono text-amber-400 font-black tracking-wide"; 
        syncText.innerText = "OFFLINE MODE";
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SETTINGS MODAL SYSTEM
//  Three themed modals replace all native alert/confirm/prompt calls that
//  originate from the settings drawer flow.
// ═══════════════════════════════════════════════════════════════════════════

let _sConfirmCb          = null;  // stored callback for executeSettingsConfirmAction
let _sConfirmShowLoading  = false; // when true, executeSettingsConfirmAction shows loading state
let _sConfirmLoadingLabel = '';    // text shown in the button during loading (no dots suffix)
let _sConfirmDotsInterval = null;  // setInterval handle for animated dots

/**
 * Open the reusable confirm modal.
 * @param {object} cfg - { faIcon, iconBg, iconColor, topBar, title, body,
 *                         btnLabel, btnClass, callback,
 *                         showLoading, loadingLabel }
 *   showLoading  {boolean} — when true the modal stays open after the button
 *                            is pressed, shows an animated loading state, and
 *                            only closes once the async callback resolves.
 *   loadingLabel {string}  — text shown in the button during loading
 *                            (dots are appended automatically). Defaults to
 *                            the btnLabel value.
 */
function openSettingsConfirmModal(cfg) {
    document.getElementById('sConfirmIconWrap').className =
        `w-12 h-12 rounded-2xl flex items-center justify-center text-xl ${cfg.iconBg || 'bg-red-500/10'}`;
    document.getElementById('sConfirmIconEl').className =
        `fa-solid ${cfg.faIcon} ${cfg.iconColor || 'text-red-400'}`;
    document.getElementById('sConfirmTopBar').className =
        `h-0.5 w-full ${cfg.topBar || 'bg-gradient-to-r from-pink-500 to-violet-500'}`;
    document.getElementById('sConfirmTitle').textContent = cfg.title;
    document.getElementById('sConfirmBody').textContent  = cfg.body;
    const btn = document.getElementById('sConfirmActionBtn');
    btn.disabled     = false; // always reset — loading state sets disabled=true and className reassignment doesn't clear DOM properties
    btn.textContent  = cfg.btnLabel;
    btn.className    = `w-full py-3 ${cfg.btnClass || 'bg-gradient-to-r from-red-600 to-rose-700'} font-black text-xs uppercase tracking-wider rounded-xl text-white active:scale-95 transition-transform shadow-lg`;
    _sConfirmCb          = cfg.callback || null;
    _sConfirmShowLoading  = !!cfg.showLoading;
    _sConfirmLoadingLabel = cfg.loadingLabel || cfg.btnLabel || 'Processing';
    document.getElementById('settingsConfirmModal').classList.remove('hidden');
}

function closeSettingsConfirmModal() {
    // Always clean up loading state before hiding
    _exitConfirmModalLoadingState();
    document.getElementById('settingsConfirmModal').classList.add('hidden');
    _sConfirmCb          = null;
    _sConfirmShowLoading  = false;
    _sConfirmLoadingLabel = '';
}

function cancelSettingsConfirmModal() {
    // X button dismiss — user cancelled, navigate back to settings drawer.
    // Guard: do nothing if currently in a loading state (X is visually disabled
    // but belt-and-suspenders here in case it fires via keyboard or AT).
    if (_sConfirmDotsInterval !== null) return;
    closeSettingsConfirmModal();
    toggleSettingsMenu(true);
}

async function executeSettingsConfirmAction() {
    const cb = _sConfirmCb;
    if (!cb) return;

    if (_sConfirmShowLoading) {
        // ── Async path: keep modal open, lock it down, await the callback ──
        _enterConfirmModalLoadingState();
        try {
            await cb();
        } catch (err) {
            console.error('Settings confirm action error:', err);
        } finally {
            // Clean up loading UI; the callback is responsible for opening the
            // result modal. We close the confirm modal last so it dissolves
            // cleanly behind whatever the callback already rendered.
            closeSettingsConfirmModal();
        }
    } else {
        // ── Synchronous path: original behaviour ────────────────────────────
        closeSettingsConfirmModal();
        cb();
    }
}

// ─── Confirm modal loading-state helpers ──────────────────────────────────────

function _enterConfirmModalLoadingState() {
    const modal = document.getElementById('settingsConfirmModal');
    if (!modal) return;

    // Lock the X button — user must wait for the operation to complete
    const xBtn = modal.querySelector('button[onclick="cancelSettingsConfirmModal()"]');
    if (xBtn) {
        xBtn.disabled = true;
        xBtn.classList.add('opacity-30', 'pointer-events-none');
    }

    // Switch action button to animated loading text
    const actionBtn = document.getElementById('sConfirmActionBtn');
    if (actionBtn) {
        actionBtn.disabled = true;
        actionBtn.classList.remove('active:scale-95');
        actionBtn.classList.add('opacity-70', 'cursor-not-allowed', 'pointer-events-none');
        const base = _sConfirmLoadingLabel;
        let dots = 0;
        actionBtn.textContent = base;
        _sConfirmDotsInterval = setInterval(() => {
            dots = (dots + 1) % 4;
            actionBtn.textContent = base + '.'.repeat(dots);
        }, 450);
    }
}

function _exitConfirmModalLoadingState() {
    // Stop animated dots
    if (_sConfirmDotsInterval !== null) {
        clearInterval(_sConfirmDotsInterval);
        _sConfirmDotsInterval = null;
    }
    const modal = document.getElementById('settingsConfirmModal');
    if (!modal) return;

    // Restore X button
    const xBtn = modal.querySelector('button[onclick="cancelSettingsConfirmModal()"]');
    if (xBtn) {
        xBtn.disabled = false;
        xBtn.classList.remove('opacity-30', 'pointer-events-none');
    }

    // Restore action button — className reassignment in openSettingsConfirmModal
    // clears visual classes but NOT the disabled DOM property, so we must reset
    // it here explicitly to ensure subsequent modal uses work correctly.
    const actionBtn = document.getElementById('sConfirmActionBtn');
    if (actionBtn) {
        actionBtn.disabled = false;
        actionBtn.classList.remove('opacity-70', 'cursor-not-allowed', 'pointer-events-none');
    }
}

/** Purge modal helpers */
function openSettingsPurgeModal() {
    const inp = document.getElementById('purgePasswordInput');
    const err = document.getElementById('purgePasswordError');
    if (inp) inp.value = '';
    if (err) err.classList.add('hidden');
    document.getElementById('settingsPurgeModal').classList.remove('hidden');
    if (inp) setTimeout(() => inp.focus(), 120);
}
function closeSettingsPurgeModal() {
    // Programmatic close (after action) — no settings reopen needed
    document.getElementById('settingsPurgeModal').classList.add('hidden');
    const inp = document.getElementById('purgePasswordInput');
    if (inp) inp.value = '';
    document.getElementById('purgePasswordError').classList.add('hidden');
}
function cancelSettingsPurgeModal() {
    // X button dismiss — navigate back to settings drawer
    closeSettingsPurgeModal();
    toggleSettingsMenu(true);
}

/** Execute the purge request once user submits password */
async function executePurgeWithPassword() {
    const inp = document.getElementById('purgePasswordInput');
    const err = document.getElementById('purgePasswordError');
    const errTxt = document.getElementById('purgePasswordErrorText');
    const btn = document.getElementById('sPurgeActionBtn');

    const password = inp ? inp.value.trim() : '';
    if (!password) {
        errTxt.textContent = 'Password cannot be blank.';
        err.classList.remove('hidden');
        return;
    }

    // Loading state
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i>Purging...';
    btn.disabled = true;
    err.classList.add('hidden');

    try {
        const response = await fetch(BACKEND_URL, {
            method: 'POST',
            mode: 'cors',
            body: JSON.stringify({
                action: 'purge_server_history',
                user: currentUser || 'System Admin',
                password
            })
        });
        const outcome = await response.json();

        closeSettingsPurgeModal();
        toggleSettingsMenu(false);

        if (outcome.result === 'success') {
            syncData(true);
            openSettingsResultModal('success', 'Logs Purged', 'Google Sheets server records and log metrics have been fully scrubbed.');
        } else if (outcome.result === 'auth_failed') {
            openSettingsResultModal('error', 'Access Denied', 'Invalid Admin Password. The purge request was rejected.');
        } else {
            openSettingsResultModal('error', 'Server Error', outcome.error || 'Unknown response received from cloud ecosystem.');
        }
    } catch (err) {
        console.error('Purge failure:', err);
        closeSettingsPurgeModal();
        openSettingsResultModal('error', 'Connection Failed', 'Communication crash. Verify your web app script setup.');
    } finally {
        btn.innerHTML = origHTML;
        btn.disabled = false;
    }
}

/**
 * Open the generic result / feedback modal.
 * @param {'success'|'error'|'info'} type
 */
function openSettingsResultModal(type, title, body) {
    const iconWrap = document.getElementById('sResultIconWrap');
    const iconEl   = document.getElementById('sResultIconEl');
    const topBar   = document.getElementById('sResultTopBar');

    if (type === 'success') {
        iconWrap.className = 'w-12 h-12 rounded-2xl flex items-center justify-center text-xl bg-emerald-500/10';
        iconEl.className   = 'fa-solid fa-circle-check text-emerald-400';
        topBar.className   = 'h-0.5 w-full bg-gradient-to-r from-emerald-500 to-teal-500';
    } else if (type === 'error') {
        iconWrap.className = 'w-12 h-12 rounded-2xl flex items-center justify-center text-xl bg-red-500/10';
        iconEl.className   = 'fa-solid fa-circle-xmark text-red-400';
        topBar.className   = 'h-0.5 w-full bg-gradient-to-r from-red-500 to-rose-500';
    } else {
        iconWrap.className = 'w-12 h-12 rounded-2xl flex items-center justify-center text-xl bg-slate-700/40';
        iconEl.className   = 'fa-solid fa-circle-info text-slate-400';
        topBar.className   = 'h-0.5 w-full bg-gradient-to-r from-pink-500 to-violet-500';
    }

    document.getElementById('sResultTitle').textContent = title;
    document.getElementById('sResultBody').textContent  = body;
    document.getElementById('settingsResultModal').classList.remove('hidden');
}
function closeSettingsResultModal() {
    document.getElementById('settingsResultModal').classList.add('hidden');
}

// ─── Missing settings action functions ───────────────────────────────────────

/** Clear all saved itinerary data — replaces native confirm/alert */
function triggerClearItineraryData() {
    openSettingsConfirmModal({
        faIcon: 'fa-trash-can', iconBg: 'bg-red-500/10', iconColor: 'text-red-400',
        topBar: 'h-0.5 w-full bg-gradient-to-r from-red-500 to-rose-500',
        title: 'Clear Itinerary',
        body:  'All timeline maps and saved itinerary schedules will be permanently reset. This cannot be undone.',
        btnLabel: 'Clear All Data',
        btnClass: 'bg-gradient-to-r from-red-600 to-rose-700',
        callback: () => {
            // Reset the in-memory itinerary cache
            if (typeof itineraryItems !== 'undefined') {
                itineraryItems = { '1': [], '2': [], '3': [] };
                localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
            }
            // Also wipe saved itineraries list
            if (typeof savedItineraries !== 'undefined') {
                savedItineraries = [];
            }
            localStorage.removeItem('compass_saved_itineraries');
            toggleSettingsMenu(false);
            if (typeof renderItineraryMasterDashboardWorkspace === 'function') {
                renderItineraryMasterDashboardWorkspace();
            }
            openSettingsResultModal('success', 'Itinerary Cleared', 'All itinerary data has been wiped and the timeline has been reset.');
        }
    });
}

/** Switch to the user selected in the settings dropdown */
function switchUserSessionViaSettings() {
    const switchBox = document.getElementById('settingsSwitchUserDropdown');
    if (!switchBox || !switchBox.value) return;
    const selectedUser = switchBox.value;

    if (selectedUser === currentUser) {
        openSettingsResultModal('info', 'Already Active', `"${selectedUser}" is already your active profile.`);
        return;
    }

    openSettingsConfirmModal({
        faIcon: 'fa-user-gear', iconBg: 'bg-violet-500/10', iconColor: 'text-violet-400',
        topBar: 'h-0.5 w-full bg-gradient-to-r from-violet-500 to-pink-500',
        title: 'Switch User',
        body:  `Switch active session to "${selectedUser}"? Your cached data will reload for this profile.`,
        btnLabel: 'Switch Session',
        btnClass: 'bg-gradient-to-r from-violet-600 to-pink-600',
        callback: () => {
            localStorage.setItem('compass_user', selectedUser);
            currentUser = selectedUser;
            toggleSettingsMenu(false);
            syncData(true);
            openSettingsResultModal('success', 'Session Switched', `Now signed in as "${selectedUser}". Data reloading...`);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────

function validateProfileRenameInput() {
    const input = document.getElementById('settingsRenameField');
    const minCharWarn = document.getElementById('profileRenameMinCharWarning');
    const nameTakenWarn = document.getElementById('profileRenameNameTakenWarning');
    const submitBtn = document.getElementById('profileRenameSubmitBtn');
    if (!input || !minCharWarn || !nameTakenWarn || !submitBtn) return;

    const val = input.value.trim();

    if (val.length === 0) {
        minCharWarn.classList.add('hidden');
        nameTakenWarn.classList.add('hidden');
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-40', 'cursor-not-allowed');
        return;
    }

    if (val.length < 3) {
        minCharWarn.classList.remove('hidden');
        nameTakenWarn.classList.add('hidden');
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-40', 'cursor-not-allowed');
        return;
    }

    // 3+ chars — hide min-char warning, check for duplicate name
    minCharWarn.classList.add('hidden');
    const nameTaken = registeredUsersList.some(u => u.toLowerCase() === val.toLowerCase());
    if (nameTaken) {
        nameTakenWarn.classList.remove('hidden');
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-40', 'cursor-not-allowed');
    } else {
        nameTakenWarn.classList.add('hidden');
        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-40', 'cursor-not-allowed');
    }
}

function resetProfileRenameValidationUI() {
    const input = document.getElementById('settingsRenameField');
    const minCharWarn = document.getElementById('profileRenameMinCharWarning');
    const nameTakenWarn = document.getElementById('profileRenameNameTakenWarning');
    const submitBtn = document.getElementById('profileRenameSubmitBtn');
    if (input) input.value = '';
    if (minCharWarn) minCharWarn.classList.add('hidden');
    if (nameTakenWarn) nameTakenWarn.classList.add('hidden');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-40', 'cursor-not-allowed');
    }
}

function commitProfileRename() {
    const renameField = document.getElementById('settingsRenameField');
    if (!renameField || !renameField.value.trim()) return; // button disabled state guards this

    const oldName = currentUser || 'Global Traveller';
    const newName = renameField.value.trim();

    if (oldName === newName) {
        openSettingsResultModal('info', 'No Change', 'The new profile name matches your current label.');
        return;
    }

    openSettingsConfirmModal({
        faIcon: 'fa-user-pen', iconBg: 'bg-violet-500/10', iconColor: 'text-violet-400',
        topBar: 'h-0.5 w-full bg-gradient-to-r from-violet-500 to-pink-500',
        title: 'Rename Profile',
        body:  `Change your identity from "${oldName}" to "${newName}"?`,
        btnLabel: 'Update Profile',
        btnClass: 'bg-gradient-to-r from-violet-600 to-pink-600',
        showLoading:  true,
        loadingLabel: 'Updating Profile Name',
        callback: async () => {
            try {
                // Single call: finds the old name row in RegisteredUsers and
                // overwrites it with the new name in-place. Also logs to History.
                await fetch(BACKEND_URL, {
                    method: 'POST',
                    mode: 'cors',
                    body: JSON.stringify({
                        action: 'rename_user',
                        old_name: oldName,
                        new_name: newName,
                        deviceMeta: cachedHardwareString
                    })
                });
            } catch (err) {
                console.error('Failed to rename user on server:', err);
            }

            // ── Update local state ──────────────────────────────────────────
            localStorage.setItem('compass_user', newName);
            currentUser = newName;

            // Replace old name in-place in the in-memory list so duplicate
            // checks remain accurate without needing a fresh server fetch.
            const renameIdx = registeredUsersList.findIndex(
                u => u.toLowerCase() === oldName.toLowerCase()
            );
            if (renameIdx !== -1) {
                registeredUsersList[renameIdx] = newName;
            } else {
                registeredUsersList.push(newName);
            }
            localStorage.setItem('compass_registered_users', JSON.stringify(registeredUsersList));

            // Refresh both dropdowns with the updated list. _fillUserDropdowns
            // reads currentUser so the settings dropdown auto-selects the new
            // name immediately — before settings is closed.
            _fillUserDropdowns(registeredUsersList);

            resetProfileRenameValidationUI();
            toggleSettingsMenu(false);
            syncData(true);
            openSettingsResultModal('success', 'Profile Updated', `Identity profile updated to "${newName}". Syncing resources...`);
        }
    });
}

function triggerSecureServerHistoryPurgeVault() {
    // Opens the themed password modal; all async logic lives in executePurgeWithPassword()
    openSettingsPurgeModal();
}

function clearDeviceSessionAndLogout() {
    openSettingsConfirmModal({
        faIcon: 'fa-right-from-bracket', iconBg: 'bg-red-500/10', iconColor: 'text-red-400',
        topBar: 'h-0.5 w-full bg-gradient-to-r from-red-500 to-rose-500',
        title: 'Logout Session',
        body:  'Your active profile context will be dropped and the local offline registry cache will be fully reset.',
        btnLabel: 'Logout & Reset',
        btnClass: 'bg-gradient-to-r from-red-600 to-rose-700',
        callback: () => {
            // Preserve the registered-users list across logout so the login
            // dropdown can be painted from cache instantly on the next load,
            // without waiting for a fresh server fetch. The list is not
            // sensitive — it contains only display names.
            const preservedUsersCache = localStorage.getItem('compass_registered_users');
            localStorage.clear();
            if (preservedUsersCache) {
                localStorage.setItem('compass_registered_users', preservedUsersCache);
            }
            window.location.reload();
        }
    });
}

// ----------------- APP INITIALIZATION (MASTER BOOTLOADER) -----------------
window.onload = function() {
    // NOTE: Do NOT write any default zoom/lat/lng here — doing so would wipe the
    // user's last active view on every reload. The priority resolver in map.js
    // reads and validates those values independently.

    // ── Kick off the user-list fetch as the very first async operation ────────
    // populateUserDropdown() has two phases:
    //   1. Synchronous: paint dropdown instantly from localStorage cache
    //   2. Async: refresh the list from the server in the background
    // By starting it before initLeafletMapEngineCanvas() we give the network
    // request the maximum possible head-start. The calibration canvas takes
    // 1-3 s to dismiss (tile load), so the fetch almost always completes before
    // the user ever sees the login screen — making the dropdown immediately ready.
    populateUserDropdown();

    cachedHardwareString = parseReadableDeviceHardware();
    document.getElementById('meta-id').innerText = `Device ID: ${deviceId}`;
    document.getElementById('meta-hardware').innerText = `Model: ${cachedHardwareString}`;
    document.getElementById('meta-version').innerText = `Version: ${APP_VERSION}`;
    
    if (typeof initLeafletMapEngineCanvas === 'function') initLeafletMapEngineCanvas();

    // Always attempt GPS on load — shows "GPS Syncing…" immediately and resolves to
    // GPS Active or GPS Off once the browser responds. On first visit this triggers
    // the browser's native location request; on repeat visits (already granted) it
    // starts silently. monitorNativeGpsPermissions() handles mid-session revocation.
    // Camera is pre-locked so the first successful fix centres the map viewport.
    if (typeof startLiveHardwareGPSTracking === 'function') {
        isCameraLocked = true;
        if (typeof syncCameraLockVisualUIState === 'function') syncCameraLockVisualUIState();
        startLiveHardwareGPSTracking();
    }

    // Safety net: if the tile-load event never fires (offline / map init error),
    // force-dismiss the calibration screen after 10 s so the app is never locked.
    setTimeout(() => {
        const loader = document.getElementById('mapCanvasWarmupLoader');
        if (loader && loader.style.display !== 'none') {
            loader.style.pointerEvents = 'none';
            loader.style.touchAction   = 'auto';
            loader.style.transition    = 'opacity 0.45s ease';
            loader.style.opacity       = '0';
            setTimeout(() => { loader.style.display = 'none'; }, 500);
        }
    }, 10000);

    // ── Minimize / Maximize (Page Visibility) handler ────────────────────────
    // window.onload does NOT re-fire on background → foreground transitions, so
    // the calibration curtain is never re-shown. This handler silently refreshes
    // map geometry and ensures the GPS stream is still running after a resume.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;

        // Dismiss loader immediately if it somehow survived into the background
        const loader = document.getElementById('mapCanvasWarmupLoader');
        if (loader && loader.style.display !== 'none') {
            loader.style.display       = 'none';
            loader.style.pointerEvents = 'none';
        }

        // Re-fit map to its container (browser may have resized it while hidden)
        if (leafletMapInstance) {
            window.requestAnimationFrame(() => leafletMapInstance.invalidateSize({ animate: false }));
        }

        // Resume GPS stream if it was running before and has since stalled
        if (gpsStatusCachedBool && liveGpsWatchId === null && typeof startLiveHardwareGPSTracking === 'function') {
            startLiveHardwareGPSTracking();
        }
    });
    syncPriorityFilterViewModeUI();
    setupNativePullToRefreshGestures();

    document.getElementById('trayFlipToBackBtn').addEventListener('click', (e) => { 
        e.stopPropagation(); 
        document.getElementById('mapDetailTrayHUD').classList.add('flipped'); 
        if (typeof assembleTrayInlineAssignorRow === 'function') assembleTrayInlineAssignorRow(); 
    });
    document.getElementById('trayFlipToFrontBtn').addEventListener('click', (e) => { 
        e.stopPropagation(); 
        document.getElementById('mapDetailTrayHUD').classList.remove('flipped'); 
    });
    
    const trayNode = document.getElementById('mapDetailTrayHUD');
    if(trayNode && typeof L !== 'undefined') {
        L.DomEvent.disableClickPropagation(trayNode);
        L.DomEvent.on(trayNode, 'contextmenu', L.DomEvent.stopPropagation);
    }
    
    document.getElementById('dropdownBlurBackdrop').addEventListener('click', () => {
        closeAllActiveHUDDropdownOverlays();
        toggleSettingsMenu(false);
        if(typeof dismissMapDetailTrayHUDCard === 'function') dismissMapDetailTrayHUDCard();
        if(typeof toggleItineraryCreationDrawerForm === 'function') toggleItineraryCreationDrawerForm(false);
    });

    // Tapping the tray-specific backdrop (outside the tray card) dismisses the tray
    const trayBackdropEl = document.getElementById('trayBlurBackdrop');
    if (trayBackdropEl) {
        trayBackdropEl.addEventListener('click', () => {
            if (typeof dismissMapDetailTrayHUDCard === 'function') dismissMapDetailTrayHUDCard();
        });
    }

    if (travelSpots.length > 0) {
        calculateSmartCityDefaultFilters();
        renderList();

        // NOTE: intentionally NOT calling triggerOptimalLandingViewportRecalculation here.
        // The map was already positioned correctly by initLeafletMapEngineCanvas using the
        // same resolveInitialMapViewState() logic. A second setView({ reset: true }) here
        // causes a visible black-screen flicker with no benefit.
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') {
            plotDynamicMarkersOnCanvasMap();
        }
        if (typeof buildItinerarySubMenuChecklist === 'function') {
            buildItinerarySubMenuChecklist();
        }
        
        const masterListViewInit = document.getElementById('itineraryMasterListView');
        if (masterListViewInit) masterListViewInit.classList.remove('hidden');
        
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    }
    
    if (!currentUser) {
        document.getElementById('userModal').classList.remove('hidden');
        resetUserModalForm(); // ensure clean form state on every show
    } else {
        initializeSessionDashboard();
    }
    document.addEventListener('click', (event) => {
         if (event.target.closest('button[onclick*="nukeAllSavedData"]') || event.target.closest('#itineraryCreationDrawerModal')) {
             return;
         }

         if (!event.target.closest('#cityHUDDropdownPopupBox') && 
             !event.target.closest('#filterCategoryDropdownPopupBox') && 
             !event.target.closest('#cityFilterHUDTriggerBtn') && 
             !event.target.closest('#filterMenuTriggerBtn')) {
             closeAllActiveHUDDropdownOverlays();
         }
         
         if (!event.target.closest('#mapLayerStyleDropdownDeck') && !event.target.closest('button[onclick*="mapLayerStyleDropdownDeck"]')) {
             const deck = document.getElementById('mapLayerStyleDropdownDeck');
             if (deck) deck.classList.add('hidden');
         }
         
         const settingsMenu = document.getElementById('settingsDrawer');
         if (settingsMenu && !settingsMenu.classList.contains('hidden')) {
             // Don't close settings while a settings sub-modal is open — those modals
             // sit above the drawer and their X button handles the back-navigation.
             const subModalOpen = document.getElementById('settingsConfirmModal')?.classList.contains('hidden') === false
                               || document.getElementById('settingsPurgeModal')?.classList.contains('hidden') === false
                               || document.getElementById('settingsResultModal')?.classList.contains('hidden') === false;
             // Also guard against clicks that originated inside a sub-modal container.
             // Without this, the cancel* functions hide the sub-modal and re-open settings,
             // but the click then bubbles here — subModalOpen is already false by then —
             // and the handler incorrectly closes settings again.
             if (!subModalOpen
                 && !event.target.closest('#settingsDrawerContentBody')
                 && !event.target.closest('#settingsConfirmModal')
                 && !event.target.closest('#settingsPurgeModal')
                 && !event.target.closest('#settingsResultModal')
                 && !event.target.closest('button[onclick="toggleSettingsMenu(true)"]')) {
                 toggleSettingsMenu(false);
             }
         }
     });
};