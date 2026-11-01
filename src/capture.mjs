import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TIMELINE = [
  { to: 0.2, duration: 3500, easing: 'easeInOutCubic' },
  { hold: 500 },
  { to: 0.5, duration: 4000, easing: 'easeInOutCubic' },
  { hold: 500 },
  { to: 0.78, duration: 4000, easing: 'easeInOutCubic' },
  { hold: 500 },
  { to: 1, duration: 3500, easing: 'easeInOutCubic' },
  { hold: 500 }
];

function parseArgs(argv) {
  const args = { profiles: [], types: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--config') args.config = argv[++index];
    else if (item === '--url') args.url = argv[++index];
    else if (item === '--name') args.name = argv[++index];
    else if (item === '--profile') args.profiles.push(argv[++index]);
    else if (item === '--type') args.types.push(argv[++index]);
    else if (item === '--output-dir') args.outputDir = argv[++index];
    else if (item === '--headed') args.headless = false;
    else if (item === '--help' || item === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  npm run capture -- --config sites/default.json
  npm run capture -- --url https://example.com --name example

Options:
  --config <file>       JSON capture configuration
  --url <url>           Override the configured URL
  --name <slug>         Override the output filename prefix
  --profile <name>      Capture only one profile (repeatable)
  --type <name>         Output type: video or screenshot (repeatable; default: video)
  --output-dir <dir>    Output directory (default: outputs)
  --headed              Show Chromium while capturing
  --help                Show this message`);
}

async function loadConfig(args) {
  let config = {};
  if (args.config) {
    config = JSON.parse(await readFile(path.resolve(args.config), 'utf8'));
  }
  config.url = args.url ?? config.url;
  if (!config.url) throw new Error('A URL is required via --url or --config.');
  config.name = args.name ?? config.name ?? new URL(config.url).hostname.replace(/^www\./, '').split('.')[0];
  config.durationSeconds ??= 20;
  config.fps ??= 60;
  config.settleMilliseconds ??= 1500;
  config.cookieConsent ??= true;
  config.timeline ??= DEFAULT_TIMELINE;
  config.profiles ??= {
    desktop: { width: 1920, height: 1080, videoBorderPercent: 0.062, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    mobile: { width: 1080, height: 1920, deviceScaleFactor: 1, isMobile: true, hasTouch: true }
  };
  return config;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function dismissCookieConsent(page) {
  const patterns = [
    /aceitar todos/i, /aceitar cookies/i, /^aceitar$/i, /allow all/i,
    /accept all/i, /^accept$/i, /concordo/i, /continuar/i, /^ok$/i
  ];
  for (const pattern of patterns) {
    const candidate = page.getByRole('button', { name: pattern }).first();
    try {
      if (await candidate.isVisible({ timeout: 200 })) {
        await candidate.click({ timeout: 1000 });
        await delay(250);
        return true;
      }
    } catch {
      // Consent banners are best-effort and differ across sites.
    }
  }
  return false;
}

async function preparePage(page, config) {
  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  if (config.cookieConsent) await dismissCookieConsent(page);
  await page.addStyleTag({ content: `
    html { scroll-behavior: auto !important; }
    body { overflow-x: hidden !important; }
    * { caret-color: transparent !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
  ` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(config.settleMilliseconds);
}

async function smoothScroll(page, destinationRatio, duration, easing) {
  await page.evaluate(async ({ destinationRatio, duration, easing }) => {
    const easingFunctions = {
      linear: t => t,
      easeInOutCubic: t => t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2,
      easeInOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2
    };
    const ease = easingFunctions[easing] ?? easingFunctions.easeInOutCubic;
    const startY = window.scrollY;
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const targetY = Math.max(0, Math.min(maxY, maxY * destinationRatio));
    const start = performance.now();
    await new Promise(resolve => {
      const tick = now => {
        const progress = Math.min(1, (now - start) / duration);
        window.scrollTo(0, startY + (targetY - startY) * ease(progress));
        if (progress < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }, { destinationRatio, duration, easing });
}

async function playTimeline(page, timeline, durationSeconds) {
  const startedAt = performance.now();
  for (const step of timeline) {
    if (step.hold) await delay(step.hold);
    else if (step.jumpTo !== undefined) {
      await page.evaluate(ratio => {
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(0, maxY * ratio);
      }, Number(step.jumpTo));
    }
    else await smoothScroll(page, Number(step.to), Number(step.duration), step.easing);
  }
  const remaining = durationSeconds * 1000 - (performance.now() - startedAt);
  if (remaining > 0) await delay(remaining);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}`)));
  });
}

