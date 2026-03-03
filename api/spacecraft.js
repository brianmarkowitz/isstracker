/**
 * Dynamic Spacecraft API endpoint.
 * Fetches the active stations list from CelesTrak, filters for visiting vehicles
 * (Dragon, Soyuz, Shenzhou, Progress, Cygnus, etc.), and propagates their orbits.
 */

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json';

let cachedData = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache for dynamic spacecraft

function keplerToLatLon(gp, nowMs) {
    const MU = 398600.4418;
    const RE = 6371.0;
    const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
    const DAY_MS = 86400000;
    const TWO_PI = 2 * Math.PI;
    const DEG2RAD = Math.PI / 180;
    const RAD2DEG = 180 / Math.PI;

    const inc = gp.INCLINATION * DEG2RAD;
    const raan0 = gp.RA_OF_ASC_NODE * DEG2RAD;
    const ecc = gp.ECCENTRICITY;
    const argP = gp.ARG_OF_PERICENTER * DEG2RAD;
    const M0 = gp.MEAN_ANOMALY * DEG2RAD;
    const mm = gp.MEAN_MOTION;

    const epochMs = new Date(gp.EPOCH).getTime();
    const dtDays = (nowMs - epochMs) / DAY_MS;

    if (Math.abs(dtDays) > 10) return null; // Ignore stale data

    const n = mm * TWO_PI / 86400;
    const a = Math.pow(MU / (n * n), 1 / 3);

    let M = M0 + n * (dtDays * 86400);
    M = ((M % TWO_PI) + TWO_PI) % TWO_PI;

    let E = M;
    for (let i = 0; i < 5; i++) {
        E = E - (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
    }

    const sinE = Math.sin(E);
    const cosE = Math.cos(E);
    const sinV = (Math.sqrt(1 - ecc * ecc) * sinE) / (1 - ecc * cosE);
    const cosV = (cosE - ecc) / (1 - ecc * cosE);
    const v = Math.atan2(sinV, cosV);
    const u = argP + v;
    const r = a * (1 - ecc * cosE);

    const cosU = Math.cos(u);
    const sinU = Math.sin(u);

    const jd = (nowMs - J2000) / DAY_MS;
    const gmst = ((280.46061837 + 360.98564736629 * jd) % 360) * DEG2RAD;

    const j2 = 0.00108263;
    const p = (1 - ecc * ecc);
    const raanRate = -1.5 * n * j2 * (RE / a) * (RE / a) * Math.cos(inc) / (p * p);
    const raanNow = raan0 + raanRate * dtDays * 86400;

    const cosR = Math.cos(raanNow);
    const sinR = Math.sin(raanNow);
    const cosI = Math.cos(inc);
    const sinI = Math.sin(inc);

    const xOrb = r * cosU;
    const yOrb = r * sinU;

    const xECI = cosR * xOrb - sinR * cosI * yOrb;
    const yECI = sinR * xOrb + cosR * cosI * yOrb;
    const zECI = sinI * yOrb;

    const cosG = Math.cos(gmst);
    const sinG = Math.sin(gmst);
    const xECEF = cosG * xECI + sinG * yECI;
    const yECEF = -sinG * xECI + cosG * yECI;

    const lon = Math.atan2(yECEF, xECEF) * RAD2DEG;
    const lat = Math.atan2(zECI, Math.sqrt(xECEF * xECEF + yECEF * yECEF)) * RAD2DEG;
    const alt = r - RE;

    // Velocity vis-viva calculation
    const velKmS = Math.sqrt(MU * ((2 / r) - (1 / a)));
    const velKmH = velKmS * 3600;

    // Footprint
    const footprintRadius = RE * Math.acos(RE / (RE + alt));

    return {
        lat: Math.round(lat * 10000) / 10000,
        lon: Math.round(lon * 10000) / 10000,
        alt: Math.round(alt * 10) / 10,
        velocity: Math.round(velKmH * 10) / 10,
        footprint: Math.round(footprintRadius)
    };
}

module.exports = async (req, res) => {
    try {
        const nowMs = Date.now();

        if (cachedData && (nowMs - cachedAt) < CACHE_TTL_MS) {
            res.setHeader('Cache-Control', 'max-age=0, s-maxage=60, stale-while-revalidate=120');
            return res.status(200).json(cachedData);
        }

        const response = await fetch(CELESTRAK_URL, {
            headers: { 'User-Agent': 'isstracker-vercel-dynamic' }
        });

        if (!response.ok) throw new Error(`CelesTrak returned ${response.status}`);
        const gpData = await response.json();

        const results = [];

        for (const gp of gpData) {
            if (gp.DECAY_DATE) continue;

            const name = gp.OBJECT_NAME.toUpperCase();

            // Skip space stations themselves
            if (name.includes('ISS') || name.includes('CSS') || name.includes('POISK') ||
                name.includes('NAUKA') || name.includes('WENTIAN') || name.includes('MENGTIAN')) {
                continue;
            }

            // Look for specific spacecraft identifiers
            const isDragon = name.includes('DRAGON');
            const isSoyuz = name.includes('SOYUZ');
            const isShenzhou = name.includes('SHENZHOU') || name.includes('SZ-');
            const isProgress = name.includes('PROGRESS');
            const isTianzhou = name.includes('TIANZHOU');
            const isCygnus = name.includes('CYGNUS');
            const isStarliner = name.includes('STARLINER');
            const isHTV = name.includes('HTV');

            if (!isDragon && !isSoyuz && !isShenzhou && !isProgress && !isTianzhou && !isCygnus && !isStarliner && !isHTV) {
                continue; // Not a recognized visiting vehicle
            }

            const state = keplerToLatLon(gp, nowMs);
            if (!state) continue;

            // Determine display type
            let type = 'standard';
            let color = '#a78bfa'; // purple-ish default

            if (isDragon || isStarliner) {
                type = 'capsule';
                color = '#fffbeb'; // amber-white
            } else if (isSoyuz || isShenzhou) {
                type = 'capsule_winged';
                color = '#fba11b'; // orange
            } else if (isProgress || isTianzhou || isCygnus || isHTV) {
                type = 'cargo';
                color = '#94a3b8'; // slate
            }

            results.push({
                name: name,
                noradId: gp.NORAD_CAT_ID,
                latitude: state.lat,
                longitude: state.lon,
                altitude: state.alt,
                velocity: state.velocity,
                footprint: state.footprint,
                type: type,
                color: color
            });
        }

        cachedData = results;
        cachedAt = nowMs;

        res.setHeader('Cache-Control', 'max-age=0, s-maxage=60, stale-while-revalidate=120');
        res.status(200).json(results);
    } catch (error) {
        console.error('Spacecraft backend error:', error);
        if (cachedData) return res.status(200).json(cachedData);
        res.status(502).json({ error: 'Failed to fetch spacecraft data' });
    }
};
