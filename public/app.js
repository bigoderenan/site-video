const form = document.querySelector('#generator-form');
const submitButton = form.querySelector('.generate');
const idleState = document.querySelector('#idle-state');
const runningState = document.querySelector('#running-state');
const resultState = document.querySelector('#result-state');
const errorState = document.querySelector('#error-state');
const statusMessage = document.querySelector('#status-message');
const progressBar = document.querySelector('#progress-bar');
const progressNumber = document.querySelector('#progress-number');
const resultFiles = document.querySelector('#result-files');
const expiry = document.querySelector('#expiry');
const outputInputs = [...form.querySelectorAll('input[name="output"]')];
const videoSettings = [...form.querySelectorAll('.video-setting')];
const submitLabel = submitButton.querySelector('span');

const apiUrl = relative => new URL(relative, window.location.href).toString();

function showState(state) {
  idleState.hidden = state !== 'idle';
  runningState.hidden = state !== 'running';
  resultState.hidden = state !== 'result';
  errorState.hidden = state !== 'error';
}

function setProgress(progress, message) {
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  progressBar.style.width = `${value}%`;
  progressNumber.textContent = `${value}%`;
  if (message) statusMessage.textContent = message;
}

function normalizeUrl(value) {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function reset() {
  submitButton.disabled = false;
  setProgress(0, 'Preparando a geração…');
  resultFiles.replaceChildren();
  showState('idle');
}

function syncOutputOptions() {
  const videoEnabled = outputInputs.some(input => input.value === 'video' && input.checked);
  for (const setting of videoSettings) setting.hidden = !videoEnabled;
  form.duration.disabled = !videoEnabled;
  form.easing.disabled = !videoEnabled;
  const screenshotEnabled = outputInputs.some(input => input.value === 'screenshot' && input.checked);
  submitLabel.textContent = videoEnabled && screenshotEnabled
    ? 'Gerar vídeos e capturas'
    : videoEnabled ? 'Gerar vídeos' : 'Gerar capturas';
}

for (const input of outputInputs) input.addEventListener('change', syncOutputOptions);
syncOutputOptions();

form.addEventListener('submit', async event => {
  event.preventDefault();
  const profiles = [...form.querySelectorAll('input[name="profile"]:checked')].map(input => input.value);
  if (!profiles.length) return alert('Selecione pelo menos um formato.');
  const outputTypes = outputInputs.filter(input => input.checked).map(input => input.value);
  if (!outputTypes.length) return alert('Selecione pelo menos um tipo de arquivo.');
  submitButton.disabled = true;
  showState('running');
  setProgress(2, 'Enviando a configuração…');
  const payload = {
    url: normalizeUrl(form.url.value),
    name: form.name.value,
    profiles,
    outputTypes,
    durationSeconds: Number(form.duration.value),
    easing: form.easing.value
  };
  try {
    const response = await fetch(apiUrl('api/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível iniciar.');
    const events = new EventSource(apiUrl(`api/jobs/${data.id}/events`));
    events.addEventListener('progress', event => {
      const update = JSON.parse(event.data);
      setProgress(update.progress, update.message);
    });
    events.addEventListener('complete', event => {
      events.close();
      const update = JSON.parse(event.data);
      resultFiles.replaceChildren(...update.files.map(file => {
        const link = document.createElement('a');
        link.className = 'file-link';
        link.href = apiUrl(file.url);
        link.download = file.filename;
        const mode = file.profile === 'desktop' ? 'desktop' : 'mobile';
        const title = file.type === 'screenshot' ? `Captura ${mode}` : `Vídeo ${mode}`;
        const dimensions = file.profile === 'desktop' ? '1920 × 1080' : '1080 × 1920';
        const details = file.type === 'screenshot' ? `${dimensions} · PNG` : `${dimensions} · 60 FPS`;
        link.innerHTML = `<span><strong>${title}</strong><small>${details}</small></span><span class="download-icon">↓</span>`;
        return link;
      }));
      const time = new Date(update.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      expiry.textContent = `Downloads disponíveis até ${time}.`;
      submitButton.disabled = false;
      showState('result');
    });
    events.addEventListener('failed', event => {
      events.close();
      const update = JSON.parse(event.data);
      document.querySelector('#error-message').textContent = update.message;
      submitButton.disabled = false;
      showState('error');
    });
    events.onerror = () => {
      if (events.readyState !== EventSource.CLOSED) statusMessage.textContent = 'Reconectando ao servidor…';
    };
  } catch (error) {
    document.querySelector('#error-message').textContent = error.message;
    submitButton.disabled = false;
    showState('error');
  }
});

document.querySelector('#new-job').addEventListener('click', reset);
document.querySelector('#retry-job').addEventListener('click', reset);
