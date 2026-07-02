'use strict';

// -- State ------------------------------------------------------------------
let viewer    = null;
const gridEl  = document.getElementById('pano-grid');
let debTimer  = null;
let imageUrl  = null;
let imageName = null;
let imageW    = 0;
let imageH    = 0;
let map       = null;
let marker    = null;
let gpsLat    = null;
let gpsLon    = null;
let photoDate = null;   // 'YYYY:MM:DD HH:MM:SS' or null
let tzOffset  = null;   // '+HH:MM' / '-HH:MM' or null
let currentFile = null; // File reference for "Detect from image"
let baseRoll  = 0;      // accumulated horizonRoll before current Straighten session
let basePitch = 0;      // accumulated horizonPitch before current Straighten session

const p = {
	poseHeading:    0,   // set by Set North + EXIF
	initialHeading: 0,   // set by Use Current View + EXIF
	initialPitch:   0,   // set by Use Current View + EXIF
	horizonPitch:   0,   // derived from Straighten + heading
	horizonRoll:    0,   // derived from Straighten + heading
	initialFov:     100, // FOV slider
};

const loadedVals = {
	poseHeading:    0,
	initialHeading: 0,
	initialPitch:   0,
	horizonPitch:   0,
	horizonRoll:    0,
	initialFov:     100,
};

// -- Control definitions (slider-bound controls only) -----------------------
const CONTROLS = [
	{ id: 'initial-fov', key: 'initialFov', min: 30, max: 150, def: 100 },
];

function clamp(v, mn, mx) { return Math.min(mx, Math.max(mn, v)); }
function r1(v)             { return Math.round(v * 10) / 10; }

// -- Slider ↔ number input binding -----------------------------------------
function bindControls() {
	CONTROLS.forEach(({ id, key, min, max }) => {
		const num    = document.getElementById(id);
		const slider = document.getElementById(id + '-slider');

		function update(raw) {
			const v  = r1(clamp(parseFloat(raw) || 0, min, max));
			p[key]       = v;
			num.value    = v;
			slider.value = v;
			generateCommand();
			if (!imageUrl) return;
			if (viewer) {
				applyLiveUpdate(key);
			} else {
				clearTimeout(debTimer);
				debTimer = setTimeout(buildViewer, 250);
			}
		}

		num.addEventListener('input',  () => update(num.value));
		num.addEventListener('change', () => update(num.value));
		slider.addEventListener('input', () => update(slider.value));

		function resetToLoaded() { update(loadedVals[key]); }
		slider.addEventListener('dblclick', resetToLoaded);
		num.addEventListener('dblclick',    resetToLoaded);
	});
}

function setControl(id, val) {
	const ctrl = CONTROLS.find(c => c.id === id);
	if (!ctrl) return;
	const v = r1(clamp(parseFloat(val) || 0, ctrl.min, ctrl.max));
	p[ctrl.key] = v;
	document.getElementById(id).value             = v;
	document.getElementById(id + '-slider').value = v;
}

function resetControls() {
	CONTROLS.forEach(({ id, key, def }) => { setControl(id, def); loadedVals[key] = def; });
	p.poseHeading    = 0;
	p.initialHeading = 0;
	p.initialPitch   = 0;
	p.horizonPitch   = 0;
	p.horizonRoll    = 0;
	baseRoll         = 0;
	basePitch        = 0;
	document.getElementById('heading-slider').value    = 0;
	document.getElementById('heading-num').value       = 0;
	document.getElementById('straighten-slider').value = 0;
	document.getElementById('straighten').value        = 0;
	photoDate = null;
	tzOffset  = null;
	document.getElementById('datetime-input').value = '';
	document.getElementById('tz-input').value        = '';
}

// -- Heading navigation control (viewer-only, not stored as metadata) -------
function setHeading(compassBearing) {
	const v = r1(PanoRotation.normalize360(parseFloat(compassBearing) || 0));
	document.getElementById('heading-slider').value = v;
	document.getElementById('heading-num').value    = v;
	// Freeze accumulated correction and reset Straighten slider
	baseRoll  = p.horizonRoll;
	basePitch = p.horizonPitch;
	document.getElementById('straighten-slider').value = 0;
	document.getElementById('straighten').value        = 0;
	if (!viewer) return;
	let yaw = ((v - p.poseHeading) % 360 + 360) % 360;
	if (yaw > 180) yaw -= 360;
	viewer.setYaw(yaw, false);
}

