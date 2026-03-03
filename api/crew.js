const CREW_URL = 'http://api.open-notify.org/astros.json';

module.exports = async (req, res) => {
  try {
    const upstream = await fetch(CREW_URL, {
      headers: { 'User-Agent': 'isstracker-vercel-proxy' }
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Upstream crew API error' });
      return;
    }

    const data = await upstream.json();

    // Crew data changes infrequently, so cache a bit longer.
    res.setHeader('Cache-Control', 'max-age=0, s-maxage=300, stale-while-revalidate=3600');
    res.setHeader('CDN-Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.setHeader('Vercel-CDN-Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    res.status(200).json(data);
  } catch (error) {
    res.status(502).json({ error: 'Crew proxy request failed' });
  }
};
