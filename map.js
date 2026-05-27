function calculateDefaultMapCenterCity() {
    if (!travelSpots || travelSpots.length === 0) return null;

    let cityDensityCounterMap = {};
    let highestFrequencyFound = 0;
    let candidatePoolList = [];

    travelSpots.forEach(spot => {
        if (!spot.city || !spot.latitude || String(spot.latitude).trim() === "0") return;
        const nameKey = spot.city.trim();
        cityDensityCounterMap[nameKey] = (cityDensityCounterMap[nameKey] || 0) + 1;
        
        if (cityDensityCounterMap[nameKey] > highestFrequencyFound) {
            highestFrequencyFound = cityDensityCounterMap[nameKey];
        }
    });

    for (let cityName in cityDensityCounterMap) {
        if (cityDensityCounterMap[cityName] === highestFrequencyFound) {
            candidatePoolList.push(cityName);
        }
    }

    if (candidatePoolList.length === 0) return null;
    
    const pickedCityName = candidatePoolList[Math.floor(Math.random() * candidatePoolList.length)];
    return travelSpots.find(s => s.city === pickedCityName);
}

function triggerOptimalLandingViewportRecalculation() {
    if (!leafletMapInstance) return;
    
    const savedLat = localStorage.getItem('compass_map_state_lat');
    const savedLng = localStorage.getItem('compass_map_state_lng');
    const savedZoom = localStorage.getItem('compass_map_state_zoom');

    if (savedLat && savedLng && savedZoom && savedLat !== "0" && savedLat !== "38.7223") {
        leafletMapInstance.setView([parseFloat(savedLat), parseFloat(savedLng)], parseInt(savedZoom), { reset: true });
    } else {
        const optimalDefaultRecord = calculateDefaultMapCenterCity();
        if (optimalDefaultRecord) {
            leafletMapInstance.setView([parseFloat(optimalDefaultRecord.latitude), parseFloat(optimalDefaultRecord.longitude)], 12, { reset: true });
            localStorage.setItem('compass_map_state_lat', optimalDefaultRecord.latitude);
            localStorage.setItem('compass_map_state_lng', optimalDefaultRecord.longitude);
            localStorage.setItem('compass_map_state_zoom', '12');
        } else {
            leafletMapInstance.setView([38.7223, -9.1393], 12, { reset: true });
        }
    }
}

function initLeafletMapEngineCanvas() {
    if (leafletMapInstance) return;
    
    leafletMapInstance = L.map('map-render-element', { 
        zoomControl: false, 
        attributionControl: false,
        touchRotate: true,
        rotate: true,
        bounceAtZoomLimits: false,
        fadeAnimation: false 
    }).setView([38.7223, -9.1393], 12);
    
    setMapBaseLayerProviderSource(currentMapStyleKey);
    mapMarkersLayerGroup = L.layerGroup().addTo(leafletMapInstance);

    leafletMapInstance.on('movestart zoomstart dragstart', (e) => {
        const deck = document.getElementById('mapLayerStyleDropdownDeck');
        if (deck) deck.classList.add('hidden');
    });

    leafletMapInstance.on('moveend zoomend viewreset animationend', () => {
        if (leafletMapInstance) {
            const currentZoomLevel = leafletMapInstance.getZoom();
            const debugNode = document.getElementById('mapZoomDebugHUD');
            if (debugNode) debugNode.innerText = `Zoom: ${currentZoomLevel}`;

            const center = leafletMapInstance.getCenter();
            localStorage.setItem('compass_map_state_lat', center.lat);
            localStorage.setItem('compass_map_state_lng', center.lng);
            localStorage.setItem('compass_map_state_zoom', String(currentZoomLevel));
            
            if (travelSpots.length > 0) {
                window.requestAnimationFrame(() => {
                    plotDynamicMarkersOnCanvasMap();
                });
            }
        }
    });

    triggerOptimalLandingViewportRecalculation();
    
    // Smooth Veil Reveal Loop: Safe calibration sequence removes the loading curtain overlay cleanly
    setTimeout(() => {
        if (leafletMapInstance) {
            window.requestAnimationFrame(() => {
                leafletMapInstance.invalidateSize({ animate: false });
                triggerOptimalLandingViewportRecalculation();
                
                setTimeout(() => {
                    window.requestAnimationFrame(() => {
                        const warmupScreenNode = document.getElementById('mapCanvasWarmupLoader');
                        if(warmupScreenNode) {
                            warmupScreenNode.classList.add('opacity-0');
                            setTimeout(() => { warmupScreenNode.classList.add('hidden'); }, 500);
                        }
                    });
                }, 350); 
            });
        }
    }, 1500);
}

