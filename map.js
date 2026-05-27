// map.js — production build, no mock/debug overrides

function setupV4TwoFingerRotationListeners() {
    if (!ENABLE_MAP_ROTATION) return;
    const targetElement = document.getElementById('map-render-element');
    if (!targetElement) return;

    let initialTouchAngle = 0;
    let baseBearingAngleOnTouchStart = 0;
    let processingRotationActive = false;

    targetElement.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
            processingRotationActive = true;
            baseBearingAngleOnTouchStart = currentMapBearingAngle;
            initialTouchAngle = Math.atan2(
                e.touches[1].pageY - e.touches[0].pageY,
                e.touches[1].pageX - e.touches[0].pageX
            ) * 180 / Math.PI;
        }
    }, { passive: true });

    targetElement.addEventListener('touchmove', (e) => {
        if (processingRotationActive && e.touches.length === 2) {
            const currentTouchAngle = Math.atan2(
                e.touches[1].pageY - e.touches[0].pageY,
                e.touches[1].pageX - e.touches[0].pageX
            ) * 180 / Math.PI;
            
            const angleDelta = currentTouchAngle - initialTouchAngle;
            currentMapBearingAngle = (baseBearingAngleOnTouchStart + angleDelta) % 360;
            
            const pane = document.querySelector('.leaflet-map-pane');
            if (pane) {
                pane.style.transform = `rotate(${currentMapBearingAngle}deg)`;
            }

            const innerCompassIcon = document.getElementById('innerCompassEmojiSpinnerSpan');
            if (innerCompassIcon) {
                innerCompassIcon.style.transform = `rotate(${-currentMapBearingAngle}deg)`;
            }
        }
    }, { passive: true });

    targetElement.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
            processingRotationActive = false;
        }
    }, { passive: true });
}

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

// ── Map Viewport Priority Resolver ───────────────────────────────────────────
// Priority 1: Last active saved view (localStorage)
// Priority 2: Most-frequent city in the database
// Priority 3: Lisbon city-centre cold-boot fallback
function resolveInitialMapViewState() {
    const rawLat  = localStorage.getItem('compass_map_state_lat');
    const rawLng  = localStorage.getItem('compass_map_state_lng');
    const rawZoom = localStorage.getItem('compass_map_state_zoom');

    if (rawLat && rawLng && rawZoom) {
        const lat = parseFloat(rawLat), lng = parseFloat(rawLng), zoom = parseInt(rawZoom, 10);
        if (!isNaN(lat) && !isNaN(lng) && !isNaN(zoom) && zoom >= 1 && zoom <= 20) {
            return { lat, lng, zoom };
        }
    }

    const cityRecord = calculateDefaultMapCenterCity();
    if (cityRecord) {
        const lat = parseFloat(cityRecord.latitude), lng = parseFloat(cityRecord.longitude);
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng, zoom: 12 };
    }

    // Global fallback: Lisbon city centre
    return { lat: 38.7223, lng: -9.1393, zoom: 12 };
}

function triggerOptimalLandingViewportRecalculation() {
    if (!leafletMapInstance) return;
    const view = resolveInitialMapViewState();
    leafletMapInstance.setView([view.lat, view.lng], view.zoom, { reset: true });
}

