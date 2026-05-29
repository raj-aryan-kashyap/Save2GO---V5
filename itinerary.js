// ── Dev / testing flags ───────────────────────────────────────────────────────
// Set to true during development to lift production restrictions.
// Must be false before shipping.

/** When true, past dates are selectable in the itinerary calendar (useful for
 *  building test itineraries with elapsed days to trigger the recalculate flow). */
const DEV_ALLOW_PAST_DATE_SELECTION = false;

// ── Itinerary state globals ──────────────────────────────────────────────────
// All itinerary logic shares these; they are intentionally module-level so
// every function in this file (and callers from aap.js / map.js) can read them.

let savedItineraries         = JSON.parse(localStorage.getItem('compass_saved_itineraries')) || [];
let itineraryItems           = JSON.parse(localStorage.getItem('compass_itinerary_cache'))    || { '1': [], '2': [], '3': [] };
let activeItineraryId        = null;
let activeItineraryDayTracker = 0;
let itinSelectedCategorySequence = [];
let itinPacingMode           = 'max';
let selectedMultiDatesArray  = [];
let calMonth                 = new Date().getMonth();
let calYear                  = new Date().getFullYear();
let finalGeneratedSequenceRowIds = [null, null, null, null];
let isEditingMode            = false;
let editingItinId            = null;
let pendingConfirmCallback   = null;
let pendingCancelCallback    = null; // fired when thematic confirm is dismissed without confirming
// Snapshot of prefilled field values when the rebuild drawer opens.
// Used by validateItineraryForm to keep the Rebuild button disabled
// until the user changes at least one field from the original config.
let _itinEditSnapshot        = null;
let itinShowStarredOnly      = JSON.parse(localStorage.getItem('compass_itin_starred_only')) || false;

// Duration (minutes) and operating hours per category keyword.
// Used by getCategoryLogic() when scheduling time slots.
/**
 * Return "YYYY-MM-DD" for today ± offsetDays using local calendar time.
 * Always prefer this over toISOString() which can shift the date in timezones
 * that are behind UTC.
 * @param {number} [offsetDays=0]
 * @returns {string}
 */
function _getLocalYMD(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CATEGORY_DEFAULTS = {
    // morningOnly: true  → skip for today if recalc fires after noon
    // outdoor: true      → defer on days with rain/storm forecast
    'food':        { durationMax: 60,  durationRelaxed: 90,  open:  8, close: 22 },
    'restaurant':  { durationMax: 60,  durationRelaxed: 90,  open:  8, close: 22 },
    'cafe':        { durationMax: 45,  durationRelaxed: 75,  open:  7, close: 21, morningOnly: true },
    'coffee':      { durationMax: 45,  durationRelaxed: 60,  open:  7, close: 20, morningOnly: true },
    'attraction':  { durationMax: 90,  durationRelaxed: 120, open:  9, close: 18 },
    'museum':      { durationMax: 90,  durationRelaxed: 120, open:  9, close: 17, morningOnly: true },
    'gallery':     { durationMax: 60,  durationRelaxed: 90,  open: 10, close: 18 },
    'shopping':    { durationMax: 60,  durationRelaxed: 90,  open: 10, close: 21 },
    'market':      { durationMax: 60,  durationRelaxed: 90,  open:  8, close: 20, morningOnly: true, outdoor: true },
    'park':        { durationMax: 60,  durationRelaxed: 90,  open:  6, close: 20, outdoor: true },
    'garden':      { durationMax: 60,  durationRelaxed: 90,  open:  8, close: 18, morningOnly: true, outdoor: true },
    'beach':       { durationMax: 120, durationRelaxed: 180, open:  6, close: 20, outdoor: true },
    'nature':      { durationMax: 90,  durationRelaxed: 120, open:  6, close: 19, outdoor: true },
    'hotel':       { durationMax: 30,  durationRelaxed: 30,  open:  0, close: 24 },
    'bar':         { durationMax: 60,  durationRelaxed: 90,  open: 17, close: 24 },
    'nightlife':   { durationMax: 90,  durationRelaxed: 120, open: 20, close: 24 },
    'club':        { durationMax: 90,  durationRelaxed: 120, open: 21, close: 24 },
    'sport':       { durationMax: 90,  durationRelaxed: 120, open:  8, close: 20, outdoor: true },
    'spa':         { durationMax: 90,  durationRelaxed: 120, open:  9, close: 20 },
    'default':     { durationMax: 60,  durationRelaxed: 90,  open:  9, close: 18 }
};

// ── Itinerary weather cache ──────────────────────────────────────────────────
// Keyed by lowercase city name. Each entry: { days: [{date, iconClass, temp}], fetchedAt }
const itinWeatherCache    = new Map();
const ITIN_WEATHER_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetches a 5-day weather forecast for a city via the Apps Script proxy.
 * Returns { days: [{date, iconClass, temp}] } from cache or network,
 * or null if the city is invalid / the network request fails.
 */
async function fetchItineraryForecast(city) {
    if (!city || !city.trim()) return null;
    const cacheKey = city.trim().toLowerCase();
    const cached   = itinWeatherCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < ITIN_WEATHER_CACHE_TTL) return cached;

    try {
        const base = (typeof BACKEND_URL !== 'undefined') ? BACKEND_URL
                   : (typeof API_URL    !== 'undefined') ? API_URL : null;
        if (!base) return null;

        const res  = await fetch(`${base}?action=get_forecast&city=${encodeURIComponent(city.trim())}`);
        const data = await res.json();
        if (data.error || !Array.isArray(data.days) || data.days.length === 0) return null;

        const result = {
            days:      data.days.map(d => ({
                date:      d.date,
                iconClass: (typeof getWeatherFAIconClass === 'function')
                               ? getWeatherFAIconClass(d.icon)
                               : 'fa-cloud text-slate-400',
                temp:      d.temp,
            })),
            fetchedAt: Date.now(),
        };
        itinWeatherCache.set(cacheKey, result);
        return result;
    } catch (e) {
        return null;
    }
}

// ── 3-hour interval forecast cache ──────────────────────────────────────────
// Keyed by lowercase city name. Each entry: { slots: [{dt_txt, date, hour, iconClass, temp}], fetchedAt }
// OWM's 3-hour forecast updates every 3 h, so we match the TTL.
const itinForecast3hCache    = new Map();
const ITIN_FORECAST_3H_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

/**
 * Fetches a 5-day / 3-hour interval forecast for a city via the Apps Script proxy.
 * Returns { slots: [{dt_txt, date, hour, iconClass, temp}] } from cache or network,
 * or null if the city is invalid / the network request fails.
 * The backend action is "get_forecast_3h" — see Apps Script for the implementation.
 */
async function fetchItineraryForecast3h(city) {
    if (!city || !city.trim()) return null;
    const cacheKey = city.trim().toLowerCase();
    const cached   = itinForecast3hCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < ITIN_FORECAST_3H_CACHE_TTL) return cached;

    try {
        const base = (typeof BACKEND_URL !== 'undefined') ? BACKEND_URL
                   : (typeof API_URL    !== 'undefined') ? API_URL : null;
        if (!base) return null;

        const res  = await fetch(`${base}?action=get_forecast_3h&city=${encodeURIComponent(city.trim())}`);
        const data = await res.json();
        if (data.error || !Array.isArray(data.slots) || data.slots.length === 0) return null;

        const result = {
            slots: data.slots.map(s => {
                // dt_txt format from OWM: "2025-05-28 15:00:00"
                const parts    = (s.dt_txt || '').split(' ');
                const datePart = parts[0] || '';
                const timePart = parts[1] || '';
                const hour     = timePart ? parseInt(timePart.split(':')[0], 10) : 0;
                return {
                    dt_txt:    s.dt_txt,
                    date:      datePart,
                    hour,
                    iconClass: (typeof getWeatherFAIconClass === 'function')
                                   ? getWeatherFAIconClass(s.icon)
                                   : 'fa-cloud text-slate-400',
                    temp:      s.temp,
                };
            }),
            fetchedAt: Date.now(),
        };
        itinForecast3hCache.set(cacheKey, result);
        return result;
    } catch (e) {
        return null;
    }
}

// ── Missing utility functions ────────────────────────────────────────────────

/** Returns the currently active itinerary object or null. */
function getActiveItinerary() {
    if (!activeItineraryId) return null;
    return savedItineraries.find(i => i.id === activeItineraryId) || null;
}

/**
 * Validates the itinerary creation form on every keystroke in the title field
 * or change to any other required field.
 *
 * Rules for the title:
 *   • Empty      → hide both warnings, button disabled
 *   • < 3 chars  → yellow "Minimum 3 characters" warning, button disabled
 *   • ≥ 3 chars  → check for case-insensitive duplicate among savedItineraries
 *                  for the current user (scoped by itin.user === currentUser):
 *                  - duplicate found → red "already exists" warning, button disabled
 *                  - no duplicate    → clear both warnings, enable if all other
 *                                      fields are also complete
 */
function validateItineraryForm() {
    const btn           = document.getElementById('buildItinerarySubmitBtn');
    const minCharWarn   = document.getElementById('itinTitleMinCharWarning');
    const dupWarn       = document.getElementById('itinTitleDuplicateWarning');
    if (!btn || !minCharWarn || !dupWarn) return;

    const title = (document.getElementById('itin-new-name')?.value || '').trim();
    const city  = document.getElementById('itin-new-city')?.value  || '';
    const otherFieldsReady = city && selectedMultiDatesArray.length > 0 && itinSelectedCategorySequence.length > 0;

    // Helper: put the button into disabled state
    function _disable() {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'grayscale', 'cursor-not-allowed');
        btn.classList.remove('active:scale-95');
    }
    // Helper: put the button into enabled state
    function _enable() {
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'grayscale', 'cursor-not-allowed');
        btn.classList.add('active:scale-95');
    }

    // ── Empty ────────────────────────────────────────────────────────────────
    if (title.length === 0) {
        minCharWarn.classList.add('hidden');
        dupWarn.classList.add('hidden');
        _disable();
        return;
    }

    // ── Under 3 chars ────────────────────────────────────────────────────────
    if (title.length < 3) {
        minCharWarn.classList.remove('hidden');
        dupWarn.classList.add('hidden');
        _disable();
        return;
    }

    // ── 3+ chars — check for duplicate ──────────────────────────────────────
    minCharWarn.classList.add('hidden');

    const lowerTitle  = title.toLowerCase();
    const user        = typeof currentUser !== 'undefined' ? currentUser : null;
    const isDuplicate = (savedItineraries || []).some(itin => {
        const sameUser  = !user || !itin.user || itin.user === user;
        const sameTitle = (itin.title || '').trim().toLowerCase() === lowerTitle;
        // When editing, exclude the itinerary currently being edited
        const notSelf   = !isEditingMode || itin.id !== editingItinId;
        return sameUser && sameTitle && notSelf;
    });

    if (isDuplicate) {
        dupWarn.classList.remove('hidden');
        _disable();
        return;
    }

    // ── All title rules pass — gate on remaining fields ───────────────────
    dupWarn.classList.add('hidden');
    if (!otherFieldsReady) { _disable(); return; }

    // ── In edit/rebuild mode: require at least one changed field ──────────
    if (isEditingMode && _itinEditSnapshot) {
        const curTitle  = title;
        const curCity   = document.getElementById('itin-new-city')?.value  || '';
        const curStart  = document.getElementById('itin-new-start')?.value || '';
        const curEnd    = document.getElementById('itin-new-end')?.value   || '';

        const datesChanged = JSON.stringify([...selectedMultiDatesArray].sort()) !==
                             JSON.stringify([..._itinEditSnapshot.dates].sort());
        const catsChanged  = JSON.stringify(itinSelectedCategorySequence) !==
                             JSON.stringify(_itinEditSnapshot.categories);

        const isDirty = curTitle  !== _itinEditSnapshot.title  ||
                        curCity   !== _itinEditSnapshot.city   ||
                        itinPacingMode !== _itinEditSnapshot.pacing ||
                        curStart  !== _itinEditSnapshot.start  ||
                        curEnd    !== _itinEditSnapshot.end    ||
                        datesChanged || catsChanged;

        if (!isDirty) { _disable(); return; }
    }

    _enable();
}

/**
 * Resets the title validation UI to its initial (empty / disabled) state.
 * Call this every time the creation drawer is opened or closed.
 */
function resetItineraryTitleValidationUI() {
    const nameInput   = document.getElementById('itin-new-name');
    const minCharWarn = document.getElementById('itinTitleMinCharWarning');
    const dupWarn     = document.getElementById('itinTitleDuplicateWarning');
    const btn         = document.getElementById('buildItinerarySubmitBtn');
    if (nameInput)   nameInput.value = '';
    if (minCharWarn) minCharWarn.classList.add('hidden');
    if (dupWarn)     dupWarn.classList.add('hidden');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'grayscale', 'cursor-not-allowed');
        btn.classList.remove('active:scale-95');
    }
}

/**
 * Fetches all itineraries for the current user from the ItineraryVault cloud
 * sheet, merges with any locally-stored itineraries that haven't been synced
 * yet, and updates both the in-memory array and localStorage.
 *
 * Falls back to localStorage-only if the network request fails.
 */
async function loadUserItineraries() {
    const localData = JSON.parse(localStorage.getItem('compass_saved_itineraries')) || [];
    const user      = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;

    if (!user) {
        savedItineraries = localData;
        return;
    }

    try {
        const backendBase = (typeof BACKEND_URL !== 'undefined') ? BACKEND_URL : (typeof API_URL !== 'undefined' ? API_URL : null);
        if (!backendBase) { savedItineraries = localData; return; }

        const res      = await fetch(`${backendBase}?action=get_itineraries&user=${encodeURIComponent(user)}`);
        const cloudRows = await res.json();

        if (Array.isArray(cloudRows) && cloudRows.length > 0) {
            // Each cloud row: { user, itin_id, data: <itinerary object>, last_updated }
            const cloudItins = cloudRows.map(row => ({
                ...row.data,
                id:   row.itin_id || (row.data && row.data.id),
                user: row.user    || (row.data && row.data.user),
            }));

            // Keep any local itineraries that haven't been uploaded to cloud yet
            // (cloud is source of truth; local-only items are appended)
            const cloudIds  = new Set(cloudItins.map(i => i.id));
            const localOnly = localData.filter(i => !cloudIds.has(i.id));

            savedItineraries = [...cloudItins, ...localOnly];
        } else {
            // Cloud returned nothing — trust local data (may be first run or offline)
            savedItineraries = localData;
        }
    } catch (err) {
        console.warn('[ItinerarySync] cloud fetch failed, using localStorage:', err);
        savedItineraries = localData;
    }

    // Keep localStorage in sync with whatever we resolved
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
}

/**
 * Persists a single itinerary to the ItineraryVault cloud sheet and updates
 * localStorage.  `action` must be 'save' or 'delete'.
 *
 * Uses mode:'no-cors' (same pattern as all other backend POSTs in this app)
 * so the response body is opaque — errors are silent to the user but logged.
 */