function setMapBaseLayerProviderSource(styleKey) {
    if(!leafletMapInstance) return;
    if(activeBaseTileLayer) leafletMapInstance.removeLayer(activeBaseTileLayer);

    let providerUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    let attributionMeta = { maxZoom: 20, preload: true, keepBuffer: 4 };
    let visibleLabel = "Style: Dark";

    if(styleKey === 'light') {
        providerUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
        visibleLabel = "Style: Light";
    } else if(styleKey === 'terrain') {
        providerUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        visibleLabel = "Style: Terrain";
    } else if(styleKey === 'satellite') {
        providerUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
        attributionMeta.maxZoom = 18;
        visibleLabel = "Style: Sat";
    }

    activeBaseTileLayer = L.tileLayer(providerUrl, attributionMeta).addTo(leafletMapInstance);
    currentMapStyleKey = styleKey;
    localStorage.setItem('compass_map_style', styleKey);

    const displayLabelNode = document.getElementById('activeLayerDisplayLabel');
    if(displayLabelNode) displayLabelNode.innerText = visibleLabel;

    if (mapMarkersLayerGroup && travelSpots.length > 0) {
        plotDynamicMarkersOnCanvasMap();
    }
}

function updateGpsHudStatus(statusKey, labelText) {
    const btn = document.getElementById('gpsBadgeButton');
    const iconFrame = document.getElementById('gpsIconFrame');
    const textFrame = document.getElementById('gpsBadgeText');
    if (!btn || !iconFrame || !textFrame) return;

    if (statusKey === 'syncing') {
        textFrame.innerText = "GPS Syncing...";
    } else if (statusKey === 'active') {
        textFrame.innerText = "GPS Active";
    } else {
        textFrame.innerText = "GPS Off";
    }

    if (statusKey === 'active') {
        btn.className = "h-8 px-2.5 rounded-lg text-[9px] font-black uppercase border flex items-center gap-1.5 bg-emerald-500/10 border-emerald-500/40 text-emerald-400 cursor-pointer relative z-[60] transition-colors";
        iconFrame.innerHTML = '<i class="fa-solid fa-location-crosshairs text-emerald-400"></i>';
    } else if (statusKey === 'syncing') {
        btn.className = "h-8 px-2.5 rounded-lg text-[9px] font-black uppercase border flex items-center gap-1.5 bg-amber-500/10 border-amber-500/40 text-amber-400 cursor-pointer relative z-[60] transition-colors";
        iconFrame.innerHTML = '<i class="fa-solid fa-location-crosshairs text-amber-400 subtle-gps-pulse"></i>';
    } else {
        btn.className = "h-8 px-2.5 rounded-lg text-[9px] font-black uppercase border flex items-center gap-1.5 bg-red-500/10 border-red-500/20 text-red-400 cursor-pointer relative z-[60] transition-colors";
        iconFrame.innerHTML = '<i class="fa-solid fa-location-crosshairs text-red-400"></i>';
    }
}

function handleGpsBadgeClickAction(event) {
    if (event) event.stopPropagation();
    startLiveHardwareGPSTracking();
}

function startLiveHardwareGPSTracking() {
    if (!navigator.geolocation) {
        gpsStatusCachedBool = false;
        updateGpsHudStatus('off', "Unsupported");
        return;
    }
    
    if (liveGpsWatchId !== null) {
        navigator.geolocation.clearWatch(liveGpsWatchId);
    }
    
    updateGpsHudStatus('syncing', "Syncing...");

    liveGpsWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            gpsStatusCachedBool = true;
            lastGpsSuccessTime = Date.now();
            cachedUserCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            userLat = pos.coords.latitude; userLon = pos.coords.longitude;
            updateGpsHudStatus('active', "GPS Active");

            isCameraLocked = true;
            syncCameraLockVisualUIState();

            if (leafletMapInstance) {
                if (userPositionPulseCircle) {
                    userPositionPulseCircle.setLatLng([userLat, userLon]);
                } else {
                    userPositionPulseCircle = L.circleMarker([userLat, userLon], { 
                        radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#ffffff', weight: 2 
                    }).addTo(leafletMapInstance);
                }
                leafletMapInstance.setView([userLat, userLon], 18);
            }
        },
        (err) => {
            gpsStatusCachedBool = false;
            isCameraLocked = false;
            syncCameraLockVisualUIState();
            updateGpsHudStatus('off', "GPS Off");
            document.getElementById('gpsInstructionsOverlayModal').classList.remove('hidden');
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

function triggerRecenterToGpsHardwareAction(event) {
    if(event) event.stopPropagation();
    
    const compassBtn = document.getElementById('hardwareCompassRecenterButtonNode');
    if (compassBtn) {
        compassBtn.classList.add('scale-95', 'transition-transform', 'duration-100');
        setTimeout(() => { compassBtn.classList.remove('scale-95'); }, 120);
    }

    if (!gpsStatusCachedBool && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                gpsStatusCachedBool = true;
                cachedUserCoords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
                userLat = pos.coords.latitude; userLon = pos.coords.longitude;
                updateGpsHudStatus('active', "GPS Active");
                executeSnappyRecenterViewportSequence();
            },
            (err) => {
                gpsStatusCachedBool = false;
                updateGpsHudStatus('off', "GPS Off");
                document.getElementById('gpsInstructionsOverlayModal').classList.remove('hidden');
            },
            { timeout: 1500, maximumAge: 0 }
        );
        return;
    }

    executeSnappyRecenterViewportSequence();
}