function initLeafletMapEngineCanvas() {
    if (leafletMapInstance) return;

    // Resolve correct starting view BEFORE creating the map so tiles load at
    // the right location immediately — no viewport flash or wasted tile fetches
    const initialView = resolveInitialMapViewState();

    leafletMapInstance = L.map('map-render-element', {
        zoomControl: false,
        attributionControl: false,
        touchRotate: true,
        rotate: true,
        bounceAtZoomLimits: false,
        fadeAnimation: false
    }).setView([initialView.lat, initialView.lng], initialView.zoom);

    setMapBaseLayerProviderSource(currentMapStyleKey);
    mapMarkersLayerGroup = L.layerGroup().addTo(leafletMapInstance);

    // Ensure the map fills its container from the first rendered frame
    window.requestAnimationFrame(() => leafletMapInstance.invalidateSize({ animate: false }));

    leafletMapInstance.on('movestart zoomstart dragstart', () => {
        document.getElementById('mapLayerStyleDropdownDeck')?.classList.add('hidden');
    });

    leafletMapInstance.on('moveend zoomend viewreset animationend', () => {
        if (!leafletMapInstance) return;
        const zoom   = leafletMapInstance.getZoom();
        const center = leafletMapInstance.getCenter();
        const debugNode = document.getElementById('mapZoomDebugHUD');
        if (debugNode) debugNode.innerText = `Zoom: ${zoom}`;

        // Continuously persist the active view so the next launch resumes here
        localStorage.setItem('compass_map_state_lat',  center.lat);
        localStorage.setItem('compass_map_state_lng',  center.lng);
        localStorage.setItem('compass_map_state_zoom', String(zoom));

        if (travelSpots.length > 0) {
            window.requestAnimationFrame(() => plotDynamicMarkersOnCanvasMap());
        }

        if (mapTileCleanupTimerId) clearTimeout(mapTileCleanupTimerId);
        mapTileCleanupTimerId = setTimeout(() => {
            if (activeBaseTileLayer?._pruneTiles) activeBaseTileLayer._pruneTiles();
        }, 10000);
    });

    // ── Calibration canvas dismiss ────────────────────────────────────────────
    // Waits for the tile layer's load event (all current-viewport tiles ready),
    // then holds a 350 ms settle buffer so the user sees a fully-rendered map
    // when the curtain lifts — not a half-loaded canvas.
    // Hard maximum: 3 s in case tiles are slow or the device is offline.
    let calibrationDismissed = false;
    const dismissCalibrationScreen = () => {
        if (calibrationDismissed) return;
        calibrationDismissed = true;

        // 350 ms tile-settle buffer
        setTimeout(() => {
            const el = document.getElementById('mapCanvasWarmupLoader');
            if (!el || el.style.display === 'none') return;
            el.style.pointerEvents = 'none';
            el.style.touchAction   = 'auto';
            el.style.transition    = 'opacity 0.5s ease';
            el.style.opacity       = '0';
            setTimeout(() => {
                el.style.display       = 'none';
                el.style.pointerEvents = 'none';
            }, 550);
        }, 350);
    };

    if (activeBaseTileLayer) activeBaseTileLayer.once('load', dismissCalibrationScreen);
    setTimeout(dismissCalibrationScreen, 3000); // hard max safety net

    const debugNode = document.getElementById('mapZoomDebugHUD');
    if (debugNode) debugNode.innerText = `Zoom: ${leafletMapInstance.getZoom()}`;
}

function setMapBaseLayerProviderSource(styleKey) {
    if(!leafletMapInstance) return;
    if(activeBaseTileLayer) leafletMapInstance.removeLayer(activeBaseTileLayer);

    let providerUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    
    let attributionMeta = { 
        maxZoom: 20,
        preload: true,
        keepBuffer: 4, 
        updateWhenIdle: false, 
        updateWhenZooming: false
    };
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

    ['dark', 'light', 'terrain', 'satellite'].forEach(k => {
        const card = document.getElementById(`styleCard-${k}`);
        if(card) {
            if(k === styleKey) {
                card.className = "flex flex-col items-center gap-1 p-1 bg-slate-900 rounded-xl border-2 border-pink-500 shadow-lg scale-105 transform duration-150";
            } else {
                card.className = "flex flex-col items-center gap-1 p-1 bg-slate-950 rounded-xl border border-slate-800/80 hover:bg-slate-900 transition-all duration-150 opacity-70";
            }
        }
    });

    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if(deck) deck.classList.add('hidden');
    
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
    
    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

    startLiveHardwareGPSTracking();
}

