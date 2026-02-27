const ISS_URL = 'https://api.wheretheiss.at/v1/satellites/25544';

module.exports = async (req, res) => {
  try {
    const upstream = await fetch(ISS_URL, {
      headers: { 'User-Agent': 'isstracker-vercel-proxy' }
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Upstream ISS API error' });
      return;
    }

    const data = await upstream.json();

    // Share fresh data across users for a short window.
    res.setHeader('Cache-Control', 'max-age=0, s-maxage=4, stale-while-revalidate=20');
    res.setHeader('CDN-Cache-Control', 's-maxage=4, stale-while-revalidate=20');
    res.setHeader('Vercel-CDN-Cache-Control', 's-maxage=4, stale-while-revalidate=20');
    res.status(200).json(data);
  } catch (error) {
    res.status(502).json({ error: 'ISS proxy request failed' });
  }
};
