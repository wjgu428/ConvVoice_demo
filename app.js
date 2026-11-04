(() => {
  const sampleEl = document.getElementById("sample");
  const playEl = document.getElementById("play");
  const jumpEl = document.getElementById("jump-extend");
  const clockEl = document.getElementById("clock");
  const statusEl = document.getElementById("status");
  const captionsEl = document.getElementById("captions");
  const sourcePlayerEl = document.getElementById("source-player");
  const playSourceEl = document.getElementById("play-source");
  const sourceClockEl = document.getElementById("source-clock");
  const sourceCaptionsEl = document.getElementById("source-captions");
  const canvases = [
    document.getElementById("wave-0"),
    document.getElementById("wave-1"),
  ];
  const contexts = canvases.map((el) => el.getContext("2d"));
  const rulerEl = document.getElementById("ruler");
  const rulerCtx = rulerEl.getContext("2d");
  const srcCanvases = [
    document.getElementById("src-wave-0"),
    document.getElementById("src-wave-1"),
  ];
  const srcContexts = srcCanvases.map((el) => el.getContext("2d"));
  const srcRulerEl = document.getElementById("src-ruler");
  const srcRulerCtx = srcRulerEl.getContext("2d");
  const WAVE_COLORS = [
    { recon: "#5eead4", extend: "#fb923c" },
    { recon: "#fbbf24", extend: "#fb7185" },
  ];
  const SOURCE_COLORS = ["#c4b5fd", "#ddd6fe"];

  let samples = [];
  let audioCtx = null;
  let mix = null;
  let origMix = null;
  let reconSeconds = 0;
  let utterances = [];
  let origUtterances = [];
  let source = null;
  let origNode = null;
  let playing = false;
  let origPlaying = false;
  let startedAt = 0;
  let origStartedAt = 0;
  let offset = 0;
  let origOffset = 0;
  let peaks = [[], []];
  let origPeaks = [[], []];
  let raf = 0;
  let origRaf = 0;

  sampleEl.addEventListener("change", () => loadSample(sampleEl.value));
  playEl.addEventListener("click", togglePlay);
  playSourceEl.addEventListener("click", toggleOrig);
  jumpEl.addEventListener("click", () => seek(reconSeconds));
  [canvases[0], canvases[1], rulerEl].forEach((canvas) => {
    canvas.addEventListener("click", (event) => {
      if (!mix) return;
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      seek(x * mix.duration);
    });
  });
  [srcCanvases[0], srcCanvases[1], srcRulerEl].forEach((canvas) => {
    canvas.addEventListener("click", (event) => {
      if (!origMix) return;
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      seekOrig(x * origMix.duration);
    });
  });
  window.addEventListener("resize", () => {
    drawWave(now());
    drawOrig(origNow());
  });

  fetch("samples.json?v=1793784363")
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
    stopOrig(true);
    const item = samples.find((s) => s.path === path);
    if (!item) return;
    statusEl.textContent = "加载中…";
    captionsEl.innerHTML = "";
    sourceCaptionsEl.innerHTML = "";
    origMix = null;
    origUtterances = [];
    sourcePlayerEl.classList.add("hidden");
    try {
      audioCtx = audioCtx || new AudioContext();
      const fetches = [
        fetch(item.reconstruction.transcript).then((r) => r.json()),
        fetch(item.extension.transcript).then((r) => r.json()),
        decode(item.reconstruction.speaker0),
        decode(item.reconstruction.speaker1),
        decode(item.extension.speaker0),
        decode(item.extension.speaker1),
      ];
      if (item.source) {
        fetches.push(decode(item.source.speaker0), decode(item.source.speaker1));
      }
      const loaded = await Promise.all(fetches);
      const [reconT, extT, r0, r1, e0, e1] = loaded;
      const reconMix = stereoMix(r0, r1);
      const extMix = stereoMix(e0, e1);
      reconSeconds = reconMix.duration;
      mix = concatMany([reconMix, extMix]);
      peaks = [downsample(mix, 0), downsample(mix, 1)];
      utterances = applySpokenEnds(mergeUtterances(reconT, extT, reconSeconds), mix);
      if (item.source) {
        origMix = stereoMix(loaded[6], loaded[7]);
        origPeaks = [downsample(origMix, 0), downsample(origMix, 1)];
        origUtterances = (reconT.utterances || []).map(shiftSourceUtt);
        sourcePlayerEl.classList.remove("hidden");
        renderSourceCaptions();
        drawOrig(0);
        sourceClockEl.textContent =
          formatTime(0) + " / " + formatTime(origMix.duration);
        playSourceEl.textContent = "播放原音频";
      }
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

  function concatMany(buffers) {
    const sr = buffers[0].sampleRate;
    const length = buffers.reduce((n, buf) => n + buf.length, 0);
    const out = audioCtx.createBuffer(2, length, sr);
    let offset = 0;
    for (const buf of buffers) {
      for (let ch = 0; ch < 2; ch++) {
        out
          .getChannelData(ch)
          .set(buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1)), offset);
      }
      offset += buf.length;
    }
    return out;
  }

  function downsample(buffer, channel) {
    const samples = buffer.getChannelData(channel);
    const buckets = 1000;
    const size = Math.ceil(samples.length / buckets);
    const out = new Float32Array(buckets);
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const start = i * size;
      const end = Math.min(samples.length, start + size);
      for (let j = start; j < end; j++) {
        peak = Math.max(peak, Math.abs(samples[j]));
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

  function shiftSourceUtt(u) {
    const start = Number.isFinite(u.source_start_ms) ? u.source_start_ms : u.start_ms;
    const end = Number.isFinite(u.source_end_ms) ? u.source_end_ms : u.end_ms;
    return {
      speaker_id: u.speaker_id,
      text: u.text || "",
      tagged: u.text_with_audio_tags || u.text || "",
      type: u.type || null,
      hook: u.hook || null,
      truncated_at_char: null,
      stage: "source",
      t0: start / 1000,
      t1: end / 1000,
      words: [],
    };
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
      tagged: u.text_with_audio_tags || u.text || "",
      type: u.type || null,
      hook: u.hook || null,
      truncated_at_char: u.truncated_at_char,
      stage,
      t0: (u.start_ms + offsetMs) / 1000,
      t1: (u.end_ms + offsetMs) / 1000,
      words,
    };
  }

  function hostInterrupted(rows, index) {
    const u = rows[index];
    if (u.speaker_id !== 1 || u.stage !== "extend") return false;
    if (Number.isInteger(u.truncated_at_char)) return true;
    for (let j = index + 1; j < rows.length; j++) {
      const nxt = rows[j];
      if (nxt.stage !== u.stage) break;
      if (nxt.type === "interrupt" && nxt.speaker_id === 0) return true;
      if (nxt.speaker_id === 1 && nxt.type === "sequential") break;
    }
    return false;
  }

  function firstCollapsedChar(u) {
    for (const w of u.words) {
      if (w.t1 <= w.t0 + 1e-4 && Number.isInteger(w.start)) return w.start;
    }
    return u.text.length;
  }

  // ponytail: heard-until from host-channel energy; drop a short clipped
  // burst after a gap at the cut. Upgrade: write heard_until_char in assemble.
  function spokenTimeFromChannel(u, buffer, channel) {
    if (!buffer || buffer.numberOfChannels <= channel) return null;
    const data = buffer.getChannelData(channel);
    const sr = buffer.sampleRate;
    const hop = 0.02;
    const t0 = u.t0;
    const t1 = u.t1;
    const frames = [];
    let peak = 0;
    for (let t = t0; t < t1; t += hop) {
      const a = Math.max(0, Math.floor(t * sr));
      const b = Math.min(data.length, Math.floor((t + hop) * sr));
      let e = 0;
      for (let i = a; i < b; i++) e = Math.max(e, Math.abs(data[i]));
      frames.push({ t, e });
      peak = Math.max(peak, e);
    }
    const th = Math.max(peak * 0.12, 0.015);
    const runs = [];
    let run = null;
    for (const { t, e } of frames) {
      if (e >= th) {
        if (!run) run = { t0: t, t1: t + hop };
        else run.t1 = t + hop;
      } else if (run) {
        runs.push(run);
        run = null;
      }
    }
    if (run) runs.push(run);
    const merged = [];
    for (const r of runs) {
      const prev = merged[merged.length - 1];
      if (prev && r.t0 - prev.t1 <= 0.1) prev.t1 = r.t1;
      else merged.push({ t0: r.t0, t1: r.t1 });
    }
    if (!merged.length) return t0;
    let keep = merged[merged.length - 1];
    const prev = merged[merged.length - 2];
    if (
      keep.t1 >= t1 - 0.06 &&
      keep.t1 - keep.t0 < 0.32 &&
      prev &&
      keep.t0 - prev.t1 >= 0.18
    ) {
      keep = prev;
    }
    return keep.t1;
  }

  function spokenEndFromAudio(u, buffer) {
    const collapsed = firstCollapsedChar(u);
    const spokenT = spokenTimeFromChannel(u, buffer, 1);
    let spokenEnd = 0;
    if (spokenT != null) {
      for (const w of u.words) {
        if (w.t1 <= w.t0 + 1e-4) continue;
        if (w.t0 < spokenT - 0.03 && Number.isInteger(w.end)) spokenEnd = w.end;
      }
    }
    if (!spokenEnd) spokenEnd = collapsed;
    return Math.min(spokenEnd, collapsed);
  }

  function applySpokenEnds(rows, buffer) {
    for (let i = 0; i < rows.length; i++) {
      if (!hostInterrupted(rows, i)) continue;
      rows[i].spokenEnd = spokenEndFromAudio(rows[i], buffer);
    }
    return rows;
  }

  function userState(u) {
    if (u.speaker_id !== 0) return null;
    if (u.type === "interrupt") return "interrupt";
    if (u.type === "backchannel") return "backchannel";
    return "incomplete";
  }

  function appendSlice(parent, str, from, to, spokenEnd) {
    if (from >= to) return;
    const cut = spokenEnd == null ? to : spokenEnd;
    if (cut <= from) {
      const span = document.createElement("span");
      span.className = "unspoken";
      span.textContent = str.slice(from, to);
      parent.appendChild(span);
      return;
    }
    if (cut >= to) {
      parent.append(str.slice(from, to));
      return;
    }
    parent.append(str.slice(from, cut));
    const span = document.createElement("span");
    span.className = "unspoken";
    span.textContent = str.slice(cut, to);
    parent.appendChild(span);
  }

  function fillCaptionBody(body, u) {
    const text = u.text;
    const spokenEnd = u.spokenEnd;
    if (!u.words.length) {
      appendSlice(body, text, 0, text.length, spokenEnd);
      return;
    }
    let cursor = 0;
    u.words.forEach((w, wi) => {
      const start = Number.isInteger(w.start) ? w.start : cursor;
      const end = Number.isInteger(w.end) ? w.end : start + (w.text || "").length;
      if (start > cursor) appendSlice(body, text, cursor, start, spokenEnd);
      const span = document.createElement("span");
      span.className = "word";
      if (spokenEnd != null && start >= spokenEnd) span.classList.add("unspoken");
      span.dataset.wi = String(wi);
      if (spokenEnd != null && start < spokenEnd && spokenEnd < end) {
        span.append(text.slice(start, spokenEnd));
        const tail = document.createElement("span");
        tail.className = "unspoken";
        tail.textContent = text.slice(spokenEnd, end);
        span.appendChild(tail);
      } else {
        span.textContent = text.slice(start, end) || w.text;
      }
      body.appendChild(span);
      cursor = Math.max(cursor, end);
    });
    if (cursor < text.length) appendSlice(body, text, cursor, text.length, spokenEnd);
  }

  function renderCaptions() {
    captionsEl.innerHTML = "";
    utterances.forEach((u, i) => {
      const state = userState(u);
      const el = document.createElement("article");
      el.className = `utt speaker-${u.speaker_id} ${u.stage}`;
      if (state) el.classList.add("state-" + state);
      el.dataset.index = String(i);
      const meta = document.createElement("div");
      meta.className = "meta";
      const stage = document.createElement("span");
      stage.className = "pill stage";
      stage.textContent = u.stage === "recon" ? "重建" : "扩展";
      meta.append(stage);
      if (state) {
        const pill = document.createElement("span");
        pill.className = "pill state-" + state;
        pill.textContent = state;
        meta.append(pill);
      }
      meta.append(document.createTextNode(u.speaker_id === 0 ? "User 0" : "Host 1"));
      const body = document.createElement("div");
      body.className = "body";
      fillCaptionBody(body, u);
      const tagged = document.createElement("div");
      tagged.className = "tagged";
      tagged.innerHTML =
        '<span class="hint">AUDIO TAG</span>' + taggedMarkup(u.tagged);
      el.append(meta, body, tagged);
      el.addEventListener("click", () => seek(u.t0));
      captionsEl.appendChild(el);
    });
  }

  function renderSourceCaptions() {
    sourceCaptionsEl.innerHTML = "";
    origUtterances.forEach((u, i) => {
      const el = document.createElement("article");
      el.className = `utt speaker-${u.speaker_id} source`;
      el.dataset.index = String(i);
      const meta = document.createElement("div");
      meta.className = "meta";
      const stage = document.createElement("span");
      stage.className = "pill stage";
      stage.textContent = "原音频";
      meta.append(stage);
      meta.append(document.createTextNode(u.speaker_id === 0 ? "User 0" : "Host 1"));
      const body = document.createElement("div");
      body.className = "body";
      fillCaptionBody(body, u);
      el.append(meta, body);
      el.addEventListener("click", () => seekOrig(u.t0));
      sourceCaptionsEl.appendChild(el);
    });
  }

  function togglePlay() {
    if (!mix) return;
    if (playing) pause();
    else play();
  }

  async function play() {
    pauseOrig();
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

  function toggleOrig() {
    if (!origMix) return;
    if (origPlaying) pauseOrig();
    else playOrig();
  }

  async function playOrig() {
    pause();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    if (origOffset >= origMix.duration - 0.02) origOffset = 0;
    origNode = audioCtx.createBufferSource();
    origNode.buffer = origMix;
    origNode.connect(audioCtx.destination);
    origNode.onended = () => {
      if (!origPlaying) return;
      if (origNow() >= origMix.duration - 0.05) {
        stopOrig(true);
        drawOrig(origMix.duration);
        syncOrig(origMix.duration);
      }
    };
    origNode.start(0, origOffset);
    origStartedAt = audioCtx.currentTime;
    origPlaying = true;
    playSourceEl.textContent = "暂停";
    tickOrig();
  }

  function pauseOrig() {
    origOffset = origNow();
    origPlaying = false;
    if (origNode) {
      try {
        origNode.stop();
      } catch (_) {}
      origNode = null;
    }
    playSourceEl.textContent = "播放原音频";
    cancelAnimationFrame(origRaf);
    if (origMix) {
      drawOrig(origOffset);
      syncOrig(origOffset);
    }
  }

  function stopOrig(resetOffset) {
    origPlaying = false;
    if (origNode) {
      try {
        origNode.stop();
      } catch (_) {}
      origNode = null;
    }
    if (resetOffset) origOffset = 0;
    playSourceEl.textContent = "播放原音频";
    cancelAnimationFrame(origRaf);
  }

  function seekOrig(seconds) {
    if (!origMix) return;
    origOffset = Math.min(Math.max(0, seconds), origMix.duration);
    if (origPlaying) {
      stopOrig(false);
      playOrig();
    } else {
      drawOrig(origOffset);
      syncOrig(origOffset);
    }
  }

  function origNow() {
    if (!origPlaying || !origMix) return origOffset;
    return Math.min(origMix.duration, origOffset + (audioCtx.currentTime - origStartedAt));
  }

  function tickOrig() {
    const t = origNow();
    drawOrig(t);
    syncOrig(t);
    if (origPlaying) origRaf = requestAnimationFrame(tickOrig);
  }

  function syncOrig(t) {
    if (!origMix) return;
    sourceClockEl.textContent = formatTime(t) + " / " + formatTime(origMix.duration);
    let active = -1;
    for (let i = 0; i < origUtterances.length; i++) {
      if (t >= origUtterances[i].t0 && t < origUtterances[i].t1) active = i;
    }
    sourceCaptionsEl.querySelectorAll(".utt").forEach((el, i) => {
      el.classList.toggle("active", i === active);
    });
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
    canvases.forEach((canvas, speaker) => {
      drawOneWave(
        canvas,
        contexts[speaker],
        peaks[speaker] || [],
        t,
        WAVE_COLORS[speaker]
      );
    });
    drawRuler(t);
  }

  function drawOneWave(canvas, ctx2d, series, t, palette) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = 88;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, width, height);
    if (!mix || !series.length) return;
    const mid = height / 2;
    const split = reconSeconds / mix.duration;
    const splitX = split * width;
    const played = mix.duration ? t / mix.duration : 0;
    ctx2d.fillStyle = "rgba(45, 212, 191, 0.08)";
    ctx2d.fillRect(0, 0, splitX, height);
    ctx2d.fillStyle = "rgba(251, 146, 60, 0.08)";
    ctx2d.fillRect(splitX, 0, width - splitX, height);
    const n = series.length;
    const bar = Math.max(1, width / n - 0.45);
    for (let i = 0; i < n; i++) {
      const x0 = (i / n) * width;
      const h = Math.max(1.4, series[i] * (mid - 10));
      const past = i / n <= played;
      ctx2d.globalAlpha = past ? 0.95 : 0.38;
      ctx2d.fillStyle = i / n < split ? palette.recon : palette.extend;
      ctx2d.fillRect(x0, mid - h, bar, h * 2);
    }
    ctx2d.globalAlpha = 1;
    ctx2d.strokeStyle = "rgba(255,255,255,0.28)";
    ctx2d.setLineDash([3, 4]);
    ctx2d.beginPath();
    ctx2d.moveTo(splitX, 6);
    ctx2d.lineTo(splitX, height - 6);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
    const playX = played * width;
    ctx2d.strokeStyle = "#fafaf9";
    ctx2d.lineWidth = 1.4;
    ctx2d.beginPath();
    ctx2d.moveTo(playX, 0);
    ctx2d.lineTo(playX, height);
    ctx2d.stroke();
    ctx2d.fillStyle = "#fafaf9";
    ctx2d.beginPath();
    ctx2d.moveTo(playX - 4.5, 0);
    ctx2d.lineTo(playX + 4.5, 0);
    ctx2d.lineTo(playX, 7);
    ctx2d.closePath();
    ctx2d.fill();
  }

  function drawOrig(t) {
    srcCanvases.forEach((canvas, speaker) => {
      drawOrigWave(
        canvas,
        srcContexts[speaker],
        origPeaks[speaker] || [],
        t,
        SOURCE_COLORS[speaker]
      );
    });
    drawOrigRuler(t);
  }

  function drawOrigWave(canvas, ctx2d, series, t, color) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = 72;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, width, height);
    if (!origMix || !series.length) return;
    const mid = height / 2;
    const played = origMix.duration ? t / origMix.duration : 0;
    ctx2d.fillStyle = "rgba(167, 139, 250, 0.10)";
    ctx2d.fillRect(0, 0, width, height);
    const n = series.length;
    const bar = Math.max(1, width / n - 0.45);
    for (let i = 0; i < n; i++) {
      const x0 = (i / n) * width;
      const h = Math.max(1.4, series[i] * (mid - 8));
      ctx2d.globalAlpha = i / n <= played ? 0.95 : 0.38;
      ctx2d.fillStyle = color;
      ctx2d.fillRect(x0, mid - h, bar, h * 2);
    }
    ctx2d.globalAlpha = 1;
    const playX = played * width;
    ctx2d.strokeStyle = "#fafaf9";
    ctx2d.lineWidth = 1.4;
    ctx2d.beginPath();
    ctx2d.moveTo(playX, 0);
    ctx2d.lineTo(playX, height);
    ctx2d.stroke();
    ctx2d.fillStyle = "#fafaf9";
    ctx2d.beginPath();
    ctx2d.moveTo(playX - 4.5, 0);
    ctx2d.lineTo(playX + 4.5, 0);
    ctx2d.lineTo(playX, 7);
    ctx2d.closePath();
    ctx2d.fill();
  }

  function drawOrigRuler(t) {
    const dpr = window.devicePixelRatio || 1;
    const width = srcRulerEl.clientWidth || 800;
    const height = 28;
    srcRulerEl.width = Math.floor(width * dpr);
    srcRulerEl.height = Math.floor(height * dpr);
    srcRulerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    srcRulerCtx.clearRect(0, 0, width, height);
    if (!origMix) return;
    const dur = origMix.duration;
    const step = niceStep(dur, width);
    srcRulerCtx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (let s = 0; s <= dur + 0.001; s += step) {
      const x = (s / dur) * width;
      srcRulerCtx.strokeStyle = "rgba(255,255,255,0.2)";
      srcRulerCtx.beginPath();
      srcRulerCtx.moveTo(x + 0.5, 0);
      srcRulerCtx.lineTo(x + 0.5, 7);
      srcRulerCtx.stroke();
      if (s > 0.05) {
        srcRulerCtx.fillStyle = "#a8a29e";
        srcRulerCtx.fillText(formatTime(s), x + 4, 20);
      }
    }
    srcRulerCtx.fillStyle = "#c4b5fd";
    srcRulerCtx.fillText("原音频", 4, 20);
    const playX = (t / dur) * width;
    srcRulerCtx.strokeStyle = "#fafaf9";
    srcRulerCtx.beginPath();
    srcRulerCtx.moveTo(playX + 0.5, 0);
    srcRulerCtx.lineTo(playX + 0.5, height);
    srcRulerCtx.stroke();
  }

  function drawRuler(t) {
    const dpr = window.devicePixelRatio || 1;
    const width = rulerEl.clientWidth || 800;
    const height = 28;
    rulerEl.width = Math.floor(width * dpr);
    rulerEl.height = Math.floor(height * dpr);
    rulerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rulerCtx.clearRect(0, 0, width, height);
    if (!mix) return;
    const dur = mix.duration;
    const step = niceStep(dur, width);
    rulerCtx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (let s = 0; s <= dur + 0.001; s += step) {
      const x = (s / dur) * width;
      rulerCtx.strokeStyle = "rgba(255,255,255,0.2)";
      rulerCtx.beginPath();
      rulerCtx.moveTo(x + 0.5, 0);
      rulerCtx.lineTo(x + 0.5, 7);
      rulerCtx.stroke();
      if (s > 0.05 && Math.abs(x - (reconSeconds / dur) * width) > 40) {
        rulerCtx.fillStyle = "#a8a29e";
        rulerCtx.fillText(formatTime(s), x + 4, 20);
      }
    }
    const splitX = (reconSeconds / dur) * width;
    rulerCtx.fillStyle = "#5eead4";
    rulerCtx.fillText("重建", 4, 20);
    if (splitX > 48 && splitX < width - 36) {
      rulerCtx.fillStyle = "#fb923c";
      rulerCtx.fillText("扩展", splitX + 6, 20);
    }
    const playX = (t / dur) * width;
    rulerCtx.strokeStyle = "#fafaf9";
    rulerCtx.beginPath();
    rulerCtx.moveTo(playX + 0.5, 0);
    rulerCtx.lineTo(playX + 0.5, height);
    rulerCtx.stroke();
  }

  function niceStep(dur, width) {
    const target = Math.max(4, Math.floor(width / 92));
    const raw = dur / target;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const n = raw / mag;
    const step = n < 1.5 ? mag : n < 3.5 ? 2 * mag : n < 7.5 ? 5 * mag : 10 * mag;
    return Math.max(1, Math.round(step));
  }

  function taggedMarkup(raw) {
    return escapeHtml(raw || "")
      .replace(/\[([^\[\]&]+)\]/g, '<mark class="sq">[$1]</mark>')
      .replace(/&lt;(\/?[a-z0-9_-]+)&gt;/gi, '<mark class="pair">&lt;$1&gt;</mark>');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }
})();
