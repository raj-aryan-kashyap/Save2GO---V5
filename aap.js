const APP_VERSION = "v5.0.10";
const API_URL = "https://script.google.com/macros/s/AKfycbyYTU_I0zel50EKpB767LmQ2NjeKudS93yv8-DYSYnBxaFS5_I1TWily79rOkMdGTu5IA/exec"; 
const BACKEND_URL = API_URL;

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

let userLat = 38.7223; let userLon = -9.1393; // Lisbon city-centre — global cold-boot fallback
let cachedHardwareString = "Unknown Device Model";
let gpsStatusCachedBool = false; 
let activeTabID = 'map';

let liveGpsWatchId = null; 
let speechBubbleHideTimer = null;
let continuousGpsFailsafeIntervalId = null; 
let lastGpsSuccessTime = 0; 
let cachedUserCoords = null; 
let isCameraLocked = false;
let gpsLastKnownDenied = false; // true only after a PERMISSION_DENIED error — enables instant modal-show
let currentMapBearingAngle = 0;
let mapTileCleanupTimerId = null;
let hasInitialGpsLockRendered = false;

let leafletMapInstance = null; 
let mapMarkersLayerGroup = null; 
let userPositionPulseCircle = null; 
let userAccuracyRadiusCircle = null;
let activeBaseTileLayer = null; 

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
    e.stopPropagation(); 
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
    const chosenUser = document.getElementById('user-dropdown-select').value || "Global Traveller";
    localStorage.setItem('compass_user', chosenUser); currentUser = chosenUser;
    document.getElementById('userModal').classList.add('hidden');
    initializeSessionDashboard();
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

