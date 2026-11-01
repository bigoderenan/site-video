import http from 'node:http';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { ZipArchive } from 'archiver';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(root, 'public');
const outputDirectory = path.join(root, 'outputs');
const jobsDirectory = path.join(root, 'work', 'ui-jobs');
const captureScript = path.join(root, 'src', 'capture.mjs');
const baseConfigPath = path.join(root, 'sites', 'default.json');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const configuredBasePath = normalizeBasePath(process.env.APP_BASE_PATH || '');
const expiryMilliseconds = Math.max(5, Number(process.env.FILE_TTL_MINUTES || 10)) * 60_000;
const jobs = new Map();
let activeJobId = null;

await mkdir(outputDirectory, { recursive: true });
await mkdir(jobsDirectory, { recursive: true });

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  return `/${String(value).replace(/^\/+|\/+$/g, '')}`;
}

function routePath(pathname) {
  if (configuredBasePath && pathname.startsWith(configuredBasePath)) {
    return pathname.slice(configuredBasePath.length) || '/';
  }
  return pathname;
}

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || parts[0] === 0;
}

async function validatePublicUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Informe uma URL válida.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('A URL deve usar HTTP ou HTTPS.');
  if (parsed.username || parsed.password) throw new Error('URLs com credenciais não são permitidas.');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('Endereços locais não são permitidos.');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('A URL não pode apontar para uma rede privada.');
  }
  return parsed.href;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error('Requisição muito grande.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function emit(job, type, payload) {
  const event = { type, payload };
  job.events.push(event);
  for (const client of job.clients) {
    client.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

function progressFromLine(line, job) {
  const profileCount = job.profiles.length;
  let progress = job.progress;
  let message = line;
  if (/Loading /.test(line)) {
    const mobile = line.includes('[mobile]');
    progress = profileCount === 1 ? 12 : mobile ? 56 : 8;
    message = mobile ? 'Abrindo o site no formato mobile…' : 'Abrindo o site no formato desktop…';
  } else if (/Screenshot done/.test(line)) {
    const mobile = line.includes('[mobile]');
    const screenshotOnly = job.outputTypes.length === 1 && job.outputTypes[0] === 'screenshot';
    progress = screenshotOnly ? (profileCount === 1 ? 94 : mobile ? 96 : 49) : (profileCount === 1 ? 18 : mobile ? 62 : 12);
    message = mobile ? 'Captura mobile pronta.' : 'Captura desktop pronta.';
  } else if (/Screenshot /.test(line)) {
    const mobile = line.includes('[mobile]');
    progress = profileCount === 1 ? 15 : mobile ? 60 : 10;
    message = mobile ? 'Capturando a tela mobile…' : 'Capturando a tela desktop…';
  } else if (/Recording /.test(line)) {
    const mobile = line.includes('[mobile]');
    progress = profileCount === 1 ? 30 : mobile ? 66 : 20;
    message = mobile ? 'Gravando o movimento mobile…' : 'Gravando o movimento desktop…';
  } else if (/Encoding /.test(line)) {
    const mobile = line.includes('[mobile]');
    progress = profileCount === 1 ? 74 : mobile ? 86 : 38;
    message = mobile ? 'Finalizando o vídeo mobile…' : 'Finalizando o vídeo desktop…';
  } else if (/Done \(/.test(line)) {
    const mobile = line.includes('[mobile]');
    progress = profileCount === 1 ? 94 : mobile ? 96 : 49;
    message = mobile ? 'Vídeo mobile pronto.' : 'Vídeo desktop pronto.';
  } else return;
  job.progress = Math.max(job.progress, progress);
  emit(job, 'progress', { progress: job.progress, message });
}

async function createZip(files, zipPath) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = new ZipArchive({ store: true });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    for (const file of files) {
      archive.file(path.join(outputDirectory, file.filename), { name: file.filename });
    }
    archive.finalize();
  });
}

