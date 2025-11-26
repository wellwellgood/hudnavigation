// === 글로벌 상태 ===
let northUp = true;          // 북쪽 고정 여부
let lastFix = null;          // 최근 GPS [lng, lat]
let userInteracting = false; // 손으로 지도 조작 중인지
let _idleT = null;
let followGps = true;        // GPS 따라 자동 이동 여부

// 경로 / 길안내 상태
let routeLineCoords = [];    // 경로 polyline 좌표들 [ [lng,lat], ... ]
let routeSteps = [];         // 안내 포인트 [{ lng, lat, turnType, description }]
let totalDistanceM = 0;      // 전체 거리(m)
let totalTimeSec = 0;        // 전체 시간(sec)
let destCoord = null;        // 목적지 [lng, lat]
let guidanceActive = false;  // 길 안내 ON/OFF

// HUD 엘리먼트
const spdEl = document.getElementById("spd");
const brgEl = document.getElementById("brg");
let navChip = null;          // 다음 턴 안내
let distChip = null;         // 남은 거리
let etaChip = null;          // 남은 시간

// 모의주행 상태
let routeCumDist = [];       // 각 polyline 포인트까지 누적 거리 (m)
let simActive = false;
let simFrame = null;
let simDist = 0;             // 현재까지 앞당긴 거리 (m)
let simSpeedMps = 13.9;      // 기본 속도 (약 50km/h)
let simSpeedMultiplier = 1;  // 1x / 2x / 4x
let simLastTs = 0;

// === 유틸 ===
function clampBearing(deg) {
    return ((deg % 360) + 360) % 360;
}
function toKmH(ms) {
    return Math.round((ms || 0) * 3.6);
}
function toRad(deg) {
    return (deg * Math.PI) / 180;
}
// 하버사인 거리(m)
function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
// 초 → "h시간 m분 s초"
function formatTime(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    if (h > 0) return `${h}시간 ${m}분 ${s}초`;
    if (m > 0) return `${m}분 ${s}초`;
    return `${s}초`;
}
// turnType → 텍스트
function turnTypeToText(turnType) {
    const t = Number(turnType);
    switch (t) {
        case 11:
        case 51:
            return "직진";
        case 12:
        case 16:
        case 17:
            return "좌회전";
        case 13:
        case 18:
        case 19:
            return "우회전";
        case 14:
            return "U턴";
        case 71:
            return "첫 번째 출구";
        case 72:
            return "두 번째 출구";
        case 73:
            return "첫 번째 오른쪽 길";
        case 200:
            return "출발지";
        case 201:
            return "목적지";
        default:
            return "직진";
    }
}

// === 지도 생성 ===
const MAP_STYLE = "https://api.maptiler.com/maps/streets-v2/style.json?key=2HioygjPVFKopzhBEhM3";

const map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [126.506498, 37.479726],
    zoom: 16,
    bearing: -20,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

// === HUD chip들 동적 생성 (기존 spd/brg 옆) ===
(function setupHudChips() {
    const hud = document.querySelector(".hud");
    if (!hud) return;

    navChip = document.createElement("div");
    navChip.className = "chip";
    navChip.id = "nav";
    navChip.textContent = "경로 없음";
    hud.appendChild(navChip);

    distChip = document.createElement("div");
    distChip.className = "chip";
    distChip.id = "dist";
    distChip.textContent = "남은 거리 없음";
    hud.appendChild(distChip);

    etaChip = document.createElement("div");
    etaChip.className = "chip";
    etaChip.id = "eta";
    etaChip.textContent = "남은 시간 없음";
    hud.appendChild(etaChip);
})();

