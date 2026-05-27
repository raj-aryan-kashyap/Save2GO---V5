const APP_VERSION = "v5.0.10";
const API_URL = "https://script.google.com/macros/s/AKfycbyYTU_I0zel50EKpB767LmQ2NjeKudS93yv8-DYSYnBxaFS5_I1TWily79rOkMdGTu5IA/exec"; 
const BACKEND_URL = API_URL;

// --- GLOBAL SHARED APPLICATION ENGINE MEMORY STATE ---
// Restored to localStorage so your database cache survives force-refreshes perfectly
let currentUser = localStorage.getItem('compass_user');
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

// Lisbon default anchor coordinates fallback profiles initialized natively
let userLat = 38.7223; let userLon = -9.1393;
let cachedHardwareString = "Unknown Device Model";
let gpsStatusCachedBool = false; 
let activeTabID = 'map';

let liveGpsWatchId = null; 
let speechBubbleHideTimer = null;
let continuousGpsFailsafeIntervalId = null; 
let lastGpsSuccessTime = 0; 
let cachedUserCoords = null; 
let isCameraLocked = false; 
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
async function populateUserDropdown() {
    const select = document.getElementById('user-dropdown-select');
    try {
        const response = await fetch(`${BACKEND_URL}?action=get_users`);
        if (!response.ok) throw new Error('Failed to reach server');
        const users = await response.json();
        
        select.innerHTML = '<option value="">Select User</option>';
        users.forEach(user => {
            const opt = document.createElement('option');
            opt.value = user;
            opt.textContent = user;
            select.appendChild(opt);
        });
    } catch (err) {
        console.error("Failed to load users:", err);
        select.innerHTML = '<option value="">Error: Server Unreachable</option>';
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
            
            if (typeof triggerOptimalLandingViewportRecalculation === 'function') {
                triggerOptimalLandingViewportRecalculation();
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