async function syncItineraryToCloud(itin, action) {
    // Always update localStorage immediately so the UI stays consistent even
    // if the network call fails or the user is offline.
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));

    if (!itin || !itin.id) return;
    const user = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
    if (!user) return; // nothing to key the cloud row against without a user

    const backendBase = (typeof BACKEND_URL !== 'undefined') ? BACKEND_URL : (typeof API_URL !== 'undefined' ? API_URL : null);
    if (!backendBase) return;

    const payload = {
        action:  'sync_itinerary',
        user,
        itin_id: itin.id,
        method:  action === 'delete' ? 'delete' : 'save',
        data:    action !== 'delete' ? itin : undefined,
    };

    try {
        await fetch(backendBase, {
            method:  'POST',
            mode:    'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
    } catch (err) {
        console.warn('[ItinerarySync] cloud POST failed (offline?):', err);
    }
}

/**
 * Opens the creation drawer pre-filled with an existing itinerary's data
 * so the user can edit and re-generate it.
 */
function openEditItineraryModal(itinId) {
    const itin = savedItineraries.find(i => i.id === itinId);
    if (!itin) return;
    isEditingMode = true;
    editingItinId = itinId;

    // openItineraryCreationDrawerForm resets everything to "new" defaults first;
    // we then override every field with the existing itinerary's values below.
    openItineraryCreationDrawerForm();

    // ── Pre-fill fields ──────────────────────────────────────────────────────
    const nameEl  = document.getElementById('itin-new-name');
    const startEl = document.getElementById('itin-new-start');
    const endEl   = document.getElementById('itin-new-end');
    const cityEl  = document.getElementById('itin-new-city');

    if (nameEl) nameEl.value = itin.title;

    if (itin.config) {
        selectedMultiDatesArray      = [...(itin.config.dates      || [])];
        itinSelectedCategorySequence = [...(itin.config.categories || [])];
        if (itin.config.pacing) setItinPacingMode(itin.config.pacing);
        if (startEl) startEl.value = (itin.config.start != null) ? minutesToHHMM(itin.config.start) : '09:00';
        if (endEl)   endEl.value   = (itin.config.end   != null) ? minutesToHHMM(itin.config.end)   : '21:00';
    }

    // Pre-select city (the dropdown was just populated by openItineraryCreationDrawerForm)
    if (cityEl && itin.city) cityEl.value = itin.city;

    updateMultiDateUILabel();
    renderItineraryFormCategoriesAndQueryRows();
    _syncTimeDisplayButtons(); // update display buttons to match prefilled hidden inputs

    // ── Snapshot all prefilled values ────────────────────────────────────────
    // validateItineraryForm checks against this to keep Rebuild disabled until
    // the user actually changes something.
    _itinEditSnapshot = {
        title:      nameEl  ? nameEl.value  : itin.title,
        city:       cityEl  ? cityEl.value  : (itin.city || ''),
        pacing:     itinPacingMode,
        start:      startEl ? startEl.value : '',
        end:        endEl   ? endEl.value   : '',
        dates:      [...selectedMultiDatesArray],
        categories: [...itinSelectedCategorySequence],
    };

    // ── Switch drawer chrome to "Rebuild" mode ───────────────────────────────
    const titleEl  = document.getElementById('itinDrawerTitle');
    const iconEl   = document.getElementById('itinDrawerTitleIcon');
    const labelEl  = document.getElementById('itinDrawerSubmitLabel');
    const iconBtn  = document.getElementById('itinDrawerSubmitIcon');
    if (titleEl)  titleEl.textContent = `Rebuild your '${itin.title}'`;
    if (iconEl)   iconEl.className    = 'fa-solid fa-wand-magic-sparkles';
    if (labelEl)  labelEl.textContent = 'Rebuild';
    if (iconBtn)  iconBtn.className   = 'fa-solid fa-wand-magic-sparkles mr-1.5';

    // Start with Rebuild disabled — user must change at least one field
    validateItineraryForm();
}

/**
 * Stub for the inline spot-picker drawer (to be implemented).
 * Shows a friendly toast until the full UI is wired up.
 */
function openInlineUnscheduledSpotDrawer() {
    if (typeof showFormErrorSpeechBubble === 'function') {
        showFormErrorSpeechBubble(['Spot picker coming soon!']);
    }
}

// ── Custom Time Picker (Drum-Roll) ───────────────────────────────────────────
// Replaces the OS-native <input type="time"> for the Daily Time Window field.
// Hours: 12, 1–11 (12 h display).  Minutes: 00, 05 … 55 (5-min steps).
// Internally stores and returns 24 h "HH:MM" strings (same format as before).
//
// Looping: hours and minutes drums are tripled so the user can scroll infinitely
// in either direction without hitting a wall.  A boundary-jump silently
// repositions the drum to the equivalent middle-copy position when the user
// reaches the outer copies.  AM/PM has only 2 values so it does not loop.
//
// Pop animation: when the scroll settles (100 ms debounce), the newly-centred
// item plays a short springy scale animation (drumItemPop keyframe in CSS).
// ─────────────────────────────────────────────────────────────────────────────

let _activeTimePickerTarget = null; // 'start' | 'end'

const _DRUM_HOURS   = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const _DRUM_MINUTES = ['00','05','10','15','20','25','30','35','40','45','50','55'];
const _DRUM_PERIODS = ['AM','PM'];
const _DRUM_ITEM_H  = 44; // px — must match CSS .itin-drum-item height
const _DRUM_PAD     = 2;  // invisible spacer rows top + bottom

/** Convert a 24 h "HH:MM" string into a human-friendly "HH:MM AM/PM" label. */
function _fmtDisplayTime(hhmm) {
    if (!hhmm || !hhmm.includes(':')) return hhmm || '';
    const [h, m] = hhmm.split(':').map(Number);
    const period = h < 12 ? 'AM' : 'PM';
    const h12    = h % 12 || 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

/** Push both display buttons to match the current hidden-input values. */
function _syncTimeDisplayButtons() {
    const sVal = document.getElementById('itin-new-start')?.value || '09:00';
    const eVal = document.getElementById('itin-new-end')?.value   || '21:00';
    const sEl  = document.getElementById('itinStartTimeDisplay');
    const eEl  = document.getElementById('itinEndTimeDisplay');
    if (sEl) sEl.textContent = _fmtDisplayTime(sVal);
    if (eEl) eEl.textContent = _fmtDisplayTime(eVal);
}


/**
 * Build (or rebuild) a drum column.
 *
 * For drums with more than 2 values the content is tripled so the user can
 * scroll infinitely in either direction.  A passive scroll listener watches
 * for boundary crossings and silently jumps the scrollTop back to the
 * equivalent position in the middle copy — visually seamless because all
 * copies contain identical content.
 *
 * @param {string}  drumId   Element ID of the .itin-drum-scroll container
 * @param {Array}   values   The display/data values for this drum
 * @param {*}       selected The initially selected value
 */
function _buildDrum(drumId, values, selected) {
    const drum = document.getElementById(drumId);
    if (!drum) return;

    // Abort any scroll listener attached by a previous _buildDrum call on this element
    if (drum._scrollAbort) {
        drum._scrollAbort.abort();
        drum._scrollAbort = null;
    }

    drum.innerHTML = '';

    const N      = values.length;
    const loop   = N > 2;       // AM/PM (2 items) doesn't loop
    const copies = loop ? 3 : 1;

    // Store metadata so _readDrum and _highlightDrumCentre can normalise correctly
    drum.dataset.setSize = N;
    drum.dataset.loop    = loop ? '1' : '0';

    const strSel = String(selected);
    let selIdx   = values.findIndex(v => String(v) === strSel);
    if (selIdx < 0) selIdx = 0;

    // ── DOM: top pads ────────────────────────────────────────────────────────
    for (let p = 0; p < _DRUM_PAD; p++) {
        const pad = document.createElement('div');
        pad.className = 'itin-drum-pad';
        drum.appendChild(pad);
    }

    // ── DOM: items (1 or 3 copies) ───────────────────────────────────────────
    for (let c = 0; c < copies; c++) {
        values.forEach((v, i) => {
            const item  = document.createElement('div');
            const strV  = String(v);
            item.className   = 'itin-drum-item';
            item.textContent = isNaN(v) ? strV : strV.padStart(2, '0');
            item.dataset.value = strV;

            // Tap → smooth scroll to the matching item in the MIDDLE copy
            item.addEventListener('click', () => {
                const midOffset = loop ? N : 0;
                drum.scrollTo({ top: (midOffset + i) * _DRUM_ITEM_H, behavior: 'smooth' });
            });

            drum.appendChild(item);
        });
    }

    // ── DOM: bottom pads ─────────────────────────────────────────────────────
    for (let p = 0; p < _DRUM_PAD; p++) {
        const pad = document.createElement('div');
        pad.className = 'itin-drum-pad';
        drum.appendChild(pad);
    }

    // ── Initial scroll position ───────────────────────────────────────────────
    // For looping drums, start in the middle copy so the user can scroll either way.
    // scrollTop formula: (copy_index * N + item_index) * ITEM_HEIGHT
    // Middle copy = copy index 1 → midOffset = N
    const midOffset    = loop ? N : 0;
    drum.scrollTop     = (midOffset + selIdx) * _DRUM_ITEM_H;

    // Highlight the selected item immediately (no pop animation on open)
    _highlightDrumCentre(drum, false);

    // ── Scroll listener ───────────────────────────────────────────────────────
    let _debounceTimer;
    const abortCtrl = new AbortController();
    drum._scrollAbort = abortCtrl;

    drum.addEventListener('scroll', () => {
        // Boundary jump — keep the drum in the middle-copy range
        if (loop) {
            const setH = N * _DRUM_ITEM_H;
            if (drum.scrollTop < setH) {
                drum.scrollTop += setH;  // jumped: next scroll event re-runs highlight
                return;
            }
            if (drum.scrollTop >= 2 * setH) {
                drum.scrollTop -= setH;
                return;
            }
        }

        // Live colour update during drag (no pop animation yet)
        _highlightDrumCentre(drum, false);

        // Pop animation fires only after the scroll settles
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => _highlightDrumCentre(drum, true), 100);
    }, { passive: true, signal: abortCtrl.signal });
}

/**
 * Update the --active class on the item currently snapped to centre.
 * If playPop is true and the active item has changed, play the springy
 * drumItemPop animation on the incoming item.
 *
 * The scroll position encodes the absolute item index directly
 * (scrollTop / ITEM_HEIGHT = absolute index across all copies).
 * For looping drums the index is always in [N, 2N) after boundary jumps.
 *
 * @param {HTMLElement} drum
 * @param {boolean}     playPop  Play the springy animation when active changes
 */
function _highlightDrumCentre(drum, playPop = false) {
    const absIdx = Math.round(drum.scrollTop / _DRUM_ITEM_H);
    const items  = drum.querySelectorAll('.itin-drum-item');

    items.forEach((el, i) => {
        const isActive  = (i === absIdx);
        const wasActive = el.classList.contains('itin-drum-item--active');

        if (isActive && !wasActive) {
            el.classList.add('itin-drum-item--active');
            if (playPop) {
                // Restart animation if it's already running (rapid scroll)
                el.classList.remove('drum-pop');
                void el.offsetWidth; // force reflow to restart keyframe
                el.classList.add('drum-pop');
                el.addEventListener('animationend', () => el.classList.remove('drum-pop'), { once: true });
            }
        } else if (!isActive && wasActive) {
            el.classList.remove('itin-drum-item--active', 'drum-pop');
        }
    });
}

/**
 * Read the value of the item currently centred in a drum column.
 * Uses the absolute scroll index (works for both looping and non-looping drums).
 */
function _readDrum(drumId) {
    const drum = document.getElementById(drumId);
    if (!drum) return null;
    const absIdx = Math.round(drum.scrollTop / _DRUM_ITEM_H);
    const items  = drum.querySelectorAll('.itin-drum-item');
    return items[absIdx]?.dataset.value ?? null;
}

/**
 * Open the themed drum-roll time picker.
 * The drums pre-select the value currently stored in the hidden input.
 * Defaults are 09:00 for start and 21:00 for end, set by openItineraryCreationDrawerForm.
 *
 * @param {'start'|'end'} target  Which hidden input to update on confirm.
 */
function openCustomTimePicker(target) {
    _activeTimePickerTarget = target;

    const inputId = target === 'start' ? 'itin-new-start' : 'itin-new-end';
    const rawVal  = document.getElementById(inputId)?.value
                    || (target === 'start' ? '09:00' : '21:00');

    // Parse 24 h value → 12 h display components
    const [hRaw, mRaw] = rawVal.split(':').map(Number);
    const period  = hRaw < 12 ? 'AM' : 'PM';
    const hour12  = hRaw % 12 || 12;
    const minSel  = _DRUM_MINUTES[Math.min(Math.round(mRaw / 5), _DRUM_MINUTES.length - 1)];

    // Update modal title
    const titleEl = document.getElementById('customTimePickerTitle');
    if (titleEl) titleEl.textContent = target === 'start' ? 'Day Start Time' : 'Day End Time';

    // ── Show the modal BEFORE building drums ─────────────────────────────────
    // scrollTop assignments on display:none elements are discarded by browsers.
    // The element must be visible and have real layout before we set scrollTop.
    document.getElementById('customTimePickerModal').classList.remove('hidden');

    // Build drums now that the container has layout
    _buildDrum('timeDrumHour',   _DRUM_HOURS,   hour12);
    _buildDrum('timeDrumMinute', _DRUM_MINUTES, minSel);
    _buildDrum('timeDrumPeriod', _DRUM_PERIODS, period);

    // Re-highlight after one frame to ensure the browser has committed layout
    // (scroll-snap can shift scrollTop slightly on first paint)
    requestAnimationFrame(() => {
        ['timeDrumHour', 'timeDrumMinute', 'timeDrumPeriod'].forEach(id => {
            const d = document.getElementById(id);
            if (d) _highlightDrumCentre(d, false);
        });
    });
}

/** Read the three drums, convert to 24 h, persist to hidden input, update display. */
function confirmCustomTimePicker() {
    const h      = _readDrum('timeDrumHour');
    const m      = _readDrum('timeDrumMinute');
    const period = _readDrum('timeDrumPeriod');

    if (!h || !m || !period) { closeCustomTimePicker(); return; }

    let hour24 = parseInt(h, 10);
    if (period === 'AM' && hour24 === 12) hour24 = 0;
    if (period === 'PM' && hour24 !== 12) hour24 += 12;

    const timeStr = `${String(hour24).padStart(2, '0')}:${m}`;

    const inputId = _activeTimePickerTarget === 'start' ? 'itin-new-start' : 'itin-new-end';
    const input   = document.getElementById(inputId);
    if (input) input.value = timeStr;

    const dispId = _activeTimePickerTarget === 'start' ? 'itinStartTimeDisplay' : 'itinEndTimeDisplay';
    const dispEl = document.getElementById(dispId);
    if (dispEl) dispEl.textContent = _fmtDisplayTime(timeStr);

    closeCustomTimePicker();
    validateItineraryForm();
}

function closeCustomTimePicker() {
    document.getElementById('customTimePickerModal')?.classList.add('hidden');
    _activeTimePickerTarget = null;
}

// ── End of globals / stubs block ─────────────────────────────────────────────

function isItineraryCacheWhollyEmpty() {
    return (!itineraryItems["1"] || itineraryItems["1"].length === 0) &&
           (!itineraryItems["2"] || itineraryItems["2"].length === 0) &&
           (!itineraryItems["3"] || itineraryItems["3"].length === 0);
}

function forceClearItinerarySavedCache() {
    if (!confirm("Force clear saved itinerary data? All timeline maps will be reset.")) return;
    itineraryItems = { "1": [], "2": [], "3": [] };
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    if(typeof toggleSettingsMenu === 'function') toggleSettingsMenu(false);
    renderItineraryMasterDashboardWorkspace();
    alert("Itinerary registry wiped.");
}

function toggleItineraryChildDropdownMenu(event) {
    if (event) event.stopPropagation();
    const bucket = document.getElementById('itineraryChildSelectorMenuBucket');
    const caret = document.getElementById('itinChildCaretNode');
    if (!bucket || !caret) return;
    if (bucket.classList.contains('hidden')) {
        bucket.classList.remove('hidden'); caret.innerText = "▼";
    } else {
        bucket.classList.add('hidden'); caret.innerText = "▶";
    }
}

function buildItinerarySubMenuChecklist() {
    const bucket = document.getElementById('itineraryChildSelectorMenuBucket');
    if (!bucket) return;
    bucket.innerHTML = `
        <button onclick="injectActiveSpotToItineraryDay(1, null, event)" class="w-full text-left text-[10px] py-1 px-2 hover:bg-slate-800 text-slate-300 font-semibold rounded block">→ Schedule Day 1</button>
        <button onclick="injectActiveSpotToItineraryDay(2, null, event)" class="w-full text-left text-[10px] py-1 px-2 hover:bg-slate-800 text-slate-300 font-semibold rounded block">→ Schedule Day 2</button>
        <button onclick="injectActiveSpotToItineraryDay(3, null, event)" class="w-full text-left text-[10px] py-1 px-2 hover:bg-slate-800 text-slate-300 font-semibold rounded block">→ Schedule Day 3</button>
    `;
}

function assembleTrayInlineAssignorRow() {
    const container = document.getElementById('trayItineraryBtnDeck');
    const actionBtn = document.getElementById('trayActionBtn');
    if (!container || !actionBtn) return;
    const currentRowId = actionBtn.getAttribute('data-row-id');
    if (!currentRowId) { container.innerHTML = ''; return; }
    container.innerHTML = `
        <button onclick="injectActiveSpotToItineraryDay(1, ${currentRowId}, event)" class="px-2 py-1 bg-slate-900 border border-slate-800 rounded font-black text-[9px] text-pink-400 active:bg-slate-850">D1</button>
        <button onclick="injectActiveSpotToItineraryDay(2, ${currentRowId}, event)" class="px-2 py-1 bg-slate-900 border border-slate-800 rounded font-black text-[9px] text-pink-400 active:bg-slate-850">D2</button>
        <button onclick="injectActiveSpotToItineraryDay(3, ${currentRowId}, event)" class="px-2 py-1 bg-slate-900 border border-slate-800 rounded font-black text-[9px] text-pink-400 active:bg-slate-850">D3</button>
    `;
}

function injectActiveSpotToItineraryDay(dayIndex, fallbackRowId, event) {
    if (event) event.stopPropagation();
    let resolvedRowId = fallbackRowId;
    if (!resolvedRowId) {
        const actionBtn = document.getElementById('trayActionBtn');
        if (actionBtn) resolvedRowId = actionBtn.getAttribute('data-row-id');
    }
    if (!resolvedRowId) { alert("Select a location asset card payload first."); return; }
    
    const numericId = parseInt(resolvedRowId);
    if (!itineraryItems[dayIndex]) itineraryItems[dayIndex] = [];
    if (itineraryItems[dayIndex].includes(numericId)) {
        alert(`Asset row #${numericId} is already mapped to Day ${dayIndex}.`); return;
    }
    
    itineraryItems[dayIndex].push(numericId);
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    renderItineraryMasterDashboardWorkspace();
    
    const notificationTarget = event ? event.target : document.body;
    if(typeof triggerCuteSpeechBubbleHUD === 'function') triggerCuteSpeechBubbleHUD(`Added to Day ${dayIndex}!`, notificationTarget, event);
}

function selectActiveItineraryDayIndex(dayIndex) {
    activeItineraryDayTracker = dayIndex;
    const container = document.getElementById('itineraryMasterDaySelectorDeck');
    if (container) {
        const buttons = container.querySelectorAll('button');
        buttons.forEach((btn, idx) => {
            if ((idx + 1) === dayIndex) {
                btn.className = "px-3 py-1.5 rounded-lg text-xs font-black transition-all bg-pink-600 text-white shadow";
            } else {
                btn.className = "px-3 py-1.5 rounded-lg text-xs font-black transition-all bg-slate-900 text-slate-400 border border-slate-800";
            }
        });
    }
    renderItineraryMasterDashboardWorkspace();
}

function clearItineraryDay() {
    if (!confirm(`Flush all matrix sequence records mapped to Day ${activeItineraryDayTracker}?`)) return;
    itineraryItems[activeItineraryDayTracker] = [];
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    renderItineraryMasterDashboardWorkspace();
}

function removeSpotFromItineraryDay(rowId) {
    if (!itineraryItems[activeItineraryDayTracker]) return;
    itineraryItems[activeItineraryDayTracker] = itineraryItems[activeItineraryDayTracker].filter(id => id !== parseInt(rowId));
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    renderItineraryMasterDashboardWorkspace();
}

function toggleItineraryWizardModalTray(show) {
    document.getElementById('itineraryWizardModalTray').classList.toggle('hidden', !show);
}

function openItineraryAutoSequenceWizard() {
    toggleItineraryWizardModalTray(true);
    const container = document.getElementById('wizardBlueprintSlotsContainer');
    if (!container) return;
    container.innerHTML = '';
    finalGeneratedSequenceRowIds = [null, null, null, null];

    itinWizardSequenceBlueprint.forEach((categoryLabel, slotIndex) => {
        const rowWrapper = document.createElement('div');
        rowWrapper.className = "space-y-1 bg-slate-950 p-2 rounded-xl border border-slate-850 flex flex-col";
        rowWrapper.innerHTML = `<span class="text-[9px] font-black tracking-wide text-slate-400">Slot ${slotIndex + 1}: ${categoryLabel}</span>`;
        
        const selector = document.createElement('select');
        selector.className = "w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-[11px] font-semibold text-slate-200 focus:outline-none focus:border-pink-500 h-9";
        selector.onchange = function() { finalGeneratedSequenceRowIds[slotIndex] = this.value ? parseInt(this.value) : null; };
        
        const defaultOpt = document.createElement('option');
        defaultOpt.value = ""; defaultOpt.innerText = "-- Select Match Candidate --";
        selector.appendChild(defaultOpt);

        const lowerBlueprint = categoryLabel.toLowerCase();
        travelSpots.forEach(spot => {
            const spotCat = (spot.category || "").toLowerCase();
            if (spotCat.includes(lowerBlueprint) || (lowerBlueprint.includes("activity") && spotCat.includes("shop"))) {
                const opt = document.createElement('option');
                opt.value = spot.rowid; opt.innerText = `[${spot.city || 'Global'}] ${spot.spot_name || 'Unnamed'}`;
                selector.appendChild(opt);
            }
        });
        
        rowWrapper.appendChild(selector);
        container.appendChild(rowWrapper);
    });
}

function saveGeneratedWizardSequenceToActiveDay() {
    if (!itineraryItems[activeItineraryDayTracker]) itineraryItems[activeItineraryDayTracker] = [];
    let injectionCounter = 0;

    finalGeneratedSequenceRowIds.forEach(rowId => {
        if (rowId && !itineraryItems[activeItineraryDayTracker].includes(rowId)) {
            itineraryItems[activeItineraryDayTracker].push(rowId);
            injectionCounter++;
        }
    });

    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    toggleItineraryWizardModalTray(false);
    renderItineraryMasterDashboardWorkspace();
    alert(`Surgically compiled matrix track. Injecting ${injectionCounter} sequence units into Day ${activeItineraryDayTracker}.`);
}

function toggleItineraryCreationDrawerForm(show) {
    const modal = document.getElementById('itineraryCreationDrawerModal');
    if (modal) modal.classList.toggle('hidden', !show);
    // When the drawer is cancelled (X button) while in edit mode, the user arrived
    // here from the burger menu — reopen the menu so they don't lose navigation context.
    // Note: generateIntelligentItinerary sets isEditingMode = false *before* calling
    // this function, so the reopen only fires on genuine cancellations, not successful rebuilds.
    if (!show && isEditingMode) {
        openItinDetailMenuDrawer();
    }
}

function openItineraryCreationDrawerForm() {
    toggleItineraryCreationDrawerForm(true);
    resetItineraryTitleValidationUI();
    _itinEditSnapshot = null;  // cleared here; openEditItineraryModal sets it after prefilling

    // Reset drawer chrome to "new" mode — openEditItineraryModal overrides these
    const _titleEl  = document.getElementById('itinDrawerTitle');
    const _iconEl   = document.getElementById('itinDrawerTitleIcon');
    const _labelEl  = document.getElementById('itinDrawerSubmitLabel');
    const _iconBtn  = document.getElementById('itinDrawerSubmitIcon');
    if (_titleEl)  _titleEl.textContent = 'Build Your Itinerary';
    if (_iconEl)   _iconEl.className    = 'fa-solid fa-route';
    if (_labelEl)  _labelEl.textContent = 'Build Itinerary';
    if (_iconBtn)  _iconBtn.className   = 'fa-solid fa-wand-magic-sparkles mr-1.5';

    itinSelectedCategorySequence = [];
    
    let defaultFoodCategory = 'Food Spot'; 
    if (travelSpots && travelSpots.length > 0) {
        let uniqueCategories = new Set();
        travelSpots.forEach(spot => { if (spot.category) spot.category.split(',').forEach(c => uniqueCategories.add(c.trim())); });
        for (let cat of uniqueCategories) {
            if (cat.toLowerCase().includes('food')) {
                defaultFoodCategory = cat;
                break;
            }
        }
    }
    itinSelectedCategorySequence = [defaultFoodCategory];
    
    const selectCity = document.getElementById('itin-new-city');
    if (selectCity) {
        selectCity.innerHTML = '';
        let citySet = new Set();
        travelSpots.forEach(spot => { if (spot.city) citySet.add(spot.city.trim()); });
        citySet.forEach(city => {
            const opt = document.createElement('option');
            opt.value = city; opt.innerText = city;
            selectCity.appendChild(opt);
        });
    }
    
    updateMultiDateUILabel();
    renderItineraryFormCategoriesAndQueryRows();

    // Reset time fields to fixed defaults: 09:00 AM start, 09:00 PM end.
    const _startEl = document.getElementById('itin-new-start');
    const _endEl   = document.getElementById('itin-new-end');
    if (_startEl) _startEl.value = '09:00';
    if (_endEl)   _endEl.value   = '21:00';
    _syncTimeDisplayButtons();
}

function setItinPacingMode(mode) {
    itinPacingMode = mode;
    const maxBtn = document.getElementById('itinPacingToggleMax');
    const relBtn = document.getElementById('itinPacingToggleRelaxed');
    if(mode === 'max') {
        maxBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-amber-400 bg-amber-500/10 flex items-center justify-center gap-1.5 transition-colors";
        relBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-slate-500 flex items-center justify-center gap-1.5 transition-colors bg-transparent";
    } else {
        maxBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-slate-500 flex items-center justify-center gap-1.5 transition-colors bg-transparent";
        relBtn.className = "flex-1 text-center text-[10px] font-black tracking-wide rounded-lg text-amber-400 bg-amber-500/10 flex items-center justify-center gap-1.5 transition-colors";
    }
}

function openMultiDatePickerModal() {
    // For a new itinerary always open on the current calendar month.
    // For Rebuild, jump to the month of the earliest already-selected date
    // so the user immediately sees their existing selection.
    if (isEditingMode && selectedMultiDatesArray.length > 0) {
        const firstDate = [...selectedMultiDatesArray].sort()[0];
        const parts = firstDate.split('-').map(Number);
        calYear  = parts[0];
        calMonth = parts[1] - 1;
    } else {
        const now = new Date();
        calMonth = now.getMonth();
        calYear  = now.getFullYear();
    }
    document.getElementById('itinCalendarModal').classList.remove('hidden');
    renderMultiDateCalendarGrid();
}

function changeMultiCalendarMonth(offset) {
    calMonth += offset;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    else if (calMonth > 11) { calMonth = 0; calYear++; }
    renderMultiDateCalendarGrid();
}

function renderMultiDateCalendarGrid() {
    const grid  = document.getElementById('calendarDaysGrid');
    const title = document.getElementById('calendarMonthTitle');
    if (!grid) return;
    grid.innerHTML = '';
    title.innerText = `${["January","February","March","April","May","June","July","August","September","October","November","December"][calMonth]} ${calYear}`;

    // Build today's YYYY-MM-DD string using local time (no UTC offset issues)
    const _now = new Date();
    const todayStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;

    // Leading empty cells to align the first day of the month
    for (let i = 0; i < new Date(calYear, calMonth, 1).getDay(); i++) {
        grid.innerHTML += `<div></div>`;
    }

    for (let i = 1; i <= new Date(calYear, calMonth + 1, 0).getDate(); i++) {
        const dateStr    = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
        const isSelected = selectedMultiDatesArray.includes(dateStr);
        const isToday    = dateStr === todayStr;
        const isPast     = !DEV_ALLOW_PAST_DATE_SELECTION && dateStr < todayStr;

        let btnClass;
        let onclickAttr;
        if (isPast) {
            // Elapsed date: visually disabled, not interactive
            btnClass    = "w-8 h-8 rounded-full text-slate-700 font-medium text-xs flex items-center justify-center mx-auto border border-slate-800/40 cursor-not-allowed select-none opacity-35 line-through decoration-slate-700";
            onclickAttr = '';
        } else if (isSelected) {
            // Selected: solid pink fill
            btnClass    = "w-8 h-8 rounded-full bg-pink-600 text-white font-bold text-xs flex items-center justify-center mx-auto shadow-lg shadow-pink-600/30 transform scale-110 transition-transform cursor-pointer";
            onclickAttr = `onclick="toggleMultiDateSelection('${dateStr}')"`;
        } else if (isToday) {
            // Today (not selected): dotted ring indicator
            btnClass    = "w-8 h-8 rounded-full text-pink-300 font-bold text-xs flex items-center justify-center mx-auto border-2 border-dashed border-pink-500/60 cursor-pointer transition-colors hover:bg-slate-800";
            onclickAttr = `onclick="toggleMultiDateSelection('${dateStr}')"`;
        } else {
            // Future day
            btnClass    = "w-8 h-8 rounded-full bg-slate-900 text-slate-300 font-medium text-xs flex items-center justify-center mx-auto border border-slate-800 hover:bg-slate-800 hover:text-white cursor-pointer transition-colors";
            onclickAttr = `onclick="toggleMultiDateSelection('${dateStr}')"`;
        }

        grid.innerHTML += `<div ${onclickAttr} class="${btnClass}">${i}</div>`;
    }

    // Enable / disable action buttons based on whether any dates are selected
    const hasSelection = selectedMultiDatesArray.length > 0;
    const resetBtn   = document.getElementById('calResetBtn');
    const confirmBtn = document.getElementById('calConfirmBtn');
    if (resetBtn) {
        resetBtn.disabled = !hasSelection;
        resetBtn.classList.toggle('opacity-40',          !hasSelection);
        resetBtn.classList.toggle('pointer-events-none', !hasSelection);
    }
    if (confirmBtn) {
        confirmBtn.disabled = !hasSelection;
        confirmBtn.classList.toggle('opacity-40',          !hasSelection);
        confirmBtn.classList.toggle('pointer-events-none', !hasSelection);
    }
}

function toggleMultiDateSelection(dateStr) {
    if (selectedMultiDatesArray.includes(dateStr)) {
        selectedMultiDatesArray = selectedMultiDatesArray.filter(d => d !== dateStr);
    } else {
        selectedMultiDatesArray.push(dateStr);
    }
    renderMultiDateCalendarGrid();
    // Re-evaluate the Build / Rebuild button whenever the date selection changes
    validateItineraryForm();
}

/** Clear all selected dates, re-render the grid and re-validate the form. */
function resetMultiDateSelection() {
    selectedMultiDatesArray = [];
    renderMultiDateCalendarGrid();
    validateItineraryForm();
}

function checkSequentialDates(dates) {
    if(dates.length <= 1) return true;
    let sorted = [...dates].sort(); 
    for(let i=1; i<sorted.length; i++) {
        let d1 = new Date(sorted[i-1]);
        d1.setDate(d1.getDate() + 1);
        let nextDayStr = d1.toISOString().split('T')[0];
        if (nextDayStr !== sorted[i]) return false;
    }
    return true;
}

function closeMultiDatePickerModal() {
    document.getElementById('itinCalendarModal').classList.add('hidden');
    updateMultiDateUILabel();
    // Re-evaluate Build / Rebuild button now that the selection is confirmed
    validateItineraryForm();
}

function updateMultiDateUILabel() {
    const display = document.getElementById('itin-date-display');
    const meta = document.getElementById('itin-date-meta');
    
    if (selectedMultiDatesArray.length === 0) {
        display.innerText = "Select Dates";
        meta.classList.add('hidden');
    } else if (selectedMultiDatesArray.length === 1) {
        display.innerText = selectedMultiDatesArray[0];
        meta.classList.add('hidden');
    } else {
        display.innerText = `${selectedMultiDatesArray.length} Days Selected`;
        let isSeq = checkSequentialDates(selectedMultiDatesArray);
        if (!isSeq) {
            meta.innerText = "Non-sequential days";
            meta.classList.remove('hidden');
        } else {
            meta.classList.add('hidden');
        }
    }
}

function renderItineraryFormCategoriesAndQueryRows() {
    const gridContainer = document.getElementById('itinModalCategoryGridContainer');
    const rowBox = document.getElementById('itinModalSequenceQueryRowBox');
    if (!gridContainer || !rowBox) return;

    gridContainer.innerHTML = '';
    rowBox.innerHTML = '';

    let countsMap = {};
    itinSelectedCategorySequence.forEach(cat => { countsMap[cat] = (countsMap[cat] || 0) + 1; });

    let uniqueCategories = new Set();
    travelSpots.forEach(spot => { if (spot.category) spot.category.split(',').forEach(c => uniqueCategories.add(c.trim())); });

    uniqueCategories.forEach(catName => {
        if (!catName) return;
        const count = countsMap[catName] || 0;
        const isSelected = count > 0;

        const btn = document.createElement('button');
        btn.type = "button";
        if (isSelected) {
            btn.className = "px-2 py-1.5 rounded-lg text-[10px] font-black flex items-center justify-between min-h-[30px] bg-pink-500/10 border border-dashed border-pink-500 text-pink-400 shadow-sm transition-all";
        } else {
            btn.className = "px-2 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-between min-h-[30px] bg-slate-950/60 border border-dashed border-slate-700 text-slate-400 hover:bg-slate-900 transition-all";
        }

        btn.onclick = function() {
            itinSelectedCategorySequence.push(catName);
            renderItineraryFormCategoriesAndQueryRows();
        };

        btn.innerHTML = `
            <span class="truncate pr-1.5">${catName}</span>
            ${isSelected ? `<span class="text-[8px] bg-pink-600 text-white font-mono px-1 py-0.5 rounded shrink-0">x${count}</span>` : `<i class="fa-solid fa-plus text-[8px] opacity-40 shrink-0"></i>`}
        `;
        gridContainer.appendChild(btn);
    });

    if (itinSelectedCategorySequence.length === 0) {
        rowBox.innerHTML = ''; 
    } else {
        itinSelectedCategorySequence.forEach((cat, idx) => {
            const pill = document.createElement('div');
            pill.className = "flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg py-1.5 px-2 shrink-0 text-[10px] font-bold text-slate-300 shadow";
            pill.innerHTML = `
                <span>${cat}</span>
                <button onclick="removeCategoryFromSequenceByIndex(${idx})" class="w-4 h-4 bg-red-950/40 border border-red-500/30 rounded-full flex items-center justify-center text-red-400 text-[8px] hover:bg-red-900/60 transition-colors"><i class="fa-solid fa-xmark"></i></button>
            `;
            rowBox.appendChild(pill);

            if (idx < itinSelectedCategorySequence.length - 1) {
                const separator = document.createElement('span');
                separator.className = "text-pink-500 font-black text-[14px] shrink-0 mx-0.5 drop-shadow-[0_0_5px_rgba(236,72,153,0.5)]";
                separator.innerText = "→";
                rowBox.appendChild(separator);
            }
        });
    }
    validateItineraryForm();
}

function removeCategoryFromSequenceByIndex(index) {
    itinSelectedCategorySequence.splice(index, 1);
    renderItineraryFormCategoriesAndQueryRows();
}

function compileItineraryFromSequencePatternForm() {
    const chosenCity = document.getElementById('itin-new-city').value;
    if (!chosenCity) { alert("Please assign a valid target city boundary first."); return; }
    if (itinSelectedCategorySequence.length === 0) { alert("Please select at least one pattern category element to construct the timeline matrix."); return; }

    let calculatedTrackIds = [];
    let utilizedRowIds = new Set();

    itinSelectedCategorySequence.forEach(searchCategory => {
        const matchedRecord = travelSpots.find(spot => {
            if (utilizedRowIds.has(spot.rowid)) return false;
            if ((spot.city || "").trim() !== chosenCity.trim()) return false;
            
            const spotCats = (spot.category || "").split(',').map(c => c.trim().toLowerCase());
            return spotCats.includes(searchCategory.toLowerCase());
        });

        if (matchedRecord) {
            calculatedTrackIds.push(parseInt(matchedRecord.rowid));
            utilizedRowIds.add(matchedRecord.rowid);
        }
    });

    if (calculatedTrackIds.length === 0) {
        alert(`No database assets found inside ${chosenCity} matching your precise sequence blueprint.`);
        return;
    }

    itineraryItems[activeItineraryDayTracker] = calculatedTrackIds;
    localStorage.setItem('compass_itinerary_cache', JSON.stringify(itineraryItems));
    toggleItineraryCreationDrawerForm(false);
    renderItineraryMasterDashboardWorkspace();
    alert(`Surgically compiled matrix track sequence pattern mapping. Injected ${calculatedTrackIds.length} path targets.`);
}

function openThematicConfirm(title, desc, confirmText, callback, theme = 'pink', cancelCb = null) {
    document.getElementById('thematicConfirmTitle').innerText = title;
    document.getElementById('thematicConfirmDesc').innerText = desc;
    const btn = document.getElementById('thematicConfirmActionBtn');
    const icon = document.getElementById('thematicConfirmIcon');
    btn.innerText = confirmText;

    if (theme === 'pink') {
        btn.className = "w-full max-w-[200px] py-3.5 bg-gradient-to-r from-pink-600 to-purple-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-pink-600/20 active:scale-95 transition-transform";
        icon.className = "w-16 h-16 rounded-full bg-pink-500/10 flex items-center justify-center text-pink-500 text-2xl mx-auto mb-2 border border-pink-500/20";
        icon.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
    } else {
        btn.className = "flex-1 py-3.5 bg-gradient-to-r from-red-600 to-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-red-600/20 active:scale-95 transition-transform";
        icon.className = "w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 text-2xl mx-auto mb-2 border border-red-500/20";
        icon.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
    }

    pendingConfirmCallback = callback;
    pendingCancelCallback  = cancelCb; // stored separately; cleared on confirm so it only fires on dismiss
    const modal = document.getElementById('thematicConfirmModal');
    const box = document.getElementById('thematicConfirmBox');
    modal.classList.remove('hidden');
    setTimeout(() => {
        modal.classList.remove('opacity-0', 'pointer-events-none');
        box.classList.remove('scale-95'); box.classList.add('scale-100');
    }, 10);
}

function closeThematicConfirm() {
    const modal = document.getElementById('thematicConfirmModal');
    const box = document.getElementById('thematicConfirmBox');
    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.remove('scale-100'); box.classList.add('scale-95');
    setTimeout(() => modal.classList.add('hidden'), 300);
    pendingConfirmCallback = null;
    // Fire cancel callback (e.g. reopen burger menu) when dismissed without confirming.
    // The confirm button path clears this before calling closeThematicConfirm, so it
    // only fires on backdrop-tap / X-close / programmatic cancel.
    if (pendingCancelCallback) { pendingCancelCallback(); pendingCancelCallback = null; }
}

document.getElementById('thematicConfirmActionBtn').addEventListener('click', () => {
    if (pendingConfirmCallback) pendingConfirmCallback();
    pendingCancelCallback = null; // confirmed — don't fire cancel
    closeThematicConfirm();
});

function promptDeleteItinerary() {
    openThematicConfirm(
        "Delete Itinerary",
        "Are you sure you want to delete this specific itinerary?",
        "Delete",
        () => {
            savedItineraries = savedItineraries.filter(i => i.id !== activeItineraryId);
            localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
            syncItineraryToCloud({id: activeItineraryId}, 'delete');
            activeItineraryId = null;
            closeItineraryDetailView();
        },
        'red',
        () => openItinDetailMenuDrawer() // cancelled → return to burger menu
    );
}

/**
 * Toggles the starred state of an itinerary, then persists it locally and
 * fires a cloud sync so the ItineraryVault sheet's `starred` column is updated.
 * Works from both the master card and the expanded detail view.
 */
function toggleItineraryStar(itinId) {
    const itin = savedItineraries.find(i => i.id === itinId);
    if (!itin) return;
    itin.starred = !itin.starred;
    syncItineraryToCloud(itin, 'save');   // updates localStorage + fires cloud POST

    // renderItineraryMasterDashboardWorkspace() unconditionally hides the detail
    // view as its first action, so we must not call it while the detail view is
    // open — doing so would collapse the expanded tray.  Only call it when the
    // user is actually looking at the master list.
    const detailView = document.getElementById('itineraryDetailView');
    const inDetailView = detailView && !detailView.classList.contains('hidden');
    if (inDetailView) {
        // Just update the star icon in the header — leave everything else alone
        _syncDetailViewStarBtn(itin);
    } else {
        _renderItineraryMasterAnimated(itinId, itin.starred);
    }
}

/**
 * Animated re-render of the itinerary master list after a star toggle.
 * Mirrors the renderListAnimated FLIP engine used by the Saved Spots list:
 *   • Starring   → amber burst in-place, then FLIP slide to top
 *   • Unstarring → FLIP slide to new position (no burst, motion is enough)
 */
function _renderItineraryMasterAnimated(itinId, isStarringAction) {
    const masterList = document.getElementById('itineraryMasterListScroll');
    if (!masterList) { renderItineraryMasterDashboardWorkspace(); return; }

    // Query only the data cards — ignore footer / empty-state / filter-msg nodes
    const getCards = () => [...masterList.querySelectorAll('[id^="itin-master-card-"]')];

    // Inner FLIP helper — snapshots positions, rebuilds, then animates each card
    // from its old screen position to its new one.
    // skipFlash=true when the burst already played in-place so it doesn't fire again.
    function _doFlip(skipFlash) {
        const snapBefore = new Map();
        getCards().forEach(el => snapBefore.set(el.id, el.getBoundingClientRect().top));

        renderItineraryMasterDashboardWorkspace(); // synchronous rebuild (starred now on top)

        requestAnimationFrame(() => {
            const entries = getCards().map(el => ({
                el,
                newTop: el.getBoundingClientRect().top,
            }));

            // Batch writes — displace each card back to its pre-render screen position
            entries.forEach(({ el, newTop }) => {
                const oldTop = snapBefore.get(el.id);
                if (oldTop !== undefined) {
                    const deltaY = oldTop - newTop;
                    if (Math.abs(deltaY) > 1) {
                        el.style.transition = 'none';
                        el.style.transform  = `translateY(${deltaY}px)`;
                        el.dataset.animMove = '1';
                    }
                } else {
                    // Newly visible card (shouldn't normally happen here, safety net)
                    el.style.opacity    = '0';
                    el.dataset.animFade = '1';
                }
            });

            void entries[0]?.el.offsetHeight; // force layout so transforms are registered

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
            });
        });
    }

    // ── Starring: flash at current position THEN slide to top ────────────────
    if (isStarringAction) {
        const cardEl = document.getElementById(`itin-master-card-${itinId}`);
        if (cardEl) {
            cardEl.classList.add('card-flash-star');
            cardEl.addEventListener('animationend', () => {
                cardEl.classList.remove('card-flash-star');
                _doFlip(true); // flash already played — skip second burst
            }, { once: true });
            return;
        }
        // Card not in DOM — fall through to immediate reorder
    }

    // ── Unstarring (or card not found): FLIP reorder directly ────────────────
    _doFlip(false);
}