(function bindHeading() {
	const slider = document.getElementById('heading-slider');
	const num    = document.getElementById('heading-num');
	slider.addEventListener('input',  () => setHeading(slider.value));
	num.addEventListener('input',     () => setHeading(num.value));
	num.addEventListener('change',    () => setHeading(num.value));
	function resetToCenter() { setHeading(p.poseHeading); }
	slider.addEventListener('dblclick', resetToCenter);
	num.addEventListener('dblclick',    resetToCenter);
}());

// -- Straighten control (direction-relative: decomposes into roll + pitch) --
(function bindStraighten() {
	const slider = document.getElementById('straighten-slider');
	const num    = document.getElementById('straighten');

	function update(raw) {
		const s = r1(clamp(parseFloat(raw) || 0, -30, 30));
		slider.value = s;
		num.value    = s;
		const headingVal = parseFloat(document.getElementById('heading-slider').value) || 0;
		const imageYaw   = ((headingVal - p.poseHeading) % 360 + 360) % 360;
		const θ = imageYaw * Math.PI / 180;
		p.horizonRoll  = r1(baseRoll  + s * Math.cos(θ));
		p.horizonPitch = r1(basePitch + s * Math.sin(θ));
		if (viewer) {
			viewer.setHorizonRoll(p.horizonRoll);
			viewer.setHorizonPitch(p.horizonPitch);
		}
		generateCommand();
	}

	function resetStraighten() {
		p.horizonRoll  = baseRoll;
		p.horizonPitch = basePitch;
		slider.value   = 0;
		num.value      = 0;
		if (viewer) {
			viewer.setHorizonRoll(p.horizonRoll);
			viewer.setHorizonPitch(p.horizonPitch);
		}
		generateCommand();
	}

	slider.addEventListener('input', () => update(slider.value));
	num.addEventListener('input',    () => update(num.value));
	num.addEventListener('change',   () => update(num.value));
	slider.addEventListener('dblclick', resetStraighten);
	num.addEventListener('dblclick',    resetStraighten);
}());

// -- Pannellum --------------------------------------------------------------
function buildViewer() {
	if (viewer) { viewer.destroy(); viewer = null; }

	const northOffset = p.poseHeading;
	const pose  = { heading: p.poseHeading, pitch: p.horizonPitch, roll: p.horizonRoll };
	const local = PanoRotation.worldToLocal(pose, { heading: p.initialHeading, pitch: p.initialPitch });
	const yaw   = local.heading > 180 ? local.heading - 360 : local.heading;

	viewer = pannellum.viewer('pannellum-container', {
		type:         'equirectangular',
		panorama:     imageUrl,
		autoLoad:     true,
		compass:      true,
		northOffset:  northOffset,
		pitch:        local.pitch,
		yaw:          yaw,
		hfov:         p.initialFov,
		horizonPitch: p.horizonPitch,
		horizonRoll:  p.horizonRoll,
		showControls: true,
	});
	document.getElementById('pannellum-container').appendChild(gridEl);
}

function applyLiveUpdate(changedKey) {
	if (!viewer || changedKey !== 'initialFov') return;
	viewer.setHfov(p.initialFov, false);
}

// -- Action buttons ---------------------------------------------------------
document.getElementById('use-current-view').addEventListener('click', () => {
	if (!viewer) return;
	const local = { heading: PanoRotation.normalize360(viewer.getYaw()), pitch: viewer.getPitch() };
	const pose  = { heading: p.poseHeading, pitch: p.horizonPitch, roll: p.horizonRoll };
	const world = PanoRotation.localToWorld(pose, local);
	p.initialHeading = r1(world.heading);
	p.initialPitch   = r1(clamp(world.pitch, -90, 90));
	generateCommand();
});