function monitorNativeGpsPermissions() {
    if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then(status => {
            const checkState = () => {
                if (status.state === 'denied') { 
                    gpsStatusCachedBool = false; 
                    updateGpsHudStatus('off', "GPS Off"); 
                }
            };
            status.onchange = checkState; checkState();
        });
    }
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
            gpsStatusCachedBool  = true;
            gpsLastKnownDenied   = false; // clear any previous denied state on success
            lastGpsSuccessTime   = Date.now();
            userLat              = pos.coords.latitude;
            userLon              = pos.coords.longitude;
            cachedUserCoords     = { lat: userLat, lon: userLon };

            // Persist live telemetry so next launch has fresh cached coords
            localStorage.setItem('compass_user_live_lat', userLat);
            localStorage.setItem('compass_user_live_lng', userLon);
            localStorage.setItem('compass_user_live_ts',  Date.now());

            updateGpsHudStatus('active', "GPS Active");
            // NOTE: do NOT forcefully set isCameraLocked = true here.
            // Camera lock is an intentional user action (recenter tap / auto-start).
            // If the user navigated away manually (e.g. magnifying glass city zoom),
            // isCameraLocked will be false — honour that and update the position
            // marker silently without hijacking the viewport.
            syncCameraLockVisualUIState();

            if (leafletMapInstance) {
                // Always keep the position marker accurate regardless of lock state
                if (userPositionPulseCircle) {
                    userPositionPulseCircle.setLatLng([userLat, userLon]);
                } else {
                    userPositionPulseCircle = L.circleMarker([userLat, userLon], {
                        radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#ffffff', weight: 2
                    }).addTo(leafletMapInstance);
                }

                const accuracy = pos.coords.accuracy || 0;
                if (userAccuracyRadiusCircle) {
                    userAccuracyRadiusCircle.setLatLng([userLat, userLon]).setRadius(accuracy);
                } else {
                    userAccuracyRadiusCircle = L.circle([userLat, userLon], {
                        radius: accuracy,
                        fillColor: '#3b82f6',
                        fillOpacity: 0.12,
                        stroke: false,
                        pointerEvents: 'none'
                    }).addTo(leafletMapInstance);
                }

                // Only pan the viewport when the user has explicitly locked onto GPS.
                // This prevents the map snapping back after a magnifying-glass city zoom
                // or any other intentional manual navigation.
                if (isCameraLocked) {
                    leafletMapInstance.setView([userLat, userLon], leafletMapInstance.getZoom());
                }
            }
        },
        (err) => {
            if (err.code === err.PERMISSION_DENIED) {
                gpsLastKnownDenied  = true;
                gpsStatusCachedBool = false;
                isCameraLocked      = false;
                syncCameraLockVisualUIState();
                updateGpsHudStatus('off', "GPS Off");
                document.getElementById('gpsInstructionsOverlayModal').classList.remove('hidden');
                if (liveGpsWatchId !== null) {
                    navigator.geolocation.clearWatch(liveGpsWatchId);
                    liveGpsWatchId = null;
                }
            } else {
                // Transient error (timeout / position unavailable) — stay syncing, watchPosition retries
                updateGpsHudStatus('syncing', "GPS Syncing...");
            }
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

// ── Recenter: instant snap to cached coords + silent background micro-adjust ──
function _executeInstantRecenterSnap() {
    if (!cachedUserCoords || !leafletMapInstance) return;

    const snapLat = cachedUserCoords.lat;
    const snapLon = cachedUserCoords.lon;

    // Instant viewport snap — zero hardware latency, user sees their location
    // the same millisecond they tap the button
    leafletMapInstance.setView([snapLat, snapLon], 18);
    isCameraLocked = true;
    syncCameraLockVisualUIState();

    // Place / update the user position marker at the cached location immediately
    if (userPositionPulseCircle) {
        userPositionPulseCircle.setLatLng([snapLat, snapLon]);
    } else {
        userPositionPulseCircle = L.circleMarker([snapLat, snapLon], {
            radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#ffffff', weight: 2
        }).addTo(leafletMapInstance);
    }

    // Silent background micro-adjustment — only when the live stream is already
    // running (otherwise starting the stream handles the authoritative position)
    if (liveGpsWatchId !== null && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const freshLat = pos.coords.latitude;
                const freshLon = pos.coords.longitude;

                // Update global telemetry cache
                userLat          = freshLat;
                userLon          = freshLon;
                cachedUserCoords = { lat: freshLat, lon: freshLon };
                gpsStatusCachedBool = true;
                lastGpsSuccessTime  = Date.now();
                localStorage.setItem('compass_user_live_lat', freshLat);
                localStorage.setItem('compass_user_live_lng', freshLon);
                localStorage.setItem('compass_user_live_ts',  Date.now());

                // Only pan if the user has physically moved more than ~5 metres
                // (0.00005° ≈ 5.5 m) — filters GPS noise, prevents jarring micro-snaps
                const moved = Math.abs(freshLat - snapLat) > 0.00005 ||
                              Math.abs(freshLon - snapLon) > 0.00005;

                if (moved) {
                    if (userPositionPulseCircle) userPositionPulseCircle.setLatLng([freshLat, freshLon]);
                    if (userAccuracyRadiusCircle) {
                        userAccuracyRadiusCircle.setLatLng([freshLat, freshLon])
                                                .setRadius(pos.coords.accuracy || 0);
                    }
                    if (leafletMapInstance && isCameraLocked) {
                        leafletMapInstance.panTo([freshLat, freshLon], { animate: true, duration: 0.5 });
                    }
                }
            },
            () => { /* silent — cached snap coordinates are still valid */ },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
        );
    }

    // If the live stream isn't running, start it — it will take over continuous tracking
    if (liveGpsWatchId === null) {
        startLiveHardwareGPSTracking();
    }
}