async function startJob(job, config) {
  activeJobId = job.id;
  const configPath = path.join(jobsDirectory, `${job.id}.json`);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const args = [captureScript, '--config', configPath];
  for (const profile of job.profiles) args.push('--profile', profile);
  for (const outputType of job.outputTypes) args.push('--type', outputType);
  emit(job, 'progress', { progress: 3, message: 'Preparando a geração…' });
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  job.child = child;
  const consume = stream => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) progressFromLine(line, job);
    });
  };
  consume(child.stdout);
  consume(child.stderr);
  child.once('error', error => {
    job.status = 'failed';
    activeJobId = null;
    emit(job, 'failed', { message: error.message });
  });
  child.once('exit', async code => {
    activeJobId = null;
    job.child = null;
    if (code !== 0) {
      job.status = 'failed';
      emit(job, 'failed', { message: 'A geração falhou. Verifique se Chromium e FFmpeg estão instalados.' });
      return;
    }
    job.status = 'complete';
    job.progress = 100;
    const expiresAt = Date.now() + expiryMilliseconds;
    const files = job.profiles.flatMap(profile => job.outputTypes.map(type => {
      const dimensions = profile === 'desktop' ? '1920x1080' : '1080x1920';
      const filename = type === 'screenshot'
        ? `${config.name}-${profile}-${dimensions}.png`
        : `${config.name}-${profile}-${dimensions}-${config.fps}fps.mp4`;
      setTimeout(() => unlink(path.join(outputDirectory, filename)).catch(() => {}), expiryMilliseconds).unref();
      return { profile, type, fps: type === 'video' ? config.fps : undefined, filename, url: `outputs/${encodeURIComponent(filename)}` };
    }));
    let bundle;
    try {
      if (files.length > 1) {
        const filename = `${config.name}-arquivos.zip`;
        await createZip(files, path.join(outputDirectory, filename));
        setTimeout(() => unlink(path.join(outputDirectory, filename)).catch(() => {}), expiryMilliseconds).unref();
        bundle = { filename, url: `outputs/${encodeURIComponent(filename)}`, count: files.length };
      }
      emit(job, 'complete', { progress: 100, message: 'Arquivos concluídos.', files, bundle, expiresAt });
    } catch (error) {
      job.status = 'failed';
      emit(job, 'failed', { message: `Os arquivos foram gerados, mas o ZIP falhou: ${error.message}` });
    }
  });
}

async function createJob(request, response) {
  if (activeJobId) return json(response, 409, { error: 'Já existe uma geração em andamento.' });
  try {
    const body = await readBody(request);
    const url = await validatePublicUrl(body.url);
    const parsedUrl = new URL(url);
    const name = slugify(body.name || parsedUrl.hostname.replace(/^www\./, '').split('.')[0]);
    if (!name) throw new Error('Informe um nome para o projeto.');
    const profiles = ['desktop', 'mobile'].filter(profile => body.profiles?.includes(profile));
    if (!profiles.length) throw new Error('Selecione pelo menos um formato.');
    const requestedOutputTypes = Array.isArray(body.outputTypes) ? body.outputTypes : ['video'];
    const outputTypes = ['video', 'screenshot'].filter(type => requestedOutputTypes.includes(type));
    if (!outputTypes.length) throw new Error('Selecione pelo menos um tipo de arquivo.');
    const desktopCaptureMode = ['recordVideo', 'screencast'].includes(body.desktopCaptureMode)
      ? body.desktopCaptureMode
      : 'screencast';
    const durationSeconds = Math.round(Number(body.durationSeconds || 20));
    if (durationSeconds < 10 || durationSeconds > 60) throw new Error('A duração deve ficar entre 10 e 60 segundos.');
    const requestedFps = Number(body.fps ?? 60);
    if (!Number.isInteger(requestedFps) || requestedFps < 1 || requestedFps > 120) {
      throw new Error('O FPS deve ser um número inteiro entre 1 e 120.');
    }
    const fps = requestedFps;
    const easing = ['easeInOutSine', 'easeInOutCubic', 'linear'].includes(body.easing) ? body.easing : 'easeInOutSine';
    const baseConfig = JSON.parse(await readFile(baseConfigPath, 'utf8'));
    const halfDuration = durationSeconds * 500;
    const config = {
      ...baseConfig,
      name,
      url,
      durationSeconds,
      fps,
      profiles: {
        ...baseConfig.profiles,
        desktop: {
          ...baseConfig.profiles.desktop,
          captureMode: desktopCaptureMode,
          captureWidth: baseConfig.profiles.desktop.width,
          captureHeight: baseConfig.profiles.desktop.height
        }
      },
      timeline: [
        { to: 1, duration: halfDuration, easing },
        { to: 0, duration: halfDuration, easing }
      ]
    };
    const id = crypto.randomUUID();
    const job = { id, status: 'running', progress: 0, profiles, outputTypes, events: [], clients: new Set(), child: null };
    jobs.set(id, job);
    json(response, 202, { id });
    startJob(job, config).catch(error => {
      activeJobId = null;
      job.status = 'failed';
      emit(job, 'failed', { message: error.message });
    });
  } catch (error) {
    json(response, 400, { error: error.message });
  }
}

