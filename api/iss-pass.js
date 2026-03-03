const BASE_URL = 'https://api.wheretheiss.at/v1/satellites/25544/positions';
const EARTH_RADIUS_KM = 6371;
const MIN_ELEVATION_DEG = 10;
const BATCH_SIZE = 25;

/**
 * Compute the great-circle distance and elevation angle of the ISS
 * as seen from an observer on Earth.
 */
function computeElevation(obsLat, obsLon, issLat, issLon, issAltKm) {
  const toRad = (d) => d * Math.PI / 180;
  const olat = toRad(obsLat);
  const olon = toRad(obsLon);
  const ilat = toRad(issLat);
  const ilon = toRad(issLon);

  // Haversine great-circle angular distance
  const dlat = ilat - olat;
  const dlon = ilon - olon;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(olat) * Math.cos(ilat) * Math.sin(dlon / 2) ** 2;
  const centralAngle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Slant range and elevation angle
  const R = EARTH_RADIUS_KM;
  const h = issAltKm;
  const slant = Math.sqrt(R * R + (R + h) * (R + h) - 2 * R * (R + h) * Math.cos(centralAngle));
  const elevation = Math.asin(((R + h) * Math.cos(centralAngle) - R) / slant) * 180 / Math.PI;

  // Azimuth
  const y = Math.sin(dlon) * Math.cos(ilat);
  const x = Math.cos(olat) * Math.sin(ilat) - Math.sin(olat) * Math.cos(ilat) * Math.cos(dlon);
  let azimuth = Math.atan2(y, x) * 180 / Math.PI;
  azimuth = (azimuth + 360) % 360;

  return { elevation, azimuth, distance: slant };
}

module.exports = async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);

    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      res.status(400).json({ error: 'Invalid lat/lon' });
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    // Scan 12 hours ahead at 60-second intervals (720 points)
    const scanDurationSec = 12 * 60 * 60;
    const stepSec = 60;
    const totalPoints = Math.floor(scanDurationSec / stepSec);

    // Build all timestamps
    const allTimestamps = [];
    for (let i = 0; i <= totalPoints; i++) {
      allTimestamps.push(nowSec + i * stepSec);
    }

    // Fetch in batches (API limit ~30 per call)
    const allPositions = [];
    for (let batchStart = 0; batchStart < allTimestamps.length; batchStart += BATCH_SIZE) {
      const batch = allTimestamps.slice(batchStart, batchStart + BATCH_SIZE);
      const url = `${BASE_URL}?timestamps=${batch.join(',')}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'isstracker-vercel-proxy' }
      });
      if (!response.ok) {
        // If a batch fails, return what we have so far
        break;
      }
      const data = await response.json();
      allPositions.push(...data);
    }

    if (allPositions.length === 0) {
      res.status(502).json({ error: 'Could not fetch ISS positions' });
      return;
    }

    // Compute elevation for each position and find passes
    const passes = [];
    let currentPass = null;

    for (const pos of allPositions) {
      const { elevation, azimuth } = computeElevation(lat, lon, pos.latitude, pos.longitude, pos.altitude);

      if (elevation >= MIN_ELEVATION_DEG) {
        if (!currentPass) {
          // Pass starts
          currentPass = {
            riseTime: pos.timestamp,
            riseAzimuth: Math.round(azimuth),
            maxElevation: elevation,
            maxElevationTime: pos.timestamp,
            setTime: pos.timestamp,
            setAzimuth: Math.round(azimuth),
          };
        } else {
          // Mid-pass update
          currentPass.setTime = pos.timestamp;
          currentPass.setAzimuth = Math.round(azimuth);
          if (elevation > currentPass.maxElevation) {
            currentPass.maxElevation = elevation;
            currentPass.maxElevationTime = pos.timestamp;
          }
        }
      } else if (currentPass) {
        // Pass ends
        currentPass.maxElevation = Math.round(currentPass.maxElevation * 10) / 10;
        passes.push(currentPass);
        currentPass = null;
      }
    }

    // Close any pass still in progress at the end of the window
    if (currentPass) {
      currentPass.maxElevation = Math.round(currentPass.maxElevation * 10) / 10;
      passes.push(currentPass);
    }

    // Cache for 5 minutes (pass predictions don't change quickly)
    res.setHeader('Cache-Control', 'max-age=0, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('CDN-Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Vercel-CDN-Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      observer: { lat, lon },
      scanWindowMinutes: scanDurationSec / 60,
      passes,
    });
  } catch (error) {
    console.error('Pass prediction error:', error);
    res.status(502).json({ error: 'Pass prediction failed' });
  }
};