// === 버튼 패널 (현위치 / 북쪽고정 / 경로안내 / 모의주행 / 배속) ===
const ctl = document.createElement("div");
ctl.style.cssText = `
  position:absolute; right:12px; bottom:12px; z-index:10;
  display:flex; gap:8px; pointer-events:auto;
`;
const mkBtn = (t) => {
    const b = document.createElement("button");
    b.textContent = t;
    b.style.cssText = `
    padding:8px 10px; border:1px solid #2dd4bf; border-radius:8px;
    background:rgba(0,0,0,.6); color:#0ff; font:600 13px ui-monospace;
  `;
    return b;
};
const btnLocate = mkBtn("📍 현위치");
const btnNorth = mkBtn("N↑ 북쪽고정");
const btnGuide = mkBtn("▶ 경로안내");
const btnSim = mkBtn("🧪 모의주행");
const btnSpeed = mkBtn("1x");
ctl.append(btnLocate, btnNorth, btnGuide, btnSim, btnSpeed);
document.body.appendChild(ctl);

// === 제스처 및 사용자 상태 감지 ===
map.dragRotate.enable();
map.touchZoomRotate.enable();
map.touchZoomRotate.enableRotation();
map.scrollZoom.enable();
map.keyboard.enable();

map.on("movestart", () => {
    userInteracting = true;
    followGps = false; // 손으로 움직이는 순간 자동 추적 OFF
    clearTimeout(_idleT);
});
map.on("moveend", () => {
    clearTimeout(_idleT);
    _idleT = setTimeout(() => {
        userInteracting = false;
    }, 1500);
});
map.on("rotateend", () => {
    // 북쪽고정 모드일 때만 0도로 복귀
    if (northUp && map.getBearing() !== 0) {
        map.easeTo({ bearing: 0, duration: 300 });
    }
});

// === GeolocateControl ===
const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showAccuracyCircle: true,
    showUserHeading: true,
});
map.addControl(geolocate, "top-right");
map.on("load", () => { map.resize(); });
window.addEventListener("orientationchange", () => map.resize());
window.addEventListener("resize", () => map.resize());

// === GPS 마커 & 팔로우 ===
const markerEl = document.createElement("div");
markerEl.style.cssText =
    "width:16px;height:16px;border-radius:50%;background:#0ff;box-shadow:0 0 8px #0ff;";
const marker = new maplibregl.Marker({ element: markerEl }).setLngLat(map.getCenter()).addTo(map);

const geoOpts = { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 };

function updateGuidanceForPosition(center) {
    if (!guidanceActive || !routeLineCoords.length) return;

    const [lng, lat] = center;

    // 남은 거리/시간 계산
    const { remainingM } = computeRemainingDistance(center);

    if (totalDistanceM > 0 && totalTimeSec > 0) {
        const ratio = Math.max(0, Math.min(1, remainingM / totalDistanceM));
        const remainingSec = totalTimeSec * ratio;

        if (distChip) {
            let distLabel;
            if (remainingM >= 1000) {
                distLabel = `남은 ${(remainingM / 1000).toFixed(1)}km`;
            } else {
                distLabel = `남은 ${Math.round(remainingM)}m`;
            }
            distChip.textContent = distLabel;
        }

        if (etaChip) {
            etaChip.textContent = `남은 ${formatTime(Math.round(remainingSec))}`;
        }
    }

    if (!routeSteps.length || !navChip) return;

    // 현재 위치 기준 가장 가까운 안내 포인트
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < routeSteps.length; i++) {
        const s = routeSteps[i];
        const d = haversineMeters(lat, lng, s.lat, s.lng);
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }

    const step = routeSteps[bestIdx];
    const turnText = step.description
        ? step.description
        : turnTypeToText(step.turnType);

    let label;
    if (Number(step.turnType) === 201) {
        label = "곧 목적지입니다";
    } else if (bestDist < 15) {
        label = "지금 " + turnText;
    } else {
        label = `${Math.round(bestDist)}m 앞 ${turnText}`;
    }
    navChip.textContent = label;
}