/** Syncs the star button icon/colour in the expanded detail view header. */
function _syncDetailViewStarBtn(itin) {
    const btn = document.getElementById('detailItinStarBtn');
    if (!btn || !itin) return;
    const icon = btn.querySelector('i');
    if (!icon) return;
    if (itin.starred) {
        icon.className = 'fa-solid fa-star text-[11px] text-amber-400';
        btn.classList.replace('text-slate-300', 'text-amber-400');
    } else {
        icon.className = 'fa-regular fa-star text-[11px]';
        btn.classList.replace('text-amber-400', 'text-slate-300');
    }
}

// ── Itinerary master list filter ─────────────────────────────────────────────
// Sets the itinerary-specific star filter and re-renders the master list.
// UI toggle sync (the top HUD "All / Starred" pill) is handled by
// syncPriorityFilterViewModeUI() in aap.js, which is tab-aware.
function setItinFilterState(starredOnly) {
    itinShowStarredOnly = !!starredOnly;
    localStorage.setItem('compass_itin_starred_only', JSON.stringify(itinShowStarredOnly));
    renderItineraryMasterDashboardWorkspace();
}

function renderItineraryMasterDashboardWorkspace() {
    const masterList  = document.getElementById('itineraryMasterListScroll');
    const container   = document.getElementById('itineraryMasterListView');
    const headerBar   = document.getElementById('itineraryMasterListHeader');
    const emptyState  = document.getElementById('itineraryEmptyStateLanding');
    const detailView  = document.getElementById('itineraryDetailView');

    if (container)  container.classList.remove('hidden');
    if (detailView) detailView.classList.add('hidden');

    if (!masterList) return;

    if (!savedItineraries || savedItineraries.length === 0) {
        // Show the static landing page, hide the data header
        if (headerBar)  headerBar.classList.add('hidden');
        if (emptyState) emptyState.classList.remove('hidden');
        // Remove any previously rendered itinerary cards
        Array.from(masterList.children).forEach(el => {
            if (el.id !== 'itineraryEmptyStateLanding') el.remove();
        });
        return;
    }

    // At least one itinerary — show header, hide empty state
    if (headerBar)  headerBar.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    // Keep the top HUD toggle in sync regardless of how render was triggered
    if (typeof syncPriorityFilterViewModeUI === 'function') syncPriorityFilterViewModeUI();

    // Clear previous cards (keep only the static landing page node)
    Array.from(masterList.children).forEach(el => {
        if (el.id !== 'itineraryEmptyStateLanding') el.remove();
    });

    // Sort order: starred → normal → fully-completed (bottom)
    // Mirrors the Saved Spots list: priority items at top, done items at bottom.
    const _itinSortKey = i => {
        const _allSpots = i.days.flatMap(d => d.timeline || []);
        const _isDone   = _allSpots.length > 0 && _allSpots.every(s => s.isDone);
        if (_isDone)      return 2; // completed — bottom
        if (i.starred)    return 0; // starred   — top
        return 1;                   // normal    — middle
    };
    const _sortedItineraries = [...savedItineraries].sort((a, b) => _itinSortKey(a) - _itinSortKey(b));

    let visibleCount = 0;
    _sortedItineraries.forEach(itin => {
        // ── Master list filters ───────────────────────────────────────────────
        if (itinShowStarredOnly && !itin.starred) return;
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(itin.city)) {
            return;
        }
        visibleCount++;

        let doneCount  = 0;
        let totalCount = 0;
        itin.days.forEach(d => d.timeline.forEach(s => { totalCount++; if (s.isDone) doneCount++; }));
        const allDone    = totalCount > 0 && doneCount === totalCount;

        // Remaining days = real (non-suggested) days whose date is today or in the future
        const _todayYMD      = _getLocalYMD(0);
        const _remainingDays = itin.days.filter(d => d && !d.isSuggested && d.date && d.date >= _todayYMD).length;
        const _dayPillLabel  = `${_remainingDays} Day${_remainingDays !== 1 ? 's' : ''} Remaining`;
        const coverageColor = allDone ? 'text-emerald-400' : 'text-slate-300';
        const coverageIcon  = allDone
            ? '<i class="fa-solid fa-circle-check text-emerald-400 mr-1"></i>'
            : '<i class="fa-solid fa-map-pin text-pink-400 mr-1"></i>';
        const isStarred = !!itin.starred;

        const card = document.createElement('div');
        card.id = `itin-master-card-${itin.id}`;
        // Completed itineraries get a greyed-out look; starred get the gold glow;
        // normal cards get the default slate border.
        const _cardBorderCls = allDone ? 'border-slate-800 opacity-50 grayscale' : (isStarred ? 'starred-gold-glow' : 'border-slate-800');
        card.className = `itin-master-card bg-slate-900 border rounded-2xl p-4 flex flex-col gap-2 cursor-pointer active:scale-[0.98] transition-transform shadow-lg ${_cardBorderCls}`;
        card.onclick = () => openItineraryDetailView(itin.id);
        // Text nodes inside a completed card get strikethrough + muted colour
        const _titleCls = allDone ? 'line-through text-slate-500' : 'text-slate-200';
        const _cityCls  = allDone ? 'line-through text-slate-600' : 'text-slate-500';
        card.innerHTML = `
            <div class="flex justify-between items-start">
                <h3 class="text-sm font-black ${_titleCls} flex-1 min-w-0 pr-2 flex items-center gap-1.5">
                    <i class="fa-solid ${itin.config?.pacing === 'relaxed' ? 'fa-mug-hot text-sky-400' : 'fa-rocket text-amber-400'} text-[10px] shrink-0"></i>
                    <span class="truncate">${itin.title}</span>
                </h3>
                <div class="flex items-center gap-2 shrink-0">
                    <button onclick="event.stopPropagation(); toggleItineraryStar('${itin.id}')"
                            class="w-6 h-6 flex items-center justify-center transition-colors active:scale-90">
                        <i class="fa-${isStarred ? 'solid' : 'regular'} fa-star text-sm ${isStarred ? 'text-amber-400' : 'text-slate-600'}"></i>
                    </button>
                    <span class="text-[9px] font-bold px-2 py-1 bg-slate-800 border border-slate-700 rounded-md text-slate-400 shadow-inner">${_dayPillLabel}</span>
                </div>
            </div>
            <div class="flex items-center gap-1.5 text-[10px] ${_cityCls} font-bold uppercase tracking-wider">
                <i class="fa-solid fa-location-dot text-pink-500"></i> ${itin.city}
            </div>
            <div class="mt-1 overflow-hidden rounded-lg bg-slate-950/60 border border-slate-800/60" style="height:22px">
                <div id="itinWeatherStrip-${itin.id}" class="h-full flex items-center px-2">
                    <span class="text-[9px] text-slate-700 font-bold tracking-wide flex items-center gap-1.5">
                        <i class="fa-solid fa-cloud-sun text-slate-700 text-[8px]"></i> Loading forecast…
                    </span>
                </div>
            </div>
            <div class="mt-2 flex items-center justify-between border-t border-slate-800 pt-3">
                <span class="text-[10px] font-black ${coverageColor}">${coverageIcon}${doneCount}/${totalCount} Spots Covered</span>
                <i class="fa-solid fa-chevron-right text-slate-600"></i>
            </div>
        `;
        masterList.appendChild(card);
    });

    // If the active filter hides everything, show a contextual nudge
    if (visibleCount === 0) {
        let msg = document.getElementById('itinFilteredEmptyMsg');
        if (!msg) {
            msg = document.createElement('div');
            msg.id = 'itinFilteredEmptyMsg';
        }
        msg.className = "flex flex-col items-center justify-center py-16 text-center px-6";
        msg.innerHTML = `
            <i class="fa-regular fa-star text-3xl text-slate-700 mb-4"></i>
            <p class="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">No starred itineraries</p>
            <p class="text-[11px] text-slate-600 font-medium">Star an itinerary to save it here.</p>
            <button onclick="setItinFilterState(false)" class="mt-5 px-5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-[10px] font-black text-slate-400 active:bg-slate-800 transition-colors">
                Show All
            </button>`;
        masterList.appendChild(msg);
        return;
    }

    const footer = document.createElement('div');
    footer.className = "text-center py-8 text-[10px] font-black text-slate-600 tracking-widest opacity-60 border-t border-slate-800/50 mt-4";
    footer.textContent = "End of Filtered Itinerary List";
    masterList.appendChild(footer);

    // Populate weather strips async — respect same filters as the card loop
    savedItineraries.forEach(itin => {
        if (itinShowStarredOnly && !itin.starred) return;
        if (checkedCitiesStateArray.length > 0 && !checkedCitiesStateArray.includes(itin.city)) return;
        if (itin.city) _populateItineraryWeatherStrip(itin.id, itin.city, itin.days);
    });
}

// ── Weather: master card consolidated summary strip ──────────────────────────
/**
 * Fetches forecast for `city`, then renders a single-line consolidated summary:
 *   Oct 14 (Tue) → Oct 16 (Thu)  ☀ → 🌧  12°C – 22°C
 * Icons come from the days with the highest and lowest temperatures.
 * Falls back to a greyed-out cloud + "No forecast" on any failure.
 */
