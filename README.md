# ISS Tracker

Futuristic single-page ISS dashboard with:
- Live ISS telemetry (position, altitude, velocity, footprint)
- Global trajectory map with orbital trail and prediction
- NASA external camera panel
- Crew manifest and telemetry event log

## Live Site

- Production: [https://isstracker-nine.vercel.app](https://isstracker-nine.vercel.app)
- Repository: [https://github.com/brianmarkowitz/isstracker](https://github.com/brianmarkowitz/isstracker)

## Tech Stack

- Static HTML/CSS/JS (`index.html`)
- Tailwind (CDN)
- D3.js (map rendering)
- Lucide icons
- Public ISS APIs (`wheretheiss.at`)

## Local Development

From the project root:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## Deployment

This project is deployed on Vercel.

```bash
vercel deploy --prod -y
```

## NASA Feed Note

The NASA panel currently uses this stream:

- [https://www.youtube.com/watch?v=aB1yRz0HhdY](https://www.youtube.com/watch?v=aB1yRz0HhdY)

If NASA changes stream IDs again, update the iframe `src` in `index.html`.