document.getElementById('set-north').addEventListener('click', () => {
	if (!viewer) return;
	const yaw     = viewer.getYaw();
	p.poseHeading = ((-yaw % 360) + 360) % 360;
	viewer.setNorthOffset(p.poseHeading);
	baseRoll  = p.horizonRoll;
	basePitch = p.horizonPitch;
	document.getElementById('straighten-slider').value = 0;
	document.getElementById('straighten').value        = 0;
	document.getElementById('heading-slider').value    = 0;
	document.getElementById('heading-num').value       = 0;
	generateCommand();
});

// -- Date & time helpers ----------------------------------------------------
function systemTzOffset() {
	const off  = -new Date().getTimezoneOffset();
	const sign = off >= 0 ? '+' : '-';
	const hh   = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
	const mm   = String(Math.abs(off) % 60).padStart(2, '0');
	return sign + hh + ':' + mm;
}

function isValidOffset(s) {
	return /^[+-]\d{2}:\d{2}$/.test(s);
}

function toDatetimeLocal(val) {
	if (!val) return '';
	let d;
	if (val instanceof Date) {
		d = val;
	} else {
		const m = String(val).match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
		if (!m) return '';
		d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	}
	if (isNaN(d.getTime())) return '';
	const pad = n => String(n).padStart(2, '0');
	return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
	       'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function fromDatetimeLocal(val) {
	if (!val) return null;
	const m = val.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
	if (!m) return null;
	const ss = m[6] || '00';
	return m[1] + ':' + m[2] + ':' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + ss;
}

function extractDateFromFilename(filename) {
	const m = filename.match(/(\d{8})_(\d{6})/);
	if (!m) return null;
	const d = m[1], t = m[2];
	return d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8) +
	       'T' + t.slice(0,2) + ':' + t.slice(2,4) + ':' + t.slice(4,6);
}

function detectDateTime(file, data) {
	let dtLocal = extractDateFromFilename(file.name);

	if (!dtLocal) {
		if (data && data.DateTimeOriginal) {
			dtLocal = toDatetimeLocal(data.DateTimeOriginal);
		} else if (data && data.CreateDate) {
			dtLocal = toDatetimeLocal(data.CreateDate);
		} else if (data && data.ModifyDate) {
			dtLocal = toDatetimeLocal(data.ModifyDate);
		}
	}

	if (!dtLocal) return;

	document.getElementById('datetime-input').value = dtLocal;
	photoDate = fromDatetimeLocal(dtLocal);
	tzOffset  = systemTzOffset();
	document.getElementById('tz-input').value = tzOffset;
}

// -- EXIF reading -----------------------------------------------------------
async function readExif(file) {
	try {
		const data = await exifr.parse(file, { xmp: true, gps: true, exif: true, tiff: true });
		if (!data) return;
		if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
			setGPS(data.latitude, data.longitude);
			map.setView([data.latitude, data.longitude], 14);
		}
		// Slider-bound fields
		if (typeof data.InitialHorizontalFOVDegrees === 'number') setControl('initial-fov', data.InitialHorizontalFOVDegrees);
		// Non-slider fields — assign directly to p
		if (typeof data.PoseHeadingDegrees        === 'number') p.poseHeading    = r1(PanoRotation.normalize360(data.PoseHeadingDegrees));
		if (typeof data.PosePitchDegrees          === 'number') p.horizonPitch   = r1(clamp(data.PosePitchDegrees,        -90,   90));
		if (typeof data.PoseRollDegrees           === 'number') p.horizonRoll    = r1(clamp(data.PoseRollDegrees,         -180,  180));
		if (typeof data.InitialViewHeadingDegrees === 'number') p.initialHeading = r1(PanoRotation.normalize360(data.InitialViewHeadingDegrees));
		if (typeof data.InitialViewPitchDegrees   === 'number') p.initialPitch   = r1(clamp(data.InitialViewPitchDegrees,  -90,   90));
		detectDateTime(file, data);

	} catch (_) { /* no/invalid EXIF is fine */ }
}