async function _populateItineraryWeatherStrip(itinId, city, days) {
    const el = document.getElementById(`itinWeatherStrip-${itinId}`);
    if (!el) return;

    // ── Error/fallback renderer ───────────────────────────────────────────────
    const _noData = () => {
        el.innerHTML = `
            <span class="inline-flex items-center gap-1.5 text-[9px] text-slate-700 font-bold">
                <i class="fa-solid fa-cloud text-slate-700 text-[8px]"></i>
                <span>No forecast</span>
            </span>`;
    };

    const forecast = await fetchItineraryForecast(city);
    if (!forecast || !forecast.days || forecast.days.length === 0) { _noData(); return; }

    // Normalise trip dates to YYYY-MM-DD strings
    const _toYMD = (d) => {
        if (d instanceof Date) {
            const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
            return `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
        return String(d).slice(0, 10);
    };

    // Safe local-time Date constructor (avoids UTC midnight off-by-one)
    const _parseDate = (d) => {
        if (d instanceof Date) return d;
        const p = String(d).slice(0, 10).split('-').map(Number);
        return new Date(p[0], p[1] - 1, p[2]);
    };

    const tripDates  = (days || []).map(d => _toYMD(d.date));
    const matched    = forecast.days.filter(fd => tripDates.includes(fd.date));
    // Fall back to using the first N available forecast days when dates don't overlap
    const pool       = matched.length > 0 ? matched : forecast.days.slice(0, Math.max((days || []).length, 1));

    const valid = pool.filter(d => d.temp !== undefined && d.temp !== null);
    if (valid.length === 0) { _noData(); return; }

    // Days with extreme temperatures
    const maxDay = valid.reduce((a, b) => a.temp >= b.temp ? a : b);
    const minDay = valid.reduce((a, b) => a.temp <= b.temp ? a : b);

    // Format itinerary start → end date labels
    const _fmtDate = (d) => {
        if (!d || isNaN(d.getTime())) return '';
        const month   = d.toLocaleDateString('en-US', { month: 'short' });
        const dayNum  = d.getDate();
        const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
        return `${month} ${dayNum} (${weekday})`;
    };

    const itinDays    = days || [];
    const startLabel  = itinDays.length > 0 ? _fmtDate(_parseDate(itinDays[0].date)) : '';
    const endLabel    = itinDays.length > 1  ? _fmtDate(_parseDate(itinDays[itinDays.length - 1].date)) : '';
    const dateRange   = startLabel && endLabel
        ? `<span class="text-slate-600">${startLabel}</span>
           <span class="text-slate-700 mx-1">→</span>
           <span class="text-slate-600">${endLabel}</span>
           <span class="text-slate-800 mx-1.5">·</span>`
        : startLabel
            ? `<span class="text-slate-600">${startLabel}</span><span class="text-slate-800 mx-1.5">·</span>`
            : '';

    // Temperatures always use text-slate-300 (readable on dark bg regardless of
    // weather condition).  Tying temp colour to the icon class caused overcast
    // entries to render as uniform grey — visually identical to the no-data state.
    el.innerHTML = `
        <span class="inline-flex items-center text-[9px] font-bold whitespace-nowrap">
            ${dateRange}
            <i class="fa-solid ${maxDay.iconClass} text-[9px] mr-0.5"></i>
            <span class="text-slate-300 opacity-90 mr-1">${Math.round(maxDay.temp)}°</span>
            <span class="text-slate-700 mr-1">→</span>
            <i class="fa-solid ${minDay.iconClass} text-[9px] mr-0.5"></i>
            <span class="text-slate-300 opacity-90">${Math.round(minDay.temp)}°</span>
        </span>`;
}

// ── Weather: expanded view day badge ─────────────────────────────────────────
/**
 * Updates the #detailDayWeatherBadge for the currently displayed day.
 *
 * Strategy: try to match the forecast by exact date first (most accurate). If
 * the itinerary dates fall outside OWM's 5-day window (very common for future
 * trips), fall back to using dayIndex to pick from available forecast days so
 * the expanded view is always consistent with the master card.
 *
 * @param {string}         city     – itinerary city name
 * @param {string|Date}    dateStr  – date of the active day
 * @param {number}         dayIndex – 0-based index of the active day (fallback)
 */
async function _fetchAndRenderDetailDayWeather(city, dateStr, dayIndex) {
    const badge = document.getElementById('detailDayWeatherBadge');
    if (!badge) return;

    badge.innerHTML = `<i class="fa-solid fa-ellipsis text-slate-700 text-[9px] animate-pulse"></i>`;

    if (!city) { badge.innerHTML = ''; return; }

    const forecast = await fetchItineraryForecast(city);
    if (!forecast || !forecast.days || forecast.days.length === 0) {
        badge.innerHTML = `<i class="fa-solid fa-cloud text-slate-700 text-[9px]"></i>`;
        return;
    }

    // Normalise target date to YYYY-MM-DD
    const targetDate = (dateStr instanceof Date)
        ? (() => {
            const d = dateStr;
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          })()
        : String(dateStr).slice(0, 10);

    // 1st: exact date match
    let match = forecast.days.find(fd => fd.date === targetDate);

    // 2nd: day-index fallback (same pool the master card uses)
    if (!match && typeof dayIndex === 'number') {
        match = forecast.days[Math.min(dayIndex, forecast.days.length - 1)];
    }

    if (!match) {
        badge.innerHTML = `<i class="fa-solid fa-cloud text-slate-700 text-[9px]"></i>`;
        return;
    }

    const temp = match.temp !== undefined ? `${Math.round(match.temp)}°C` : '';
    badge.innerHTML = `
        <i class="fa-solid ${match.iconClass} text-[11px]"></i>
        ${temp ? `<span class="text-slate-300 opacity-90 font-bold text-[9px]">${temp}</span>` : ''}`;
}

// ── Weather: per-activity badge in the expanded timeline ─────────────────────
/**
 * Fills the compact weather badge (`#wba-*`) that sits next to each activity's
 * time slot.  Re-uses the same city forecast cache so no extra network call is
 * made when the day's weather was already fetched for the header badge.
 *
 * Strategy mirrors _fetchAndRenderDetailDayWeather: exact-date match first,
 * then dayIndex fallback so badges always show something meaningful.
 *
 * Matching the Saved Spots badge style:
 *   container  bg-sky-500/10 text-sky-300  (set at render time, kept here)
 *   icon       uses its own colour from iconClass  (e.g. text-yellow-400)
 *   temp       inherits text-sky-300 from container — same as Saved Spots
 *
 * @param {string}      badgeId  – element id of the badge span
 * @param {string}      city     – itinerary city name
 * @param {string|Date} dateStr  – date of the active day
 * @param {number}      dayIndex – 0-based day index (fallback selector)
 */
/**
 * @param {string}      badgeId   – element id of the per-activity weather span
 * @param {string}      city      – itinerary city (city-level forecast fallback)
 * @param {string|Date} dateStr   – calendar date of the active day
 * @param {number}      dayIndex  – 0-based day index (fallback selector)
 * @param {object}      [spotObj] – activity spot; when the date is today and the
 *                                   spot has valid coordinates, real-time per-location
 *                                   weather is fetched so each spot on the same day
 *                                   can show different conditions.
 */
async function _populateItinActivityWeatherBadge(badgeId, city, dateStr, dayIndex, spotObj) {
    const el = document.getElementById(badgeId);
    if (!el) return;

    if (!city) { el.innerHTML = ''; return; }

    // Normalise target date → YYYY-MM-DD
    const targetDate = (dateStr instanceof Date)
        ? (() => {
            const d = dateStr;
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          })()
        : String(dateStr).slice(0, 10);

    // Today's date string — used to decide whether real-time fetch makes sense
    const todayStr = (() => {
        const t = new Date();
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    })();

    // ── Path A: today's activity with valid coordinates ───────────────────────
    // Uses fetchWeatherForCoords (current weather, per-location) so activities
    // at different parts of the city can show genuinely different conditions.
    // The result is cached by coordinate key, so N spots → max N unique fetches.
    if (targetDate === todayStr && spotObj && typeof fetchWeatherForCoords === 'function') {
        const lat = spotObj._lat  || (spotObj.latitude  ? parseFloat(spotObj.latitude)  : null);
        const lng = spotObj._lng  || (spotObj.longitude ? parseFloat(spotObj.longitude) : null);
        if (lat && lng && lat !== 0 && lng !== 0) {
            const w = await fetchWeatherForCoords(lat, lng);
            if (w) {
                el.innerHTML = `<i class="fa-solid ${w.iconClass} text-[8px]"></i>${w.temp ? `<span>${w.temp}°</span>` : ''}`;
                return;
            }
        }
    }

    // ── Path B: 3-hour slot forecast ─────────────────────────────────────────
    // Calls the get_forecast_3h backend action, which returns up to 40 slots
    // (5 days × 8 slots/day) at 3-hour intervals.  We pick the slot whose hour
    // is closest to the activity's scheduled start hour so each spot gets a
    // genuinely time-matched forecast rather than the day's single average.
    const forecast3h = await fetchItineraryForecast3h(city);
    if (forecast3h && Array.isArray(forecast3h.slots) && forecast3h.slots.length > 0) {
        const daySlots = forecast3h.slots.filter(s => s.date === targetDate);
        if (daySlots.length > 0) {
            // Convert sch_start (minutes since midnight) → hour of day; noon fallback
            const actHour = (spotObj && typeof spotObj.sch_start === 'number')
                ? Math.floor(spotObj.sch_start / 60)
                : 12;
            let best     = daySlots[0];
            let bestDiff = Math.abs(best.hour - actHour);
            for (let i = 1; i < daySlots.length; i++) {
                const diff = Math.abs(daySlots[i].hour - actHour);
                if (diff < bestDiff) { best = daySlots[i]; bestDiff = diff; }
            }
            const temp3h = best.temp !== undefined ? `${Math.round(best.temp)}°` : '';
            el.innerHTML = `<i class="fa-solid ${best.iconClass} text-[8px]"></i>${temp3h ? `<span>${temp3h}</span>` : ''}`;
            return;
        }
        // If we have 3h data but no slots for this specific date (beyond the 5-day
        // window), fall through to the daily-forecast path below.
    }

    // ── Path C: no 3h data or date out of range → city-level daily forecast ──
    // All activities on the same day share one daily snapshot.  This path acts
    // as a reliable fallback when the 3h endpoint is unavailable or the date is
    // too far out for the 5-day/3h window.
    const forecast = await fetchItineraryForecast(city);
    if (!forecast || !forecast.days || forecast.days.length === 0) {
        el.innerHTML = `<i class="fa-solid fa-cloud text-[8px] opacity-30"></i>`;
        return;
    }

    let match = forecast.days.find(fd => fd.date === targetDate);
    if (!match && typeof dayIndex === 'number') {
        match = forecast.days[Math.min(dayIndex, forecast.days.length - 1)];
    }

    if (!match) {
        el.innerHTML = `<i class="fa-solid fa-cloud text-[8px] opacity-30"></i>`;
        return;
    }

    const temp = match.temp !== undefined ? `${Math.round(match.temp)}°` : '';
    el.innerHTML = `<i class="fa-solid ${match.iconClass} text-[8px]"></i>${temp ? `<span>${temp}</span>` : ''}`;
}

/**
 * Asynchronously shows or hides the rain-risk badge for a single activity card.
 *
 * Works independently of the recalculate engine — the badge appears as soon as
 * the forecast is available (even on freshly-created itineraries) by fetching
 * weather data into the warm cache, then re-evaluating whether the day is rainy
 * AND the spot's category is marked as outdoor.
 *
 * @param {string} badgeId   — the DOM id of the rain-risk <span> element
 * @param {string} city      — itinerary city (used for forecast lookup)
 * @param {string} dateYMD   — YYYY-MM-DD date of the day being displayed
 * @param {string} category  — spot category string (matched via getCategoryLogic)
 * @param {boolean} isDone   — done spots never show the badge
 */
async function _updateRainRiskBadge(badgeId, city, dateYMD, category, isDone) {
    if (isDone) return;
    const el = document.getElementById(badgeId);
    if (!el) return;

    // Warm up the cache if needed (no-op when already cached within TTL)
    if (city) {
        await fetchItineraryForecast(city);
    }

    const hasRain   = _dayHasRain(city, dateYMD);
    const isOutdoor = getCategoryLogic(category).outdoor;
    el.classList.toggle('hidden', !(hasRain && isOutdoor));
}

// ── Open map-style info tray from the itinerary expanded view ─────────────────
/**
 * Opens the standard mapDetailTrayHUD populated with the given spot's data,
 * exactly as it appears when tapping a map pin.  The FAB is already hidden
 * while the itinerary is open; we monkey-patch dismissMapDetailTrayHUDCard
 * once so it re-hides the FAB after any dismissal path (X button on either
 * face, done-button dismiss).  The patch restores itself on first invocation.
 */
function openSpotTrayFromItinerary(spotObj) {
    if (typeof revealMapItemDetailTrayHUD !== 'function') return;

    const plusBtn      = document.getElementById('globalFloatingActionPlusButton');
    const fabWasHidden = plusBtn && plusBtn.classList.contains('hidden');

    const isStarred = ['high', '🔥', 'must do', 'starred']
        .includes((spotObj.priority || '').toLowerCase());

    // Compute distStr using the same logic as the Saved Spots list render so the
    // tray shows: distance in km/m when GPS is on, GPS Off icon when GPS is off,
    // or "Missing Location" when the spot has no coordinate data.
    const _lat = spotObj.latitude  ? String(spotObj.latitude).trim()  : '';
    const _lng = spotObj.longitude ? String(spotObj.longitude).trim() : '';
    const _hasCoords = _lat !== '' && _lat !== '0' && _lng !== '' && _lng !== '0';

    let _distStr;
    if (!_hasCoords) {
        _distStr = 'Missing Location';
    } else if (!gpsStatusCachedBool) {
        _distStr = "<i class='fa-solid fa-location-dot mr-1'></i>GPS Off";
    } else if (typeof calculateDistance === 'function') {
        const _d = calculateDistance(userLat, userLon, parseFloat(_lat), parseFloat(_lng));
        _distStr = _d < 1 ? `${Math.round(_d * 1000)}m` : `${_d.toFixed(1)}km`;
    } else {
        _distStr = 'GPS Off';
    }

    const safeSpot = { ...spotObj, distStr: _distStr };

    revealMapItemDetailTrayHUD(safeSpot, isStarred);

    // Restore FAB to its pre-tray state (hidden) when tray is closed.
    // All dismissal paths (both X buttons, done-button) call the global
    // dismissMapDetailTrayHUDCard by name, so patching window-level is enough.
    if (fabWasHidden && typeof window.dismissMapDetailTrayHUDCard === 'function') {
        const _orig = window.dismissMapDetailTrayHUDCard;
        window.dismissMapDetailTrayHUDCard = function () {
            _orig();                                       // hides tray, shows FAB
            if (plusBtn) plusBtn.classList.add('hidden');  // re-hide for itinerary
            window.dismissMapDetailTrayHUDCard = _orig;    // restore for map use
        };
    }
}

function openItineraryDetailView(itinId) {
    activeItineraryId = itinId;

    // Default to Day 1 (index 0), then try to advance to the current active day.
    // "Active day" = the first real (non-suggested) day whose date >= today.
    // This means if Day 1 is yesterday and Day 2 is today, the view opens on Day 2.
    // If the itinerary is entirely in the past, or has no dated days, stay on Day 1.
    activeItineraryDayTracker = 0;
    const _itin    = savedItineraries.find(i => i.id === itinId);
    const _todayYMD = _getLocalYMD(0);
    if (_itin?.days) {
        const _smartIdx = _itin.days.findIndex(d => d && !d.isSuggested && d.date && d.date >= _todayYMD);
        if (_smartIdx !== -1) activeItineraryDayTracker = _smartIdx;
    }

    document.getElementById('itineraryMasterListView').classList.add('hidden');
    document.getElementById('itineraryDetailView').classList.remove('hidden');
    renderDetailViewTimeline();
}

function closeItineraryDetailView() {
    document.getElementById('itineraryDetailView').classList.add('hidden');
    document.getElementById('itineraryMasterListView').classList.remove('hidden');
    renderItineraryMasterDashboardWorkspace();
}

/**
 * Returns true when the recalculate engine would have something to act on:
 *   1. At least one real (non-suggested) day whose calendar date is in the past.
 *   2. AND at least one of the following is true:
 *        a. A past day has an undone, non-anchored, non-skipped activity
 *           (something to lift and reschedule).
 *        b. Any activity anywhere is marked Done
 *           (trip is in-progress; confidence + re-sorting is still useful).
 */
function _hasRecalculatableItems() {
    const itin = getActiveItinerary();
    if (!itin) return false;
    const todayYMD = _getLocalYMD(0);

    // Condition 1: at least one real elapsed past day
    const elapsedDays = itin.days.filter(d => d && !d.isSuggested && d.date && d.date < todayYMD);
    if (elapsedDays.length === 0) return false;

    // Condition 2a: a past day has at least one pending (liftable) activity
    const hasPendingOnPastDay = elapsedDays.some(day =>
        day.timeline?.some(s => !s.isDone && !s.isAnchored && !s.isSkipped)
    );
    if (hasPendingOnPastDay) return true;

    // Condition 2b: any Done item exists anywhere (trip in-progress, re-sorting valid)
    return itin.days.some(day => day?.timeline?.some(s => s.isDone));
}

/** Opens the ☰ action bottom-sheet for the expanded timeline header. */
function openItinDetailMenuDrawer() {
    const drawer = document.getElementById('itinDetailMenuDrawer');
    if (!drawer) return;

    // Context-aware Recalculate button: enabled only when the itinerary has at
    // least one elapsed past day AND at least one Done activity to act on.
    const recalcBtn = document.getElementById('itinBurgerRecalcBtn');
    if (recalcBtn) {
        const canRecalc = _hasRecalculatableItems();
        recalcBtn.disabled = !canRecalc;
        recalcBtn.classList.toggle('opacity-40',        !canRecalc);
        recalcBtn.classList.toggle('pointer-events-none', !canRecalc);
        // Replace amber with muted slate when disabled so it reads as inactive
        recalcBtn.classList.toggle('bg-amber-500/10',    canRecalc);
        recalcBtn.classList.toggle('border-amber-500/20', canRecalc);
        recalcBtn.classList.toggle('bg-slate-800/30',    !canRecalc);
        recalcBtn.classList.toggle('border-slate-700/20', !canRecalc);
    }

    drawer.classList.remove('hidden');
}

/** Closes the ☰ action bottom-sheet. */
function closeItinDetailMenuDrawer() {
    document.getElementById('itinDetailMenuDrawer')?.classList.add('hidden');
}

function navigateItineraryDay(offset) {
    const itin = getActiveItinerary();
    if(!itin) return;
    activeItineraryDayTracker += offset;
    if (activeItineraryDayTracker < 0) activeItineraryDayTracker = 0;
    if (activeItineraryDayTracker >= itin.days.length) activeItineraryDayTracker = itin.days.length - 1;
    renderDetailViewTimeline();
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggested extra-days persistent banner
// Stored on itin._suggestedBanner = { active, count } so it survives refresh /
// device switch via the existing localStorage + cloud sync path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the styled suggested-days banner element that floats above the first
 * activity card in the timeline.  Matches the app's dark-slate art style.
 */
function _createSuggestedTimelineBanner(itin) {
    const count = itin._suggestedBanner?.count || 1;
    const noun  = count === 1 ? 'day' : 'days';
    const wrap  = document.createElement('div');
    wrap.className = 'suggested-timeline-banner suggested-banner-float';
    wrap.style.cssText = 'margin: 0 16px 20px; padding-top: 12px;';

    wrap.innerHTML = `
        <div style="
            background: linear-gradient(135deg, rgba(236,72,153,0.07) 0%, rgba(15,23,42,0.95) 100%);
            border: 1px solid rgba(236,72,153,0.22);
            border-radius: 18px;
            padding: 14px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.30), 0 0 0 1px rgba(236,72,153,0.05) inset;
            display: flex;
            flex-direction: column;
            gap: 12px;
        ">
            <!-- Header row: icon · title · dismiss X -->
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="
                    width:34px;height:34px;border-radius:11px;flex-shrink:0;
                    background:rgba(236,72,153,0.10);border:1px solid rgba(236,72,153,0.22);
                    display:flex;align-items:center;justify-content:center;">
                    <i class="fa-solid fa-calendar-plus" style="color:rgb(236,72,153);font-size:13px;pointer-events:none;"></i>
                </div>
                <div style="flex:1;min-width:0;">
                    <p style="margin:0 0 2px;font-size:10px;font-weight:900;color:rgb(236,72,153);
                               text-transform:uppercase;letter-spacing:0.07em;">
                        ${count} Suggested Extra ${count === 1 ? 'Day' : 'Days'}
                    </p>
                    <p style="margin:0;font-size:10px;font-weight:500;color:rgb(100,116,139);line-height:1.45;">
                        ${count} ${noun} of activities couldn't fit your schedule. Extend your trip to include ${count === 1 ? 'it' : 'them'}.
                    </p>
                </div>
                <!-- Dismiss -->
                <button onclick="_dismissSuggestedBanner(event)"
                        class="w-7 h-7 bg-red-950/40 border border-red-500/30 rounded-full flex items-center justify-center text-red-400 text-xs font-bold shrink-0 active:scale-90 transition-transform"
                        style="-webkit-tap-highlight-color:transparent;">
                    <i class="fa-solid fa-xmark pointer-events-none"></i>
                </button>
            </div>

            <!-- Divider -->
            <div style="height:1px;background:rgba(236,72,153,0.10);border-radius:1px;"></div>

            <!-- Action button -->
            <button onclick="addSuggestedDaysToTrip()" style="
                width:100%;padding:11px 0;cursor:pointer;
                background:linear-gradient(135deg, rgb(236,72,153) 0%, rgb(168,85,247) 100%);
                border:none;border-radius:12px;color:#fff;
                font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.07em;
                display:flex;align-items:center;justify-content:center;gap:7px;
                box-shadow:0 4px 14px rgba(236,72,153,0.22);
                -webkit-tap-highlight-color:transparent;">
                <i class="fa-solid fa-calendar-plus" style="font-size:11px;pointer-events:none;"></i>
                Add ${count === 1 ? 'This Day' : 'These Days'} to My Trip
            </button>
        </div>`;
    return wrap;
}

/**
 * Dismiss the suggested-days banner WITHOUT confirming.
 * Restores itin.days to the exact pre-recalculation snapshot so every activity
 * redistribution is reverted, then clears all pending recalc state.
 * The user lands back on the same day they were viewing before recalculation ran.
 */
function _dismissSuggestedBanner(e) {
    if (e) e.stopPropagation();
    const itin = getActiveItinerary();
    if (!itin) return;

    // Restore the full pre-recalc day list (activities returned to original days)
    if (itin._preRecalcSnapshot) {
        try {
            itin.days = JSON.parse(JSON.stringify(itin._preRecalcSnapshot));
        } catch (_) {
            // If snapshot is somehow corrupted, at least remove any suggested days
            itin.days = itin.days.filter(d => !d?.isSuggested);
        }
    }

    // Clear all pending and recalc state
    itin._pendingSuggestedDays = null;
    itin._preRecalcSnapshot    = null;
    itin._suggestedBanner      = { active: false, count: 0 };
    itin._recalcMoveGuidance   = null;

    // _recalcBaseSnapshot is intentionally NOT touched here.
    // Dismiss reverts only the in-flight recalc (via _preRecalcSnapshot).
    // If the user had previously accepted an earlier recalc, _recalcBaseSnapshot
    // from that run remains valid and the Undo button stays correctly visible.
    // If no prior recalc was accepted, _recalcBaseSnapshot is still null and
    // the Undo button correctly stays hidden.

    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    // Sync dismiss to cloud so that a hard refresh or a new-device load via
    // loadUserItineraries() doesn't resurrect the stale pending banner.
    syncItineraryToCloud(itin, 'save');
    // activeItineraryDayTracker is not changed — user lands back on the same day
    renderDetailViewTimeline();
    _updateBurgerMenuUndoBtn();
}

// ─────────────────────────────────────────────────────────────────────────────
// Move-guidance banner — appears on the elapsed day the user was viewing when
// they triggered recalculation if activities were moved out of it.  The action
// button navigates them straight to the first future day that received spots.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the move-guidance banner element.
 * Matches the app's dark-slate art style using a pink/purple accent palette.
 */
function _createRecalcMoveGuidanceBanner(itin) {
    const guidance  = itin._recalcMoveGuidance;
    if (!guidance)  return document.createDocumentFragment();
    const count     = guidance.movedCount || 0;
    const targetIdx = guidance.toDayIndices[0];
    const dayLabel  = `Day ${targetIdx + 1}`;
    const wrap      = document.createElement('div');
    wrap.className  = 'suggested-banner-float recalc-move-guidance-banner';
    wrap.style.cssText = 'margin: 0 16px 20px; padding-top: 12px;';

    wrap.innerHTML = `
        <div style="
            background: linear-gradient(135deg, rgba(236,72,153,0.07) 0%, rgba(15,23,42,0.93) 100%);
            border: 1px solid rgba(236,72,153,0.22);
            border-radius: 18px;
            padding: 14px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.25), 0 0 0 1px rgba(236,72,153,0.05) inset;
            display: flex;
            flex-direction: column;
            gap: 12px;
        ">
            <!-- Header row: icon · title · dismiss X -->
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="
                    width:34px;height:34px;border-radius:11px;flex-shrink:0;
                    background:rgba(236,72,153,0.10);border:1px solid rgba(236,72,153,0.22);
                    display:flex;align-items:center;justify-content:center;">
                    <i class="fa-solid fa-arrows-turn-right" style="color:rgb(236,72,153);font-size:13px;"></i>
                </div>
                <div style="flex:1;min-width:0;">
                    <p style="margin:0 0 2px;font-size:10px;font-weight:900;color:rgb(236,72,153);
                               text-transform:uppercase;letter-spacing:0.07em;">
                        Activities Redistributed
                    </p>
                    <p style="margin:0;font-size:10px;font-weight:500;color:rgb(100,116,139);line-height:1.45;">
                        ${count} spot${count !== 1 ? 's were' : ' was'} moved from this day to upcoming days.
                    </p>
                </div>
                <!-- Dismiss -->
                <button onclick="_dismissRecalcMoveGuidanceBanner(event)" style="
                    width:26px;height:26px;border-radius:50%;flex-shrink:0;cursor:pointer;
                    background:rgba(30,41,59,0.9);border:1px solid rgba(71,85,105,0.45);
                    display:flex;align-items:center;justify-content:center;
                    -webkit-tap-highlight-color:transparent;">
                    <i class="fa-solid fa-xmark" style="color:rgb(100,116,139);font-size:9px;pointer-events:none;"></i>
                </button>
            </div>

            <!-- Divider -->
            <div style="height:1px;background:rgba(236,72,153,0.10);border-radius:1px;"></div>

            <!-- Action button -->
            <button onclick="_jumpToRecalcMovedDay()" style="
                width:100%;padding:11px 0;cursor:pointer;
                background:linear-gradient(135deg, rgb(236,72,153) 0%, rgb(168,85,247) 100%);
                border:none;border-radius:12px;color:#fff;
                font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.07em;
                display:flex;align-items:center;justify-content:center;gap:7px;
                box-shadow:0 4px 14px rgba(236,72,153,0.22);
                -webkit-tap-highlight-color:transparent;">
                <i class="fa-solid fa-arrow-right" style="font-size:11px;pointer-events:none;"></i>
                View ${dayLabel} — Redistributed Activities
            </button>
        </div>`;
    return wrap;
}

/** Dismiss the move-guidance banner without navigating. */
function _dismissRecalcMoveGuidanceBanner(e) {
    if (e) e.stopPropagation();
    const itin = getActiveItinerary();
    if (!itin) return;
    itin._recalcMoveGuidance = null;
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    renderDetailViewTimeline();
}

/**
 * Navigate to the first future day that received redistributed activities.
 * Clears the guidance state so the banner doesn't persist after the user
 * has been guided to the relevant content.
 */
function _jumpToRecalcMovedDay() {
    const itin = getActiveItinerary();
    if (!itin || !itin._recalcMoveGuidance) return;
    const targetIdx = itin._recalcMoveGuidance.toDayIndices[0];
    itin._recalcMoveGuidance = null;
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    activeItineraryDayTracker = targetIdx;
    renderDetailViewTimeline();
}

/**
 * Determines whether a given day is "too packed" using two independent axes:
 *
 *  1. TIME UTILISATION — total scheduled activity minutes ÷ available day window.
 *     Threshold: ≥ 80 %.  Catches days with a few long activities that fill the
 *     clock even if the spot count looks manageable.
 *
 *  2. SPOT COUNT — raw number of activities regardless of duration.
 *     Threshold: ≥ 6 on max pacing, ≥ 5 on relaxed.
 *     Catches days with many short/quick stops that create logistical busyness
 *     even if the cumulative time is under the threshold.
 *
 * Done/anchored spots are counted the same as active spots — they still occupy
 * real time in the user's day.
 *
 * Suggested extra days are excluded: they're hypothetical and shouldn't alarm.
 */
function _isPackedDay(day, itin) {
    if (!day || day.isSuggested) return false;
    const timeline = day.timeline || [];
    if (timeline.length === 0) return false;

    const isRelaxed  = (itin?.config?.pacing || 'max') === 'relaxed';
    const dayStart   = itin?.config?.start ?? parseTimeToMinutes('09:00');
    const dayEnd     = itin?.config?.end   ?? parseTimeToMinutes('21:00');
    const windowMins = Math.max(1, dayEnd - dayStart);

    // Axis 1: time utilisation
    const totalActivityMins = timeline.reduce((sum, s) => {
        const dur = (s.sch_end ?? (s.sch_start + 60)) - (s.sch_start ?? 0);
        return sum + Math.max(0, dur);
    }, 0);
    if (totalActivityMins / windowMins >= 0.80) return true;

    // Axis 2: spot count density
    const countThreshold = isRelaxed ? 5 : 6;
    if (timeline.length >= countThreshold) return true;

    return false;
}

function renderDetailViewTimeline() {
    const container = document.getElementById('itineraryTimelineScrollContainer');
    const itin = getActiveItinerary();
    if (!itin) return;
    // Keep undo burger button in sync on every render
    _updateBurgerMenuUndoBtn();

    const _pacingIconHtml = (itin.config?.pacing === 'relaxed')
        ? '<i class="fa-solid fa-mug-hot text-sky-400 text-[11px] shrink-0"></i>'
        : '<i class="fa-solid fa-rocket  text-amber-400 text-[11px] shrink-0"></i>';
    const _safeTitle = (itin.title || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    document.getElementById('detailItineraryTitle').innerHTML =
        `${_pacingIconHtml}<span class="truncate min-w-0">${_safeTitle}</span>`;
    // ── Day label: "Day X of Y" with optional contextual tag ─────────────────────
    const _currentDay     = itin.days[activeItineraryDayTracker];
    const _currentDayDate = _currentDay?.date;
    let _relativeTag = '';

    if (_currentDay?.isSuggested) {
        // Suggested extra days appended by the recalculate engine
        _relativeTag = `Suggested Extra Day ${_currentDay.suggestedIndex}`;
    } else if (_currentDayDate) {
        // Compare against device-local dates using the shared _getLocalYMD helper
        if      (_currentDayDate === _getLocalYMD(-1)) _relativeTag = 'Yesterday';
        else if (_currentDayDate === _getLocalYMD(0))  _relativeTag = 'Today';
        else if (_currentDayDate === _getLocalYMD(1))  _relativeTag = 'Tomorrow';
    }

    const _dayLabelEl = document.getElementById('detailDayLabel');
    if (_dayLabelEl) {
        const _mainText = `Day ${activeItineraryDayTracker + 1} of ${itin.days.length}`;
        if (_relativeTag) {
            _dayLabelEl.innerHTML =
                `${_mainText} <span class="font-normal normal-case tracking-normal opacity-60">(${_relativeTag})</span>`;
        } else {
            _dayLabelEl.textContent = _mainText;
        }
    }

    // ── Packed-day indicator ──────────────────────────────────────────────────
    const _packed    = _isPackedDay(itin.days[activeItineraryDayTracker], itin);
    const _navBar    = document.getElementById('itinDayNavBar');
    const _pkTooltip = document.getElementById('packedDayTooltip');
    if (_navBar)    _navBar.classList.toggle('itin-packed-day-nav', _packed);
    if (_pkTooltip) _pkTooltip.classList.toggle('hidden', !_packed);

    const prevBtn     = document.getElementById('itinNavPrevBtn');
    const nextBtn     = document.getElementById('itinNavNextBtn');
    if (prevBtn) prevBtn.classList.toggle('invisible', activeItineraryDayTracker === 0);
    if (nextBtn) nextBtn.classList.toggle('invisible', activeItineraryDayTracker >= itin.days.length - 1);

    _syncDetailViewStarBtn(itin);

    const activeDay = itin.days[activeItineraryDayTracker];
    document.getElementById('detailDateLabel').innerText = new Date(activeDay.date)
        .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    _fetchAndRenderDetailDayWeather(itin.city, activeDay.date, activeItineraryDayTracker);

    container.innerHTML = '';
    container.scrollTop = 0; // reset scroll on every render so banners always start visible

    // ── Move-guidance banner visibility ───────────────────────────────────────
    // True when recalculation moved spots out of the day the user is viewing,
    // so we can show the pink banner that guides them to where those spots went.
    const _showMoveGuidance = !!(itin._recalcMoveGuidance &&
        activeItineraryDayTracker === itin._recalcMoveGuidance.fromDayIdx &&
        !_currentDay?.isSuggested);

    // ── Layout constants ──────────────────────────────────────────────────────
    const PX_PER_MIN  = 2.0;   // 120 px per hour
    const RULER_W     = 46;    // left time-column width in px
    const MIN_BLOCK_H = 140;   // minimum block height — ensures card always fits
    const CARD_TOP    = 2;     // px from block top to card top — flush with time mark

    // ── Empty-day state ───────────────────────────────────────────────────────
    if (activeDay.timeline.length === 0) {
        // Inject both recalc banners before the empty-state message so the user
        // understands what happened rather than seeing a blank day with no context.
        if (_showMoveGuidance) {
            container.appendChild(_createRecalcMoveGuidanceBanner(itin));
        }
        const _hasSuggestedBanner = itin._suggestedBanner?.active && !_currentDay?.isSuggested;
        if (_hasSuggestedBanner) {
            container.appendChild(_createSuggestedTimelineBanner(itin));
        }
        // Only show the empty-state illustration when no contextual banner is
        // occupying the view — the suggested-day banner is self-explanatory and
        // the mug + message would just add visual noise beneath it.
        if (!_hasSuggestedBanner) {
            const emptyDiv = document.createElement('div');
            emptyDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:80px 16px;text-align:center;';
            const emptyMsg = activeDay.isSuggested
                ? 'No activities could be placed on this suggested day — venue hours or durations may not fit.'
                : 'No activities scheduled for this day.';
            emptyDiv.innerHTML = `
            <div style="font-size:2.5rem;opacity:0.2;color:rgb(148 163 184);">
                <i class="fa-solid fa-mug-hot"></i>
            </div>
            <p style="font-size:11px;font-weight:600;color:rgb(71 85 105);">${emptyMsg}</p>`;
            container.appendChild(emptyDiv);
        }
        return;
    }

    // ── Helper: format a minutes value into a label object ───────────────────
    // Returns { main, ampm, isMid } — e.g. 570 → { main:"9:30", ampm:"AM", isMid:false }
    const _fmtLabel = (mins) => {
        const h    = Math.floor(mins / 60) % 24;
        const m    = mins % 60;
        const h12  = h === 0 ? 12 : h <= 12 ? h : h - 12;
        const ampm = h < 12 ? 'AM' : 'PM';
        const main = m === 0 ? String(h12) : `${h12}:${String(m).padStart(2, '0')}`;
        return { main, ampm, isMid: mins === 0 || mins === 720 };
    };

    // ── Helper: add a horizontal time mark to a block element ────────────────
    // isStart marks are always rendered as a solid line (they anchor the block).
    // Internal hour marks are solid; internal half-hour marks are dotted.
    // All lines span left:0 → right:0 (full block width, behind the card).
    const _addMark = (block, mins, offsetPx, isStart) => {
        const onHour     = mins % 60 === 0;
        const renderSolid = isStart || onHour;
        const lbl        = _fmtLabel(mins);

        const wrap = document.createElement('div');
        wrap.style.cssText = `position:absolute;left:0;right:0;top:${offsetPx}px;height:0;z-index:0;pointer-events:none;`;

        if (renderSolid) {
            const lineCol = lbl.isMid ? 'rgba(71,85,105,0.6)' : 'rgba(30,41,59,1)';
            const lblCol  = lbl.isMid ? 'rgba(148,163,184,0.65)'
                          : isStart    ? 'rgba(100,116,139,0.95)'
                          :              'rgba(71,85,105,0.8)';
            wrap.innerHTML = `
                <div style="position:absolute;left:0;right:0;top:0;height:1px;background:${lineCol};"></div>
                <span style="
                    position:absolute;left:4px;top:-8px;
                    font-size:7.5px;font-weight:800;color:${lblCol};
                    white-space:nowrap;line-height:1;letter-spacing:0.02em;">
                    ${lbl.main}<span style="font-size:6px;margin-left:1px;">${lbl.ampm}</span>
                </span>`;
        } else {
            // Half-hour mark: full-width dashed line using a repeating gradient
            // (4 px dash / 6 px gap) — readable at any screen density
            wrap.innerHTML = `
                <div style="
                    position:absolute;left:0;right:0;top:0;height:1px;
                    background:repeating-linear-gradient(
                        to right,
                        rgba(30,41,59,0.9) 0px,
                        rgba(30,41,59,0.9) 4px,
                        transparent 4px,
                        transparent 10px
                    );"></div>`;
        }

        block.appendChild(wrap);
    };

    // ── Helper: append a proportional ruler section (preamble / gap / postamble)
    // Renders hour (solid) and half-hour (dotted) marks over the time range
    // [fromMins, toMins].  The last mark (toMins) is suppressed unless it is
    // exactly midnight (1440) so it is never double-drawn with the next block's
    // start mark.
    const _appendRulerSection = (fromMins, toMins) => {
        if (toMins <= fromMins) return;
        const sectionH = Math.round((toMins - fromMins) * PX_PER_MIN);
        if (sectionH <= 0) return;

        const section = document.createElement('div');
        section.style.cssText = `position:relative;height:${sectionH}px;`;

        // Ruler spine
        const spine = document.createElement('div');
        spine.style.cssText = `position:absolute;left:${RULER_W - 1}px;top:0;bottom:0;width:1px;background:rgba(20,30,40,1);z-index:0;pointer-events:none;`;
        section.appendChild(spine);

        // Draw marks for every 30-min boundary within [fromMins, toMins]
        const startMark = (fromMins % 30 === 0) ? fromMins : Math.ceil(fromMins / 30) * 30;
        for (let m = startMark; m <= toMins; m += 30) {
            // Suppress the closing boundary mark except at true midnight (end of day)
            if (m === toMins && toMins !== 1440) continue;
            const offsetPx = Math.round((m - fromMins) * PX_PER_MIN);
            // Use m % 1440 so 1440 displays as "12 AM" via _fmtLabel
            _addMark(section, m % 1440, offsetPx, false);
        }

        container.appendChild(section);
    };

    // ── Render blocks ─────────────────────────────────────────────────────────
    const timeline = activeDay.timeline;

    // Preamble ruler: 12 AM → first activity start
    const firstStart = timeline.length > 0 ? (timeline[0].sch_start || 0) : 1440;
    const lastEnd    = timeline.length > 0
        ? (timeline[timeline.length - 1].sch_end
           || (timeline[timeline.length - 1].sch_start + 60))
        : 0;
    _appendRulerSection(0, firstStart);

    timeline.forEach((spot, spotIndex) => {
        const startMins    = spot.sch_start || 0;
        const endMins      = spot.sch_end   || (startMins + 60);
        const durationMins = Math.max(endMins - startMins, 1);
        // Proportional height drives min-height so time marks stay evenly spaced,
        // but the block can grow beyond this to fit card content.
        const propH = Math.round(durationMins * PX_PER_MIN);

        // ── Move-guidance banner: injected once above the first card ─────────
        // Appears when recalculation redistributed spots out of this day so the
        // user has a clear call-to-action to navigate to the affected future day.
        if (spotIndex === 0 && _showMoveGuidance) {
            container.appendChild(_createRecalcMoveGuidanceBanner(itin));
        }

        // ── Suggested-days banner: injected once, right above the first card ──
        // Only shown on real days (not on the suggested-day view which has its own
        // explanation banner) and only when itin._suggestedBanner.active is true.
        if (spotIndex === 0 && itin._suggestedBanner?.active && !_currentDay?.isSuggested) {
            container.appendChild(_createSuggestedTimelineBanner(itin));
        }

        // ── Gap spacer before this block (skipped for the first entry) ────────
        if (spotIndex > 0) {
            const prevEnd = timeline[spotIndex - 1].sch_end
                         || (timeline[spotIndex - 1].sch_start + 60);
            const gapMins = startMins - prevEnd;

            if (gapMins > 0) {
                // Proportional ruler section for the free-time gap
                _appendRulerSection(prevEnd, startMins);
            }
        }

        // ── Activity block ────────────────────────────────────────────────────
        // Card is in NORMAL FLOW (not absolute) so the block grows to fit its
        // content — cards can never overflow into adjacent blocks.
        // padding-left pushes the card into the right column.
        // min-height keeps proportional time-mark spacing even on short activities.
        const block = document.createElement('div');
        block.dataset.itinBlock = `${activeItineraryDayTracker}-${spotIndex}`;
        block.style.cssText = `
            position:relative;
            padding:${CARD_TOP}px 16px ${CARD_TOP}px ${RULER_W + 6}px;
            min-height:${Math.max(propH, MIN_BLOCK_H)}px;`;
        // 1px right-border of the ruler column — visual vertical spine
        const spine = document.createElement('div');
        spine.style.cssText = `
            position:absolute;left:${RULER_W - 1}px;top:0;bottom:0;
            width:1px;background:rgba(20,30,40,1);z-index:0;pointer-events:none;`;
        block.appendChild(spine);

        // Start-time solid mark (always at top of block)
        _addMark(block, startMins, 0, true);

        // All hour / half-hour marks that fall strictly inside the activity window
        const firstInternal = Math.ceil((startMins + 1) / 30) * 30;
        for (let m = firstInternal; m < endMins; m += 30) {
            _addMark(block, m, Math.round((m - startMins) * PX_PER_MIN), false);
        }

        // Done state: dim only the timeline chrome (spine + ruler marks) so they don't
        // appear noisy behind the card. We intentionally do NOT apply a block-level
        // filter/opacity because that would also dim the Undo and Delete buttons —
        // those should remain fully visible as the card's only active actions.
        if (spot.isDone) {
            Array.from(block.children).forEach(el => { el.style.opacity = '0.22'; });
        }

        // ── Card — normal-flow child; grows to fit its own content ────────────
        // Resolve category icon — same helper used by the Saved Spots list
        const _catIconCls = (typeof getCategoryIconClass === 'function')
            ? getCategoryIconClass(spot.category)
            : 'fa-location-dot text-slate-400';

        // Star state — same check used across the whole app
        const _isHigh = ['high', '🔥', 'must do', 'starred']
            .includes((spot.priority || '').toLowerCase());

        const card = document.createElement('div');
        // Stable ID lets toggleItinerarySpotStar find this card after re-render
        // to fire the amber burst animation without a full DOM search.
        card.id = `itin-timeline-card-${activeItineraryDayTracker}-${spotIndex}`;
        // Base card — itin-timeline-card drives the border/glow CSS transition.
        // Done cards: itin-done-card supplies a faint border + semi-transparent bg so the
        // card reads as greyed-out without a parent filter (which would also dim Undo/Delete).
        // w-full ensures the card always fills its block container regardless of
        // whether optional badges (confidence, weather risk) are present or absent.
        // Without w-full, card width could shrink to content width in WebKit,
        // causing layout jitter when badges appear/disappear.
        card.className = `itin-timeline-card w-full border rounded-2xl p-4 relative cursor-pointer ${spot.isDone ? 'itin-done-card' : 'bg-slate-900 ' + (_isHigh ? 'starred-gold-glow' : 'border-slate-800')}`;

        // ── Per-element done-state helpers ──────────────────────────────────────
        // Apply independently to each element so Undo/Delete can carry their own styles.
        const _catPillCls   = spot.isDone
            ? 'bg-slate-900/30 text-slate-600 border-slate-700/30 itin-done-text'
            : 'bg-slate-950 text-slate-400 border-slate-800';
        const _timeBadgeCls = spot.isDone
            ? 'text-slate-600 bg-slate-800/20 border-slate-700/30 itin-done-text'
            : 'text-pink-400 bg-pink-500/10 border-pink-500/20';
        const _wxBadgeCls   = spot.isDone ? 'opacity-30' : '';
        const _deleteBtnCls = spot.isDone
            ? 'bg-red-950/15 text-red-700 active:bg-red-900/25'
            : 'bg-red-950/20 text-red-500 active:bg-red-900/60';
        const _nameCls      = spot.isDone ? 'text-slate-500 itin-done-text' : 'text-slate-200';

        // ── Feature 1: Confidence badge ────────────────────────────────────
        let _confBadge = '';
        if (spot._confidence != null && !spot.isDone) {
            const sc  = spot._confidence;
            const col = sc >= 75 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                      : sc >= 50 ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                                 : 'text-red-400 bg-red-500/10 border-red-500/20';
            const lbl = sc >= 75 ? 'Strong fit' : sc >= 50 ? 'Moderate fit' : 'Weak fit';
            _confBadge = `<span class="inline-flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded-lg font-bold border shrink-0 ${col}">
                <i class="fa-solid fa-circle-dot text-[7px]"></i>${lbl}
            </span>`;
        }

        // ── Rain-risk badge ────────────────────────────────────────────────
        // Always rendered with a stable DOM id so the async job can show/hide
        // it once the forecast data arrives — even on fresh itineraries that
        // have never been through the recalculate engine.
        // Synchronous initial visibility: spot._weatherRisk (set by recalc)
        // OR a live cache hit via _dayHasRain + outdoor category check.
        const _rrBadgeId  = `rrb-${itin.id}-${activeItineraryDayTracker}-${spotIndex}`;
        const _liveRisk   = !spot.isDone && (
            spot._weatherRisk ||
            (_dayHasRain(itin.city, activeDay.date) && getCategoryLogic(spot.category).outdoor)
        );
        const _weatherRiskBadge = `<span id="${_rrBadgeId}"
            class="inline-flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded-lg font-bold border text-sky-400 bg-sky-500/10 border-sky-500/20 shrink-0${_liveRisk ? '' : ' hidden'}">
            <i class="fa-solid fa-cloud-rain text-[7px]"></i>Rain risk
        </span>`;

        // ── Feature 3: Defer badge ─────────────────────────────────────────
        let _deferBadge = '';
        if (spot.isDeferToLastDay && !spot.isDone) {
            _deferBadge = `<span class="inline-flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded-lg font-bold border text-violet-400 bg-violet-500/10 border-violet-500/20 shrink-0">
                <i class="fa-solid fa-clock-rotate-left text-[7px]"></i>Deferred
            </span>`;
        }

        card.innerHTML = `
            <div class="absolute top-0 bottom-0 left-0 w-1 bg-gradient-to-b from-pink-500 to-purple-600 rounded-l-2xl ${spot.isDone ? 'opacity-10' : 'opacity-80'}"></div>

            <div class="pl-2">
                <!-- Row 1: category pill · time badge · weather · delete -->
                <div class="flex items-center gap-1.5 mb-1.5">
                    <span class="inline-flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-lg font-bold border shrink-0 ${_catPillCls}">
                        <i class="fa-solid ${_catIconCls} text-[8px]"></i>
                        <span class="uppercase tracking-wider">${spot.category || 'General'}</span>
                        ${spot.isAnchored ? '<i class="fa-solid fa-lock text-amber-400 text-[7px] ml-0.5"></i>' : ''}
                    </span>
                    <span class="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border shadow-inner shrink-0 ${_timeBadgeCls}">
                        ${formatMinutesToTime(spot.sch_start)} – ${formatMinutesToTime(spot.sch_end)}
                    </span>
                    <span id="wba-${itin.id}-${activeItineraryDayTracker}-${spotIndex}"
                          class="inline-flex items-center justify-center gap-0.5 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-lg min-w-[2.75rem] bg-sky-500/10 text-sky-300 shrink-0 ${_wxBadgeCls}">
                        <i class="fa-solid fa-cloud text-[8px] opacity-25 animate-pulse"></i>
                    </span>
                    <button onclick="removeActivityWithAnimation(${activeItineraryDayTracker}, ${spotIndex})"
                            class="ml-auto w-6 h-6 flex items-center justify-center rounded-lg shrink-0 text-[10px] transition-colors ${_deleteBtnCls}">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>

                <!-- Row 1b: confidence · rain-risk · defer badges -->
                <!-- Always rendered so the rain-risk span (which has a stable DOM id)
                     can be shown/hidden by the async _updateRainRiskBadge job even when
                     the forecast cache wasn't warm at render time. -->
                <div class="flex items-center gap-1.5 mb-1.5 flex-wrap">
                    ${_confBadge}${_weatherRiskBadge}${_deferBadge}
                </div>

                <!-- Row 2: spot name -->
                <h3 class="text-[13px] font-black truncate mb-2 ${_nameCls}">${spot.spot_name}</h3>

                <!-- Notes (optional) -->
                ${spot.notes ? `<div class="mb-3 bg-slate-950/40 p-2.5 rounded-xl border border-slate-900/60"><p class="text-[10px] leading-relaxed font-medium text-slate-400 line-clamp-2 ${spot.isDone ? 'itin-done-text' : ''}">${spot.notes}</p></div>` : ''}

                <!-- Action row: when done → only Undo and Delete (in row 1) are active -->
                <div class="flex gap-1.5 items-center">
                    <!-- Ref — active (gradient) when normal; flat grey when done -->
                    <a href="${spot.instagram_url || spot.reference_link || '#'}" target="_blank"
                       class="flex-1 text-center text-[10px] font-bold py-2 rounded-xl flex items-center justify-center gap-1 transition-opacity ${spot.isDone ? 'bg-slate-800/40 border border-slate-700/30 text-slate-600 opacity-40 pointer-events-none' : 'bg-gradient-to-r from-pink-600 to-purple-600 text-white shadow-md active:opacity-80'}">
                        <i class="fa-solid fa-link text-[9px]"></i> Ref
                    </a>
                    <!-- Dir — always disabled on done -->
                    <button data-row-id="${spot.rowid}" onclick="handleAdaptiveDirectionClick(this, event)"
                            class="flex-1 bg-slate-950 border border-slate-800 text-slate-300 text-[10px] font-bold py-2 rounded-xl flex items-center justify-center gap-1 active:bg-slate-900 transition-colors ${spot.isDone ? 'opacity-40 pointer-events-none' : ''}">
                        <i class="fa-solid fa-map text-[9px]"></i> Dir
                    </button>
                    <!-- Done / Undo — always active -->
                    <button onclick="toggleActivityDoneState(${activeItineraryDayTracker}, ${spotIndex})"
                            class="flex-1 text-[10px] font-bold py-2 rounded-xl flex items-center justify-center gap-1 border transition-colors
                                   ${spot.isDone ? 'bg-pink-600/10 border-pink-600/20 text-pink-400 active:bg-pink-600/20' : 'bg-slate-950 border-slate-800 text-slate-400 active:bg-slate-900'}">
                        ${spot.isDone
                            ? '<i class="fa-solid fa-arrow-rotate-left text-[9px]"></i> Undo'
                            : '<i class="fa-solid fa-check text-[9px]"></i> Done'}
                    </button>
                    <!-- Star: matches Saved Spots tray convention exactly —
                         fa-star (full)        amber = not yet starred → tap to star
                         fa-star-half-stroke   amber = currently starred → tap to unstar
                         Disabled on done — only Undo and Delete are active on a done card. -->
                    <button onclick="toggleItinerarySpotStar(${activeItineraryDayTracker}, ${spotIndex})"
                            class="w-9 h-9 flex items-center justify-center rounded-xl border transition-colors active:scale-90
                                   ${spot.isDone
                                     ? 'opacity-40 pointer-events-none bg-slate-950 border-slate-800 text-slate-700'
                                     : 'bg-amber-500/10 border-amber-500/20 text-amber-400 active:bg-amber-500/20'}">
                        <i class="fa-solid fa-${_isHigh ? 'star-half-stroke' : 'star'} text-[11px]"></i>
                    </button>
                    <!-- Swap — disabled on done -->
                    <button onclick="swapActivityInTimeline(${activeItineraryDayTracker}, ${spotIndex})"
                            class="w-9 h-9 flex items-center justify-center bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl active:bg-indigo-500/20 transition-colors ${spot.isDone ? 'opacity-40 pointer-events-none' : ''}">
                        <i class="fa-solid fa-arrows-rotate text-[11px]"></i>
                    </button>
                </div>
            </div>`;

        // Tap on the card body (not a button or link) → open full map info tray.
        // Done cards are not tappable — only their Undo and Delete buttons work.
        card.addEventListener('click', function (e) {
            if (spot.isDone) return;
            if (e.target.closest('button, a')) return;
            openSpotTrayFromItinerary(spot);
        });

        // ── Feature 3: Long-press → skip / defer context menu ────────────────
        if (!spot.isDone) {
            let _lpTimer = null;
            const _capturedDay = activeItineraryDayTracker;
            const _capturedIdx = spotIndex;
            card.addEventListener('touchstart', function (e) {
                if (e.target.closest('button, a')) return;
                _lpTimer = setTimeout(() => {
                    e.preventDefault();
                    const menu     = document.getElementById('spotContextMenu');
                    const backdrop = document.getElementById('spotContextMenuBackdrop');
                    if (!menu) return;
                    menu.dataset.dayIndex  = _capturedDay;
                    menu.dataset.spotIndex = _capturedIdx;

                    // Disable "Defer to Last Day" when the current day IS the last
                    // real day, or the itinerary has only one real day.
                    const _itin      = getActiveItinerary();
                    const _deferBtn  = document.getElementById('spotContextDeferBtn');
                    const _deferSub  = document.getElementById('spotContextDeferSubtitle');
                    if (_deferBtn && _itin) {
                        const _realDays  = (_itin.days || [])
                            .filter(d => !d?.isSuggested && d?.date)
                            .sort((a, b) => a.date > b.date ? 1 : -1);
                        const _curDate   = _itin.days[_capturedDay]?.date;
                        const _lastDate  = _realDays[_realDays.length - 1]?.date;
                        const _canDefer  = _realDays.length > 1 && _curDate && _lastDate && _curDate < _lastDate;
                        _deferBtn.disabled = !_canDefer;
                        _deferBtn.classList.toggle('opacity-40',  !_canDefer);
                        _deferBtn.classList.toggle('pointer-events-none', !_canDefer);
                        if (_deferSub) {
                            _deferSub.textContent = _canDefer
                                ? 'Move to the final day of your trip'
                                : 'Already on the last day of the trip';
                        }
                    }

                    if (backdrop) backdrop.classList.remove('hidden');
                    menu.classList.remove('hidden');
                    // Position near touch
                    const t   = e.touches[0];
                    const vw  = window.innerWidth;
                    const vh  = window.innerHeight;
                    const mw  = 200;
                    const mh  = 110;
                    let  left = Math.min(t.clientX, vw - mw - 10);
                    let  top  = Math.min(t.clientY - mh - 10, vh - mh - 10);
                    if (top < 80) top = t.clientY + 10;
                    menu.style.left = `${left}px`;
                    menu.style.top  = `${top}px`;
                }, 500);
            }, { passive: true });
            card.addEventListener('touchend',    () => clearTimeout(_lpTimer));
            card.addEventListener('touchmove',   () => clearTimeout(_lpTimer));
            card.addEventListener('touchcancel', () => clearTimeout(_lpTimer));
        }

        block.appendChild(card);
        container.appendChild(block);
    });

    // Postamble ruler: last activity end → midnight
    _appendRulerSection(lastEnd, 1440);

    // Per-activity weather badges — deferred so the DOM is painted first.
    const _actWeatherJobs = timeline.map((spot, idx) => ({
        badgeId:  `wba-${itin.id}-${activeItineraryDayTracker}-${idx}`,
        date:     activeDay.date,
        dayIndex: activeItineraryDayTracker,
        spot,
    }));

    // Rain-risk badge jobs — one per spot, keyed by the stable rrb-* DOM id.
    // Runs alongside the weather badge jobs; _updateRainRiskBadge internally
    // calls fetchItineraryForecast which hits the cache on subsequent calls,
    // so the net cost is at most one extra network fetch per city per hour.
    const _rainRiskJobs = timeline.map((spot, idx) => ({
        badgeId:  `rrb-${itin.id}-${activeItineraryDayTracker}-${idx}`,
        date:     activeDay.date,
        category: spot.category,
        isDone:   spot.isDone,
    }));

    setTimeout(() => {
        _actWeatherJobs.forEach(job =>
            _populateItinActivityWeatherBadge(job.badgeId, itin.city, job.date, job.dayIndex, job.spot)
        );
        _rainRiskJobs.forEach(job =>
            _updateRainRiskBadge(job.badgeId, itin.city, job.date, job.category, job.isDone)
        );
    }, 0);

    // Auto-scroll: when a banner is active (move-guidance or suggested-days),
    // scroll so the banner is fully in view with the first activity card visible
    // below it.  Otherwise snap to ~30 min before the first activity.
    //
    // We use a double-rAF (requestAnimationFrame inside requestAnimationFrame) so
    // the browser has completed two full paint cycles and the banner element has a
    // committed offsetHeight before we compute the scroll target.  A single rAF
    // fires before layout is flushed and produces an incorrect scrollTop.
    if (timeline.length > 0) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const _hasBanner = _showMoveGuidance ||
                    (itin._suggestedBanner?.active && !_currentDay?.isSuggested);
                if (_hasBanner) {
                    // The preamble ruler occupies firstStart * PX_PER_MIN px.
                    // The banner is appended immediately after the ruler, so its
                    // top edge is at exactly that pixel offset.
                    // Subtract a comfortable top-margin (12 px) so the banner
                    // title isn't flush with the viewport edge.
                    const rulerHeight  = Math.round(firstStart * PX_PER_MIN);
                    // Try to measure the real banner height so we know the first
                    // card also fits in view; fall back to 0 if not yet rendered.
                    const bannerEl     = container.querySelector('.suggested-timeline-banner, .recalc-move-guidance-banner');
                    const bannerH      = bannerEl ? bannerEl.offsetHeight : 0;
                    // Scroll target: put banner ~12 px from viewport top.
                    // The first card starts at rulerHeight + bannerH, so if the
                    // viewport height is reasonable both banner and card are visible.
                    const scrollTarget = Math.max(0, rulerHeight - 12);
                    container.scrollTop = scrollTarget;
                } else {
                    const scrollTarget = Math.max(0, Math.round((firstStart - 30) * PX_PER_MIN));
                    container.scrollTop = scrollTarget;
                }
            });
        });
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const tlFooter = document.createElement('div');
    tlFooter.style.cssText = 'margin:24px 16px 0;padding:20px 0;text-align:center;font-size:9px;font-weight:900;color:rgb(51 65 85);letter-spacing:0.12em;opacity:0.6;border-top:1px solid rgba(30,41,59,0.8);';
    tlFooter.textContent = 'End of Selected Day Itinerary List';
    container.appendChild(tlFooter);
}

/**
 * Toggles the star (priority) state of a saved spot within the itinerary timeline.
 * Mirrors the exact same star/unstar logic used in the Saved Spots list:
 *   - Updates the itinerary's in-memory copy (so re-render reflects the change)
 *   - Calls updateCloudAction to sync travelSpots in memory + write to the cloud sheet
 *   - Saves the updated itinerary to localStorage
 */
function toggleItinerarySpotStar(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    if (!itin || !itin.days[dayIndex] || !itin.days[dayIndex].timeline[spotIndex]) return;
    const spot = itin.days[dayIndex].timeline[spotIndex];
    const isCurrentlyStarred = ['high', '🔥', 'must do', 'starred']
        .includes((spot.priority || '').toLowerCase());
    const newPriority = isCurrentlyStarred ? 'Normal' : 'Starred';

    // ── 1. Update the itinerary copy ─────────────────────────────────────────
    spot.priority = newPriority;
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));

    // ── 2. Mirror priority into travelSpots in-memory ────────────────────────
    // IMPORTANT: we intentionally do NOT call updateCloudAction() here because
    // that helper calls renderItineraryMasterDashboardWorkspace(), which
    // unconditionally hides itineraryDetailView — collapsing the expanded tray.
    // Instead we patch travelSpots directly and fire the POST ourselves.
    if (typeof travelSpots !== 'undefined') {
        const masterSpot = travelSpots.find(s => s.rowid === spot.rowid);
        if (masterSpot) masterSpot.priority = newPriority;
    }

    // ── 3. Fire cloud POST without touching any view state ───────────────────
    (function () {
        const api = (typeof API_URL !== 'undefined') ? API_URL : null;
        if (!api) return;
        const meta = (typeof cachedHardwareString !== 'undefined') ? cachedHardwareString : '';
        fetch(api, {
            method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rowId: spot.rowid, action: 'toggle_priority', value: newPriority,
                spot: spot.spot_name || '', deviceMeta: meta
            })
        }).catch(() => {});
    })();

    // ── 4. Re-render only the timeline — detail view stays open ──────────────
    renderDetailViewTimeline();
    // Fire the amber burst on the freshly rendered card when starring (not unstarring)
    if (newPriority === 'Starred') {
        const _timelineCard = document.getElementById(`itin-timeline-card-${dayIndex}-${spotIndex}`);
        if (_timelineCard) {
            _timelineCard.classList.add('card-flash-star');
            _timelineCard.addEventListener('animationend', () => _timelineCard.classList.remove('card-flash-star'), { once: true });
        }
    }
}

