/**
 * Starlink constellation positions endpoint.
 * Fetches all Starlink TLEs from CelesTrak as a batch,
 * propagates Keplerian orbits, and returns compact lat/lon arrays.
 *
 * CelesTrak group endpoint returns ~6000 satellites.
 * We compute positions server-side and cache aggressively.
 */

const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json';

// In-memory cache
let cachedData = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Simplified Kepler propagation — returns [lat, lon] for a GP element set.
 * Stripped down for performance (6000+ satellites).
 */
function propagate(gp, nowMs) {
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
    const mm = gp.MEAN_MOTION; // rev/day

    const epochMs = new Date(gp.EPOCH).getTime();
    const dtDays = (nowMs - epochMs) / DAY_MS;

    // Skip if TLE is too old (>30 days stale)
    if (Math.abs(dtDays) > 30) return null;

    const n = mm * TWO_PI / 86400; // rad/s
    const a = Math.pow(MU / (n * n), 1 / 3);

    // Mean anomaly at current time
    let M = M0 + n * (dtDays * 86400);
    M = ((M % TWO_PI) + TWO_PI) % TWO_PI;

    // Kepler's equation (3 iterations for speed)
    let E = M;
    for (let i = 0; i < 3; i++) {
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

    // GMST
    const jd = (nowMs - J2000) / DAY_MS;
    const gmst = ((280.46061837 + 360.98564736629 * jd) % 360) * DEG2RAD;

    // J2 RAAN precession
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

    return [Math.round(lat * 100) / 100, Math.round(lon * 100) / 100];
}

module.exports = async (req, res) => {
    try {
        const nowMs = Date.now();

        // Return cached data if fresh
        if (cachedData && (nowMs - cachedAt) < CACHE_TTL_MS) {
            res.setHeader('Cache-Control', 'max-age=0, s-maxage=120, stale-while-revalidate=300');
            res.setHeader('X-Cache', 'HIT');
            return res.status(200).json(cachedData);
        }

        // Fetch all Starlink GP elements
        const response = await fetch(CELESTRAK_URL, {
            headers: { 'User-Agent': 'isstracker-vercel-proxy' }
        });

        if (!response.ok) {
            throw new Error(`CelesTrak returned ${response.status}`);
        }

        const gpData = await response.json();

        // Propagate positions
        const positions = [];
        for (const gp of gpData) {
            // Only include operational satellites (skip decayed)
            if (gp.DECAY_DATE) continue;
            const pos = propagate(gp, nowMs);
            if (pos) positions.push(pos);
        }

        cachedData = {
            count: positions.length,
            positions, // [[lat, lon], [lat, lon], ...]
            computedAt: nowMs,
        };
        cachedAt = nowMs;

        res.setHeader('Cache-Control', 'max-age=0, s-maxage=120, stale-while-revalidate=300');
        res.setHeader('CDN-Cache-Control', 's-maxage=120, stale-while-revalidate=300');
        res.setHeader('X-Cache', 'MISS');
        res.status(200).json(cachedData);
    } catch (error) {
        console.error('Starlink tracking error:', error);
        // Return stale cache if available
        if (cachedData) {
            res.setHeader('X-Cache', 'STALE');
            return res.status(200).json(cachedData);
        }
        res.status(502).json({ error: 'Starlink tracking failed' });
    }
};
