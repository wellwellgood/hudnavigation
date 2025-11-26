// netlify/functions/geocode.js
exports.handler = async (event, context) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Content-Type": "application/json; charset=utf-8",
    };

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

    const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY;

    if (!KAKAO_REST_API_KEY) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "KAKAO REST API KEY missing" }),
        };
    }

    try {
        const q = event.queryStringParameters?.q || "";
        if (!q) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "query param 'q' required" }),
            };
        }

        // 카카오 키워드 검색 API
        const url =
            "https://dapi.kakao.com/v2/local/search/keyword.json?query=" +
            encodeURIComponent(q);

        const resp = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `KakaoAK ${KAKAO_REST_API_KEY}`,
                Accept: "application/json",
            },
        });

        const text = await resp.text();

        return {
            statusCode: resp.status,
            headers,
            body: text,
        };
    } catch (e) {
        console.error("Kakao search error:", e);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "internal error", message: e.message }),
        };
    }
};