function toggleActivityDoneState(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    if(!itin) return;
    itin.days[dayIndex].timeline[spotIndex].isDone = !itin.days[dayIndex].timeline[spotIndex].isDone;
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    syncItineraryToCloud(itin, 'save');
    renderDetailViewTimeline();
}

/**
 * Animated delete: slingshot right → slide left → block collapses → data mutation.
 * Falls back to instant removal if the block element can't be found.
 */
function removeActivityWithAnimation(dayIndex, spotIndex) {
    const block = document.querySelector(`[data-itin-block="${dayIndex}-${spotIndex}"]`);
    if (!block) {
        removeActivityFromTimeline(dayIndex, spotIndex);
        return;
    }
    const card = block.querySelector('.itin-timeline-card');
    if (!card) {
        removeActivityFromTimeline(dayIndex, spotIndex);
        return;
    }

    // Phase 1: slingshot right (130ms)
    card.classList.add('itin-deleting-slingshot');

    setTimeout(() => {
        // Phase 2: slide left off-screen (270ms)
        card.classList.remove('itin-deleting-slingshot');
        card.classList.add('itin-deleting-exit');

        setTimeout(() => {
            // Phase 3: collapse the block so the rest of the timeline reflows (290ms)
            block.classList.add('itin-block-collapsing');

            setTimeout(() => {
                // Data mutation fires after all animation frames are done
                removeActivityFromTimeline(dayIndex, spotIndex);
            }, 300);
        }, 280);
    }, 140);
}