const onPos = (pos) => {
    if (simActive) return; // 모의주행 중이면 실제 GPS 무시

    const { longitude, latitude, speed, heading } = pos.coords;
    const center = [longitude, latitude];
    lastFix = center;

    marker.setLngLat(center);
    if (spdEl) spdEl.textContent = `${toKmH(speed)} km/h`;
    if (brgEl) brgEl.textContent = `${Math.round(clampBearing(heading ?? 0))}°`;

    if (followGps && !userInteracting) {
        const easeOpts = {
            center,
            bearing: northUp ? 0 : (heading ?? map.getBearing()),
            pitch: 60,
            zoom: Math.max(16, map.getZoom()),
            duration: 600,
        };
        map.easeTo(easeOpts);
    }

    updateGuidanceForPosition(center);
};

const onErr = (e) => {
    console.warn("geo error", e.code, e.message);
    if (spdEl) spdEl.textContent = "위치권한 거부/실패";
    navigator.geolocation.getCurrentPosition(onPos, console.warn, { ...geoOpts, timeout: 45000 });
};

navigator.geolocation.watchPosition(onPos, onErr, geoOpts);

function applyGesturePolicy() {
    map.dragPan.enable();
    map.scrollZoom.enable();
    map.doubleClickZoom.enable();
    map.touchZoomRotate.enable();
    if (northUp) {
        map.dragRotate.disable();
        map.touchZoomRotate.disableRotation();
    } else {
        map.dragRotate.enable();
        map.touchZoomRotate.enableRotation();
    }
}
applyGesturePolicy();

// === 버튼 동작들 ===
btnLocate.onclick = () => {
    followGps = true;
    userInteracting = false;

    const centerTo = (center) => {
        if (!center) return;
        lastFix = center;
        map.easeTo({
            center,
            zoom: Math.max(16, map.getZoom()),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
            duration: 600,
        });
    };

    if (lastFix) {
        centerTo(lastFix);
    } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (p) => centerTo([p.coords.longitude, p.coords.latitude]),
            (err) => {
                console.warn("현위치 버튼 getCurrentPosition 에러:", err);
                alert("현 위치를 가져올 수 없습니다: " + err.message);
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    } else {
        alert("이 브라우저에서는 위치 서비스를 지원하지 않습니다.");
    }
};

btnNorth.onclick = () => {
    northUp = !northUp;
    btnNorth.textContent = northUp ? "N↑ 북쪽고정" : "🚗 진행방향";
    applyGesturePolicy();
};

// === Tmap 경로 관련 ===
const ROUTE_SOURCE_ID = "tmap-route-source";
const ROUTE_LAYER_ID = "tmap-route-layer";

// polyline 기반 남은 거리(m)
function computeRemainingDistance(center) {
    if (!routeLineCoords.length) return { remainingM: 0, nearestIdx: 0, nearestDist: 0 };
    const [lng, lat] = center;

    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < routeLineCoords.length; i++) {
        const [rlng, rlat] = routeLineCoords[i];
        const d = haversineMeters(lat, lng, rlat, rlng);
        if (d < nearestDist) {
            nearestDist = d;
            nearestIdx = i;
        }
    }

    let remain = 0;
    for (let i = nearestIdx; i < routeLineCoords.length - 1; i++) {
        const [lng1, lat1] = routeLineCoords[i];
        const [lng2, lat2] = routeLineCoords[i + 1];
        remain += haversineMeters(lat1, lng1, lat2, lng2);
    }

    return { remainingM: remain, nearestIdx, nearestDist: nearestDist };
}

// 누적 거리 테이블 생성
function buildRouteDistanceTable() {
    routeCumDist = [];
    let acc = 0;
    for (let i = 0; i < routeLineCoords.length; i++) {
        if (i === 0) {
            routeCumDist.push(0);
        } else {
            const [lng1, lat1] = routeLineCoords[i - 1];
            const [lng2, lat2] = routeLineCoords[i];
            acc += haversineMeters(lat1, lng1, lat2, lng2);
            routeCumDist.push(acc);
        }
    }
}