// -- Image loading & validation ---------------------------------------------
function processFile(file) {
	if (!file.type.startsWith('image/')) { showError('File is not an image.'); return; }
	currentFile = file;

	const url = URL.createObjectURL(file);
	const img = new Image();

	img.onload = async () => {
		const ratio = img.naturalWidth / img.naturalHeight;
		if (ratio < 1.99 || ratio > 2.01) {
			URL.revokeObjectURL(url);
			showError(
				'Invalid aspect ratio: ' + ratio.toFixed(3) + ':1 (expected 2:1). ' +
				'Detected size: ' + img.naturalWidth + '×' + img.naturalHeight + 'px.'
			);
			return;
		}
		hideError();
		if (imageUrl) URL.revokeObjectURL(imageUrl);
		imageUrl  = url;
		imageName = file.name;
		imageW    = img.naturalWidth;
		imageH    = img.naturalHeight;

		document.getElementById('file-info').innerHTML =
			'<strong>' + esc(file.name) + '</strong>&nbsp;&nbsp;' + imageW + '×' + imageH + 'px';

		resetControls();
		showMain();
		await readExif(file);
		Object.assign(loadedVals, p);
		baseRoll  = p.horizonRoll;
		basePitch = p.horizonPitch;
		buildViewer();
		generateCommand();
	};

	img.onerror = () => { URL.revokeObjectURL(url); showError('Could not read image file.'); };
	img.src = url;
}

function showError(msg) {
	const el = document.getElementById('upload-error');
	el.textContent = msg;
	el.classList.remove('hidden');
}
function hideError() { document.getElementById('upload-error').classList.add('hidden'); }

function showMain() {
	document.getElementById('upload-zone').classList.add('hidden');
	document.getElementById('main-layout').classList.remove('hidden');
	if (!map) initMap();
}

function resetAll() {
	clearTimeout(debTimer);
	if (viewer)   { viewer.destroy(); viewer = null; }
	if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
	imageName = null; imageW = 0; imageH = 0;
	gpsLat = null; gpsLon = null;
	if (marker) { marker.remove(); marker = null; }

	resetControls();
	document.getElementById('lat-input').value            = '';
	document.getElementById('lon-input').value            = '';
	document.getElementById('location-search').value      = '';
	document.getElementById('command-output').textContent = '';
	document.getElementById('file-input').value           = '';

	document.getElementById('main-layout').classList.add('hidden');
	document.getElementById('upload-zone').classList.remove('hidden');
	hideError();
}

// -- Drag-and-drop & file browse --------------------------------------------
const dropArea = document.getElementById('drop-area');

dropArea.addEventListener('click',     () => document.getElementById('file-input').click());
dropArea.addEventListener('dragover',  e  => { e.preventDefault(); dropArea.classList.add('drag-over'); });
dropArea.addEventListener('dragleave', ()  => dropArea.classList.remove('drag-over'));
dropArea.addEventListener('drop',      e  => {
	e.preventDefault();
	dropArea.classList.remove('drag-over');
	const f = e.dataTransfer.files[0];
	if (f) processFile(f);
});

document.getElementById('browse-btn').addEventListener('click', e => {
	e.stopPropagation();
	document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', e => {
	if (e.target.files[0]) processFile(e.target.files[0]);
});
document.getElementById('reset-btn').addEventListener('click', resetAll);

// -- Leaflet map ------------------------------------------------------------
function initMap() {
	map = L.map('map').setView([20, 0], 2);

	L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
		attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' +
								 ' contributors © <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
		subdomains: 'abcd',
		maxZoom: 19,
	}).addTo(map);

	map.on('click', e => { setGPS(e.latlng.lat, e.latlng.lng); map.panTo(e.latlng); });

	if (navigator.geolocation) {
		navigator.geolocation.getCurrentPosition(
			pos => map.setView([pos.coords.latitude, pos.coords.longitude], 10),
			() => {}
		);
	}
}

function setGPS(lat, lon) {
	gpsLat = parseFloat(parseFloat(lat).toFixed(6));
	gpsLon = parseFloat(parseFloat(lon).toFixed(6));
	document.getElementById('lat-input').value = gpsLat;
	document.getElementById('lon-input').value = gpsLon;

	if (marker) {
		marker.setLatLng([gpsLat, gpsLon]);
	} else {
		marker = L.marker([gpsLat, gpsLon], { draggable: true }).addTo(map);
		marker.on('dragend', () => {
			const ll = marker.getLatLng();
			gpsLat = parseFloat(ll.lat.toFixed(6));
			gpsLon = parseFloat(ll.lng.toFixed(6));
			document.getElementById('lat-input').value = gpsLat;
			document.getElementById('lon-input').value = gpsLon;
			generateCommand();
		});
	}
	generateCommand();
}