function removeActivityFromTimeline(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    if(!itin) return;
    itin.days[dayIndex].timeline.splice(spotIndex, 1);
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    renderDetailViewTimeline();
}

function swapActivityInTimeline(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    const currentSpot = itin.days[dayIndex].timeline[spotIndex];
    
    let allUsedIds = new Set();
    itin.days.forEach(d => d.timeline.forEach(s => allUsedIds.add(s.rowid)));

    let candidates = travelSpots.filter(s => s.city === itin.city && !allUsedIds.has(s.rowid) && (s.category || "").toLowerCase().includes(currentSpot.category.toLowerCase()));
    
    if (candidates.length > 0) {
        const replacement = candidates[Math.floor(Math.random() * candidates.length)];
        itin.days[dayIndex].timeline[spotIndex] = {
            ...replacement,
            sch_start: currentSpot.sch_start,
            sch_end: currentSpot.sch_end, // Lock into identical time slot
            isDone: false,
            isAnchored: false
        };
        localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
        renderDetailViewTimeline();
        if(typeof showFormErrorSpeechBubble === 'function') showFormErrorSpeechBubble([`Swapped for: ${replacement.spot_name}`]);
    } else {
        if(typeof showFormErrorSpeechBubble === 'function') showFormErrorSpeechBubble(["No unused alternatives found for this category!"]);
    }
}