// 거리 d만큼 진행한 위치 (interpolation)
function getPointAtDistance(d) {
    if (!routeLineCoords.length || !routeCumDist.length) return null;
    const total = routeCumDist[routeCumDist.length - 1];
    if (d <= 0) return routeLineCoords[0];
    if (d >= total) return routeLineCoords[routeLineCoords.length - 1];

    let i = 0;
    while (i < routeCumDist.length - 1 && routeCumDist[i + 1] < d) {
        i++;
    }

    const d1 = routeCumDist[i];
    const d2 = routeCumDist[i + 1];
    const t = (d - d1) / (d2 - d1);

    const [lng1, lat1] = routeLineCoords[i];
    const [lng2, lat2] = routeLineCoords[i + 1];

    const lng = lng1 + (lng2 - lng1) * t;
    const lat = lat1 + (lat2 - lat1) * t;

    return [lng, lat];
}

// Tmap 경로 그리기
function drawTmapRoute(tmapData) {
    routeLineCoords = [];
    routeSteps = [];
    totalDistanceM = 0;
    totalTimeSec = 0;

    guidanceActive = true;

    if (navChip) navChip.textContent = "경로 안내 준비중";
    if (distChip) distChip.textContent = "남은 거리 계산중";
    if (etaChip) etaChip.textContent = "남은 시간 계산중";

    if (!tmapData || !Array.isArray(tmapData.features)) {
        console.warn("Tmap data has no features");
        if (navChip) navChip.textContent = "경로 데이터 없음";
        return;
    }

    let summarySet = false;

    for (const f of tmapData.features) {
        const geom = f.geometry;
        const prop = f.properties || {};

        if (!summarySet && typeof prop.totalDistance === "number") {
            totalDistanceM = prop.totalDistance;
            totalTimeSec = prop.totalTime ?? 0;
            summarySet = true;
        }

        if (geom && geom.type === "LineString" && Array.isArray(geom.coordinates)) {
            for (const c of geom.coordinates) {
                routeLineCoords.push([c[0], c[1]]);
            }
        }

        if (geom && geom.type === "Point" && geom.coordinates) {
            const [lng, lat] = geom.coordinates;
            if (typeof prop.turnType !== "undefined") {
                routeSteps.push({
                    lng,
                    lat,
                    turnType: prop.turnType,
                    description: prop.description || prop.name || "",
                });
            }
        }
    }

    if (!routeLineCoords.length) {
        console.warn("No LineString in Tmap route");
        if (navChip) navChip.textContent = "경로 데이터 없음";
        return;
    }

    buildRouteDistanceTable();

    const geojson = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: routeLineCoords },
        properties: {},
    };

    if (map.getSource(ROUTE_SOURCE_ID)) {
        map.getSource(ROUTE_SOURCE_ID).setData(geojson);
    } else {
        map.addSource(ROUTE_SOURCE_ID, {
            type: "geojson",
            data: geojson,
        });

        map.addLayer({
            id: ROUTE_LAYER_ID,
            type: "line",
            source: ROUTE_SOURCE_ID,
            layout: {
                "line-cap": "round",
                "line-join": "round",
            },
            paint: {
                "line-width": 6,
                "line-opacity": 0.9,
                "line-color": "#00f0ff",
            },
        });
    }

    const bounds = new maplibregl.LngLatBounds();
    routeLineCoords.forEach((c) => bounds.extend(c));
    map.fitBounds(bounds, { padding: 80, duration: 800 });

    if (navChip) navChip.textContent = "경로 안내 준비 완료";
    if (etaChip && totalTimeSec > 0) {
        etaChip.textContent = `총 예상 ${formatTime(totalTimeSec)}`;
    }
    if (distChip && totalDistanceM > 0) {
        if (totalDistanceM >= 1000) {
            distChip.textContent = `전체 ${(totalDistanceM / 1000).toFixed(1)}km`;
        } else {
            distChip.textContent = `전체 ${Math.round(totalDistanceM)}m`;
        }
    }
}