// ── Recovery poll: verify hardware state when GPS modal is already open ───────
// Fires a single getCurrentPosition to check if the user re-enabled GPS in Settings.
// Success: dismiss modal, lock camera, snap to confirmed position.
// Failure: keep modal open, keep HUD red, map stays exactly as-is.
function _pollGpsForModalRecovery() {
    if (!navigator.geolocation) return;

    updateGpsHudStatus('syncing', "GPS Syncing...");

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            // GPS is now active — reset denied flag and update all state
            gpsLastKnownDenied  = false;
            gpsStatusCachedBool = true;
            lastGpsSuccessTime  = Date.now();
            userLat             = pos.coords.latitude;
            userLon             = pos.coords.longitude;
            cachedUserCoords    = { lat: userLat, lon: userLon };

            localStorage.setItem('compass_user_live_lat', userLat);
            localStorage.setItem('compass_user_live_lng', userLon);
            localStorage.setItem('compass_user_live_ts',  Date.now());

            // Dismiss the error modal
            const modal = document.getElementById('gpsInstructionsOverlayModal');
            if (modal) modal.classList.add('hidden');

            updateGpsHudStatus('active', "GPS Active");
            isCameraLocked = true;
            syncCameraLockVisualUIState();

            // Snap map to confirmed hardware position
            if (leafletMapInstance) {
                leafletMapInstance.setView([userLat, userLon], 18);
                if (userPositionPulseCircle) {
                    userPositionPulseCircle.setLatLng([userLat, userLon]);
                } else {
                    userPositionPulseCircle = L.circleMarker([userLat, userLon], {
                        radius: 8, fillColor: '#3b82f6', fillOpacity: 0.8, color: '#ffffff', weight: 2
                    }).addTo(leafletMapInstance);
                }
            }

            // Start continuous watchPosition stream now that permission is granted
            startLiveHardwareGPSTracking();
        },
        (err) => {
            // GPS still off or denied — keep modal open, no map changes
            if (err.code === err.PERMISSION_DENIED) gpsLastKnownDenied = true;
            gpsStatusCachedBool = false;
            updateGpsHudStatus('off', "GPS Off");
            // Modal stays visible, camera stays unlocked, map tiles unchanged
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
}

// ── Main recenter entry-point — routes to the correct state handler ───────────
function triggerRecenterToGpsHardwareAction(event) {
    if (event) event.stopPropagation();

    const compassBtn  = document.getElementById('hardwareCompassRecenterButtonNode');
    const compassIcon = document.getElementById('innerCompassEmojiSpinnerSpan');
    const modal       = document.getElementById('gpsInstructionsOverlayModal');
    const isModalOpen = modal && !modal.classList.contains('hidden');

    // ── Button press animation (always, every tap) ───────────────────────────
    if (compassBtn) {
        compassBtn.classList.remove('recenter-button-press');
        void compassBtn.offsetWidth;
        compassBtn.classList.add('recenter-button-press');
        setTimeout(() => compassBtn.classList.remove('recenter-button-press'), 420);
    }

    // ── State D: Error modal is open — verify hardware and attempt recovery ──
    if (isModalOpen) {
        _pollGpsForModalRecovery();
        return;
    }

    // ── State C: GPS hardware is known denied/off — intercept, preserve map ──
    // Map viewport is NOT touched — tiles stay on whatever coordinates were
    // already displaying, preventing any risk of undefined coordinate writes
    if (!navigator.geolocation || gpsLastKnownDenied) {
        if (modal) modal.classList.remove('hidden');
        updateGpsHudStatus('off', "GPS Off");
        return;
    }

    // Snapshot centering state BEFORE any async side-effects can change it
    const wasAlreadyCentered = isCameraLocked;

    // ── Visual feedback: compass spin (new location) or pink glow (already locked)
    if (wasAlreadyCentered) {
        if (compassBtn) {
            compassBtn.classList.remove('thematic-pink-glow');
            void compassBtn.offsetWidth;
            compassBtn.classList.add('thematic-pink-glow');
        }
    } else {
        if (compassIcon) {
            compassIcon.style.transition = 'none';
            compassIcon.style.transform  = '';
            compassIcon.classList.remove('compass-spin-active');
            void compassIcon.offsetWidth;
            compassIcon.classList.add('compass-spin-active');
            setTimeout(() => {
                compassIcon.classList.remove('compass-spin-active');
                compassIcon.style.transition = '';
            }, 700);
        }
    }

    // ── State A: Cached coords available — instant snap + background refresh ─
    if (cachedUserCoords) {
        _executeInstantRecenterSnap();
        return;
    }

    // ── State B: No cached coords yet — start live stream normally ───────────
    // The stream's success callback will fire setView once a position is acquired
    startLiveHardwareGPSTracking();
}