document.getElementById('lat-input').addEventListener('change', () => {
	const lat = parseFloat(document.getElementById('lat-input').value);
	if (!isNaN(lat)) setGPS(lat, gpsLon !== null ? gpsLon : 0);
});
document.getElementById('lon-input').addEventListener('change', () => {
	const lon = parseFloat(document.getElementById('lon-input').value);
	if (!isNaN(lon)) setGPS(gpsLat !== null ? gpsLat : 0, lon);
});
document.getElementById('clear-gps-btn').addEventListener('click', () => {
	gpsLat = gpsLon = null;
	document.getElementById('lat-input').value        = '';
	document.getElementById('lon-input').value        = '';
	document.getElementById('location-search').value  = '';
	if (marker) { marker.remove(); marker = null; }
	generateCommand();
});

// -- Date & time controls ---------------------------------------------------
document.getElementById('detect-date-btn').addEventListener('click', async () => {
	if (!currentFile) return;
	try {
		const data = await exifr.parse(currentFile, { exif: true, tiff: true });
		detectDateTime(currentFile, data || {});
		generateCommand();
	} catch (_) {
		detectDateTime(currentFile, {});
		generateCommand();
	}
});

document.getElementById('datetime-input').addEventListener('input', () => {
	photoDate = fromDatetimeLocal(document.getElementById('datetime-input').value);
	generateCommand();
});

document.getElementById('tz-input').addEventListener('input', () => {
	const val = document.getElementById('tz-input').value.trim();
	tzOffset = isValidOffset(val) ? val : null;
	generateCommand();
});

document.getElementById('clear-date-btn').addEventListener('click', () => {
	photoDate = null;
	tzOffset  = null;
	document.getElementById('datetime-input').value = '';
	document.getElementById('tz-input').value        = '';
	generateCommand();
});

// -- DMS parser -------------------------------------------------------------
function parseDMS(str) {
	str = str.trim();

	const dec = str.match(/^(-?[\d.]+)[,\s]+(-?[\d.]+)$/);
	if (dec) {
		const lat = parseFloat(dec[1]), lon = parseFloat(dec[2]);
		if (!isNaN(lat) && !isNaN(lon)) return { lat, lon };
	}

	const dms = str.match(
		/(\d+)[°\s]\s*(\d+)[''\s]\s*([\d.]+)["″\s]*([NS])[,;\s]+(\d+)[°\s]\s*(\d+)[''\s]\s*([\d.]+)["″\s]*([EW])/i
	);
	if (dms) {
		let lat = +dms[1] + +dms[2] / 60 + +dms[3] / 3600;
		let lon = +dms[5] + +dms[6] / 60 + +dms[7] / 3600;
		if (/s/i.test(dms[4])) lat = -lat;
		if (/w/i.test(dms[8])) lon = -lon;
		return { lat, lon };
	}
	return null;
}

function searchLocation() {
	const str = document.getElementById('location-search').value;
	const r   = parseDMS(str);
	if (r) {
		setGPS(r.lat, r.lon);
		map.setView([r.lat, r.lon], 14);
	} else {
		alert(
			'Could not parse coordinates.\n\nAccepted formats:\n' +
			'  37.7749, -122.4194\n' +
			'  14°33‧44.7″N 90°31‧20.9″W'
		);
	}
}

document.getElementById('search-btn').addEventListener('click', searchLocation);
document.getElementById('location-search').addEventListener('keydown', e => {
	if (e.key === 'Enter') searchLocation();
});

// -- Exiftool command generation --------------------------------------------
function ddToDms(decimal) {
	const abs = Math.abs(decimal);
	const d   = Math.floor(abs);
	const mf  = (abs - d) * 60;
	const m   = Math.floor(mf);
	const s   = (mf - m) * 60;
	return d + ' ' + m + ' ' + s.toFixed(4);
}

