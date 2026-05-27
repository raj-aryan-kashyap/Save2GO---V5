// Dictionary mapping common travel destination cities to macro bounding territories (Lat/Lon range bounds)
const KNOWN_COUNTRY_GEOMETRIC_BOUNDS = {
    "paris": { name: "France", minLat: 48.8, maxLat: 48.9, minLng: 2.2, maxLng: 2.4 },
    "patna": { name: "India", minLat: 25.5, maxLat: 25.7, minLng: 85.0, maxLng: 85.2 },
    "london": { name: "United Kingdom", minLat: 51.4, maxLat: 51.6, minLng: -0.2, maxLng: 0.1 },
    "tokyo": { name: "Japan", minLat: 35.6, maxLat: 35.8, minLng: 139.6, maxLng: 139.8 },
    "new york": { name: "United States", minLat: 40.6, maxLat: 40.8, minLng: -74.0, maxLng: -73.8 },
    "lisbon": { name: "Portugal", minLat: 38.7, maxLat: 38.8, minLng: -9.2, maxLng: -9.1 }
};

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

// Fix Architecture: Robust coordinate positioning logic tracking true localStorage states cleanly on reloads
function triggerOptimalLandingViewportRecalculation() {
    if (!leafletMapInstance) return;
    
    const savedLat = localStorage.getItem('compass_map_state_lat');
    const savedLng = localStorage.getItem('compass_map_state_lng');
    const savedZoom = localStorage.getItem('compass_map_state_zoom');

    // Protect coordinate boundaries: Avoid freezing over Null Island water if localStorage holds prior data metrics
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
            // Re-point fallback map tracks directly to Lisbon City Center instead of Atlantic Ocean water bounds
            leafletMapInstance.setView([38.7223, -9.1393], 12, { reset: true });
        }
    }
}

function initLeafletMapEngineCanvas() {
    if (leafletMapInstance) return;
    
    // Step 1: Boot parent container over safe platform city center instead of empty world ocean tracks
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

            if (mapTileCleanupTimerId) clearTimeout(mapTileCleanupTimerId);
            mapTileCleanupTimerId = setTimeout(() => {
                if (activeBaseTileLayer && typeof activeBaseTileLayer._pruneTiles === 'function') {
                    activeBaseTileLayer._pruneTiles();
                }
            }, 10000);
        }
    });

    // Step 2: Instantly run density calculations using cached local storage data before removing screen loading masks
    triggerOptimalLandingViewportRecalculation();
    
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

    const initialZoomLevel = leafletMapInstance.getZoom();
    const debugNode = document.getElementById('mapZoomDebugHUD');
    if (debugNode) debugNode.innerText = `Zoom: ${initialZoomLevel}`;
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
                
                const currentAccuracyRadiusMeters = pos.coords.accuracy || 0;
                if (userAccuracyRadiusCircle) {
                    userAccuracyRadiusCircle.setLatLng([userLat, userLon]).setRadius(currentAccuracyRadiusMeters);
                } else {
                    userAccuracyRadiusCircle = L.circle([userLat, userLon], {
                        radius: currentAccuracyRadiusMeters,
                        fillColor: '#3b82f6',
                        fillOpacity: 0.12,
                        stroke: false,
                        pointerEvents: 'none'
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
    if(typeof killLiveSpeechBubbleHUDState === 'function') killLiveSpeechBubbleHUDState();
    
    const deck = document.getElementById('mapLayerStyleDropdownDeck');
    if (deck) deck.classList.add('hidden');

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

    if (ENABLE_MAP_ROTATION) {
        currentMapBearingAngle = 0;
        const pane = document.querySelector('.leaflet-map-pane');
        if (pane) pane.style.transform = 'rotate(0deg)';
    }

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