function syncCameraLockVisualUIState() {
    const compassBtn = document.getElementById('hardwareCompassRecenterButtonNode');
    if (!compassBtn) return;

    // Snapshot animation classes that are mid-flight so className reset doesn't
    // cancel or restart them — they expire on their own via setTimeout cleanup
    const liveAnimClasses = ['thematic-pink-glow', 'recenter-button-press']
        .filter(cls => compassBtn.classList.contains(cls));

    if (isCameraLocked) {
        compassBtn.className = "w-12 h-12 bg-slate-900 rounded-full flex items-center justify-center text-slate-300 active:bg-slate-800 transition-all duration-300 select-none overflow-hidden relative text-[19px]";
    } else {
        compassBtn.className = "w-12 h-12 bg-slate-900/95 border border-slate-800 rounded-full shadow-2xl flex items-center justify-center text-slate-300 active:bg-slate-800 transition-all duration-300 select-none overflow-hidden relative text-[19px]";
    }

    // Restore mid-flight animation classes
    liveAnimClasses.forEach(cls => compassBtn.classList.add(cls));
}

function snapMapViewportToSelectedCityBounds(event) {
    if(event) event.stopPropagation();
    if(typeof killLiveSpeechBubbleHUDState === 'function') killLiveSpeechBubbleHUDState();
    
    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

    const magnifyingButton = document.getElementById('shortcutMagnifyingButton');

    if (!leafletMapInstance || travelSpots.length === 0) return;
    
    if (checkedCitiesStateArray.length === 0) {
        if(magnifyingButton) {
            magnifyingButton.classList.remove('thematic-pink-glow');
            void magnifyingButton.offsetWidth; 
            magnifyingButton.classList.add('thematic-pink-glow');
        }
        if(typeof triggerCuteSpeechBubbleHUD === 'function') triggerCuteSpeechBubbleHUD("Select a city filter first!", magnifyingButton, event);
        return;
    }

    let activeCityPins = travelSpots.filter(spot => {
        const latVal = spot.latitude ? String(spot.latitude).trim() : "";
        return latVal !== "" && latVal !== "0" && checkedCitiesStateArray.includes(spot.city);
    });

    if (activeCityPins.length === 0) {
        if(magnifyingButton) {
            magnifyingButton.classList.remove('thematic-pink-glow');
            void magnifyingButton.offsetWidth;
            magnifyingButton.classList.add('thematic-pink-glow');
        }
        if(typeof triggerCuteSpeechBubbleHUD === 'function') triggerCuteSpeechBubbleHUD("No pins found for this city!", magnifyingButton, event);
        return;
    }

    let targetBounds = L.latLngBounds();
    activeCityPins.forEach(spot => {
        targetBounds.extend([parseFloat(spot.latitude), parseFloat(spot.longitude)]);
    });

    const currentMapBounds = leafletMapInstance.getBounds();
    const pinsAreAlreadyWhollyVisible = currentMapBounds.contains(targetBounds);

    if (pinsAreAlreadyWhollyVisible) {
        if (magnifyingButton) {
            magnifyingButton.classList.remove('thematic-pink-glow', 'lens-zoom-animation');
            void magnifyingButton.offsetWidth; 
            magnifyingButton.classList.add('thematic-pink-glow');
        }
    } else {
        if (magnifyingButton) {
            magnifyingButton.classList.remove('thematic-pink-glow', 'lens-zoom-animation');
            void magnifyingButton.offsetWidth; 
            magnifyingButton.classList.add('lens-zoom-animation');
        }

        isCameraLocked = false;
        syncCameraLockVisualUIState();

        if (activeCityPins.length === 1) {
            leafletMapInstance.setView([parseFloat(activeCityPins[0].latitude), parseFloat(activeCityPins[0].longitude)], 18, { animate: true });
        } else {
            leafletMapInstance.fitBounds(targetBounds, {
                padding: [50, 50], 
                animate: true,
                duration: 0.6
            });
        }
    }
}

