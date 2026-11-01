# Instalação no DirectAdmin

## 1. Envie e extraia o projeto

Envie o ZIP para a pasta inicial da conta e extraia em:

```text
/home/usuario/site-video
```

Não coloque o projeto dentro de `public_html`; o DirectAdmin publicará a
aplicação Node.js na URL escolhida.

## 2. Crie a aplicação Node.js

Preencha o formulário com:

| Campo | Valor |
| --- | --- |
| Versão Node.js | `24.20.0` (ou qualquer versão 20+) |
| Modo de aplicação | `Production` |
| Raiz do aplicativo | `site-video` |
| URL do aplicativo | domínio `example.com`, caminho `site-video` |
| Arquivo de inicialização | `app.js` |

Adicione estas variáveis de ambiente:

| Variável | Valor |
| --- | --- |
| `APP_BASE_PATH` | `/site-video` |
| `FILE_TTL_MINUTES` | `60` |

Depois clique em **Criar**.

## 3. Ative o ambiente e instale

O DirectAdmin mostrará um comando `source` específico para a aplicação. Execute
esse comando no SSH e depois:

```bash
cd /home/usuario/site-video
npm install
npx playwright install chromium
```

O pacote `ffmpeg-static` instala o FFmpeg dentro do próprio projeto; não é
necessário haver um `ffmpeg` global.

## 4. Reinicie e abra

Use **Restart** na aplicação Node.js e abra:

```text
https://example.com/site-video/
```

## Se o Chromium não iniciar

Se a mensagem mencionar bibliotecas Linux ausentes, envie o erro ao suporte da
hospedagem. Em hospedagem compartilhada, somente o administrador pode instalar
essas dependências do sistema. Se a mensagem mencionar sandbox ou permissão, a
hospedagem pode estar bloqueando navegadores headless.

## Funcionamento

- Uma geração por vez.
- Desktop 1920x1080 e mobile 1080x1920.
- Auto scroll descendo e subindo.
- Saída MP4 H.264 a 60 FPS.
- Bloqueio de URLs locais e redes privadas.
- Vídeos removidos automaticamente após 60 minutos.