// Tmap 경로 API 호출 (Netlify Function)
async function requestTmapRoute(startLng, startLat, endLng, endLat) {
    try {
        const params = new URLSearchParams({
            sx: String(startLng),
            sy: String(startLat),
            ex: String(endLng),
            ey: String(endLat),
        });

        const res = await fetch("/.netlify/functions/tmap-route?" + params.toString());
        if (!res.ok) {
            if (navChip) navChip.textContent = "경로 탐색 실패";
            alert("Tmap 경로 탐색 실패(" + res.status + ")");
            return;
        }

        const data = await res.json();
        drawTmapRoute(data);
    } catch (e) {
        console.error("tmap-route fetch error:", e);
        if (navChip) navChip.textContent = "경로 오류";
        alert("Tmap 경로 탐색 중 오류 발생");
    }
}

// === 모의주행 엔진 ===
function applySimPosition(distM) {
    const center = getPointAtDistance(distM);
    if (!center) return;
    const [lng, lat] = center;

    // 5m 앞 지점으로 heading 추정
    let headingDeg = 0;
    const total = routeCumDist[routeCumDist.length - 1] || 0;
    const ahead = Math.min(distM + 5, total);
    const nextPt = getPointAtDistance(ahead);
    if (nextPt) {
        const [lng2, lat2] = nextPt;
        const dy = lat2 - lat;
        const dx = lng2 - lng;
        const rad = Math.atan2(dx, dy);
        headingDeg = (rad * 180) / Math.PI;
    }

    lastFix = center;
    marker.setLngLat(center);

    if (spdEl) spdEl.textContent = `${toKmH(simSpeedMps * simSpeedMultiplier)} km/h`;
    if (brgEl) brgEl.textContent = `${Math.round(clampBearing(headingDeg))}°`;

    followGps = true;
    userInteracting = false;
    northUp = false;

    map.easeTo({
        center,
        bearing: headingDeg,
        pitch: 60,
        zoom: Math.max(map.getZoom(), 16),
        duration: 0,
    });

    guidanceActive = true;
    updateGuidanceForPosition(center);
}

function simLoop(ts) {
    if (!simActive) return;

    if (!simLastTs) simLastTs = ts;
    const dt = (ts - simLastTs) / 1000;
    simLastTs = ts;

    const v = simSpeedMps * simSpeedMultiplier;
    simDist += v * dt;

    const total = routeCumDist[routeCumDist.length - 1] || 0;
    if (simDist >= total) {
        simDist = total;
        applySimPosition(simDist);
        simActive = false;
        simFrame = null;
        btnSim.textContent = "🧪 모의주행";
        if (navChip) navChip.textContent = "모의주행 종료 (도착)";
        return;
    }

    applySimPosition(simDist);
    simFrame = requestAnimationFrame(simLoop);
}

// 모의주행 버튼
btnSim.onclick = () => {
    if (!routeLineCoords.length || !routeCumDist.length) {
        alert("먼저 목적지를 검색해서 경로를 생성하세요.");
        return;
    }

    if (!simActive) {
        simActive = true;
        simDist = 0;
        simLastTs = 0;
        followGps = true;
        userInteracting = false;
        if (navChip) navChip.textContent = "모의주행 중";
        btnSim.textContent = "⏹ 모의중지";
        simFrame = requestAnimationFrame(simLoop);
    } else {
        simActive = false;
        simLastTs = 0;
        if (simFrame) cancelAnimationFrame(simFrame);
        btnSim.textContent = "🧪 모의주행";
        if (navChip) navChip.textContent = "모의주행 정지";
    }
};

