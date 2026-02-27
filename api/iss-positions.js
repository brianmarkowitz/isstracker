const BASE_URL = 'https://api.wheretheiss.at/v1/satellites/25544/positions';

module.exports = async (req, res) => {
  try {
    const rawTimestamps = typeof req.query.timestamps === 'string' ? req.query.timestamps : '';
    const parts = rawTimestamps.split(',').filter(Boolean);

    if (parts.length === 0 || parts.length > 30 || parts.some((v) => !/^\d+$/.test(v))) {
      res.status(400).json({ error: 'Invalid timestamps query' });
      return;
    }

    const upstreamUrl = `${BASE_URL}?timestamps=${parts.join(',')}`;
    const upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'isstracker-vercel-proxy' }
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Upstream ISS trajectory API error' });
      return;
    }

    const data = await upstream.json();

    // Trajectory snapshots are computed in 5-minute buckets; cache a bit longer.
    res.setHeader('Cache-Control', 'max-age=0, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('CDN-Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Vercel-CDN-Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (error) {
    res.status(502).json({ error: 'ISS trajectory proxy request failed' });
  }
};