function promptRecalculateItinerary() {
    // Note: the burger drawer is intentionally left open behind this modal.
    // Pressing X simply closes the modal and leaves the drawer as-is.
    // Only confirming closes the drawer (then runs the engine).
    openThematicConfirm(
        "Recalculate Flow",
        "Unfinished flexible spots from past days will be moved into the best available slots in upcoming days, without overriding booked or anchored activities.",
        "Recalculate",
        () => { closeItinDetailMenuDrawer(); executeRecalculateEngine(); },
        'pink'
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Recalculate engine v3 — 8 advanced features:
//   1. Confidence scoring      per-placement quality badge
//   2. Half-day awareness      skip morning-only categories when past noon today
//   3. Skip/Defer flags        isSkipped spots excluded; isDeferToLastDay spots
//                              placed only on the last real day
//   4. Geo-clustering          nearest-neighbour sort of placed spots per day
//   5. Category diversity      penalise already-saturated categories per day
//   6. Weather-aware deferral  outdoor spots skipped on rainy/stormy days
//   7. (Trip extension button  rendered in the suggested-day banner in JS below)
//   8. Undo history            snapshot before run; "Undo Recalculate" in burger
// ─────────────────────────────────────────────────────────────────────────────

/** Nearest-neighbour geo sort — reorders spots array in-place. */
function _geoClusterSort(spots) {
    if (spots.length < 3) return spots;
    const hasCoords = s => s._lat != null && s._lng != null;
    if (!spots.some(hasCoords)) return spots;

    function dist(a, b) {
        if (!hasCoords(a) || !hasCoords(b)) return 0;
        const dx = a._lat - b._lat, dy = a._lng - b._lng;
        return Math.sqrt(dx * dx + dy * dy);
    }

    const out     = [spots[0]];
    const pending = spots.slice(1);
    while (pending.length) {
        const last = out[out.length - 1];
        let   best = 0, bestDist = Infinity;
        for (let i = 0; i < pending.length; i++) {
            const d = dist(last, pending[i]);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        out.push(pending.splice(best, 1)[0]);
    }
    return out;
}

/** Confidence score (0–100) for a single placed activity. */
function _calcConfidence(spot, slotStart, slotEnd, dayStart, dayEnd, catCountMap, isToday, isSuggested) {
    let score = 55; // base

    // +15 window fit: slot falls fully within logicOpen–logicClose
    const open  = spot.logicOpen  ?? dayStart;
    const close = spot.logicClose ?? dayEnd;
    if (slotStart >= open && slotEnd <= close) score += 15;

    // +10 category diversity: this category not yet saturated on this day
    const catKey = (spot.category || 'default').toLowerCase();
    if ((catCountMap[catKey] || 0) < 2) score += 10;

    // +10 starred placed in first half of day
    const _isHigh = ['high', '🔥', 'must do', 'starred'].includes((spot.priority || '').toLowerCase());
    const dayMid  = dayStart + (dayEnd - dayStart) / 2;
    if (_isHigh && slotStart <= dayMid) score += 10;

    // +10 today's remaining hours: not a last-minute cram
    if (isToday && slotStart > dayMid) score -= 10;

    // -15 suggested extra day (uncertain)
    if (isSuggested) score -= 15;

    // -10 weather risk flagged
    if (spot._weatherRisk) score -= 10;

    return Math.max(0, Math.min(100, score));
}

/** Check if a day's date has a rainy/stormy forecast using the warm cache. */
function _dayHasRain(city, dateYMD) {
    if (!city || !dateYMD) return false;
    const cached = itinWeatherCache.get(city.trim().toLowerCase());
    if (!cached) return false;
    const dayFc = cached.days.find(d => d.date === dateYMD);
    if (!dayFc) return false;
    const ic = (dayFc.iconClass || '').toLowerCase();
    return ic.includes('rain') || ic.includes('storm') || ic.includes('thunder') || ic.includes('drizzle');
}

function executeRecalculateEngine() {
    document.getElementById('buildingItineraryLoaderPopup').classList.remove('hidden');

    setTimeout(() => {
        const itin = getActiveItinerary();
        if (!itin) {
            document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
            return;
        }

        const todayYMD  = _getLocalYMD(0);
        const now       = new Date();
        const nowMins   = now.getHours() * 60 + now.getMinutes();
        const isPastNoon = nowMins >= 720; // 12:00 — half-day awareness

        // ── Move-guidance tracking ────────────────────────────────────────────
        // Remembers which origin day lost spots and which future days received them
        // so we can display a banner + navigation arrow after recalc completes.
        const _recalcOriginDayIdx       = activeItineraryDayTracker;
        const _originDayLiftedRowids    = new Set(); // rowids lifted FROM the origin day
        const _affectedFutureDayIndices = new Set(); // itin.days[] indices that received them

        // ── Pacing config ─────────────────────────────────────────────────────
        const isRelaxed   = (itin.config?.pacing || 'max') === 'relaxed';
        const bufferMins  = isRelaxed ? 40 : 15;
        const durationKey = isRelaxed ? 'durationRelaxed' : 'durationMax';
        const dayStart    = itin.config?.start ?? parseTimeToMinutes("09:00");
        const dayEnd      = itin.config?.end   ?? parseTimeToMinutes("21:00");

        // ── Clean up any suggested extra days from a prior recalculation ──────
        itin.days = itin.days.filter(d => !d?.isSuggested);
        // Reset the persistent banners — will be re-set below if applicable
        itin._suggestedBanner      = { active: false, count: 0 };
        itin._recalcMoveGuidance   = null;
        itin._pendingSuggestedDays = null;

        // ── Snapshot for banner-dismiss rollback ──────────────────────────────
        // Deep copy of real days BEFORE any activity redistribution.
        // If the user later taps X on the suggested-day banner, _dismissSuggestedBanner
        // restores itin.days from this snapshot, reverting every recalc change.
        itin._preRecalcSnapshot = JSON.parse(JSON.stringify(itin.days));

        // ── Step 1: Lift unfinished flexible spots from ALL elapsed past days ─
        // isSkipped spots are excluded (Feature 3).
        const missedSpots = [];
        let   deferSpots  = []; // Feature 3: isDeferToLastDay
        for (let i = 0; i < itin.days.length; i++) {
            const day = itin.days[i];
            if (!day?.date || day.date >= todayYMD || day.isSuggested) continue;
            for (let j = day.timeline.length - 1; j >= 0; j--) {
                const s = day.timeline[j];
                if (s.isDone || s.isAnchored || s.isSkipped) continue;
                const cat    = getCategoryLogic(s.category);
                const newDur = cat[durationKey] ?? s.logicDur;
                const lifted = { ...s, logicDur: newDur };
                day.timeline.splice(j, 1);
                // Track spots lifted from the day the user was viewing when they triggered recalc
                if (i === _recalcOriginDayIdx) _originDayLiftedRowids.add(s.rowid);
                if (s.isDeferToLastDay) { deferSpots.push(lifted); }
                else                   { missedSpots.push(lifted); }
            }
        }

        if (missedSpots.length === 0 && deferSpots.length === 0) {
            // Nothing was moved — discard the snapshot; no undo state created.
            itin._preRecalcSnapshot = null;
            showRecalcResultBubble(
                ["No pending activities found in past days."],
                "Nothing to Reschedule",
                "fa-circle-info"
            );
            document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
            return;
        }

        // ── Feature 2: Half-day awareness ────────────────────────────────────
        // If recalc fires after noon, morning-only spots can't go on today.
        // They are kept in missedSpots but skipped during today's window.

        // ── Priority sort: starred first, then earliest-opening venues ────────
        // Feature 5: category diversity — also used during placement
        missedSpots.sort((a, b) => {
            const starDiff = (b.isStarred ? 1 : 0) - (a.isStarred ? 1 : 0);
            if (starDiff !== 0) return starDiff;
            return (a.logicOpen ?? dayStart) - (b.logicOpen ?? dayStart);
        });

        // ── Step 2: Place missed spots into today + future real days ──────────
        const remaining = [...missedSpots];

        const realFutureDays = itin.days.filter(d => d?.date && d.date >= todayYMD && !d.isSuggested);

        // Feature 3: Defer spots go only on the last real day
        const lastRealDay = realFutureDays[realFutureDays.length - 1] || null;

        for (const day of realFutureDays) {
            if (remaining.length === 0 && deferSpots.length === 0) break;

            const isToday     = day.date === todayYMD;
            const isLastDay   = (lastRealDay && day.date === lastRealDay.date);
            const existingIds = new Set(day.timeline.map(s => s.rowid));
            const anchored    = day.timeline
                .filter(s => s.isAnchored)
                .sort((a, b) => a.sch_start - b.sch_start);

            // Feature 6: Weather-aware deferral
            const dayHasRain = _dayHasRain(itin.city, day.date);

            // Feature 5: category counts already on this day
            const catCountMap = {};
            day.timeline.forEach(s => {
                const k = (s.category || 'default').toLowerCase();
                catCountMap[k] = (catCountMap[k] || 0) + 1;
            });

            // Build free windows around anchored blocks
            const windows = [];
            let cursor = isToday ? Math.max(dayStart, nowMins + bufferMins) : dayStart;
            for (const anchor of anchored) {
                const gapEnd = anchor.sch_start - bufferMins;
                if (gapEnd > cursor + 30) windows.push({ start: cursor, end: gapEnd });
                cursor = anchor.sch_end + bufferMins;
            }
            if (cursor < dayEnd - 30) windows.push({ start: cursor, end: dayEnd });

            // Which pool to place from this day
            const poolForThisDay = isLastDay
                ? [...remaining, ...deferSpots]
                : [...remaining];

            for (const win of windows) {
                if (poolForThisDay.length === 0) break;

                // Feature 5: re-sort remaining within window by category diversity penalty
                poolForThisDay.sort((a, b) => {
                    const starDiff = (b.isStarred ? 1 : 0) - (a.isStarred ? 1 : 0);
                    if (starDiff !== 0) return starDiff;
                    const catA = (a.category || 'default').toLowerCase();
                    const catB = (b.category || 'default').toLowerCase();
                    const penA = catCountMap[catA] || 0;
                    const penB = catCountMap[catB] || 0;
                    if (penA !== penB) return penA - penB; // less-used category first
                    return (a.logicOpen ?? dayStart) - (b.logicOpen ?? dayStart);
                });

                let t = win.start;
                const placed = new Set();

                for (let i = 0; i < poolForThisDay.length; i++) {
                    const spot = poolForThisDay[i];
                    if (existingIds.has(spot.rowid)) { placed.add(i); continue; }

                    const cat = getCategoryLogic(spot.category);

                    // Feature 2: Half-day awareness — skip morning-only spots today if past noon
                    if (isToday && isPastNoon && cat.morningOnly) continue;

                    // Feature 6: Skip outdoor spots on rainy days (defer to next day)
                    if (dayHasRain && cat.outdoor) {
                        spot._weatherRisk = true;
                        continue;
                    }

                    const slotStart = Math.max(t, spot.logicOpen ?? dayStart);
                    const slotEnd   = slotStart + spot.logicDur;

                    if (slotEnd > win.end)                      continue;
                    if (slotEnd > (spot.logicClose ?? dayEnd))  continue;

                    // Feature 5: update category count
                    const catKey = (spot.category || 'default').toLowerCase();
                    catCountMap[catKey] = (catCountMap[catKey] || 0) + 1;

                    // Feature 1: Confidence score
                    const confidence = _calcConfidence(
                        spot, slotStart, slotEnd, dayStart, dayEnd,
                        catCountMap, isToday, false
                    );

                    day.timeline.push({
                        ...spot,
                        sch_start:   slotStart,
                        sch_end:     slotEnd,
                        isAnchored:  false,
                        isDone:      false,
                        _confidence: confidence,
                    });
                    existingIds.add(spot.rowid);
                    // Track if a spot from the origin day landed on this future day
                    if (_originDayLiftedRowids.has(spot.rowid)) {
                        _affectedFutureDayIndices.add(itin.days.indexOf(day));
                    }
                    t = slotEnd + bufferMins;
                    placed.add(i);
                }

                // Remove placed spots from the correct source arrays
                const placedArr = [...placed].sort((a, b) => b - a);
                placedArr.forEach(i => {
                    const spot = poolForThisDay[i];
                    const ri = remaining.indexOf(spot);
                    const di = deferSpots.indexOf(spot);
                    if (ri !== -1) remaining.splice(ri, 1);
                    if (di !== -1) deferSpots.splice(di, 1);
                    poolForThisDay.splice(i, 1);
                });
            }

            // Feature 4: Geo-cluster the newly placed spots (non-anchored only)
            const anchoredPart  = day.timeline.filter(s => s.isAnchored);
            const flexPart      = day.timeline.filter(s => !s.isAnchored);
            const clusteredFlex = _geoClusterSort(flexPart);
            // Re-assign start/end times in geo order, preserving durations
            let rt = anchoredPart.length > 0
                ? Math.max(dayStart, anchoredPart[anchoredPart.length - 1].sch_end + bufferMins)
                : (isToday ? Math.max(dayStart, nowMins + bufferMins) : dayStart);
            clusteredFlex.forEach(s => {
                const dur   = s.sch_end - s.sch_start;
                s.sch_start = Math.max(rt, s.logicOpen ?? dayStart);
                s.sch_end   = s.sch_start + dur;
                rt          = s.sch_end + bufferMins;
            });
            day.timeline = [...anchoredPart, ...clusteredFlex].sort((a, b) => a.sch_start - b.sch_start);
        }

        // ── Move-guidance: store which future days received spots from origin day ─
        // Banner will appear on the origin day's timeline view so the user isn't
        // left wondering why their day looks empty after recalculation.
        if (_originDayLiftedRowids.size > 0 && _affectedFutureDayIndices.size > 0) {
            itin._recalcMoveGuidance = {
                fromDayIdx:   _recalcOriginDayIdx,
                toDayIndices: [..._affectedFutureDayIndices].sort((a, b) => a - b),
                movedCount:   _originDayLiftedRowids.size,
            };
        }

        // ── Step 3: Suggested extra days for overflow activities ──────────────
        // Suggested days are collected locally and stored in itin._pendingSuggestedDays.
        // They are NOT added to itin.days until the user confirms the banner, so the
        // "Day X of Y" header count stays correct while the confirmation is pending.
        let suggestedCount = 0;
        const _suggestedDayObjects = []; // local staging area; never pushed to itin.days here
        if (remaining.length > 0 || deferSpots.length > 0) {
            const overflow = [...remaining, ...deferSpots];
            const realDates = itin.days
                .filter(d => !d.isSuggested && d?.date)
                .map(d => d.date)
                .sort();
            let lastDate = realDates[realDates.length - 1] || todayYMD;

            while (overflow.length > 0 && suggestedCount < 7) {
                suggestedCount++;

                const [y, mo, dy] = lastDate.split('-').map(Number);
                const nextD = new Date(y, mo - 1, dy + 1);
                lastDate = `${nextD.getFullYear()}-${String(nextD.getMonth() + 1).padStart(2, '0')}-${String(nextD.getDate()).padStart(2, '0')}`;

                const sugDay = {
                    date:           lastDate,
                    isSuggested:    true,
                    suggestedIndex: suggestedCount,
                    timeline:       [],
                };
                // Stage in local array; user must confirm before it joins itin.days
                _suggestedDayObjects.push(sugDay);

                const existingIds  = new Set();
                const catCountMap2 = {};
                let t              = dayStart;
                const placed       = new Set();

                for (let i = 0; i < overflow.length; i++) {
                    const spot      = overflow[i];
                    const cat       = getCategoryLogic(spot.category);
                    // Feature 6: still flag outdoor risk on suggested days with rain
                    const rainRisk  = _dayHasRain(itin.city, lastDate) && cat.outdoor;
                    if (rainRisk) { spot._weatherRisk = true; }

                    const slotStart = Math.max(t, spot.logicOpen ?? dayStart);
                    const slotEnd   = slotStart + spot.logicDur;

                    if (slotEnd > dayEnd)                      continue;
                    if (slotEnd > (spot.logicClose ?? dayEnd)) continue;

                    // Feature 5: category diversity on suggested days
                    const catKey = (spot.category || 'default').toLowerCase();
                    if ((catCountMap2[catKey] || 0) >= 3) continue; // soft cap

                    catCountMap2[catKey] = (catCountMap2[catKey] || 0) + 1;

                    // Feature 1: Confidence score
                    const confidence = _calcConfidence(
                        spot, slotStart, slotEnd, dayStart, dayEnd,
                        catCountMap2, false, true
                    );

                    sugDay.timeline.push({
                        ...spot,
                        sch_start:   slotStart,
                        sch_end:     slotEnd,
                        isAnchored:  false,
                        isDone:      false,
                        _confidence: confidence,
                    });
                    existingIds.add(spot.rowid);
                    t = slotEnd + bufferMins;
                    placed.add(i);
                }
                [...placed].sort((a, b) => b - a).forEach(i => overflow.splice(i, 1));

                // Feature 4: Geo-cluster suggested day too
                sugDay.timeline = _geoClusterSort(sugDay.timeline);
                // Re-sequence times after clustering
                let rt2 = dayStart;
                sugDay.timeline.forEach(s => {
                    const dur   = s.sch_end - s.sch_start;
                    s.sch_start = Math.max(rt2, s.logicOpen ?? dayStart);
                    s.sch_end   = s.sch_start + dur;
                    rt2         = s.sch_end + bufferMins;
                });
            }
        }

        // ── Step 4: Persist + refresh UI ─────────────────────────────────────
        const totalMissed = missedSpots.length + deferSpots.length;
        const totalRemain = remaining.length + deferSpots.length;
        const placed      = totalMissed - totalRemain;

        // ── Undo baseline (replaces the old _recalcHistory stack) ────────────
        // _recalcBaseSnapshot is the single "go back here on undo" anchor.
        // It is only set when null — sequential recalcs all undo to the SAME
        // original baseline so the user always returns to a clean non-recalculated state.
        //
        // Case A — activities placed, no overflow banner:
        //   The result is applied immediately; set the baseline now and discard
        //   _preRecalcSnapshot (no longer needed for a dismiss rollback).
        //
        // Case B — overflow banner pending:
        //   Keep _preRecalcSnapshot alive (dismiss needs it).
        //   The baseline will be promoted inside addSuggestedDaysToTrip() once confirmed.
        //
        // Case C — placed == 0 (nothing moved, "already optimal"):
        //   No state changed; discard _preRecalcSnapshot, leave baseline alone.
        if (suggestedCount > 0) {
            // Case B: store pending suggested days; baseline handled on confirm
            itin._pendingSuggestedDays = _suggestedDayObjects;
            itin._suggestedBanner      = { active: true, count: suggestedCount };
            // _preRecalcSnapshot stays alive for potential dismiss rollback
        } else if (placed > 0) {
            // Case A: immediate result — lock in the undo baseline if not already set
            if (!itin._recalcBaseSnapshot) {
                itin._recalcBaseSnapshot = itin._preRecalcSnapshot;
            }
            itin._preRecalcSnapshot = null; // no longer needed
        } else {
            // Case C: nothing actually changed
            itin._preRecalcSnapshot = null;
        }

        localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
        // Always sync to cloud here so the pending banner state (_pendingSuggestedDays,
        // _suggestedBanner, _preRecalcSnapshot) survives hard refresh and is accessible
        // from any device via loadUserItineraries().  Without this call the cloud still
        // holds the pre-recalc snapshot and overwrites the in-flight state on next load.
        syncItineraryToCloud(itin, 'save');
        renderDetailViewTimeline();
        _updateBurgerMenuUndoBtn();
        const msgs        = [];
        if (placed > 0) {
            msgs.push(`${placed} activit${placed !== 1 ? 'ies' : 'y'} redistributed into upcoming days.`);
        }
        if (suggestedCount > 0) {
            msgs.push(`${suggestedCount} extra day${suggestedCount !== 1 ? 's' : ''} suggested — tap the banner to extend your trip.`);
        }
        if (totalRemain > 0) {
            msgs.push(`${totalRemain} activit${totalRemain !== 1 ? 'ies' : 'y'} couldn't fit even with suggested days.`);
        }
        if (isPastNoon) {
            msgs.push("Morning-only spots (cafés, museums) deferred — recalculated against remaining hours.");
        }
        if (msgs.length === 0) msgs.push("All activities already optimally placed!");

        showRecalcResultBubble(msgs);
        document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');

    }, 1000);
}

// ── Undo last accepted recalculation ─────────────────────────────────────────
// Uses itin._recalcBaseSnapshot — a single snapshot of the state before the
// first un-undone recalculation was accepted.  This replaces the old
// _recalcHistory stack, which caused the undo button to appear spuriously.
function undoRecalculate() {
    const itin = getActiveItinerary();
    if (!itin || !itin._recalcBaseSnapshot) {
        showRecalcResultBubble(
            ["Nothing to undo — the itinerary is already in its pre-recalculation state."],
            "Nothing to Undo",
            "fa-circle-info"
        );
        return;
    }

    // Restore from the baseline snapshot.
    // _recalcBaseSnapshot is always a plain array (set from _preRecalcSnapshot,
    // which is built via JSON.parse(JSON.stringify(...))), so no parse step needed.
    itin.days = JSON.parse(JSON.stringify(itin._recalcBaseSnapshot));

    // Clamp the day tracker to the restored array length.
    // Without this, if the user was on a day that no longer exists after undo
    // (e.g. Day 2 after a 1-day restore), renderDetailViewTimeline would show
    // "Day 2 of 1" until the user navigated away and back.
    if (activeItineraryDayTracker >= itin.days.length) {
        activeItineraryDayTracker = Math.max(0, itin.days.length - 1);
    }

    // Clear ALL recalc state — the itinerary is now back to a clean baseline
    itin._recalcBaseSnapshot   = null;
    itin._recalcMoveGuidance   = null;
    itin._pendingSuggestedDays = null;
    itin._preRecalcSnapshot    = null;
    itin._suggestedBanner      = { active: false, count: 0 };

    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    renderDetailViewTimeline();
    _updateBurgerMenuUndoBtn();
    showRecalcResultBubble(
        ["Recalculation undone. Previous schedule restored."],
        "Undo Successful",
        "fa-arrow-rotate-left"
    );
}

/**
 * Show the Undo button only when the itinerary is in a confirmed-recalculated
 * state — i.e. _recalcBaseSnapshot is non-null.  The button is hidden as soon
 * as the user undoes, edits (rebuilds), or is in a fresh/pre-recalc state.
 */
function _updateBurgerMenuUndoBtn() {
    const itin = getActiveItinerary();
    const btn  = document.getElementById('itinBurgerUndoBtn');
    if (!btn) return;
    btn.classList.toggle('hidden', !(itin && itin._recalcBaseSnapshot));
}

// ── Feature 3: Skip an activity from the timeline ────────────────────────────
function skipActivityFromTimeline(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    if (!itin?.days?.[dayIndex]?.timeline?.[spotIndex]) return;
    const spot = itin.days[dayIndex].timeline[spotIndex];
    spot.isSkipped = true;
    itin.days[dayIndex].timeline.splice(spotIndex, 1);
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    closeSpotContextMenu();
    renderDetailViewTimeline();
}

// ── Feature 3: Defer an activity to the last real day ────────────────────────
function deferActivityToLastDay(dayIndex, spotIndex) {
    const itin = getActiveItinerary();
    if (!itin?.days?.[dayIndex]?.timeline?.[spotIndex]) return;
    const spot = itin.days[dayIndex].timeline[spotIndex];
    spot.isDeferToLastDay = true;
    // Find the last non-suggested day
    const realDays = itin.days.filter(d => !d?.isSuggested && d?.date).sort((a, b) => a.date > b.date ? 1 : -1);
    const lastDay  = realDays[realDays.length - 1];
    if (!lastDay) { closeSpotContextMenu(); return; }
    // Move to last day at dayEnd (will be re-sorted by next recalc)
    const end       = itin.config?.end ?? parseTimeToMinutes("21:00");
    const newStart  = Math.max(end - (spot.logicDur || 60), parseTimeToMinutes("09:00"));
    itin.days[dayIndex].timeline.splice(spotIndex, 1);
    lastDay.timeline.push({
        ...spot,
        sch_start: newStart,
        sch_end:   newStart + (spot.logicDur || 60),
        isDeferToLastDay: true,
    });
    lastDay.timeline.sort((a, b) => a.sch_start - b.sch_start);
    localStorage.setItem('compass_saved_itineraries', JSON.stringify(savedItineraries));
    closeSpotContextMenu();
    renderDetailViewTimeline();
    if (typeof showFormErrorSpeechBubble === 'function') {
        showFormErrorSpeechBubble([`Deferred to Day ${itin.days.indexOf(lastDay) + 1} — will re-sort on next Recalculate.`]);
    }
}

/** Close the long-press context menu + its backdrop. */
function closeSpotContextMenu() {
    const m = document.getElementById('spotContextMenu');
    const b = document.getElementById('spotContextMenuBackdrop');
    if (m) m.classList.add('hidden');
    if (b) b.classList.add('hidden');
}

// ── Feature 7: Promote suggested extra days directly into the real itinerary ──
// Pulls from itin._pendingSuggestedDays (staged during recalculation — never yet
// in itin.days), promotes each day to a real day, then syncs to Google Sheets.
// No modal or form is opened — the days are created inline on confirmation.
function addSuggestedDaysToTrip() {
    const itin = getActiveItinerary();
    if (!itin) return;

    // Use the pending staging area set during recalculation.
    // Fall back to the legacy isSuggested path for any stale data from older sessions.
    const pendingDays = itin._pendingSuggestedDays
        ?? itin.days.filter(d => d?.isSuggested && d?.date).sort((a, b) => (a.date > b.date ? 1 : -1));

    if (!pendingDays || pendingDays.length === 0) return;

    // Remove any legacy isSuggested entries still in itin.days (safety net)
    itin.days = itin.days.filter(d => !d?.isSuggested);

    // The index where the first promoted day will land
    const firstNewDayIdx = itin.days.length;

    // Promote each pending day to a full real day
    pendingDays.forEach(d => {
        const realDay = { ...d };
        delete realDay.isSuggested;
        delete realDay.suggestedIndex;
        itin.days.push(realDay);
    });

    // ── Undo baseline: lock in the pre-recalc state as the restore point ────
    // Only set when null — sequential recalcs preserve the ORIGINAL baseline so
    // undo always returns the user to their last non-recalculated state.
    if (!itin._recalcBaseSnapshot && itin._preRecalcSnapshot) {
        itin._recalcBaseSnapshot = itin._preRecalcSnapshot;
    }

    // Clear ALL pending / in-flight state — confirmation is final
    itin._pendingSuggestedDays = null;
    itin._preRecalcSnapshot    = null;
    itin._suggestedBanner      = { active: false, count: 0 };
    itin._recalcMoveGuidance   = null;

    // Persist to localStorage AND sync the updated itinerary to Google Sheets
    syncItineraryToCloud(itin, 'save');
    _updateBurgerMenuUndoBtn();

    // Snap to the first newly created day
    activeItineraryDayTracker = firstNewDayIdx;
    renderDetailViewTimeline();

    // Brief confirmation bubble
    if (typeof showFormErrorSpeechBubble === 'function') {
        showFormErrorSpeechBubble([
            `${pendingDays.length} day${pendingDays.length !== 1 ? 's' : ''} added to your trip.`
        ]);
    }
}

function parseTimeToMinutes(timeStr) {
    if (!timeStr || !timeStr.includes(':')) return 0;
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function formatMinutesToTime(mins) {
    let h = Math.floor(mins / 60); let m = mins % 60;
    const period = h >= 12 && h < 24 ? 'PM' : 'AM';
    if (h > 12) h -= 12; if (h === 0) h = 12;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

function minutesToHHMM(mins) {
    let h = Math.floor(mins / 60);
    let m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function detectAnchoredTime(bookingText) {
    if (!bookingText) return null;
    const match = bookingText.match(/\b([0-1]?[0-9]|2[0-3]):[0-5][0-9]\b/);
    return match ? parseTimeToMinutes(match[0]) : null;
}

function getCategoryLogic(catString) {
    if (!catString) return CATEGORY_DEFAULTS['default'];
    const lower = catString.toLowerCase();
    for (let key in CATEGORY_DEFAULTS) { if (lower.includes(key)) return CATEGORY_DEFAULTS[key]; }
    return CATEGORY_DEFAULTS['default'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Recalculate result bubble — rich structured popup anchored to the burger btn
// ─────────────────────────────────────────────────────────────────────────────

let _recalcBubbleTimer = null;

/**
 * Maps a result message string to an icon + colour token for the section row.
 * Keeps the visual meaning consistent regardless of message wording.
 */
function _recalcMsgMeta(msg) {
    const m = msg.toLowerCase();
    if (m.includes('redistributed') || m.includes('optimally'))
        return { icon: 'fa-circle-check',         color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' };
    if (m.includes('suggested') || m.includes('extra day') || m.includes('extend'))
        return { icon: 'fa-calendar-plus',         color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20'   };
    if (m.includes("couldn't fit") || m.includes('failed') || m.includes('corrupted'))
        return { icon: 'fa-triangle-exclamation',  color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/20'     };
    if (m.includes('morning') || m.includes('noon') || m.includes('deferred'))
        return { icon: 'fa-sun',                   color: 'text-sky-400',     bg: 'bg-sky-500/10',     border: 'border-sky-500/20'     };
    if (m.includes('undo') || m.includes('restored') || m.includes('previous'))
        return { icon: 'fa-arrow-rotate-left',     color: 'text-indigo-400',  bg: 'bg-indigo-500/10',  border: 'border-indigo-500/20'  };
    if (m.includes('no pending') || m.includes('no recalculation') || m.includes('no match') || m.includes('no unused'))
        return { icon: 'fa-circle-info',           color: 'text-slate-400',   bg: 'bg-slate-700/30',   border: 'border-slate-600/30'   };
    return   { icon: 'fa-circle-dot',              color: 'text-slate-400',   bg: 'bg-slate-700/30',   border: 'border-slate-600/30'   };
}

/**
 * Show the structured recalculate result bubble anchored to the burger menu button.
 * @param {string[]} msgs      — array of result message strings
 * @param {string}   [titleOverride] — optional custom header title
 * @param {string}   [headerIcon]    — optional FA icon class for the header dot
 */
function showRecalcResultBubble(msgs, titleOverride, headerIcon) {
    const bubble   = document.getElementById('recalcResultBubble');
    const sections = document.getElementById('recalcBubbleSections');
    const titleEl  = document.getElementById('recalcBubbleTitle');
    const iconEl   = document.getElementById('recalcBubbleIcon');
    const anchorEl = document.getElementById('itinBurgerMenuBtn');
    if (!bubble || !sections) return;

    // ── Populate header ───────────────────────────────────────────────────────
    if (titleEl) titleEl.textContent = titleOverride || 'Recalculate Results';
    if (iconEl) {
        iconEl.className = `fa-solid ${headerIcon || 'fa-rotate-right'} text-amber-400 text-[10px]`;
    }

    // ── Populate sections ─────────────────────────────────────────────────────
    sections.innerHTML = '';
    msgs.forEach(msg => {
        const meta = _recalcMsgMeta(msg);
        const row  = document.createElement('div');
        row.className = `flex items-start gap-2.5 p-2.5 rounded-xl border ${meta.bg} ${meta.border}`;
        row.innerHTML = `
            <div class="w-6 h-6 rounded-lg ${meta.bg} border ${meta.border} flex items-center justify-center shrink-0 mt-0.5">
                <i class="fa-solid ${meta.icon} ${meta.color} text-[9px]"></i>
            </div>
            <p class="text-[10px] font-semibold text-slate-300 leading-relaxed">${msg}</p>`;
        sections.appendChild(row);
    });

    // ── Position below the burger menu button ─────────────────────────────────
    if (anchorEl) {
        const rect    = anchorEl.getBoundingClientRect();
        const bubbleW = 288;
        // Right-align bubble to the button's right edge; clamp to viewport
        let   left    = rect.right - bubbleW;
        if (left < 8) left = 8;
        const top     = rect.bottom + 6;  // 6px gap — tail overlaps card border cleanly

        bubble.style.top  = `${top}px`;
        bubble.style.left = `${left}px`;

        // Position the tail so it points at the burger button's horizontal centre.
        // CSS `right` measures from the bubble's right edge inward, so:
        //   tailRight = (bubble right edge) – (button centre X) – (half tail width)
        //             = rect.right           – (rect.left+rect.right)/2 – 7
        //             = (rect.right – rect.left) / 2 – 7  (≈ buttonWidth/2 – 7)
        const tail = document.getElementById('recalcBubbleTail');
        if (tail) {
            const btnCenterX   = (rect.left + rect.right) / 2;
            const bubbleRight  = left + bubbleW;          // = rect.right (right-aligned)
            const tailRight    = Math.max(8, Math.round(bubbleRight - btnCenterX - 7));
            tail.style.right   = `${tailRight}px`;
            tail.style.left    = 'auto';
        }
    }

    // ── Show + auto-dismiss ───────────────────────────────────────────────────
    bubble.classList.remove('hidden');
    const backdrop = document.getElementById('recalcResultBubbleBackdrop');
    if (backdrop) backdrop.classList.remove('hidden');
    clearTimeout(_recalcBubbleTimer);
    _recalcBubbleTimer = setTimeout(() => closeRecalcResultBubble(), 7000);
}

function closeRecalcResultBubble() {
    clearTimeout(_recalcBubbleTimer);
    const bubble   = document.getElementById('recalcResultBubble');
    const backdrop = document.getElementById('recalcResultBubbleBackdrop');
    if (bubble)   bubble.classList.add('hidden');
    if (backdrop) backdrop.classList.add('hidden');
}

function showFormErrorSpeechBubble(missingFieldsArray) {
    const bubble = document.getElementById('globalToastSpeechBubbleHUD');
    const textNode = document.getElementById('speechBubbleTextContainer');
    const btn = document.getElementById('buildItinerarySubmitBtn');
    
    let msg = "<span class='text-pink-400'>Missing Information:</span><br><div class='text-left mt-1 space-y-0.5 ml-2 text-[10px]'>";
    missingFieldsArray.forEach(field => msg += `<div><i class="fa-solid fa-circle-exclamation text-amber-500 mr-1"></i> ${field}</div>`);
    msg += "</div>";
    
    textNode.innerHTML = msg;
    
    const rect = btn.getBoundingClientRect();
    bubble.style.left = "50%";
    bubble.style.transform = "translateX(-50%)";
    bubble.style.bottom = (window.innerHeight - rect.top + 15) + "px";
    bubble.style.top = "auto";
    
    bubble.classList.remove('hidden');
    setTimeout(() => bubble.classList.add('hidden'), 4000);
}

function generateIntelligentItinerary() {
    const title      = document.getElementById('itin-new-name').value.trim();
    const chosenCity = document.getElementById('itin-new-city').value;
    const startMins  = parseTimeToMinutes(document.getElementById('itin-new-start').value || "09:00");
    const endMins    = parseTimeToMinutes(document.getElementById('itin-new-end').value   || "21:00");

    // ── Validate ──────────────────────────────────────────────────────────────
    const missing = [];
    if (!title)                                    missing.push("Itinerary Name");
    if (!chosenCity)                               missing.push("City Selection");
    if (selectedMultiDatesArray.length  === 0)     missing.push("Travel Dates");
    if (itinSelectedCategorySequence.length === 0) missing.push("Category Sequence");
    if (missing.length > 0) { showFormErrorSpeechBubble(missing); return; }

    document.getElementById('buildingItineraryLoaderPopup').classList.remove('hidden');

    setTimeout(() => {
        try {
            // ── Config ────────────────────────────────────────────────────────
            const isMax       = itinPacingMode === 'max';
            const bufferMins  = isMax ? 15 : 40;          // travel + transition gap
            const durationKey = isMax ? 'durationMax' : 'durationRelaxed';

            // ── Build enriched spot pool for this city ────────────────────────
            // Each pool entry is immutable — per-day scheduling reads from it but
            // only usedSpotIds tracks what has already been placed.
            const cityPool = (travelSpots || [])
                .filter(s => s.city === chosenCity)
                .map(s => {
                    const logic        = getCategoryLogic(s.category);
                    const anchoredMins = detectAnchoredTime(s.booking_requirement);
                    return {
                        ...s,
                        isAnchored:   anchoredMins !== null,
                        anchoredTime: anchoredMins,
                        logicDur:     logic[durationKey],
                        logicOpen:    logic.open  * 60,
                        logicClose:   logic.close * 60,
                        _lat:         parseFloat(s.latitude)  || null,
                        _lng:         parseFloat(s.longitude) || null,
                    };
                });

            // ── Inner helpers (defined once, shared across all days) ───────────

            /**
             * Haversine great-circle distance in kilometres between two points.
             * Returns a large sentinel (9999) when either coordinate is missing.
             */
            function _distKm(lat1, lng1, lat2, lng2) {
                if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 9999;
                const R    = 6371;
                const dLat = (lat2 - lat1) * Math.PI / 180;
                const dLng = (lng2 - lng1) * Math.PI / 180;
                const a    = Math.sin(dLat / 2) ** 2
                           + Math.cos(lat1 * Math.PI / 180)
                           * Math.cos(lat2 * Math.PI / 180)
                           * Math.sin(dLng / 2) ** 2;
                return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            }

            /**
             * Returns true when a spot's comma-separated category list contains
             * the sequence target (or vice-versa).  Case-insensitive.
             */
            function _catMatches(spotCategory, target) {
                if (!spotCategory || !target) return false;
                const t  = target.trim().toLowerCase();
                return spotCategory.toLowerCase()
                    .split(',')
                    .some(c => { const cc = c.trim(); return cc.includes(t) || t.includes(cc); });
            }

            /**
             * From the city pool, finds the closest unplaced spot that:
             *   - matches the target category
             *   - is open during the requested slot
             *   - finishes before slotEnd (the window boundary)
             * Returns null when nothing qualifies.
             */
            function _pickClosest(usedIds, targetCat, slotStart, slotEnd, refLat, refLng) {
                let best      = null;
                let bestDist  = Infinity;

                for (const s of cityPool) {
                    if (usedIds.has(s.rowid))                        continue;
                    if (!_catMatches(s.category, targetCat))         continue;
                    if (slotStart < s.logicOpen)                     continue;  // venue not open yet
                    if (slotStart + s.logicDur > s.logicClose)       continue;  // venue closes before we finish
                    if (slotStart + s.logicDur > slotEnd)            continue;  // overruns the window

                    const d = _distKm(refLat, refLng, s._lat, s._lng);
                    if (d < bestDist) { bestDist = d; best = s; }
                }
                return best;
            }

            // ── Build itinerary skeleton ──────────────────────────────────────
            const newItinerary = {
                id:     isEditingMode ? editingItinId : Date.now().toString(),
                title,
                city:   chosenCity,
                user:   (typeof currentUser !== 'undefined') ? currentUser : null,
                days:   [],
                config: {
                    dates:      [...selectedMultiDatesArray],
                    categories: [...itinSelectedCategorySequence],
                    pacing:     itinPacingMode,
                    start:      startMins,
                    end:        endMins,
                },
            };

            const usedSpotIds = new Set();
            const sortedDates = [...selectedMultiDatesArray].sort();

            // ── Per-day scheduling ────────────────────────────────────────────
            sortedDates.forEach(dateStr => {
                const dailyTimeline = [];

                // ── Phase 1: reserve anchored (booked-time) spots ─────────────
                // These become fixed time pillars around which the rest of the day
                // is filled.  Two anchored spots whose windows overlap are both
                // eligible but a conflict check skips the later one if needed.
                const anchoredCandidates = cityPool
                    .filter(s =>
                        s.isAnchored &&
                        !usedSpotIds.has(s.rowid) &&
                        s.anchoredTime >= startMins &&
                        s.anchoredTime + s.logicDur <= endMins &&
                        s.anchoredTime >= s.logicOpen &&
                        s.anchoredTime + s.logicDur <= s.logicClose
                    )
                    .sort((a, b) => a.anchoredTime - b.anchoredTime);

                // Insert anchored spots, skipping any that overlap a prior one
                let lastAnchorEnd = -1;
                for (const s of anchoredCandidates) {
                    if (s.anchoredTime < lastAnchorEnd) continue;  // overlap — skip
                    dailyTimeline.push({
                        ...s,
                        sch_start:  s.anchoredTime,
                        sch_end:    s.anchoredTime + s.logicDur,
                        isDone:     false,
                        isAnchored: true,
                    });
                    usedSpotIds.add(s.rowid);
                    lastAnchorEnd = s.anchoredTime + s.logicDur;
                }

                // ── Phase 2: derive free-time segments around the anchors ──────
                // Segments are [segStart, segEnd) windows where non-anchored spots
                // can be placed.  Each edge of an anchor gets a bufferMins gap so
                // the traveller has time to get there and settle in.
                const segments = [];
                let   cursor   = startMins;

                for (const entry of dailyTimeline) {  // already sorted by sch_start
                    const gapEnd = entry.sch_start - bufferMins;
                    if (gapEnd > cursor + 30) {        // only worth filling if >30 min free
                        segments.push([cursor, gapEnd]);
                    }
                    cursor = entry.sch_end + bufferMins;
                }
                if (cursor < endMins - 30) {
                    segments.push([cursor, endMins]);
                }

                // ── Phase 3: fill each free segment with sequence-guided spots ─
                // seqIdx resets per day so every day starts fresh from the top of
                // the category sequence (e.g., always breakfast → attraction →
                // lunch → … regardless of what happened on previous days).
                let seqIdx  = 0;
                let refLat  = null;
                let refLng  = null;

                // Seed proximity reference from the first anchored spot, if any
                if (dailyTimeline.length > 0) {
                    refLat = dailyTimeline[0]._lat;
                    refLng = dailyTimeline[0]._lng;
                }

                for (const [segStart, segEnd] of segments) {
                    let t = segStart;

                    // Allow one full rotation through the sequence before giving up
                    // on this segment — prevents an exhausted category from
                    // blocking the entire remainder of the day.
                    let consecutiveSkips = 0;
                    const maxSkips       = itinSelectedCategorySequence.length;

                    while (t + 30 <= segEnd && consecutiveSkips < maxSkips) {
                        const targetCat = itinSelectedCategorySequence[seqIdx % itinSelectedCategorySequence.length];
                        const pick      = _pickClosest(usedSpotIds, targetCat, t, segEnd, refLat, refLng);

                        if (pick) {
                            dailyTimeline.push({
                                ...pick,
                                sch_start:  t,
                                sch_end:    t + pick.logicDur,
                                isDone:     false,
                                isAnchored: false,
                            });
                            usedSpotIds.add(pick.rowid);
                            t           += pick.logicDur + bufferMins;
                            refLat       = pick._lat;
                            refLng       = pick._lng;
                            seqIdx++;
                            consecutiveSkips = 0;      // success — reset skip counter
                        } else {
                            // No spot available for this category right now —
                            // advance the sequence rather than burning the whole
                            // loop retrying an exhausted / closed category.
                            seqIdx++;
                            consecutiveSkips++;
                        }
                    }
                }

                // Final sort: anchored + free slots ordered by start time
                dailyTimeline.sort((a, b) => a.sch_start - b.sch_start);
                newItinerary.days.push({ date: dateStr, timeline: dailyTimeline });
            });

            // ── Phase 4: day-balance top-up pass ─────────────────────────────
            // After primary scheduling, days that ended up significantly lighter
            // than average (e.g. because early days consumed most of the pool)
            // get a second-chance fill using any remaining unplaced spots.
            const totalPlaced = newItinerary.days.reduce((s, d) => s + d.timeline.length, 0);
            const avgPerDay   = totalPlaced / Math.max(1, newItinerary.days.length);

            newItinerary.days.forEach(day => {
                // Only top-up days below 60 % of average (and only if avg > 1)
                if (avgPerDay <= 1 || day.timeline.length >= Math.ceil(avgPerDay * 0.6)) return;

                let t      = day.timeline.length > 0
                               ? day.timeline[day.timeline.length - 1].sch_end + bufferMins
                               : startMins;
                let refLat = day.timeline.length > 0 ? day.timeline[day.timeline.length - 1]._lat : null;
                let refLng = day.timeline.length > 0 ? day.timeline[day.timeline.length - 1]._lng : null;

                for (const cat of itinSelectedCategorySequence) {
                    if (t + 30 > endMins) break;
                    const pick = _pickClosest(usedSpotIds, cat, t, endMins, refLat, refLng);
                    if (pick) {
                        day.timeline.push({
                            ...pick,
                            sch_start:  t,
                            sch_end:    t + pick.logicDur,
                            isDone:     false,
                            isAnchored: false,
                        });
                        usedSpotIds.add(pick.rowid);
                        t     += pick.logicDur + bufferMins;
                        refLat = pick._lat;
                        refLng = pick._lng;
                    }
                }
                day.timeline.sort((a, b) => a.sch_start - b.sch_start);
            });

            // ── Guard: nothing was scheduled ─────────────────────────────────
            if (newItinerary.days.every(d => d.timeline.length === 0)) {
                document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
                if (typeof showFormErrorSpeechBubble === 'function') {
                    showFormErrorSpeechBubble([`No matching spots found in ${newItinerary.city} for the selected categories.`]);
                }
                return;
            }

            // ── Persist locally + fire cloud sync ─────────────────────────────
            if (isEditingMode) {
                const idx = savedItineraries.findIndex(i => i.id === editingItinId);
                if (idx > -1) savedItineraries[idx] = newItinerary;
                else          savedItineraries.push(newItinerary);
            } else {
                savedItineraries.push(newItinerary);
            }
            // syncItineraryToCloud updates localStorage as its first step, then
            // fires a no-cors POST to the ItineraryVault sheet (fire-and-forget).
            syncItineraryToCloud(newItinerary, 'save');

            // ── Reset transient form state ────────────────────────────────────
            // Capture before clearing so the post-reset navigation branch is correct
            const _wasEditing  = isEditingMode;
            const _rebuiltId   = newItinerary.id;
            const _totalSpots  = newItinerary.days.reduce((sum, d) => sum + d.timeline.length, 0);
            const _dayCount    = newItinerary.days.length;
            const _builtTitle  = newItinerary.title;

            isEditingMode                = false;
            editingItinId                = null;
            _itinEditSnapshot            = null;
            selectedMultiDatesArray      = [];
            itinSelectedCategorySequence = [];

            document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
            toggleItineraryCreationDrawerForm(false);

            // After a rebuild navigate straight into the updated expanded timeline;
            // after a fresh build fall back to the master list as before.
            if (_wasEditing) {
                openItineraryDetailView(_rebuiltId);
            } else {
                renderItineraryMasterDashboardWorkspace();
            }

            if (typeof showFormErrorSpeechBubble === 'function') {
                showFormErrorSpeechBubble([
                    _wasEditing
                        ? `"${_builtTitle}" rebuilt — ${_dayCount} day${_dayCount !== 1 ? 's' : ''}, ${_totalSpots} spot${_totalSpots !== 1 ? 's' : ''}!`
                        : `"${_builtTitle}" created — ${_dayCount} day${_dayCount !== 1 ? 's' : ''}, ${_totalSpots} spot${_totalSpots !== 1 ? 's' : ''}!`
                ]);
            }

        } catch (err) {
            // Safety net: never leave the loading overlay stuck on screen
            console.error('[ItineraryEngine] generation failed:', err);
            document.getElementById('buildingItineraryLoaderPopup').classList.add('hidden');
            if (typeof showFormErrorSpeechBubble === 'function') {
                showFormErrorSpeechBubble(['Something went wrong while building the itinerary. Please try again.']);
            }
        }
    }, 800);
}