function generateCommand() {
	if (!imageName) return;

	const lines = [
		'exiftool \\',
		'  -XMP-GPano:ProjectionType="equirectangular" \\',
		'  -XMP-GPano:UsePanoramaViewer=True \\',
		'  -XMP-GPano:FullPanoWidthPixels='              + imageW + ' \\',
		'  -XMP-GPano:FullPanoHeightPixels='             + imageH + ' \\',
		'  -XMP-GPano:CroppedAreaImageWidthPixels='      + imageW + ' \\',
		'  -XMP-GPano:CroppedAreaImageHeightPixels='     + imageH + ' \\',
		'  -XMP-GPano:CroppedAreaLeftPixels=0 \\',
		'  -XMP-GPano:CroppedAreaTopPixels=0 \\',
		'  -XMP-GPano:PoseHeadingDegrees='               + p.poseHeading    + ' \\',
		'  -XMP-GPano:PosePitchDegrees='                 + p.horizonPitch   + ' \\',
		'  -XMP-GPano:PoseRollDegrees='                  + p.horizonRoll    + ' \\',
		'  -XMP-GPano:InitialViewHeadingDegrees='        + p.initialHeading + ' \\',
		'  -XMP-GPano:InitialViewPitchDegrees='          + p.initialPitch   + ' \\',
		'  -XMP-GPano:InitialHorizontalFOVDegrees='      + p.initialFov     + ' \\',
	];

	if (gpsLat !== null && gpsLon !== null) {
		const latDms = ddToDms(gpsLat);
		const lonDms = ddToDms(gpsLon);
		const latRef = gpsLat >= 0 ? 'North' : 'South';
		const lonRef = gpsLon >= 0 ? 'East'  : 'West';
		lines.push('  -GPSLatitude="'  + latDms + '" -GPSLatitudeRef='  + latRef + ' \\');
		lines.push('  -GPSLongitude="' + lonDms + '" -GPSLongitudeRef=' + lonRef + ' \\');
	}

	if (photoDate && tzOffset) {
		const parts     = photoDate.split(' ');
		const date_part = parts[0];
		const time_part = parts[1];
		const dt_plain  = photoDate;
		const dt_offset = dt_plain  + tzOffset;
		const time_off  = time_part + tzOffset;
		const dt_subsec = dt_plain  + '.00' + tzOffset;
		lines.push('  -DateTimeOriginal="'          + dt_plain  + '" \\');
		lines.push('  -CreateDate="'                + dt_plain  + '" \\');
		lines.push('  -FileModifyDate="'            + dt_offset + '" \\');
		lines.push('  -ModifyDate="'                + dt_plain  + '" \\');
		lines.push('  -OffsetTime="'                + tzOffset  + '" \\');
		lines.push('  -OffsetTimeOriginal="'         + tzOffset  + '" \\');
		lines.push('  -OffsetTimeDigitized="'        + tzOffset  + '" \\');
		lines.push('  -IPTC:DigitalCreationDate="'  + date_part + '" \\');
		lines.push('  -IPTC:TimeCreated="'           + time_off  + '" \\');
		lines.push('  -IPTC:DigitalCreationTime="'   + time_off  + '" \\');
		lines.push('  -XMP:DateCreated="'            + dt_subsec + '" \\');
	}

	lines.push('  -overwrite_original \\');
	lines.push('  "' + imageName + '"');

	document.getElementById('command-output').textContent = lines.join('\n');
}

// -- Copy command -----------------------------------------------------------
document.getElementById('copy-cmd').addEventListener('click', () => {
	const text = document.getElementById('command-output').textContent;
	if (!text) return;

	const show = () => {
		const el = document.getElementById('copy-status');
		el.classList.add('visible');
		setTimeout(() => el.classList.remove('visible'), 2000);
	};

	if (navigator.clipboard) {
		navigator.clipboard.writeText(text).then(show);
	} else {
		const ta = document.createElement('textarea');
		ta.value = text;
		Object.assign(ta.style, { position: 'fixed', opacity: '0' });
		document.body.appendChild(ta);
		ta.select();
		document.execCommand('copy');
		document.body.removeChild(ta);
		show();
	}
});

// -- Viewer overlay toggles -------------------------------------------------
document.getElementById('toggle-grid').addEventListener('click', function () {
	const active = document.getElementById('pano-grid').classList.toggle('active');
	this.classList.toggle('active', active);
});

// -- Utility ----------------------------------------------------------------
function esc(s) {
	return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// -- Boot -------------------------------------------------------------------
bindControls();
