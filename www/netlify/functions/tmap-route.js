// netlify/functions/tmap-route.js
exports.handler = async (event, context) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Content-Type": "application/json; charset=utf-8",
    };

    // CORS preflight
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers, body: "" };
    }

    if (event.httpMethod !== "GET") {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: "Method not allowed" }),
        };
    }

    const TMAP_APP_KEY = process.env.TMAP_APP_KEY;
    if (!TMAP_APP_KEY) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "TMAP_APP_KEY missing" }),
        };
    }

    const qs = event.queryStringParameters || {};
    const sx = qs.sx;
    const sy = qs.sy;
    const ex = qs.ex;
    const ey = qs.ey;

    if (!sx || !sy || !ex || !ey) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
                error: "sx, sy, ex, ey 쿼리 파라미터가 필요합니다.",
            }),
        };
    }

    try {
        // 자동차차 경로 안내 API 사용
        // POST https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&format=json :contentReference[oaicite:1]{index=1}
        const url = "https://apis.openapi.sk.com/tmap/routes?version=1&format=json";
        const body = JSON.stringify({
            startX: sx,
            startY: sy,
            endX: ex,
            endY: ey,
            reqCoordType: "WGS84GEO",
            resCoordType: "WGS84GEO",
            searchOption: "0", // 0=추천/빠른길
            trafficInfo: "Y",  // 교통정보 반영
            startName: "출발지",
            endName: "도착지",
        });

        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                appKey: TMAP_APP_KEY,
            },
            body,
        });

        const text = await resp.text();

        return {
            statusCode: resp.status,
            headers,
            body: text,
        };
    } catch (e) {
        console.error("Tmap route error:", e);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "internal error", message: e.message }),
        };
    }
};
