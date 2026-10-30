(() => {
  const sampleEl = document.getElementById("sample");
  const playEl = document.getElementById("play");
  const jumpEl = document.getElementById("jump-extend");
  const clockEl = document.getElementById("clock");
  const statusEl = document.getElementById("status");
  const captionsEl = document.getElementById("captions");
  const canvas = document.getElementById("wave");
  const ctx2d = canvas.getContext("2d");

  let samples = [];
  let audioCtx = null;
  let mix = null;
  let reconSeconds = 0;
  let utterances = [];
  let source = null;
  let playing = false;
  let startedAt = 0;
  let offset = 0;
  let peaks = [];
  let raf = 0;

  sampleEl.addEventListener("change", () => loadSample(sampleEl.value));
  playEl.addEventListener("click", togglePlay);
  jumpEl.addEventListener("click", () => seek(reconSeconds));
  canvas.addEventListener("click", (event) => {
    if (!mix) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    seek(x * mix.duration);
  });
  window.addEventListener("resize", () => drawWave(now()));

  fetch("samples.json?v=1793329421")
    .then((r) => r.json())
    .then((list) => {
      samples = list;
      sampleEl.innerHTML = "";
      if (!list.length) {
        statusEl.textContent = "没有 status=ok 且重建+扩展齐全的样本";
        return;
      }
      for (const item of list) {
        const opt = document.createElement("option");
        opt.value = item.path;
        opt.textContent = item.id.split("_").pop();
        sampleEl.appendChild(opt);
      }
      loadSample(list[0].path);
    })
    .catch((err) => {
      statusEl.textContent = "无法加载样本列表：" + err;
    });

  async function loadSample(path) {
    stop(true);
    const item = samples.find((s) => s.path === path);
    if (!item) return;
    statusEl.textContent = "加载中…";
    captionsEl.innerHTML = "";
    try {
      audioCtx = audioCtx || new AudioContext();
      const [reconT, extT, r0, r1, e0, e1] = await Promise.all([
        fetch(item.reconstruction.transcript).then((r) => r.json()),
        fetch(item.extension.transcript).then((r) => r.json()),
        decode(item.reconstruction.speaker0),
        decode(item.reconstruction.speaker1),
        decode(item.extension.speaker0),
        decode(item.extension.speaker1),
      ]);
      const reconMix = stereoMix(r0, r1);
      const extMix = stereoMix(e0, e1);
      reconSeconds = reconMix.duration;
      mix = concatBuffers(reconMix, extMix);
      peaks = downsample(mix);
      utterances = mergeUtterances(reconT, extT, reconSeconds);
      renderCaptions();
      drawWave(0);
      clockEl.textContent = formatTime(0) + " / " + formatTime(mix.duration);
      statusEl.textContent = "";
      playEl.textContent = "播放";
    } catch (err) {
      statusEl.textContent = "加载失败：" + err;
    }
  }

  async function decode(url) {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    return audioCtx.decodeAudioData(buf.slice(0));
  }

  function stereoMix(leftBuf, rightBuf) {
    const sr = leftBuf.sampleRate;
    const length = Math.max(leftBuf.length, rightBuf.length);
    const out = audioCtx.createBuffer(2, length, sr);
    copyMono(leftBuf, out.getChannelData(0), length);
    copyMono(rightBuf, out.getChannelData(1), length);
    return out;
  }

  function copyMono(src, dest, length) {
    const ch = src.getChannelData(0);
    dest.set(ch.subarray(0, Math.min(ch.length, length)));
  }

  function concatBuffers(a, b) {
    const sr = a.sampleRate;
    const out = audioCtx.createBuffer(2, a.length + b.length, sr);
    for (let ch = 0; ch < 2; ch++) {
      const dest = out.getChannelData(ch);
      dest.set(a.getChannelData(Math.min(ch, a.numberOfChannels - 1)));
      dest.set(b.getChannelData(Math.min(ch, b.numberOfChannels - 1)), a.length);
    }
    return out;
  }

  function downsample(buffer) {
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const buckets = 1000;
    const size = Math.ceil(left.length / buckets);
    const out = new Float32Array(buckets);
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const start = i * size;
      const end = Math.min(left.length, start + size);
      for (let j = start; j < end; j++) {
        peak = Math.max(peak, Math.abs(left[j]), Math.abs(right[j]));
      }
      out[i] = peak;
    }
    return out;
  }

  function mergeUtterances(reconT, extT, reconSec) {
    const offsetMs = Math.round(reconSec * 1000);
    const rows = [];
    for (const u of reconT.utterances || []) {
      rows.push(shiftUtt(u, 0, "recon"));
    }
    for (const u of extT.utterances || []) {
      rows.push(shiftUtt(u, offsetMs, "extend"));
    }
    rows.sort((a, b) => a.t0 - b.t0 || a.speaker_id - b.speaker_id);
    return rows;
  }

  function shiftUtt(u, offsetMs, stage) {
    const words = (u.word_alignment || [])
      .filter((w) => w.type === "word")
      .map((w) => ({
        text: w.text,
        start: w.text_start,
        end: w.text_end,
        t0: (w.start_ms + offsetMs) / 1000,
        t1: (w.end_ms + offsetMs) / 1000,
      }));
    return {
      speaker_id: u.speaker_id,
      text: u.text || "",
      stage,
      t0: (u.start_ms + offsetMs) / 1000,
      t1: (u.end_ms + offsetMs) / 1000,
      words,
    };
  }

  function fillCaptionBody(body, u) {
    const text = u.text;
    if (!u.words.length) {
      body.textContent = text;
      return;
    }
    let cursor = 0;
    u.words.forEach((w, wi) => {
      const start = Number.isInteger(w.start) ? w.start : cursor;
      const end = Number.isInteger(w.end) ? w.end : start + (w.text || "").length;
      if (start > cursor) body.append(text.slice(cursor, start));
      const span = document.createElement("span");
      span.className = "word";
      span.dataset.wi = String(wi);
      span.textContent = text.slice(start, end) || w.text;
      body.appendChild(span);
      cursor = Math.max(cursor, end);
    });
    if (cursor < text.length) body.append(text.slice(cursor));
  }

  function renderCaptions() {
    captionsEl.innerHTML = "";
    utterances.forEach((u, i) => {
      const el = document.createElement("article");
      el.className = `utt speaker-${u.speaker_id} ${u.stage}`;
      el.dataset.index = String(i);
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `说话人 ${u.speaker_id} · ${u.stage === "recon" ? "重建" : "扩展"}`;
      const body = document.createElement("div");
      body.className = "body";
      fillCaptionBody(body, u);
      el.append(meta, body);
      el.addEventListener("click", () => seek(u.t0));
      captionsEl.appendChild(el);
    });
  }

  function togglePlay() {
    if (!mix) return;
    if (playing) pause();
    else play();
  }

  async function play() {
    if (audioCtx.state === "suspended") await audioCtx.resume();
    if (offset >= mix.duration - 0.02) offset = 0;
    source = audioCtx.createBufferSource();
    source.buffer = mix;
    source.connect(audioCtx.destination);
    source.onended = () => {
      if (!playing) return;
      if (now() >= mix.duration - 0.05) {
        stop(true);
        drawWave(mix.duration);
        syncUi(mix.duration);
      }
    };
    source.start(0, offset);
    startedAt = audioCtx.currentTime;
    playing = true;
    playEl.textContent = "暂停";
    tick();
  }

  function pause() {
    offset = now();
    playing = false;
    if (source) {
      try {
        source.stop();
      } catch (_) {}
      source = null;
    }
    playEl.textContent = "播放";
    cancelAnimationFrame(raf);
    drawWave(offset);
    syncUi(offset);
  }

  function stop(resetOffset) {
    playing = false;
    if (source) {
      try {
        source.stop();
      } catch (_) {}
      source = null;
    }
    if (resetOffset) offset = 0;
    playEl.textContent = "播放";
    cancelAnimationFrame(raf);
  }

  function seek(seconds) {
    if (!mix) return;
    offset = Math.min(Math.max(0, seconds), mix.duration);
    if (playing) {
      stop(false);
      play();
    } else {
      drawWave(offset);
      syncUi(offset);
    }
  }

  function now() {
    if (!playing || !mix) return offset;
    return Math.min(mix.duration, offset + (audioCtx.currentTime - startedAt));
  }

  function tick() {
    const t = now();
    drawWave(t);
    syncUi(t);
    if (playing) raf = requestAnimationFrame(tick);
  }

  function syncUi(t) {
    if (!mix) return;
    clockEl.textContent = formatTime(t) + " / " + formatTime(mix.duration);
    let active = -1;
    for (let i = 0; i < utterances.length; i++) {
      if (t >= utterances[i].t0 && t < utterances[i].t1) active = i;
    }
    captionsEl.querySelectorAll(".utt").forEach((el, i) => {
      const on = i === active;
      el.classList.toggle("active", on);
      const u = utterances[i];
      el.querySelectorAll(".word").forEach((span, wi) => {
        const w = u.words[wi];
        span.classList.toggle("active", on && w && t >= w.t0 && t < w.t1);
      });
    });
    const current = captionsEl.querySelector(".utt.active");
    if (current) {
      const box = captionsEl.getBoundingClientRect();
      const row = current.getBoundingClientRect();
      if (row.top < box.top || row.bottom > box.bottom + 400) {
        current.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  function drawWave(t) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = 88;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, width, height);
    if (!mix || !peaks.length) return;
    const mid = height / 2;
    const split = reconSeconds / mix.duration;
    const splitX = split * width;
    ctx2d.fillStyle = "rgba(42,143,154,0.18)";
    ctx2d.fillRect(0, 0, splitX, height);
    ctx2d.fillStyle = "rgba(196,132,58,0.18)";
    ctx2d.fillRect(splitX, 0, width - splitX, height);
    const n = peaks.length;
    for (let i = 0; i < n; i++) {
      const x0 = (i / n) * width;
      const x1 = ((i + 1) / n) * width;
      const h = peaks[i] * (mid - 4);
      ctx2d.fillStyle = i / n < split ? "#2a8f9a" : "#c4843a";
      ctx2d.fillRect(x0, mid - h, Math.max(1, x1 - x0 - 0.3), h * 2);
    }
    ctx2d.strokeStyle = "#e8eaed";
    ctx2d.beginPath();
    ctx2d.moveTo(splitX, 0);
    ctx2d.lineTo(splitX, height);
    ctx2d.stroke();
    const playX = (t / mix.duration) * width;
    ctx2d.strokeStyle = "#fff";
    ctx2d.beginPath();
    ctx2d.moveTo(playX, 0);
    ctx2d.lineTo(playX, height);
    ctx2d.stroke();
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }
})();