async function updateCloudAction(rowId, action, value, spotName) {
    const target = travelSpots.find(s => s.rowid === rowId);
    if (target) {
        if (action === 'update_status') target.status = value;
        if (action === 'toggle_priority') target.priority = value;
        
        renderList(); 
        if (typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
        if (typeof renderItineraryMasterDashboardWorkspace === 'function') renderItineraryMasterDashboardWorkspace();
    }
    if (typeof silentPassiveHardwareLocationPingRefresh === 'function') silentPassiveHardwareLocationPingRefresh();
    try {
        await fetch(API_URL, {
            method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowId, action, value, spot: spotName, deviceMeta: cachedHardwareString })
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
        if (priorityEl) priorityEl.classList.add('opacity-35', 'pointer-events-none');
        if (typeEl) typeEl.classList.add('opacity-35', 'pointer-events-none');
        closeAllActiveHUDDropdownOverlays();

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
        }, 50); 
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
    if (activeTabID === 'itinerary') return;
    killLiveSpeechBubbleHUDState();
    showStarredOnly = shouldShowStarredOnly;
    localStorage.setItem('compass_starred_only', JSON.stringify(showStarredOnly));
    syncPriorityFilterViewModeUI(); 
    renderList(); 
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

function syncPriorityFilterViewModeUI() {
    const showAllBtn = document.getElementById('toggleOptionShowAll');
    const starredBtn = document.getElementById('toggleOptionStarred');
    if (showStarredOnly) {
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
    travelSpots.forEach(spot => { if (spot.city && String(spot.city).trim() !== "") citySet.add(spot.city.trim()); });
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
    updateCityHUDTriggerButtonLabelText(); renderList(); 
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
}

function clearAllSelectedCityCheckboxes() {
    checkedCitiesStateArray = []; localStorage.setItem('compass_active_cities', JSON.stringify([]));
    const checkboxes = document.getElementById('cityHUDChecklistContainer').querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    updateCityHUDTriggerButtonLabelText(); renderList(); 
    if(typeof plotDynamicMarkersOnCanvasMap === 'function') plotDynamicMarkersOnCanvasMap();
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

function renderList() {
    const scrollContainerFrame = document.getElementById('gesture-touch-container');
    const counterHUD = document.getElementById('vaultDensityHUDLabelCounter');
    if(!scrollContainerFrame) return;

    const dynamicOldCards = scrollContainerFrame.querySelectorAll('.dynamic-card-node, .dynamic-tailpiece-node, .dynamic-empty-node, .dynamic-spacer-node');
    dynamicOldCards.forEach(el => el.remove());

    const processed = getFilteredDatasetRows();
    if (counterHUD) counterHUD.innerText = `Showing ${processed.length} / ${travelSpots.length} Spots`;
    
    if(processed.length === 0) {
        const errorDiv = document.createElement('div');
        errorDiv.className = "dynamic-empty-node text-center text-slate-600 py-12 text-xs w-full block shrink-0";
        errorDiv.innerText = "No entries loaded matching these selection profiles.";
        scrollContainerFrame.appendChild(errorDiv);
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
        cardWrapper.className = "dynamic-card-node w-full min-h-[260px] h-auto flip-perspective-container transform transition-transform duration-200 shrink-0 block";

        cardWrapper.innerHTML = `
            <div class="flip-card-inner-rotator w-full h-full">
                
                <div class="flip-card-front-face w-full h-full p-4 rounded-2xl border bg-slate-900 border-slate-800 flex flex-col justify-between">
                    <div>
                        <div class="flex justify-between items-start gap-2">
                            <div class="max-w-[70%]">
                                <span class="text-[9px] uppercase px-2 py-0.5 rounded bg-slate-950 text-slate-400 font-bold border border-slate-800">${spot.city} • ${spot.category}</span>
                                <h3 class="text-base font-bold ${isDone ? 'text-slate-500 line-through' : 'text-slate-200'} mt-1.5 truncate">${spot.spot_name}</h3>
                            </div>
                            <span id="dist-badge-${spot.rowid}" class="text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit ${!hasCoordinates ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-pink-500/10 text-pink-400'}">${spot.distStr}</span>
                        </div>
                        <div class="mt-3 bg-slate-950/40 p-2.5 rounded-xl border border-slate-900/60 min-h-[90px] overflow-hidden">
                            <p class="text-xs ${isDone ? 'text-slate-500 line-through' : 'text-slate-400'} leading-relaxed max-h-16 overflow-y-auto pr-1 subtle-scrollbar" ontouchstart="handleNoteTouchStartEvent(event, this.innerText)" ontouchmove="handleNoteTouchMoveEvent(event)" ontouchend="handleNoteTouchEndEvent(event)" onmousedown="handleNoteMouseDownEvent(event, this.innerText)" onmousemove="handleNoteMouseMoveEvent(event)" onmouseup="handleNoteMouseUpEvent(event)">${spot.notes || 'No custom notes.'}</p>
                        </div>
                    </div>
                    <div class="flex flex-col gap-2 mt-3">
                        <div class="flex gap-2">
                            <a href="${spot.instagram_url || '#'}" target="_blank" class="flex-1 bg-gradient-to-r from-pink-600 to-purple-600 text-center text-xs font-bold py-3 rounded-xl text-white flex items-center justify-center shadow-lg">Open Reference</a>
                            <button data-row-id="${spot.rowid}" onclick="handleAdaptiveDirectionClick(this, event)" class="px-4 flex items-center justify-center rounded-xl text-xs font-bold whitespace-nowrap h-12 ${!hasValidMapDestination ? 'bg-slate-950 border border-slate-800 text-amber-400 text-sm font-black w-14 shrink-0' : 'bg-slate-950 border border-slate-800 text-slate-300 flex-1'}">
                                ${!hasValidMapDestination ? '<i class="fa-solid fa-triangle-exclamation"></i>' : '<i class="fa-solid fa-map mr-1.5 text-sm"></i> Directions'}
                            </button>
                        </div>
                        ${ticketLink.trim() !== "" ? `<a href="${ticketLink}" target="_blank" class="w-full mt-1 bg-emerald-600 text-center text-xs font-bold py-2.5 rounded-xl text-white block">📄 View Ticket Details</a>` : ''}
                        <div class="flex gap-2 mt-1 justify-end items-center">
                            <button onclick="handleManualInlineCardFlipExecution(event, '${uniqueCardContainerId}', 'forward')" class="text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2.5 py-1.5 rounded-lg text-[11px] font-black tracking-wide mr-auto active:bg-sky-500/20">
                                <i class="fa-solid fa-circle-info mr-1"></i> Extra Info
                            </button>
                            <button onclick="updateCloudAction(${spot.rowid}, 'update_status', '${isDone ? 'Pending' : 'Done'}', '${spot.spot_name}')" class="text-xs px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-400 font-bold active:bg-slate-855">${isDone ? '<i class="fa-solid fa-arrow-rotate-left mr-1"></i> Undo' : '<i class="fa-solid fa-check mr-1"></i> Mark Done'}</button>
                            <button onclick="updateCloudAction(${spot.rowid}, 'toggle_priority', '${isHigh ? 'Normal' : 'Starred'}', '${spot.spot_name}')" class="text-xs px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-amber-400">${isHigh ? '<i class="fa-solid fa-star-half-stroke mr-1"></i> Unstar' : '<i class="fa-solid fa-star mr-1"></i> Star'}</button>
                        </div>
                    </div>
                </div>
                <div class="flip-card-back-face w-full h-full p-4 rounded-2xl border bg-slate-900 border-slate-800 flex flex-col justify-between overflow-hidden">
                    <div class="flex border-b border-slate-800/60 pb-1.5 shrink-0 items-center justify-between">
                        <span class="text-[10px] font-black uppercase text-slate-400 tracking-wider">Extra Info</span>
                        <span class="text-[8px] text-slate-600 font-mono">ID: #${spot.rowid}</span>
                    </div>
                    <div class="flex-1 overflow-y-auto subtle-scrollbar my-2 pr-0.5 space-y-3 text-[11px]">
                        <p class="text-slate-300 leading-relaxed font-medium bg-slate-950/50 border border-slate-950 p-2.5 rounded-xl">${(spot.long_description && spot.long_description !== "N/A") ? spot.long_description : 'No background summary recorded.'}</p>
                        
                        <div class="space-y-1">
                            <span class="text-[8px] font-black uppercase tracking-widest text-pink-500 block">Itinerary Mapping Tracker</span>
                            <div class="bg-slate-950 border border-slate-955 p-2 rounded-xl flex items-center justify-between gap-2">
                                <span class="font-bold text-slate-400 uppercase tracking-wide text-[9px]">Map to Schedule:</span>
                                <div class="flex gap-1">
                                    <button onclick="if(typeof injectActiveSpotToItineraryDay === 'function') injectActiveSpotToItineraryDay(1, ${spot.rowid}, event)" class="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-[9px] font-bold">D1</button>
                                    <button onclick="if(typeof injectActiveSpotToItineraryDay === 'function') injectActiveSpotToItineraryDay(2, ${spot.rowid}, event)" class="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-[9px] font-bold">D2</button>
                                    <button onclick="if(typeof injectActiveSpotToItineraryDay === 'function') injectActiveSpotToItineraryDay(3, ${spot.rowid}, event)" class="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 text-[9px] font-bold">D3</button>
                                </div>
                            </div>
                        </div>
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

let _sConfirmCb = null; // stored callback for executeSettingsConfirmAction

/**
 * Open the reusable confirm modal.
 * @param {object} cfg - { faIcon, iconBg, iconColor, topBar, title, body,
 *                         btnLabel, btnClass, callback }
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
    btn.textContent  = cfg.btnLabel;
    btn.className    = `w-full py-3 ${cfg.btnClass || 'bg-gradient-to-r from-red-600 to-rose-700'} font-black text-xs uppercase tracking-wider rounded-xl text-white active:scale-95 transition-transform shadow-lg`;
    _sConfirmCb = cfg.callback || null;
    document.getElementById('settingsConfirmModal').classList.remove('hidden');
}
function closeSettingsConfirmModal() {
    // Programmatic close (action executed) — settings already handled by callback
    document.getElementById('settingsConfirmModal').classList.add('hidden');
    _sConfirmCb = null;
}
function cancelSettingsConfirmModal() {
    // X button dismiss — user cancelled, navigate back to settings drawer
    closeSettingsConfirmModal();
    toggleSettingsMenu(true);
}
function executeSettingsConfirmAction() {
    const cb = _sConfirmCb;
    closeSettingsConfirmModal();
    if (typeof cb === 'function') cb();
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
        callback: async () => {
            try {
                await fetch(BACKEND_URL, {
                    method: 'POST',
                    mode: 'cors',
                    body: JSON.stringify({
                        action: 'log_name_change',
                        user: newName,
                        oldName,
                        deviceMeta: cachedHardwareString
                    })
                });
            } catch (err) {
                console.error('Failed to log name change to cloud logs:', err);
            }

            localStorage.setItem('compass_user', newName);
            currentUser = newName;

            // Keep cached list accurate for duplicate-check within the session
            if (!registeredUsersList.includes(newName)) registeredUsersList.push(newName);

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
            localStorage.clear();
            window.location.reload();
        }
    });
}

// ----------------- APP INITIALIZATION (MASTER BOOTLOADER) -----------------
window.onload = function() {
    // NOTE: Do NOT write any default zoom/lat/lng here — doing so would wipe the
    // user's last active view on every reload. The priority resolver in map.js
    // reads and validates those values independently.

    cachedHardwareString = parseReadableDeviceHardware();
    document.getElementById('meta-id').innerText = `Device ID: ${deviceId}`;
    document.getElementById('meta-hardware').innerText = `Model: ${cachedHardwareString}`;
    document.getElementById('meta-version').innerText = `Version: ${APP_VERSION}`;
    
    if (typeof initLeafletMapEngineCanvas === 'function') initLeafletMapEngineCanvas();

    // Auto-start GPS stream if permission was already granted on a previous visit.
    // We lock the camera first so the watchPosition callback moves the map to the
    // user's location on the first fix (the callback won't setView without this).
    if (navigator.permissions) {
        navigator.permissions.query({ name: 'geolocation' }).then(result => {
            if (result.state === 'granted' && typeof startLiveHardwareGPSTracking === 'function') {
                isCameraLocked = true; // allow first fix to centre the viewport
                if (typeof syncCameraLockVisualUIState === 'function') syncCameraLockVisualUIState();
                startLiveHardwareGPSTracking();
            }
        }).catch(() => { /* permissions API unsupported — GPS stays opt-in */ });
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
    populateUserDropdown(); 
    syncPriorityFilterViewModeUI();
    
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
             if (!subModalOpen
                 && !event.target.closest('#settingsDrawerContentBody')
                 && !event.target.closest('button[onclick="toggleSettingsMenu(true)"]')) {
                 toggleSettingsMenu(false);
             }
         }
     });
};