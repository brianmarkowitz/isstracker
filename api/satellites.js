/**
 * Satellite tracking proxy endpoint.
 * Fetches TLE data from CelesTrak and computes current positions
 * using a simplified SGP4-like propagation.
 *
 * For robustness, we fetch pre-computed positions from CelesTrak's
 * GP (General Perturbations) JSON endpoint which gives orbital elements,
 * then compute lat/lon from those.
 */

const CELESTRAK_GP_URL = 'https://celestrak.org/NORAD/elements/gp.php';

// Curated list of interesting satellites
const TRACKED_SATELLITES = {
    '48274': { name: 'TIANGONG', color: '#ff6b6b' },       // Chinese Space Station
    '20580': { name: 'HUBBLE', color: '#a78bfa' },          // Hubble Space Telescope
    '25544': { name: 'ISS (ZARYA)', color: '#00f3ff' },     // ISS (for reference)
};

// IDs to fetch (exclude ISS since we already track it separately)
const SATELLITE_IDS = ['48274', '20580'];

/**
 * Convert orbital elements to lat/lon at a given time.
 * Uses a simplified Keplerian propagation (no drag, J2, etc.)
 * Good enough for visual map display purposes.
 */
function keplerToLatLon(tle, nowMs) {
    const MU = 398600.4418; // Earth's gravitational parameter, km³/s²
    const RE = 6371.0;      // Earth radius, km
    const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0); // J2000 epoch
    const DAY_MS = 86400000;
    const TWO_PI = 2 * Math.PI;
    const DEG2RAD = Math.PI / 180;
    const RAD2DEG = 180 / Math.PI;

    // Parse GP elements
    const inclination = tle.INCLINATION * DEG2RAD;
    const raan = tle.RA_OF_ASC_NODE * DEG2RAD;
    const eccentricity = tle.ECCENTRICITY;
    const argPerigee = tle.ARG_OF_PERICENTER * DEG2RAD;
    const meanAnomaly = tle.MEAN_ANOMALY * DEG2RAD;
    const meanMotion = tle.MEAN_MOTION; // rev/day

    // Epoch
    const epochStr = tle.EPOCH; // ISO 8601
    const epochMs = new Date(epochStr).getTime();
    const dtDays = (nowMs - epochMs) / DAY_MS;

    // Semi-major axis from mean motion
    const n = meanMotion * TWO_PI / 86400; // rad/s
    const a = Math.pow(MU / (n * n), 1 / 3); // km

    // Propagate mean anomaly
    let M = meanAnomaly + n * (dtDays * 86400);
    M = M % TWO_PI;
    if (M < 0) M += TWO_PI;

    // Solve Kepler's equation (Newton-Raphson)
    let E = M;
    for (let i = 0; i < 10; i++) {
        E = E - (E - eccentricity * Math.sin(E) - M) / (1 - eccentricity * Math.cos(E));
    }

    // True anomaly
    const sinV = (Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(E)) / (1 - eccentricity * Math.cos(E));
    const cosV = (Math.cos(E) - eccentricity) / (1 - eccentricity * Math.cos(E));
    const v = Math.atan2(sinV, cosV);

    // Argument of latitude
    const u = argPerigee + v;

    // Radius
    const r = a * (1 - eccentricity * Math.cos(E));

    // Position in orbital plane
    const xOrb = r * Math.cos(u);
    const yOrb = r * Math.sin(u);

    // Earth rotation angle (Greenwich Sidereal Time approximation)
    const jd = (nowMs - J2000) / DAY_MS;
    const gmst = (280.46061837 + 360.98564736629 * jd) % 360 * DEG2RAD;

    // RAAN precession due to J2 (simplified)
    const j2 = 0.00108263;
    const raanRate = -1.5 * n * j2 * (RE / a) * (RE / a) * Math.cos(inclination) / ((1 - eccentricity * eccentricity) * (1 - eccentricity * eccentricity));
    const raanNow = raan + raanRate * dtDays * 86400;

    // Convert to ECI
    const cosRaan = Math.cos(raanNow);
    const sinRaan = Math.sin(raanNow);
    const cosI = Math.cos(inclination);
    const sinI = Math.sin(inclination);

    const xECI = cosRaan * xOrb - sinRaan * cosI * yOrb;
    const yECI = sinRaan * xOrb + cosRaan * cosI * yOrb;
    const zECI = sinI * yOrb;

    // ECI to ECEF (rotate by GMST)
    const cosGmst = Math.cos(gmst);
    const sinGmst = Math.sin(gmst);
    const xECEF = cosGmst * xECI + sinGmst * yECI;
    const yECEF = -sinGmst * xECI + cosGmst * yECI;
    const zECEF = zECI;

    // ECEF to geodetic
    const lon = Math.atan2(yECEF, xECEF) * RAD2DEG;
    const lat = Math.atan2(zECEF, Math.sqrt(xECEF * xECEF + yECEF * yECEF)) * RAD2DEG;
    const alt = r - RE;

    // Orbital velocity: v = sqrt(mu * (2/r - 1/a)) (vis-viva equation)
    const velocity = Math.sqrt(MU * (2 / r - 1 / a)); // km/s

    // Radar footprint: Earth surface visible from satellite
    const horizonAngle = Math.acos(RE / (RE + alt));
    const footprint = RE * horizonAngle * 2; // km diameter

    return { latitude: lat, longitude: lon, altitude: alt, velocity, footprint };
}

module.exports = async (req, res) => {
    try {
        const results = [];
        const nowMs = Date.now();

        for (const noradId of SATELLITE_IDS) {
            try {
                const url = `${CELESTRAK_GP_URL}?CATNR=${noradId}&FORMAT=json`;
                const response = await fetch(url, {
                    headers: { 'User-Agent': 'isstracker-vercel-proxy' }
                });

                if (!response.ok) continue;
                const data = await response.json();
                if (!data || data.length === 0) continue;

                const tle = data[0];
                const pos = keplerToLatLon(tle, nowMs);
                const meta = TRACKED_SATELLITES[noradId] || { name: tle.OBJECT_NAME, color: '#888' };

                results.push({
                    noradId,
                    name: meta.name,
                    color: meta.color,
                    latitude: pos.latitude,
                    longitude: pos.longitude,
                    altitude: pos.altitude,
                    velocity: pos.velocity * 3600, // km/s -> km/h
                    footprint: pos.footprint,
                });
            } catch (e) {
                console.error(`Failed to fetch satellite ${noradId}:`, e.message);
            }
        }

        res.setHeader('Cache-Control', 'max-age=0, s-maxage=30, stale-while-revalidate=120');
        res.setHeader('CDN-Cache-Control', 's-maxage=30, stale-while-revalidate=120');
        res.setHeader('Vercel-CDN-Cache-Control', 's-maxage=30, stale-while-revalidate=120');
        res.status(200).json(results);
    } catch (error) {
        console.error('Satellite tracking error:', error);
        res.status(502).json({ error: 'Satellite tracking failed' });
    }
};