function buildVideoFilter(config, profile) {
  const borderPercent = Math.max(0, Math.min(0.2, Number(profile.videoBorderPercent ?? 0)));
  const contentWidth = Math.max(2, Math.floor(profile.width * (1 - borderPercent * 2) / 2) * 2);
  const contentHeight = Math.max(2, Math.floor(profile.height * (1 - borderPercent * 2) / 2) * 2);
  return [
    'setpts=PTS-STARTPTS',
    'tpad=stop_mode=clone:stop_duration=1',
    `fps=${config.fps}`,
    `scale=${contentWidth}:${contentHeight}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1'
  ].join(',');
}

async function transcode(input, output, config, profile, trimStartSeconds) {
  const tempOutput = output.replace(/\.mp4$/i, '.tmp.mp4');
  const filter = buildVideoFilter(config, profile);
  await rm(tempOutput, { force: true });
  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-ss', trimStartSeconds.toFixed(3), '-i', input,
    '-t', String(config.durationSeconds), '-an',
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    tempOutput
  ]);
  await rm(output, { force: true });
  await rename(tempOutput, output);
}

async function transcodeFrames(framesDirectory, frameCount, output, config, profile) {
  const tempOutput = output.replace(/\.mp4$/i, '.tmp.mp4');
  const inputFps = frameCount / config.durationSeconds;
  const filter = buildVideoFilter(config, profile);
  await rm(tempOutput, { force: true });
  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-framerate', inputFps.toFixed(6),
    '-start_number', '0',
    '-i', path.join(framesDirectory, 'frame-%06d.jpg'),
    '-t', String(config.durationSeconds), '-an',
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    tempOutput
  ]);
  await rm(output, { force: true });
  await rename(tempOutput, output);
}

async function normalizeScreenshot(input, output, profile) {
  const tempOutput = output.replace(/\.png$/i, '.tmp.png');
  const filter = [
    `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=white`,
    'setsar=1'
  ].join(',');
  await rm(tempOutput, { force: true });
  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-i', input,
    '-vf', filter,
    '-frames:v', '1',
    tempOutput
  ]);
  await rm(output, { force: true });
  await rename(tempOutput, output);
  await rm(input, { force: true });
}

async function captureProfile(browser, config, profileName, profile, directories, outputTypes) {
  const rawDirectory = path.join(directories.work, profileName);
  await mkdir(rawDirectory, { recursive: true });
  const viewportWidth = profile.viewportWidth ?? profile.width;
  const viewportHeight = profile.viewportHeight ?? profile.height;
  const captureVideo = outputTypes.includes('video');
  const captureScreenshot = outputTypes.includes('screenshot');
  const useScreencast = captureVideo && profile.captureMode === 'screencast';
  const contextOptions = {
    viewport: { width: viewportWidth, height: viewportHeight },
    screen: { width: viewportWidth, height: viewportHeight },
    deviceScaleFactor: profile.deviceScaleFactor ?? 1,
    isMobile: profile.isMobile ?? false,
    hasTouch: profile.hasTouch ?? false,
    userAgent: profile.userAgent,
    locale: profile.locale ?? 'pt-BR',
    colorScheme: profile.colorScheme ?? 'light',
    reducedMotion: 'no-preference'
  };
  if (captureVideo && !useScreencast) {
    contextOptions.recordVideo = {
      dir: rawDirectory,
      size: {
        width: profile.captureWidth ?? viewportWidth,
        height: profile.captureHeight ?? viewportHeight
      },
      fps: config.fps
    };
  }
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const recordingStartedAt = performance.now();
  page.on('console', message => {
    if (message.type() === 'error') console.warn(`[browser:${profileName}] ${message.text()}`);
  });
  const video = captureVideo && !useScreencast ? page.video() : null;
  console.log(`\n[${profileName}] Loading ${config.url}`);
  await preparePage(page, config);
  const outputs = [];

  if (captureScreenshot) {
    const rawScreenshot = path.join(rawDirectory, 'screenshot.raw.png');
    const screenshotOutput = path.join(directories.output, `${config.name}-${profileName}-${profile.width}x${profile.height}.png`);
    console.log(`[${profileName}] Screenshot ${path.basename(screenshotOutput)}`);
    await page.screenshot({
      path: rawScreenshot,
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
      scale: 'device'
    });
    await normalizeScreenshot(rawScreenshot, screenshotOutput, profile);
    const screenshotStat = await stat(screenshotOutput);
    console.log(`[${profileName}] Screenshot done (${(screenshotStat.size / 1024 / 1024).toFixed(1)} MB)`);
    outputs.push(screenshotOutput);
  }

  if (!captureVideo) {
    await context.close();
    return outputs;
  }

  const captureStartSeconds = (performance.now() - recordingStartedAt) / 1000;
  console.log(`[${profileName}] Recording ${config.durationSeconds}s timeline`);
  const output = path.join(directories.output, `${config.name}-${profileName}-${profile.width}x${profile.height}-${config.fps}fps.mp4`);
  if (useScreencast) {
    const framesDirectory = path.join(rawDirectory, 'frames');
    await rm(framesDirectory, { recursive: true, force: true });
    await mkdir(framesDirectory, { recursive: true });
    const session = await context.newCDPSession(page);
    const frameWrites = [];
    let frameCount = 0;
    session.on('Page.screencastFrame', event => {
      const frameNumber = frameCount++;
      const filename = path.join(framesDirectory, `frame-${String(frameNumber).padStart(6, '0')}.jpg`);
      frameWrites.push(writeFile(filename, Buffer.from(event.data, 'base64')));
      session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 95,
      maxWidth: profile.captureWidth ?? profile.width,
      maxHeight: profile.captureHeight ?? profile.height,
      everyNthFrame: 1
    });
    await playTimeline(page, config.timeline, config.durationSeconds);
    await session.send('Page.stopScreencast');
    await delay(250);
    await Promise.all(frameWrites);
    await context.close();
    if (frameCount < 2) throw new Error(`Screencast produced only ${frameCount} frame(s).`);
    console.log(`[${profileName}] Encoding ${frameCount} native frames as ${path.basename(output)}`);
    await transcodeFrames(framesDirectory, frameCount, output, config, profile);
    await rm(framesDirectory, { recursive: true, force: true });
  } else {
    await playTimeline(page, config.timeline, config.durationSeconds);
    await delay(350);
    await context.close();
    const rawVideo = await video.path();
    console.log(`[${profileName}] Encoding ${path.basename(output)}`);
    await transcode(rawVideo, output, config, profile, captureStartSeconds);
  }
  const outputStat = await stat(output);
  console.log(`[${profileName}] Done (${(outputStat.size / 1024 / 1024).toFixed(1)} MB)`);
  outputs.push(output);
  return outputs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const config = await loadConfig(args);
  const root = process.cwd();
  const directories = {
    output: path.resolve(args.outputDir ?? path.join(root, 'outputs')),
    work: path.resolve(path.join(root, 'work', 'recordings', config.name))
  };
  await mkdir(directories.output, { recursive: true });
  await mkdir(directories.work, { recursive: true });
  const selectedProfiles = args.profiles.length ? args.profiles : Object.keys(config.profiles);
  const selectedOutputTypes = args.types.length ? [...new Set(args.types)] : ['video'];
  for (const profileName of selectedProfiles) {
    if (!config.profiles[profileName]) throw new Error(`Unknown profile: ${profileName}`);
  }
  for (const outputType of selectedOutputTypes) {
    if (!['video', 'screenshot'].includes(outputType)) throw new Error(`Unknown output type: ${outputType}`);
  }
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide an FFmpeg executable.');

  console.log(`Capturing ${config.url}`);
  console.log(`Profiles: ${selectedProfiles.join(', ')} | Outputs: ${selectedOutputTypes.join(', ')}`);
  const browser = await chromium.launch({ headless: args.headless !== false });
  const outputs = [];
  try {
    for (const profileName of selectedProfiles) {
      outputs.push(...await captureProfile(browser, config, profileName, config.profiles[profileName], directories, selectedOutputTypes));
    }
  } finally {
    await browser.close();
  }
  console.log('\nCreated:');
  for (const output of outputs) console.log(`- ${output}`);
}

main().catch(error => {
  console.error(`\nCapture failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