function streamJobEvents(request, response, id) {
  const job = jobs.get(id);
  if (!job) return json(response, 404, { error: 'Geração não encontrada.' });
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.write(': connected\n\n');
  for (const event of job.events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
  }
  job.clients.add(response);
  request.once('close', () => job.clients.delete(response));
}

async function serveFile(response, filename, directory = publicDirectory) {
  const safeName = path.basename(filename);
  const filePath = path.join(directory, safeName);
  try {
    const fileStat = await stat(filePath);
    const extension = path.extname(safeName).toLowerCase();
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.mp4': 'video/mp4',
      '.zip': 'application/zip'
    };
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Content-Length': fileStat.size,
      'Cache-Control': ['.mp4', '.png'].includes(extension) ? 'private, max-age=300' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    json(response, 404, { error: 'Arquivo não encontrado.' });
  }
}

async function removeExpiredOutputs() {
  const now = Date.now();
  for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(mp4|png|zip)$/i.test(entry.name)) continue;
    const filePath = path.join(outputDirectory, entry.name);
    const fileStat = await stat(filePath).catch(() => null);
    if (fileStat && now - fileStat.mtimeMs > expiryMilliseconds) await unlink(filePath).catch(() => {});
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const incomingUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (configuredBasePath && incomingUrl.pathname === configuredBasePath) {
      response.writeHead(302, { Location: `${configuredBasePath}/` });
      return response.end();
    }
    const pathname = routePath(incomingUrl.pathname);
    if (request.method === 'POST' && pathname === '/api/jobs') return createJob(request, response);
    const eventMatch = pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/events$/i);
    if (request.method === 'GET' && eventMatch) return streamJobEvents(request, response, eventMatch[1]);
    if (request.method === 'GET' && pathname.startsWith('/outputs/')) {
      return serveFile(response, decodeURIComponent(pathname.slice('/outputs/'.length)), outputDirectory);
    }
    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return serveFile(response, 'index.html');
    if (request.method === 'GET' && pathname.startsWith('/assets/')) return serveFile(response, pathname.slice('/assets/'.length));
    json(response, 404, { error: 'Página não encontrada.' });
  } catch (error) {
    json(response, 500, { error: error.message });
  }
});

removeExpiredOutputs().catch(() => {});
setInterval(() => removeExpiredOutputs().catch(() => {}), 10 * 60_000).unref();
server.listen(port, host, () => {
  console.log(`Site Video Studio running on http://${host}:${port}${configuredBasePath || '/'}`);
});