function plotDynamicMarkersOnCanvasMap() {
    if(!mapMarkersLayerGroup || !leafletMapInstance) return;
    mapMarkersLayerGroup.clearLayers();

    if(typeof getFilteredDatasetRows !== 'function') return;
    const dataset = getFilteredDatasetRows();
    const currentZoom = leafletMapInstance.getZoom();
    
    let overlapPixelRadiusThreshold = 28;
    if (currentZoom >= 14 && currentZoom <= 15) {
        overlapPixelRadiusThreshold = 14; 
    } else if (currentZoom >= 16) {
        overlapPixelRadiusThreshold = 6; 
    }
    
    let structuredClustersArray = [];

    dataset.forEach(spot => {
        if(!spot.latitude || !spot.longitude || String(spot.latitude).trim() === "0" || String(spot.latitude).trim() === "") return;
        
        const latLngObj = L.latLng(parseFloat(spot.latitude), parseFloat(spot.longitude));
        const screenPoint = leafletMapInstance.latLngToLayerPoint(latLngObj);
        
        let assignedToCluster = false;
        
        for (let i = 0; i < structuredClustersArray.length; i++) {
            let cluster = structuredClustersArray[i];
            const isCoordinatesExactMatch = (cluster.leadLatLng.lat === latLngObj.lat && cluster.leadLatLng.lng === latLngObj.lng);
            
            let dx = screenPoint.x - cluster.centerPx.x;
            let dy = screenPoint.y - cluster.centerPx.y;
            let pixelDistance = Math.sqrt(dx * dx + dy * dy);
            
            if (isCoordinatesExactMatch || (pixelDistance <= overlapPixelRadiusThreshold)) {
                cluster.spots.push(spot);
                assignedToCluster = true;
                break;
            }
        }
        
        if (!assignedToCluster) {
            structuredClustersArray.push({
                centerPx: screenPoint,
                leadLatLng: latLngObj,
                spots: [spot]
            });
        }
    });

    structuredClustersArray.forEach(cluster => {
        const clusterSize = cluster.spots.length;

        if (clusterSize === 1) {
            renderSingleMarkerElement(cluster.spots[0], 0, 0);
        } else {
            if (currentZoom >= 15) {
                cluster.spots.forEach((spot, index) => {
                    const angle = (index / clusterSize) * Math.PI * 2;
                    const latOffset = Math.sin(angle) * 0.00018;
                    const lonOffset = Math.cos(angle) * 0.00022;
                    renderSingleMarkerElement(spot, latOffset, lonOffset);
                });
            } else {
                const clusterHTML = `<div class="cluster-map-cube">${clusterSize}</div>`;
                const clusterIcon = L.divIcon({ html: clusterHTML, className: '', iconSize: [40, 40], iconAnchor: [20, 20] });
                const clusterMarker = L.marker([cluster.leadLatLng.lat, cluster.leadLatLng.lng], { icon: clusterIcon });
                
                clusterMarker.on('click', (e) => {
                    L.DomEvent.stopPropagation(e);
                    const maxZoomPossible = leafletMapInstance.getMaxZoom();
                    const targetZoomLevel = Math.min(leafletMapInstance.getZoom() + 2, maxZoomPossible);
                    leafletMapInstance.setView([cluster.leadLatLng.lat, cluster.leadLatLng.lng], targetZoomLevel, { animate: true });
                });
                mapMarkersLayerGroup.addLayer(clusterMarker);
            }
        }
    });
}

function renderSingleMarkerElement(spot, latOffset, lonOffset) {
    const isStarred = ['high', '🔥', 'must do', 'starred'].includes((spot.priority || "").toLowerCase());
    const isDone = (spot.status || "").toLowerCase().trim() === 'done';

    let categoryIconClass = "fa-location-dot text-slate-400";
    const catStr = (spot.category || "").toLowerCase();
    if(catStr.includes("photo")) categoryIconClass = "fa-camera-retro text-pink-500";
    else if(catStr.includes("food")) categoryIconClass = "fa-utensils text-orange-500";
    else if(catStr.includes("viewpoint")) categoryIconClass = "fa-binoculars text-sky-500";
    else if(catStr.includes("nature")) categoryIconClass = "fa-leaf text-emerald-500";
    else if(catStr.includes("culture")) categoryIconClass = "fa-landmark text-violet-500";
    else if(catStr.includes("shopping") || catStr.includes("shop")) categoryIconClass = "fa-bag-shopping text-rose-500";
    else if(catStr.includes("activity")) categoryIconClass = "fa-person-running text-amber-500";
    else if(catStr.includes("relax")) categoryIconClass = "fa-spa text-teal-500";
    else if(catStr.includes("nightlife") || catStr.includes("bar") || catStr.includes("drink")) categoryIconClass = "fa-martini-glass text-indigo-500";

    let baseThemeClasses = "";
    if (currentMapStyleKey === 'dark') {
        baseThemeClasses = "bg-slate-900 border-slate-700 shadow-lg shadow-black/60";
    } else if (currentMapStyleKey === 'light') {
        baseThemeClasses = "bg-white border-slate-200 shadow-lg shadow-slate-300/60";
    } else if (currentMapStyleKey === 'terrain') {
        baseThemeClasses = "bg-slate-50 border-slate-300 shadow-md shadow-slate-400/50";
    } else if (currentMapStyleKey === 'satellite') {
        baseThemeClasses = "bg-slate-950/70 border-white/20 shadow-lg shadow-black/80 backdrop-blur-md";
    }

    let stateClasses = "";
    if (isStarred) {
        if (currentMapStyleKey === 'light' || currentMapStyleKey === 'terrain') {
            stateClasses = "!border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.5)] ring-2 ring-amber-400/30";
        } else {
            stateClasses = "!border-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.7)]";
        }
    }
    if (isDone) {
        stateClasses += " opacity-40 grayscale";
    }

    const iconHTML = `<div class="custom-map-cube ${baseThemeClasses} ${stateClasses}"><i class="fa-solid ${categoryIconClass}"></i></div>`;
    const customMarkerIcon = L.divIcon({ html: iconHTML, className: '', iconSize: [36, 36], iconAnchor: [18, 18] });
    
    const finalLat = parseFloat(spot.latitude) + latOffset;
    const finalLon = parseFloat(spot.longitude) + lonOffset;
    const leafMarker = L.marker([finalLat, finalLon], { icon: customMarkerIcon });

    leafMarker.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        revealMapItemDetailTrayHUD(spot, isStarred);
    });
    mapMarkersLayerGroup.addLayer(leafMarker);
}

