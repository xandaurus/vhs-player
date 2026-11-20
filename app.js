(() => {
  const canvas = document.getElementById('glCanvas');
  const video = document.getElementById('sourceVideo');
  const fileInput = document.getElementById('fileInput');
  const pickBtn = document.getElementById('pickBtn');
  const dropZone = document.getElementById('dropZone');
  const overlay = document.getElementById('overlay');
  const osd = document.getElementById('osd');
  const osdTime = document.getElementById('osdTime');
  const osdStatus = document.getElementById('osdStatus');
  const fileNameEl = document.getElementById('fileName');
  const timeDisplay = document.getElementById('timeDisplay');

  const btnPlay = document.getElementById('btnPlay');
  const btnStop = document.getElementById('btnStop');
  const btnRew = document.getElementById('btnRew');
  const btnFf = document.getElementById('btnFf');

  const trackingSlider = document.getElementById('tracking');
  const noiseSlider = document.getElementById('noise');
  const chromaSlider = document.getElementById('chroma');
  const wearSlider = document.getElementById('wear');
  const fpsSlider = document.getElementById('fps');
  const fpsValueEl = document.getElementById('fpsValue');
  const seekSlider = document.getElementById('seekSlider');
  const btnVhs = document.getElementById('btnVhs');
  const btnFs = document.getElementById('btnFs');
  const effectSliders = document.getElementById('effectSliders');
  const effectInputs = [trackingSlider, noiseSlider, chromaSlider, wearSlider, fpsSlider];
  const vcrRoot = document.querySelector('.vcr');
  const actionToast = document.getElementById('actionToast');
  let toastTimer = null;

  let gl = null;
  let program = null;
  let texture = null;
  let startTime = 0;
  let animId = null;
  let hasTape = false;
  let currentFile = null;
  let audioCtx = null;
  let audioSource = null;
  let audioNodes = {};

  // Frame limiting for VHS-style low FPS
  let lastFrameTime = 0;
  let targetFps = 24;
  let frameInterval = 1000 / 24;

  // Seek bar
  let isSeeking = false;

  // VHS auto-modulation (default ON)
  let vhsAuto = true;
  let vhsLastTs = 0;
  const vhsParams = {
    tracking: { value: 15, target: 15, speed: 5 },
    noise:    { value: 5,  target: 5,  speed: 4 },
    chroma:   { value: 30, target: 30, speed: 6 },
    wear:     { value: 50, target: 50, speed: 3 }
  };

  // ---------- WebGL setup ----------
  function initGL() {
    gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false
    });
    if (!gl) {
      alert('WebGL не поддерживается в этом браузере');
      return false;
    }

    const vsSource = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        v_uv.y = 1.0 - v_uv.y;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_tex;
      uniform vec2 u_res;
      uniform float u_time;
      uniform float u_tracking;
      uniform float u_noise;
      uniform float u_chroma;
      uniform float u_wear;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      float noise2(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      void main() {
        vec2 uv = v_uv;
        float t = u_time;

        // --- Tape wave / horizontal wobble ---
        float wave = sin(uv.y * 8.0 + t * 1.4) * 0.003 * u_wear;
        wave += sin(uv.y * 23.0 - t * 2.1) * 0.0015 * u_wear;
        uv.x += wave;

        // --- Per-line jitter (tracking) ---
        float line = floor(uv.y * u_res.y);
        float jitter = (hash(vec2(line, floor(t * 25.0))) - 0.5) * 0.008 * u_tracking;
        uv.x += jitter;

        // --- Rolling tracking band ---
        float bandY = fract(t * 0.12);
        float band = smoothstep(0.04, 0.0, abs(uv.y - bandY));
        uv.x += band * (hash(vec2(line, floor(t * 10.0))) - 0.3) * 0.04 * u_tracking;

        // --- Head switching noise at bottom ---
        float head = smoothstep(0.92, 1.0, uv.y);
        uv.x += head * (hash(vec2(line * 0.5, floor(t * 30.0))) - 0.5) * 0.06 * u_wear;

        // clamp
        uv = clamp(uv, 0.001, 0.999);

        // --- Chroma shift / bleed ---
        float shift = 0.004 * u_chroma;
        float r = texture2D(u_tex, uv + vec2(shift, 0.0)).r;
        float g = texture2D(u_tex, uv).g;
        float b = texture2D(u_tex, uv - vec2(shift * 1.2, 0.0)).b;

        // mild horizontal smear for chroma
        float smear = 0.0;
        for (int i = 1; i <= 3; i++) {
          float o = float(i) * 0.002 * u_chroma;
          smear += texture2D(u_tex, uv + vec2(o, 0.0)).g;
        }
        g = mix(g, smear / 3.0, 0.35 * u_chroma);

        vec3 col = vec3(r, g, b);

        // --- Scanlines ---
        float scan = sin(uv.y * u_res.y * 3.14159);
        col *= 0.88 + 0.12 * scan;

        // --- Grain / noise ---
        float n = noise2(uv * u_res * 0.4 + t * 8.0);
        float grain = (n - 0.5) * 0.18 * u_noise;
        // stronger in dark areas
        float lum = dot(col, vec3(0.299, 0.587, 0.114));
        grain *= 1.0 + (1.0 - lum) * 0.8;
        col += grain;

        // occasional white sparkle
        float spark = step(0.997, hash(uv * 40.0 + floor(t * 20.0)));
        col += spark * 0.4 * u_noise;

        // --- Soft color wash (slightly warm / desaturated) ---
        float gray = dot(col, vec3(0.3, 0.59, 0.11));
        col = mix(col, vec3(gray), 0.12 * u_wear);
        col *= vec3(1.05, 0.98, 0.92); // mild warm tint

        // vignette
        vec2 vig = uv * (1.0 - uv);
        float vigAmt = vig.x * vig.y * 15.0;
        vigAmt = pow(vigAmt, 0.25);
        col *= mix(0.75, 1.0, vigAmt);

        // slight overall contrast
        col = (col - 0.5) * 1.08 + 0.5;

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `;

    function compile(type, source) {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    }

    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return false;
    }
    gl.useProgram(program);

    // full-screen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  1, -1,  -1, 1,
      -1,  1,  1, -1,   1, 1
    ]), gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // uniforms
    program.u = {
      tex: gl.getUniformLocation(program, 'u_tex'),
      res: gl.getUniformLocation(program, 'u_res'),
      time: gl.getUniformLocation(program, 'u_time'),
      tracking: gl.getUniformLocation(program, 'u_tracking'),
      noise: gl.getUniformLocation(program, 'u_noise'),
      chroma: gl.getUniformLocation(program, 'u_chroma'),
      wear: gl.getUniformLocation(program, 'u_wear')
    };

    return true;
  }

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // ---------- Render loop ----------
  function render(now) {
    if (!hasTape || !gl) {
      animId = requestAnimationFrame(render);
      return;
    }

    // Frame limiting: only pull a new video frame at the selected FPS
    // (shader effects still run every display frame so noise/tracking stay alive)
    const shouldUpdateFrame = (now - lastFrameTime) >= frameInterval;

    if (video.readyState >= 2) {
      if (shouldUpdateFrame) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        } catch (e) {}
        lastFrameTime = now;
      }

      const t = (now - startTime) * 0.001;
      let tracking = trackingSlider.value / 100;
      let noise = noiseSlider.value / 100;
      const chroma = chromaSlider.value / 100;
      const wear = wearSlider.value / 100;

      // На паузе — головка «держит» кадр с трудом: сильнее рябь и дёргание
      if (video.paused && hasTape && !video.ended) {
        tracking = Math.min(1, tracking * 2.8 + 0.35);
        noise = Math.min(1, noise * 2.2 + 0.25);
      }

      gl.uniform1i(program.u.tex, 0);
      gl.uniform2f(program.u.res, canvas.width, canvas.height);
      gl.uniform1f(program.u.time, t);
      gl.uniform1f(program.u.tracking, tracking);
      gl.uniform1f(program.u.noise, noise);
      gl.uniform1f(program.u.chroma, chroma);
      gl.uniform1f(program.u.wear, wear);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // OSD + seek bar update
    if (hasTape && video.readyState >= 1) {
      const dur = video.duration || 0;
      const cur = video.currentTime || 0;
      const timeStr = `${formatTime(cur)} / ${formatTime(dur)}`;
      if (!video.paused) {
        osdTime.textContent = formatTime(cur);
      }
      timeDisplay.textContent = timeStr;
      if (!isSeeking && seekSlider && dur > 0 && isFinite(dur)) {
        seekSlider.value = Math.round((cur / dur) * 1000);
      }
    }

    // VHS auto-modulation — only while actually playing (saves CPU on pause / idle)
    if (vhsAuto && hasTape && !video.paused && !video.ended) {
      tickVhsModulation(now);
    }

    animId = requestAnimationFrame(render);
  }

  function formatTime(s) {
    if (!isFinite(s)) return '--:--';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // ---------- Audio (AceStep-style: dull + hiss + soft wow) ----------
  let audioReady = false;

  function setupAudio() {
    if (audioReady) return;

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();

      // MediaElementSource takes over output — do not mute the element
      video.muted = false;
      video.volume = 1;

      audioSource = audioCtx.createMediaElementSource(video);

      // 1. High-pass — убрать гул
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 60;
      highpass.Q.value = 0.7;

      // 2. Low-pass — основной «кассетный» dull
      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 9500;
      lowpass.Q.value = 0.7;

      // 3. Лёгкий mid boost (тепло)
      const warmth = audioCtx.createBiquadFilter();
      warmth.type = 'peaking';
      warmth.frequency.value = 900;
      warmth.Q.value = 0.8;
      warmth.gain.value = 2.0;

      // 4. Очень мягкая сатурация
      const shaper = audioCtx.createWaveShaper();
      shaper.curve = makeDistortionCurve(8);
      shaper.oversample = '2x';

      // 5. Лёгкий компрессор
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 10;
      compressor.ratio.value = 2.5;
      compressor.attack.value = 0.02;
      compressor.release.value = 0.25;

      // 6. Wow (медленное дрожание высоты)
      const delayNode = audioCtx.createDelay(0.025);
      delayNode.delayTime.value = 0.006;

      const wowOsc = audioCtx.createOscillator();
      wowOsc.type = 'sine';
      wowOsc.frequency.value = 0.45; // ~0.45 Hz
      const wowGain = audioCtx.createGain();
      wowGain.gain.value = 0.0015; // едва заметно
      wowOsc.connect(wowGain);
      wowGain.connect(delayNode.delayTime);

      // 7. Тихий tape hiss
      const bufferSize = Math.floor(audioCtx.sampleRate * 2);
      const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < bufferSize; i++) {
        // простой pink-ish noise
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 0.35;
      }
      const noiseSrc = audioCtx.createBufferSource();
      noiseSrc.buffer = noiseBuffer;
      noiseSrc.loop = true;

      const noiseFilter = audioCtx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 3500;
      noiseFilter.Q.value = 0.6;

      const noiseGain = audioCtx.createGain();
      noiseGain.gain.value = 0.008; // тихо по умолчанию

      // Master
      const master = audioCtx.createGain();
      master.gain.value = 1.05;

      // Цепочка сигнала
      audioSource.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(warmth);
      warmth.connect(shaper);
      shaper.connect(compressor);
      compressor.connect(delayNode);
      delayNode.connect(master);

      // Шум отдельно
      noiseSrc.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(master);

      master.connect(audioCtx.destination);

      noiseSrc.start();
      wowOsc.start();

      audioNodes = { lowpass, warmth, noiseGain, wowGain, master };
      audioReady = true;

      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    } catch (e) {
      console.error('Audio graph setup failed', e);
      video.muted = false;
      video.volume = 1;
    }
  }

  function makeDistortionCurve(amount) {
    const n = 44100;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  function updateAudioFromSliders() {
    if (!audioReady || !audioNodes.lowpass) return;

    const wear = wearSlider.value / 100;
    const noise = noiseSlider.value / 100;

    // Wear: 0 → ~11.5 kHz, 1 → ~5.5 kHz
    audioNodes.lowpass.frequency.value = 11500 - wear * 6000;

    // Чуть больше тепла при сильном wear
    if (audioNodes.warmth) {
      audioNodes.warmth.gain.value = 1.5 + wear * 2.5;
    }

    // Noise: очень тихо → заметный шип
    audioNodes.noiseGain.gain.value = 0.003 + noise * 0.028;

    // Wow чуть сильнее на изношенной ленте
    if (audioNodes.wowGain) {
      audioNodes.wowGain.gain.value = 0.0008 + wear * 0.0025;
    }
  }

  // ---------- Startup sequence (blue → snow → play) ----------
  const startupSeq = document.getElementById('startupSeq');
  const startupBlue = document.getElementById('startupBlue');
  const snowCanvas = document.getElementById('snowCanvas');
  let snowAnimId = null;

  function drawSnowFrame() {
    if (!snowCanvas || snowCanvas.classList.contains('hidden')) return;
    const ctx = snowCanvas.getContext('2d');
    const w = snowCanvas.width;
    const h = snowCanvas.height;
    if (!w || !h) return;
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    // редкие горизонтальные полосы tracking
    if (Math.random() > 0.7) {
      const y = (Math.random() * h) | 0;
      const band = 2 + ((Math.random() * 6) | 0);
      for (let row = y; row < y + band && row < h; row++) {
        for (let x = 0; x < w; x++) {
          const i = (row * w + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = Math.random() > 0.5 ? 255 : 20;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    snowAnimId = requestAnimationFrame(drawSnowFrame);
  }

  function startSnow() {
    const rect = snowCanvas.parentElement.getBoundingClientRect();
    snowCanvas.width = Math.max(160, Math.floor(rect.width / 3));
    snowCanvas.height = Math.max(90, Math.floor(rect.height / 3));
    snowCanvas.classList.remove('hidden');
    if (startupBlue) startupBlue.classList.add('hidden');
    drawSnowFrame();
  }

  function stopSnow() {
    if (snowAnimId) cancelAnimationFrame(snowAnimId);
    snowAnimId = null;
    if (snowCanvas) snowCanvas.classList.add('hidden');
  }

  function runStartupSequence(onDone) {
    if (!startupSeq) {
      onDone();
      return;
    }
    startupSeq.classList.remove('hidden');
    if (startupBlue) startupBlue.classList.remove('hidden');
    stopSnow();

    // 1) Синий экран ~0.6 с (как после вставки кассеты)
    setTimeout(() => {
      // 2) Снег / помехи ~1.1 с
      startSnow();
      setTimeout(() => {
        // 3) Конец — убираем оверлей и запускаем видео
        stopSnow();
        startupSeq.classList.add('hidden');
        onDone();
      }, 1100);
    }, 600);
  }

  // ---------- File loading ----------
  function loadFile(file) {
    if (!file || !file.type.startsWith('video/')) {
      alert('Выберите видеофайл');
      return;
    }

    const url = URL.createObjectURL(file);
    video.src = url;
    video.load();

    currentFile = file;
    fileNameEl.textContent = file.name;
    dropZone.style.display = 'none';
    hasTape = true;
    if (seekSlider) seekSlider.value = 0;

    video.onloadedmetadata = () => {
      timeDisplay.textContent = `00:00 / ${formatTime(video.duration)}`;
      if (screenWrapper && video.videoWidth && video.videoHeight) {
        screenWrapper.style.setProperty(
          '--video-ar',
          `${video.videoWidth} / ${video.videoHeight}`
        );
      }
      setupAudio();
      updateAudioFromSliders();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      // Не стартуем сразу — сначала имитация запуска кассеты
      osd.classList.add('hidden');
      btnPlay.textContent = '▶';
      osdStatus.textContent = 'ЗАГРУЗКА…';

      runStartupSequence(() => {
        osd.classList.remove('hidden');
        video.play().then(() => {
          btnPlay.textContent = '❚❚';
          osdStatus.textContent = 'ВОСПРОИЗВЕДЕНИЕ ►';
          // showPlayBadge может быть ещё не объявлен на первом вызове — вызываем через setTimeout
          setTimeout(() => {
            if (typeof showPlayBadge === 'function') showPlayBadge();
          }, 0);
        }).catch(() => {});
      });
    };

    video.onended = () => {
      btnPlay.textContent = '▶';
      osdStatus.textContent = 'СТОП';
      if (typeof showStopScreen === 'function') showStopScreen();
    };
  }

  // ---------- Controls ----------
  const btnLoad = document.getElementById('btnLoad');
  const btnAspect = document.getElementById('btnAspect');
  const screenWrapper = document.getElementById('screenWrapper');

  const aspectModes = [
    { id: 'original', label: 'Авто' },
    { id: '4:3', label: '4:3' },
    { id: '1:1', label: '1:1' },
    { id: '16:9', label: '16:9' },
    { id: '21:9', label: '21:9' }
  ];
  let aspectIndex = 0;

  function applyAspect() {
    const mode = aspectModes[aspectIndex];
    if (screenWrapper) screenWrapper.dataset.aspect = mode.id;
    if (btnAspect) {
      btnAspect.textContent = mode.label;
      btnAspect.title = 'Пропорции: ' + mode.label + ' (нажми, чтобы сменить)';
    }
    requestAnimationFrame(() => {
      resize();
      if (screenWrapper && video.videoWidth && video.videoHeight) {
        screenWrapper.style.setProperty(
          '--video-ar',
          `${video.videoWidth} / ${video.videoHeight}`
        );
      }
    });
  }

  if (btnAspect) {
    btnAspect.addEventListener('click', () => {
      aspectIndex = (aspectIndex + 1) % aspectModes.length;
      applyAspect();
      const mode = aspectModes[aspectIndex];
      showToast('ПРОПОРЦИИ · ' + mode.label);
    });
  }
  applyAspect();

  pickBtn.addEventListener('click', () => fileInput.click());
  if (btnLoad) btnLoad.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  // drag & drop
  ['dragenter', 'dragover'].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });
  dropZone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  const bigStatus = document.getElementById('bigStatus');
  const bigStatusIcon = document.getElementById('bigStatusIcon');
  const bigStatusText = document.getElementById('bigStatusText');
  const pauseInfoEl = document.getElementById('pauseInfo');

  const READY_STATE = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
  const NETWORK_STATE = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];

  function formatBytes(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function buildVideoDiag() {
    const lines = [];
    const name = currentFile ? currentFile.name : (fileNameEl ? fileNameEl.textContent : '—');
    lines.push('Файл: ' + name);
    if (currentFile) {
      lines.push('Тип: ' + (currentFile.type || '—') + '  ·  Размер: ' + formatBytes(currentFile.size));
      if (currentFile.lastModified) {
        try {
          lines.push('Изменён: ' + new Date(currentFile.lastModified).toLocaleString());
        } catch (_) {}
      }
    }
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    lines.push('Разрешение: ' + (w && h ? w + ' × ' + h : '—') +
      (w && h ? '  (' + (w / h).toFixed(3) + ')' : ''));
    lines.push('Длительность: ' + formatTime(video.duration) +
      '  ·  Текущее: ' + formatTime(video.currentTime));
    lines.push('readyState: ' + video.readyState + ' (' + (READY_STATE[video.readyState] || '?') + ')');
    lines.push('networkState: ' + video.networkState + ' (' + (NETWORK_STATE[video.networkState] || '?') + ')');
    lines.push('paused: ' + video.paused + '  ·  ended: ' + video.ended +
      '  ·  seeking: ' + video.seeking);
    lines.push('playbackRate: ' + video.playbackRate +
      '  ·  volume: ' + video.volume.toFixed(2) +
      '  ·  muted: ' + video.muted);
    if (video.error) {
      lines.push('error: code=' + video.error.code + '  ' + (video.error.message || ''));
    }
    try {
      const buffered = video.buffered;
      if (buffered && buffered.length) {
        const parts = [];
        for (let i = 0; i < buffered.length; i++) {
          parts.push(formatTime(buffered.start(i)) + '–' + formatTime(buffered.end(i)));
        }
        lines.push('buffered: ' + parts.join(', '));
      } else {
        lines.push('buffered: —');
      }
    } catch (_) {
      lines.push('buffered: —');
    }
    return lines.join('\n');
  }

  function showStopScreen() {
    if (!bigStatus) return;
    bigStatus.classList.remove('hidden', 'play-mode');
    if (bigStatusIcon) bigStatusIcon.textContent = '■';
    if (bigStatusText) bigStatusText.textContent = 'Стоп';
    if (pauseInfoEl) {
      pauseInfoEl.classList.add('hidden');
      pauseInfoEl.textContent = '';
    }
    osd.classList.add('hidden');
  }

  function showPlayBadge() {
    if (!bigStatus) return;
    bigStatus.classList.remove('hidden');
    bigStatus.classList.add('play-mode');
    if (bigStatusIcon) bigStatusIcon.textContent = '▶';
    if (bigStatusText) bigStatusText.textContent = 'Воспроизведение';
    if (pauseInfoEl) {
      pauseInfoEl.classList.add('hidden');
      pauseInfoEl.textContent = '';
    }
    osd.classList.remove('hidden');
    clearTimeout(showPlayBadge._t);
    showPlayBadge._t = setTimeout(() => {
      if (bigStatus && !video.paused) {
        bigStatus.classList.add('hidden');
      }
    }, 2200);
  }

  function showPauseBadge() {
    if (!bigStatus) return;
    bigStatus.classList.remove('hidden');
    bigStatus.classList.add('play-mode'); // поверх картинки, без синего фона
    if (bigStatusIcon) bigStatusIcon.textContent = '❚❚';
    if (bigStatusText) bigStatusText.textContent = 'Пауза';
    if (pauseInfoEl) {
      pauseInfoEl.textContent = buildVideoDiag();
      pauseInfoEl.classList.remove('hidden');
    }
    osd.classList.remove('hidden');
    osdStatus.textContent = 'ПАУЗА';
    clearTimeout(showPlayBadge._t);
  }

  function hideBigStatus() {
    if (bigStatus) bigStatus.classList.add('hidden');
  }

  btnPlay.addEventListener('click', () => {
    if (!hasTape) return;
    if (video.paused) {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      video.muted = false;
      video.play();
      btnPlay.textContent = '❚❚';
      osdStatus.textContent = 'ВОСПРОИЗВЕДЕНИЕ ►';
      showPlayBadge();
    } else {
      video.pause();
      btnPlay.textContent = '▶';
      osdStatus.textContent = 'ПАУЗА';
      showPauseBadge();
    }
  });

  btnStop.addEventListener('click', () => {
    if (!hasTape) return;
    video.pause();
    video.currentTime = 0;
    btnPlay.textContent = '▶';
    osdStatus.textContent = 'СТОП';
    showStopScreen();
  });

  btnRew.addEventListener('click', () => {
    if (!hasTape) return;
    video.currentTime = Math.max(0, video.currentTime - 10);
    showToast('◄◄ −10 СЕК');
  });

  btnFf.addEventListener('click', () => {
    if (!hasTape) return;
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
    showToast('►► +10 СЕК');
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (!hasTape) return;
    if (e.code === 'Space') {
      e.preventDefault();
      btnPlay.click();
    } else if (e.code === 'ArrowLeft') {
      btnRew.click();
    } else if (e.code === 'ArrowRight') {
      btnFf.click();
    }
  });

  // sliders → audio + toast (only manual, when VHS auto is off)
  const sliderLabels = {
    tracking: 'ДЁРГАНИЕ',
    noise: 'ПОМЕХИ',
    chroma: 'ЦВЕТОСДВИГ',
    wear: 'ИЗНОС ЛЕНТЫ',
    fps: 'ЧАСТОТА'
  };
  [trackingSlider, noiseSlider, chromaSlider, wearSlider].forEach(s => {
    s.addEventListener('input', updateAudioFromSliders);
    s.addEventListener('change', () => {
      if (vhsAuto) return;
      const id = s.id;
      const val = s.value;
      showToast((sliderLabels[id] || id.toUpperCase()) + ' · ' + val + '%');
    });
  });

  // FPS slider (24–60)
  function updateFps() {
    targetFps = parseInt(fpsSlider.value, 10);
    frameInterval = 1000 / targetFps;
    if (fpsValueEl) fpsValueEl.textContent = targetFps;
  }
  fpsSlider.addEventListener('input', updateFps);
  fpsSlider.addEventListener('change', () => {
    if (vhsAuto) return;
    showToast('ЧАСТОТА · ' + fpsSlider.value + ' FPS');
  });
  updateFps(); // init

  // ---------- Action toast (user actions only, ≤2 s) ----------
  function showToast(msg) {
    if (!actionToast || !msg) return;
    actionToast.textContent = msg;
    actionToast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      actionToast.classList.add('hidden');
    }, 2000);
  }

  // ---------- Seek bar ----------
  if (seekSlider) {
    const beginSeek = () => { isSeeking = true; };
    const endSeek = () => {
      isSeeking = false;
      if (hasTape && video.duration && isFinite(video.duration)) {
        const t = (parseFloat(seekSlider.value) / 1000) * video.duration;
        video.currentTime = Math.max(0, Math.min(video.duration, t));
        timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
        if (video.paused) {
          osdTime.textContent = formatTime(video.currentTime);
        }
        showToast('ПЕРЕМОТКА · ' + formatTime(video.currentTime));
      }
    };
    seekSlider.addEventListener('pointerdown', beginSeek);
    seekSlider.addEventListener('mousedown', beginSeek);
    seekSlider.addEventListener('touchstart', beginSeek, { passive: true });
    seekSlider.addEventListener('input', () => {
      if (!hasTape || !video.duration || !isFinite(video.duration)) return;
      const t = (parseFloat(seekSlider.value) / 1000) * video.duration;
      // live preview while dragging
      timeDisplay.textContent = `${formatTime(t)} / ${formatTime(video.duration)}`;
      if (video.paused) osdTime.textContent = formatTime(t);
    });
    seekSlider.addEventListener('change', endSeek);
    seekSlider.addEventListener('pointerup', endSeek);
    seekSlider.addEventListener('mouseup', endSeek);
    seekSlider.addEventListener('touchend', endSeek);
  }

  // ---------- VHS auto-modulation ----------
  function randomVhsTarget(maxVal) {
    // default 1..50; noise capped at 20
    const max = (maxVal != null) ? maxVal : 50;
    return 1 + Math.random() * (max - 1);
  }

  function randomVhsSpeed() {
    // units per second, max 15
    return 3 + Math.random() * 12;
  }

  function syncVhsFromSliders() {
    vhsParams.tracking.value = parseFloat(trackingSlider.value) || 0;
    vhsParams.noise.value    = parseFloat(noiseSlider.value) || 0;
    vhsParams.chroma.value   = parseFloat(chromaSlider.value) || 0;
    vhsParams.wear.value     = parseFloat(wearSlider.value) || 0;
    vhsParams.tracking.target = vhsParams.tracking.value;
    vhsParams.noise.target    = vhsParams.noise.value;
    vhsParams.chroma.target   = vhsParams.chroma.value;
    vhsParams.wear.target     = vhsParams.wear.value;
  }

  function applyVhsToSliders() {
    trackingSlider.value = Math.round(vhsParams.tracking.value);
    noiseSlider.value    = Math.round(vhsParams.noise.value);
    chromaSlider.value   = Math.round(vhsParams.chroma.value);
    wearSlider.value     = Math.round(vhsParams.wear.value);
    updateAudioFromSliders();
  }

  function tickVhsModulation(now) {
    if (!vhsLastTs) vhsLastTs = now;
    const dt = Math.min(0.05, (now - vhsLastTs) / 1000); // cap dt
    vhsLastTs = now;

    const keys = ['tracking', 'noise', 'chroma', 'wear'];
    const maxFor = { tracking: 50, noise: 20, chroma: 50, wear: 50 };
    let changed = false;
    for (const k of keys) {
      const p = vhsParams[k];
      const maxV = maxFor[k] || 50;
      const diff = p.target - p.value;
      if (Math.abs(diff) < 0.4) {
        // reached target → pick new one
        p.target = randomVhsTarget(maxV);
        p.speed = randomVhsSpeed();
      } else {
        const step = Math.sign(diff) * Math.min(Math.abs(diff), p.speed * dt);
        p.value += step;
        // clamp; noise never above 20% in VHS auto
        p.value = Math.max(1, Math.min(maxV, p.value));
        changed = true;
      }
    }
    if (changed) applyVhsToSliders();
  }

  function setVhsMode(on) {
    vhsAuto = on;
    if (btnVhs) {
      btnVhs.classList.toggle('vhs-on', on);
      btnVhs.classList.toggle('vhs-off', !on);
      btnVhs.title = on ? 'VHS-эффекты (авто)' : 'VHS-эффекты выкл — ручная настройка';
    }
    if (effectSliders) {
      effectSliders.classList.toggle('locked', on);
    }
    effectInputs.forEach(inp => {
      if (inp) inp.disabled = on;
    });
    if (on) {
      // start from current slider positions, then drift
      syncVhsFromSliders();
      // noise cannot exceed 20% in auto mode
      if (vhsParams.noise.value > 20) {
        vhsParams.noise.value = 20;
        noiseSlider.value = 20;
      }
      const maxFor = { tracking: 50, noise: 20, chroma: 50, wear: 50 };
      Object.keys(vhsParams).forEach(k => {
        vhsParams[k].target = randomVhsTarget(maxFor[k] || 50);
        vhsParams[k].speed = randomVhsSpeed();
      });
      vhsLastTs = 0;
    }
  }

  if (btnVhs) {
    btnVhs.addEventListener('click', () => {
      const next = !vhsAuto;
      setVhsMode(next);
      showToast(next ? 'VHS АВТО · ВКЛ' : 'VHS АВТО · ВЫКЛ');
    });
  }

  // init VHS mode (default ON → lock sliders)
  setVhsMode(true);

  // ---------- Fullscreen (max device compatibility) ----------
  function getFullscreenElement() {
    return document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null;
  }

  function isFullscreen() {
    return !!getFullscreenElement() ||
      !!(video && video.webkitDisplayingFullscreen);
  }

  function requestFs(el) {
    if (!el) return Promise.reject();
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
    if (el.webkitRequestFullScreen) return el.webkitRequestFullScreen();
    if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
    if (el.msRequestFullscreen) return el.msRequestFullscreen();
    return Promise.reject();
  }

  function exitFs() {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
    if (document.webkitCancelFullScreen) return document.webkitCancelFullScreen();
    if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
    if (document.msExitFullscreen) return document.msExitFullscreen();
    // iOS video-only exit
    if (video && video.webkitDisplayingFullscreen && video.webkitExitFullscreen) {
      try { video.webkitExitFullscreen(); } catch (_) {}
    }
    return Promise.resolve();
  }

  function updateFsButton() {
    if (!btnFs) return;
    const on = isFullscreen();
    btnFs.textContent = on ? '⛶' : '⛶';
    btnFs.title = on ? 'Выйти из полного экрана' : 'Полный экран';
    btnFs.classList.toggle('vhs-on', on); // reuse blue highlight when active
  }

  function toggleFullscreen() {
    if (isFullscreen()) {
      exitFs().catch(() => {});
      showToast('ПОЛНЫЙ ЭКРАН · ВЫКЛ');
      return;
    }
    // 1) Prefer the whole VCR chrome (controls stay visible)
    const target = vcrRoot || document.documentElement;
    requestFs(target).then(() => {
      updateFsButton();
      showToast('ПОЛНЫЙ ЭКРАН · ВКЛ');
    }).catch(() => {
      // 2) Fallback: screen-wrapper / bezel
      const wrap = document.getElementById('screenWrapper') || canvas;
      requestFs(wrap).then(() => {
        updateFsButton();
        showToast('ПОЛНЫЙ ЭКРАН · ВКЛ');
      }).catch(() => {
        // 3) Last resort for old iOS / iPad: native video fullscreen
        if (video && typeof video.webkitEnterFullscreen === 'function') {
          try {
            video.webkitEnterFullscreen();
            showToast('ПОЛНЫЙ ЭКРАН · ВКЛ');
          } catch (e) {
            console.warn('Fullscreen not available', e);
          }
        } else if (video && typeof video.webkitEnterFullScreen === 'function') {
          try {
            video.webkitEnterFullScreen();
            showToast('ПОЛНЫЙ ЭКРАН · ВКЛ');
          } catch (_) {}
        }
      });
    });
  }

  if (btnFs) {
    btnFs.addEventListener('click', toggleFullscreen);
  }

  // Keep button state in sync with system fullscreen changes
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(ev => {
    document.addEventListener(ev, updateFsButton);
  });
  if (video) {
    video.addEventListener('webkitbeginfullscreen', updateFsButton);
    video.addEventListener('webkitendfullscreen', updateFsButton);
  }

  // ---------- Boot ----------
  window.addEventListener('resize', resize);
  if (initGL()) {
    resize();
    startTime = performance.now();
    animId = requestAnimationFrame(render);
  }
})();