// 배속 버튼
btnSpeed.onclick = () => {
    if (simSpeedMultiplier === 1) {
        simSpeedMultiplier = 2;
        btnSpeed.textContent = "2x";
    } else if (simSpeedMultiplier === 2) {
        simSpeedMultiplier = 4;
        btnSpeed.textContent = "4x";
    } else {
        simSpeedMultiplier = 1;
        btnSpeed.textContent = "1x";
    }
};

// 경로안내 버튼 (실제 내비 뷰 전환)
btnGuide.onclick = () => {
    guidanceActive = !guidanceActive;

    if (!guidanceActive) {
        btnGuide.textContent = "▶ 경로안내";
        followGps = false;
        if (navChip) navChip.textContent = "경로 안내 일시중지";
        return;
    }

    btnGuide.textContent = "⏹ 경로안내";
    followGps = true;
    userInteracting = false;

    const activateNavView = (center) => {
        if (!center) return;
        lastFix = center;
        map.easeTo({
            center,
            zoom: 17,
            pitch: 60,
            bearing: 0,
            duration: 600,
        });
    };

    if (lastFix) {
        activateNavView(lastFix);
    } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (p) => activateNavView([p.coords.longitude, p.coords.latitude]),
            (err) => {
                console.warn("경로안내용 현재 위치 가져오기 실패:", err);
                alert("현 위치를 가져올 수 없어 내비 뷰로 전환하지 못했습니다.");
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    }
};

// === 검색 → Naver 지오코딩 + Tmap 경로 ===
const qInput = document.getElementById("q");

async function doSearch() {
    const q = qInput.value.trim();
    if (!q) return;

    try {
        const res = await fetch(
            "/.netlify/functions/geocode?q=" + encodeURIComponent(q)
        );

        if (!res.ok) {
            console.error("geocode function error status:", res.status);
            alert("검색 실패(" + res.status + ")");
            return;
        }

        const data = await res.json();
        console.log("geocode result:", data);

        let lng = null;
        let lat = null;

        // 1) 네이버 지오코딩 형식: { addresses: [ { x, y, ... } ] }
        if (data.addresses && data.addresses.length > 0) {
            const addr = data.addresses[0];
            lng = Number(addr.x);
            lat = Number(addr.y);
        }
        // 2) 카카오 로컬 검색 / 지오코딩 형식: { documents: [ { x, y, ... } ] }
        else if (data.documents && data.documents.length > 0) {
            const place = data.documents[0];
            lng = Number(place.x);
            lat = Number(place.y);
        }

        if (lng == null || lat == null || Number.isNaN(lng) || Number.isNaN(lat)) {
            alert("검색 결과 없음");
            return;
        }

        destCoord = [lng, lat];

        // 검색 위치로 지도 이동 (프리뷰)
        followGps = false;
        userInteracting = true;

        map.easeTo({
            center: [lng, lat],
            zoom: 16,
            duration: 800,
        });

        // 경로 탐색 시작
        const startRoute = () => {
            if (lastFix) {
                requestTmapRoute(lastFix[0], lastFix[1], lng, lat);
            } else if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (p) => {
                        lastFix = [p.coords.longitude, p.coords.latitude];
                        requestTmapRoute(lastFix[0], lastFix[1], lng, lat);
                    },
                    (err) => {
                        console.warn("경로 시작 위치 가져오기 실패", err);
                        alert("현위치를 가져올 수 없어서 경로를 그릴 수 없습니다.");
                    },
                    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
                );
            } else {
                alert("이 브라우저에서는 위치 서비스를 지원하지 않습니다.");
            }
        };

        startRoute();
    } catch (e) {
        console.error("geocode fetch error:", e);
        alert("검색 중 오류 발생");
    }
}


// 엔터 키로 검색
qInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        doSearch();
    }
});

// 폼 제출 방지
if (qInput.form) {
    qInput.form.addEventListener("submit", (e) => {
        e.preventDefault();
        doSearch();
    });
}