function revealMapItemDetailTrayHUD(spotObj, isStarredBool) {
    const tray = document.getElementById('mapDetailTrayHUD');
    // Use the dedicated tray backdrop (z-488) so it sits below the bottom nav
    // (z-490) — nav tabs stay interactive — while blocking the map and top HUD.
    const blurBg = document.getElementById('trayBlurBackdrop');
    const plusBtn = document.getElementById('globalFloatingActionPlusButton');

    tray.classList.remove('flipped');

    const isDone = (spotObj.status || "").toLowerCase().trim() === 'done';
    const ticketLink = spotObj.ticket_url || "";

    if (plusBtn) plusBtn.classList.add('hidden');
    if (blurBg) blurBg.classList.remove('hidden');

    const titleWidget = document.getElementById('traySpotTitle');
    const notesWidget = document.getElementById('traySpotNotes');
    
    titleWidget.innerText = spotObj.spot_name || "Unnamed Destination";
    notesWidget.innerText = spotObj.notes || "No custom notes assigned.";
    document.getElementById('trayCityBadge').innerText = `${spotObj.city || 'Global'} • ${spotObj.category || 'General'}`;

    if (isDone) {
        titleWidget.className = "text-base font-black text-slate-500 line-through mt-2 truncate max-w-[220px]";
        notesWidget.className = "text-xs text-slate-500 leading-relaxed overflow-y-auto subtle-scrollbar max-h-[220px] line-through pr-1 select-none";
    } else {
        titleWidget.className = "text-base font-black text-slate-200 mt-2 truncate max-w-[220px]";
        notesWidget.className = "text-xs text-slate-400 leading-relaxed overflow-y-auto subtle-scrollbar max-h-[220px] pr-1 select-none";
    }
    
    const distHUD = document.getElementById('trayDistanceBadge');
    distHUD.innerHTML = spotObj.distStr;
    
    if(spotObj.distStr.includes("Missing Location")) {
        distHUD.className = "text-xs font-mono font-bold bg-amber-500/10 text-amber-400 px-2 py-1 rounded-lg border border-amber-500/20 shrink-0 h-fit";
    } else {
        distHUD.className = "text-xs font-mono font-bold px-2 py-1 rounded-lg shrink-0 h-fit bg-pink-500/10 text-pink-400";
    }

    document.getElementById('trayOpenReferenceBtn').href = spotObj.instagram_url || "#";
    
    const actionBtn = document.getElementById('trayActionBtn');
    actionBtn.setAttribute('data-row-id', spotObj.rowid);
    
    const directMapsUrl = spotObj.maps_url ? String(spotObj.maps_url).trim() : "";
    const rawLat = spotObj.latitude ? String(spotObj.latitude).trim() : "";
    const rawLng = spotObj.longitude ? String(spotObj.longitude).trim() : "";
    const hasValidMapDestination = (directMapsUrl !== "" && directMapsUrl !== "N/A") || (rawLat !== "" && rawLat !== "0" && rawLng !== "" && rawLng !== "0");

    if (!hasValidMapDestination) {
        actionBtn.innerHTML = "<i class='fa-solid fa-triangle-exclamation'></i>"; 
        actionBtn.className = "px-6 bg-slate-950 border border-slate-800 text-amber-400 flex items-center justify-center rounded-xl text-sm font-black h-12 whitespace-nowrap";
    } else {
        actionBtn.innerHTML = "<i class='fa-solid fa-map mr-1.5 text-sm'></i> Directions";
        actionBtn.className = "px-4 bg-slate-950 border border-slate-800 text-slate-300 flex items-center justify-center rounded-xl text-xs font-bold h-12 whitespace-nowrap";
    }

    const ticketRow = document.getElementById('trayTicketRow');
    const ticketBtn = document.getElementById('trayTicketBtn');
    if (ticketLink.trim() !== "") {
        ticketRow.classList.remove('hidden'); ticketBtn.href = ticketLink;
    } else {
        ticketRow.classList.add('hidden');
    }

    const starredBadge = document.getElementById('trayStarredBadge');
    if (isStarredBool) starredBadge.classList.remove('hidden'); else starredBadge.classList.add('hidden');

    const doneBtn = document.getElementById('trayDoneToggleBtn');
    const starBtn = document.getElementById('trayStarToggleBtn');

    doneBtn.innerHTML = isDone ? '<i class="fa-solid fa-arrow-rotate-left mr-1"></i> Undo' : '<i class="fa-solid fa-check mr-1"></i> Mark Done';
    doneBtn.onclick = function() {
        if(typeof updateCloudAction === 'function') updateCloudAction(spotObj.rowid, 'update_status', isDone ? 'Pending' : 'Done', spotObj.spot_name);
        dismissMapDetailTrayHUDCard();
    };

    starBtn.innerHTML = isStarredBool ? '<i class="fa-solid fa-star-half-stroke mr-1"></i> Unstar' : '<i class="fa-solid fa-star mr-1"></i> Star';
    starBtn.onclick = function() {
        if(typeof updateCloudAction === 'function') updateCloudAction(spotObj.rowid, 'toggle_priority', isStarredBool ? 'Normal' : 'Starred', spotObj.spot_name);
        dismissMapDetailTrayHUDCard();
    };

    const backDesc = document.getElementById('trayBackLongDescription');
    backDesc.innerText = (spotObj.long_description && spotObj.long_description !== "N/A") ? spotObj.long_description : "Disclaimer: Deep background details unpopulated.";

    const hoursGrid = document.getElementById('trayBackHoursGrid');
    hoursGrid.innerHTML = '';
    const staticHoursString = spotObj.opening_hours || "";
    if (staticHoursString.trim() !== "" && staticHoursString !== "N/A") {
        const daysTokens = staticHoursString.split(/[\n;]+/);
        daysTokens.forEach(token => {
            if(!token.trim()) return;
            const rowDiv = document.createElement('div');
            rowDiv.className = "flex justify-between items-center py-0.5 border-b border-slate-900/40 last:border-0";
            rowDiv.innerHTML = `<span>${token.trim()}</span>`;
            hoursGrid.appendChild(rowDiv);
        });
    } else {
        hoursGrid.innerHTML = `<div class="text-slate-500 italic text-[10px] p-1">Disclaimer: Schedule data unavailable.</div>`;
    }

    const warningCard = document.getElementById('trayBackBookingWarningCard');
    const warningText = document.getElementById('trayBackBookingValueText');
    const bookingString = (spotObj.booking_requirement || "").trim();
    if (bookingString !== "" && bookingString !== "N/A" && bookingString.toLowerCase() !== "none") {
        warningText.innerText = bookingString;
        warningCard.classList.remove('hidden');
    } else {
        warningCard.classList.add('hidden');
    }

    tray.classList.remove('hidden');
}

function dismissMapDetailTrayHUDCard() {
    const mapDetailTray = document.getElementById('mapDetailTrayHUD');
    if (mapDetailTray) {
        mapDetailTray.classList.add('hidden');
        mapDetailTray.classList.remove('flipped');
    }
    // Hide the dedicated tray backdrop
    const trayBg = document.getElementById('trayBlurBackdrop');
    if (trayBg) trayBg.classList.add('hidden');
    // Safety net: also clear the shared backdrop in case it was shown by an older call path
    const sharedBg = document.getElementById('dropdownBlurBackdrop');
    if (sharedBg) sharedBg.classList.add('hidden');
    const plusBtn = document.getElementById('globalFloatingActionPlusButton');
    if (plusBtn) plusBtn.classList.remove('hidden');
}