function executeSnappyRecenterViewportSequence() {
    if (!leafletMapInstance) return;

    const compassBtn = document.getElementById('hardwareCompassRecenterButtonNode');
    if (isCameraLocked && compassBtn) {
        compassBtn.classList.remove('thematic-pink-glow');
        void compassBtn.offsetWidth; 
        compassBtn.classList.add('thematic-pink-glow');
        return;
    }

    const emojiSpinnerNode = document.getElementById('innerCompassEmojiSpinnerSpan');
    if (emojiSpinnerNode) {
        emojiSpinnerNode.style.transform = 'rotate(180deg) scale(0.85)';
        setTimeout(() => { emojiSpinnerNode.style.transform = 'rotate(0deg) scale(1)'; }, 350);
    }

    if (cachedUserCoords) {
        leafletMapInstance.setView([cachedUserCoords.lat, cachedUserCoords.lon], 18, { animate: false });
    }

    isCameraLocked = true;
    syncCameraLockVisualUIState();
    startLiveHardwareGPSTracking();
}

function syncCameraLockVisualUIState() {
    const compassBtn = document.getElementById('hardwareCompassRecenterButtonNode');
    if (!compassBtn) return;
    
    if (isCameraLocked) {
        compassBtn.className = "w-12 h-12 bg-slate-900 rounded-full flex items-center justify-center text-slate-300 active:bg-slate-800 transition-all duration-300 select-none overflow-hidden relative text-[19px] thematic-pink-glow";
    } else {
        compassBtn.className = "w-12 h-12 bg-slate-900/95 border border-slate-800 rounded-full shadow-2xl flex items-center justify-center text-slate-300 active:bg-slate-800 transition-all duration-300 select-none overflow-hidden relative text-[19px]";
    }
}

function snapMapViewportToSelectedCityBounds(event) {
    if(event) event.stopPropagation();
    const magnifyingButton = document.getElementById('shortcutMagnifyingButton');
    if (!leafletMapInstance || travelSpots.length === 0) return;
    
    if (checkedCitiesStateArray.length === 0) {
        if(magnifyingButton) magnifyingButton.classList.add('thematic-pink-glow');
        return;
    }

    let activeCityPins = travelSpots.filter(spot => spot.latitude && checkedCitiesStateArray.includes(spot.city));
    if (activeCityPins.length === 0) return;

    let targetBounds = L.latLngBounds();
    activeCityPins.forEach(spot => targetBounds.extend([parseFloat(spot.latitude), parseFloat(spot.longitude)]));

    isCameraLocked = false;
    syncCameraLockVisualUIState();
    leafletMapInstance.fitBounds(targetBounds, { padding: [50, 50], animate: true });
}

function plotDynamicMarkersOnCanvasMap() {
    if(!mapMarkersLayerGroup || !leafletMapInstance) return;
    mapMarkersLayerGroup.clearLayers();
    if(typeof getFilteredDatasetRows !== 'function') return;

    const dataset = getFilteredDatasetRows();
    dataset.forEach(spot => {
        if(!spot.latitude || !spot.longitude || String(spot.latitude).trim() === "0") return;
        
        const isStarred = ['high', '🔥', 'must do', 'starred'].includes((spot.priority || "").toLowerCase());
        const iconHTML = `<div class="custom-map-cube bg-slate-900 border-slate-700 ${isStarred ? '!border-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.7)]' : ''}"><i class="fa-solid fa-location-dot text-pink-500"></i></div>`;
        const customMarkerIcon = L.divIcon({ html: iconHTML, className: '', iconSize: [36, 36], iconAnchor: [18, 18] });
        
        const leafMarker = L.marker([parseFloat(spot.latitude), parseFloat(spot.longitude)], { icon: customMarkerIcon });
        mapMarkersLayerGroup.addLayer(leafMarker);
    });
}
