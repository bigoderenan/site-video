# Site Video Studio

Reusable Playwright and FFmpeg workflow that opens a public web page, dismisses
common cookie banners, performs a configurable scroll, and exports MP4
deliverables for desktop and mobile.

## Requirements

- Node.js 20+
- Chromium installed by Playwright

## Setup

```powershell
pnpm install
pnpm run install:browsers
```

## Example capture

```powershell
pnpm run capture:example
```

The command creates:

- `outputs/example-desktop-1920x1080-60fps.mp4`
- `outputs/example-mobile-1080x1920-60fps.mp4`

Both files are 20 seconds long, H.264 MP4, yuv420p, 60 FPS, and web-optimized
with `faststart` metadata.

The mobile profile uses a 393x699 CSS viewport to trigger the site's real
responsive layout and a 2.75x device scale factor to render at approximately
1080x1920 physical pixels. It uses Chromium compositor screencasting so those
high-density pixels are captured natively instead of enlarging a 393px video.
`width` and `height` control the deliverable;
`viewportWidth` and `viewportHeight` control the logical layout size, while
`captureWidth` and `captureHeight` control the native recording surface.

Capture only one format:

```powershell
pnpm run capture -- --config sites/default.json --profile mobile
```

Capture another site using the built-in defaults:

```powershell
pnpm run capture -- --url https://example.com --name example
```

## Reuse and customization

Copy `sites/default.json`, change `name` and `url`, then tune `timeline` if the
home page is unusually short or long. A `to` value is a fraction of the page's
maximum scroll distance; `duration` and `hold` are milliseconds. The example
configuration scrolls smoothly to the bottom in 10 seconds and returns to the
hero in another 10 seconds. Use `jumpTo` when a clean cut is preferred.

Supported easing values are `linear`, `easeInOutCubic`, and `easeInOutSine`.
The configured timeline may be shorter than the requested video; the final frame
is held until `durationSeconds` is reached. If it is longer, FFmpeg still trims
the deliverable to the exact requested duration.

Raw Playwright recordings are kept under `work/recordings/` for debugging and
are ignored by Git. Final videos are written to `outputs/`.

## Minimal web interface

Start the local interface with:

```powershell
pnpm start
```

Open `http://localhost:3000`. The screen accepts a URL, output formats, total
duration, and motion style. It permits one generation at a time and deletes
finished MP4 files after 60 minutes.

## DirectAdmin deployment

Extract the project into the application root and create a Node.js application
with these values:

- Node.js version: 20 or newer
- Application mode: Production
- Application root: the folder containing `app.js`
- Application startup file: `app.js`
- Environment variable `APP_BASE_PATH`: the URL path used by DirectAdmin, such
  as `/scripts/site-video`
- Optional `FILE_TTL_MINUTES`: `60`

Activate the Node environment shown by DirectAdmin, enter the application root,
and run:

```bash
npm install
npx playwright install chromium
```

Then restart the application from the DirectAdmin panel. If Chromium reports
missing Linux libraries, the hosting provider must install those system
dependencies. `ffmpeg-static` supplies FFmpeg without a global installation.
