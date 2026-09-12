(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "buddy_token";
  const ORIGIN_KEY = "buddy_origin";
  const MIC_KEY = "buddy_mic";
  const SINK_KEY = "buddy_sink";
  const DEFAULT_ORIGIN = "https://bryans-macbook-pro-1.tail1ed408.ts.net:8711";
  const onPages = location.hostname.endsWith("github.io");
  const PREFIX = location.pathname.replace(/\/index\.html$/, "").replace(/\/$/, "") || "";

  (function ingestHash() {
    const raw = location.hash.slice(1);
    if (!raw.startsWith("cfg=")) return;
    try {
      const cfg = JSON.parse(decodeURIComponent(raw.slice(4)));
      if (cfg.api) localStorage.setItem(ORIGIN_KEY, String(cfg.api).replace(/\/$/, ""));
      if (cfg.token) localStorage.setItem(TOKEN_KEY, String(cfg.token));
    } catch (_) { /* bad cfg */ }
    history.replaceState(null, "", location.pathname + location.search);
  })();

  let origin = localStorage.getItem(ORIGIN_KEY) || (onPages ? DEFAULT_ORIGIN : "");
  let token = localStorage.getItem(TOKEN_KEY) || "";
  const apiUrl = (p) => {
    const path = p.startsWith("/") ? p : "/" + p;
    return origin ? origin + path : PREFIX + path;
  };
  const creds = () => (origin ? "omit" : "include");
  let state = "boot";
  let status = null;
  let abort = null;
  let rec = null;
  let chunks = [];
  let audioQ = Promise.resolve();
  let playing = [];
  let speakBuf = "";
  let firstAt = 0;
  let sessionOn = false;
  let liveStream = null;
  let vadTimer = null;
  let firstTurn = true;
  let audioCtx = null;
  let analyser = null;
  let turnBusy = false;
  let installPrompt = null;
  let showArchived = false;
  let outSink = localStorage.getItem(SINK_KEY) || "";
  let micStarting = false;
  let micSrc = null;
  let lastHoldAt = 0;
  const MOBILE = /Android|iPhone|iPad/i.test(navigator.userAgent || "");
  if (localStorage.getItem("buddy_audio") !== "v25") {
    localStorage.removeItem(MIC_KEY);
    localStorage.removeItem(SINK_KEY);
    localStorage.setItem("buddy_audio", "v25");
    outSink = "";
  }

  function alreadyHome() {
    return window.matchMedia("(display-mode: standalone)").matches
      || window.matchMedia("(display-mode: fullscreen)").matches
      || window.navigator.standalone === true;
  }

  function paintHomeBtn() {
    const b = $("homeBtn");
    if (!b) return;
    b.hidden = alreadyHome();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "VERSION") {
        const ver = $("ver");
        if (ver) ver.textContent = String(e.data.version || "").replace("buddy-shell-", "") || "v?";
      }
    });
    function askVersion() {
      navigator.serviceWorker.ready
        .then((r) => r.active && r.active.postMessage({ type: "VERSION" }))
        .catch(() => {});
    }
    askVersion();
    setTimeout(askVersion, 2500);
    navigator.serviceWorker.addEventListener("controllerchange", () => setTimeout(askVersion, 300));
    const ver = $("ver");
    if (ver) {
      ver.addEventListener("click", async () => {
        ver.className = "ver checking";
        ver.textContent = "pulling";
        try {
          const r = await navigator.serviceWorker.getRegistration();
          if (r) {
            navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
            await r.update();
            if (r.waiting) r.waiting.postMessage({ type: "SKIP_WAITING" });
            setTimeout(() => location.reload(), 3000);
            return;
          }
        } catch (_) { /* reload anyway */ }
        location.reload();
      });
    }
  }

  function setState(s) {
    state = s;
    document.body.dataset.state = s;
    const why = $("why");
    const pip = $("pip");
    const hold = $("hold");
    const map = {
      boot: ["waking", "0", "Talk"],
      connect: ["paste the token", "dark", "Talk"],
      dark: ["Pro is dark", "dark", "Talk"],
      off: ["off", "0", "Off"],
      idle: ["ready", "1", "Talk"],
      listening: ["listening", "1", "Stop"],
      hearing: ["hearing", "1", "Stop"],
      thinking: ["here", "1", "Stop"],
      talking: ["talking", "1", "Stop"],
    };
    const row = map[s] || map.idle;
    why.textContent = row[0];
    pip.dataset.on = row[1];
    if (hold) hold.setAttribute("aria-label", row[2]);
    if (status && status.mode === "counsel") document.body.dataset.mode = "counsel";
    else document.body.dataset.mode = "talk";
  }

  function showErr(msg) {
    const el = $("err");
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
  }

  function headers(json) {
    const h = {};
    if (json) h["Content-Type"] = "application/json";
    if (token) h.Authorization = "Bearer " + token;
    h["X-Buddy-Hand"] = "bryan";
    return h;
  }

  async function api(path, opt) {
    const res = await fetch(apiUrl(path), {
      credentials: creds(),
      ...opt,
      headers: { ...headers(opt && opt.body), ...(opt && opt.headers) },
    });
    if (res.status === 401) {
      token = "";
      localStorage.removeItem(TOKEN_KEY);
      showConnect("paste the token");
      throw new Error("unauthorized");
    }
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }
    if (!res.ok) throw new Error(res.statusText);
    return res;
  }

  function showConnect(msg) {
    $("connect").hidden = false;
    $("connectErr").hidden = !msg;
    $("connectErr").textContent = msg || "";
    setState("connect");
  }

  function hideConnect() {
    $("connect").hidden = true;
  }

  function paintStatus(s) {
    status = s;
    $("webBtn").dataset.on = s.web ? "1" : "0";
    $("modeBtn").dataset.on = s.mode === "counsel" ? "1" : "0";
    $("planBtn").dataset.on = s.mode === "gameplan" ? "1" : "0";
    $("talkGear").dataset.on = s.gear === "talk" ? "1" : "0";
    $("thinkGear").dataset.on = s.gear === "think" ? "1" : "0";
    $("deepGear").dataset.on = s.gear === "deep" ? "1" : "0";
    $("armBtn").dataset.on = s.armed ? "1" : "0";
    $("armBtn").textContent = s.armed ? "Off" : "On";
    if (!s.ollama) setState("dark");
    else if (!s.armed) setState("off");
    else if (state === "boot" || state === "connect" || state === "dark" || state === "off" || state === "idle") {
      setState("idle");
    }
    if (s.talk && s.talk.messages) drawRibbon(s.talk.messages);
    else drawRibbon([]);
    paintChats(s);
    paintChips(s);
  }

  function paintChips(s) {
    const ul = $("chips");
    if (!ul) return;
    const files = s.attachments || [];
    ul.hidden = files.length === 0;
    ul.innerHTML = files.map((f) =>
      `<li><button type="button" data-detach="${f.id}">${esc(f.name)} ×</button></li>`
    ).join("");
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function paintChats(s) {
    const ol = $("chatList");
    if (!ol) return;
    const cur = s.talk && s.talk.id;
    const rows = showArchived ? (s.archived || []) : (s.talks || []);
    const archLabel = showArchived ? "Unarchive" : "Archive";
    $("chatTitle").textContent = showArchived ? "Archived" : "Talks";
    $("chatArchived").textContent = showArchived ? "Live" : "Archived";
    ol.innerHTML = rows.map((t) => {
      const title = (t.title || "Buddy").slice(0, 80);
      const when = String(t.updated_at || "").replace("T", " ").slice(0, 16);
      const on = t.id === cur ? "1" : "0";
      return `<li>
        <button type="button" class="open" data-id="${t.id}" data-on="${on}"><span class="t">${esc(title)}</span><span class="m">${esc(when)}</span></button>
        <button type="button" class="arch" data-archive="${t.id}">${archLabel}</button>
      </li>`;
    }).join("") || `<li>${showArchived ? "Nothing archived." : "No talks yet."}</li>`;
  }

  function showChats(on) {
    $("chats").hidden = !on;
  }

  function drawRibbon(msgs) {
    const ol = $("ribbon");
    ol.innerHTML = "";
    msgs.forEach((m) => {
      const li = document.createElement("li");
      li.className = m.role === "user" ? "user" : "assistant";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = m.role === "user" ? "You" : "Buddy";
      li.appendChild(who);
      li.appendChild(document.createTextNode(m.body));
      ol.appendChild(li);
    });
    ol.scrollTop = ol.scrollHeight;
  }

  function liveLine() {
    let li = $("ribbon").querySelector("li.live");
    if (!li) {
      li = document.createElement("li");
      li.className = "assistant live";
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = "Buddy";
      li.appendChild(who);
      li.appendChild(document.createTextNode(""));
      $("ribbon").appendChild(li);
    }
    return li;
  }

  async function refresh() {
    try {
      const s = await api("/api/status");
      hideConnect();
      paintStatus(s);
      return s;
    } catch (e) {
      if (e.message === "unauthorized") return null;
      setState("dark");
      showErr(e.message || "dark");
      return null;
    }
  }

  function splitSentences(buf) {
    const out = [];
    let rest = buf;
    const re = /[.!?](?:["')\]]+)?(?:\s+|$)/;
    while (true) {
      const m = rest.match(re);
      if (!m) break;
      const i = m.index + m[0].length;
      const piece = rest.slice(0, i).trim();
      rest = rest.slice(i);
      if (piece) out.push(piece);
    }
    return { sentences: out, rest };
  }

  function stopAudio() {
    playing.forEach((a) => { try { a.pause(); a.src = ""; } catch (_) {} });
    playing = [];
    audioQ = Promise.resolve();
  }

  function enqueueSpeak(text) {
    if (!text || !text.trim()) return;
    audioQ = audioQ.then(async () => {
      try {
        const res = await fetch(apiUrl("/api/talk/speak"), {
          method: "POST",
          credentials: creds(),
          headers: headers(true),
          body: JSON.stringify({ text }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        await new Promise((resolve) => {
          const a = new Audio(url);
          playing.push(a);
          const go = () => {
            a.onended = () => { URL.revokeObjectURL(url); resolve(); };
            a.onerror = () => { URL.revokeObjectURL(url); resolve(); };
            a.play().catch(() => resolve());
          };
          if (!MOBILE && outSink && a.setSinkId) a.setSinkId(outSink).then(go).catch(go);
          else go();
        });
      } catch (_) { /* voice is optional */ }
    });
  }

  async function streamTalk(text) {
    if (abort) abort.abort();
    abort = new AbortController();
    speakBuf = "";
    firstAt = 0;
    const t0 = performance.now();
    setState("thinking");
    showErr("");
    const userMsgs = (status && status.talk && status.talk.messages) ? status.talk.messages.slice() : [];
    const last = userMsgs[userMsgs.length - 1];
    if (!last || last.role !== "user" || last.body !== text) {
      userMsgs.push({ role: "user", body: text });
    }
    drawRibbon(userMsgs);
    const li = liveLine();
    let body = "";

    let res;
    try {
      res = await fetch(apiUrl("/api/talk/stream"), {
        method: "POST",
        credentials: creds(),
        headers: headers(true),
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") return;
      setState("dark");
      showErr(e.message || "dark");
      return;
    }
    if (res.status === 401) {
      showConnect("paste the token");
      return;
    }
    if (!res.ok || !res.body) {
      setState("idle");
      showErr("could not talk");
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.t === "token") {
            if (!firstAt) {
              firstAt = Math.round(performance.now() - t0);
              $("pipms").hidden = false;
              $("pipms").textContent = firstAt + " ms";
              setTimeout(() => { $("pipms").hidden = true; }, 2400);
            }
            setState("talking");
            body += ev.c;
            speakBuf += ev.c;
            li.lastChild.textContent = body;
            $("ribbon").scrollTop = $("ribbon").scrollHeight;
            const split = splitSentences(speakBuf);
            split.sentences.forEach(enqueueSpeak);
            speakBuf = split.rest;
          } else if (ev.t === "error") {
            showErr(ev.error || "failed");
            if (ev.code === "dark") setState("dark");
            else if (ev.code === "off") setState("off");
          } else if (ev.t === "done") {
            if (speakBuf.trim()) enqueueSpeak(speakBuf.trim());
            speakBuf = "";
            li.classList.remove("live");
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") showErr(e.message || "cut off");
    }
    await audioQ;
    await refresh();
    if (!sessionOn && (state === "talking" || state === "thinking")) setState("idle");
  }

  function recMime() {
    const android = /Android/i.test(navigator.userAgent || "");
    const types = android
      ? ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
      : ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  const BT_NAME = /bluetooth|headset|headphone|earbuds?|buds|airpods|hands-?free|le-audio|wh-\d|wf-\d|bose|sony|jabra|sennheiser|\bjbl\b/i;
  const NOT_BT = /default|communications?$|built-?in|internal|speakerphone|earpiece|usb audio/i;
  const SILENCE = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

  function isBt(label) {
    const s = label || "";
    if (!s) return false;
    if (NOT_BT.test(s) && !BT_NAME.test(s)) return false;
    return BT_NAME.test(s);
  }

  function until(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function micAudio(deviceId, exact, headset) {
    const base = headset
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!deviceId) return base;
    return { ...base, deviceId: exact ? { exact: deviceId } : { ideal: deviceId } };
  }

  async function gum(deviceId, exact, headset) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: micAudio(deviceId, exact, headset) });
    } catch (err) {
      if (deviceId && exact) {
        try { return await navigator.mediaDevices.getUserMedia({ audio: micAudio(deviceId, false, headset) }); } catch (_) {}
      }
      if (deviceId) return navigator.mediaDevices.getUserMedia({ audio: micAudio("", false, headset) });
      throw err;
    }
  }

  function findBtInput(devices) {
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const named = inputs.find((d) => isBt(d.label));
    if (named) return named;
    const btOut = devices.find((d) => d.kind === "audiooutput" && isBt(d.label));
    if (btOut) {
      const pair = inputs.find((d) => d.groupId && d.groupId === btOut.groupId);
      if (pair) return pair;
    }
    return null;
  }

  async function pokeHeadphones() {
    try {
      const a = new Audio(SILENCE);
      a.volume = 0.02;
      if (!MOBILE && outSink && a.setSinkId) {
        try { await a.setSinkId(outSink); } catch (_) {}
      }
      await Promise.race([a.play().catch(() => {}), until(1800)]);
    } catch (_) { /* gesture still counts */ }
  }

  async function rememberSink() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const btOut = devices.find((d) => d.kind === "audiooutput" && isBt(d.label));
      if (btOut) {
        outSink = btOut.deviceId;
        localStorage.setItem(SINK_KEY, outSink);
      }
      return findBtInput(devices);
    } catch (_) {
      return null;
    }
  }

  function trackId(stream) {
    const cur = stream && stream.getAudioTracks()[0];
    const id = cur && cur.getSettings ? cur.getSettings().deviceId : "";
    const label = (cur && cur.label) || "";
    return { cur, id, label };
  }

  async function openMic() {
    const prefer = localStorage.getItem(MIC_KEY) || "";
    if (!prefer && !MOBILE) await pokeHeadphones();
    let stream = await gum(prefer, !!prefer, true);
    const first = trackId(stream);
    if (isBt(first.label) && first.id) {
      localStorage.setItem(MIC_KEY, first.id);
      rememberSink();
      return stream;
    }
    await until(MOBILE ? 300 : 50);
    const btIn = await rememberSink();
    if (btIn && btIn.deviceId && btIn.deviceId !== first.id) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await gum(btIn.deviceId, true, true);
    }
    const after = trackId(stream);
    if (isBt(after.label) && after.id) localStorage.setItem(MIC_KEY, after.id);
    return stream;
  }

  async function wireVad(stream) {
    if (audioCtx && audioCtx.state !== "closed") {
      try { await audioCtx.close(); } catch (_) {}
      audioCtx = null;
      analyser = null;
      micSrc = null;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {
      return;
    }
    if (!MOBILE && outSink && audioCtx.setSinkId) {
      try { await audioCtx.setSinkId(outSink); } catch (_) {}
    }
    if (audioCtx.state === "suspended") await audioCtx.resume();
    micSrc = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    micSrc.connect(analyser);
  }

  function rms() {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let s = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      s += v * v;
    }
    return Math.sqrt(s / data.length);
  }

  function stopVad() {
    if (vadTimer) {
      clearInterval(vadTimer);
      vadTimer = null;
    }
  }

  async function hearBlob(blob, mime) {
    if (!blob || blob.size < 1200) {
      showErr("");
      if (sessionOn) armTurn();
      else setState("idle");
      return;
    }
    setState("hearing");
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    try {
      const heard = await api("/api/talk/hear", {
        method: "POST",
        body: JSON.stringify({ data, mime: mime || blob.type || "audio/webm" }),
      });
      const text = (heard.text || "").trim();
      if (!text) {
        showErr("didn't catch that — still listening");
        if (sessionOn) armTurn();
        else setState("idle");
        return;
      }
      firstTurn = false;
      showErr("");
      await streamTalk(text);
      await audioQ;
      await new Promise((r) => setTimeout(r, 280));
      if (sessionOn) armTurn();
    } catch (err) {
      showErr(err.message || "could not hear");
      if (sessionOn) armTurn();
      else setState("idle");
    }
  }

  function stopRecorder() {
    return new Promise((resolve) => {
      const r = rec;
      rec = null;
      if (!r || r.state === "inactive") {
        resolve(new Blob(chunks, { type: (r && r.mimeType) || "audio/webm" }));
        return;
      }
      r.onstop = () => resolve(new Blob(chunks, { type: r.mimeType || "audio/webm" }));
      try { r.stop(); } catch (_) { resolve(new Blob()); }
    });
  }

  function armTurn() {
    if (!sessionOn || !liveStream) return;
    stopVad();
    if (rec && rec.state === "recording") return;
    const mime = recMime();
    chunks = [];
    try {
      rec = mime ? new MediaRecorder(liveStream, { mimeType: mime }) : new MediaRecorder(liveStream);
    } catch (_) {
      rec = new MediaRecorder(liveStream);
    }
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.start(200);
    setState("listening");
    $("hold").classList.add("hot");
    const mic = ((liveStream.getAudioTracks()[0] || {}).label || "").trim();
    if (mic) $("why").textContent = "listening · " + mic.slice(0, 42);

    const trail = 3800;
    let heard = false;
    let lastVoice = 0;
    let voicedMs = 0;
    const samples = [];
    vadTimer = setInterval(() => {
      if (!sessionOn || turnBusy) return;
      const lvl = rms();
      if (samples.length < 8) {
        samples.push(lvl);
        return;
      }
      const floor = samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)] || 0.02;
      const gate = Math.max(0.028, floor * 2.4);
      const now = performance.now();
      if (lvl > gate) {
        heard = true;
        lastVoice = now;
        voicedMs += 80;
      }
      if (heard && voicedMs >= 600 && now - lastVoice > trail) {
        finishTurn();
      }
    }, 80);
  }

  async function finishTurn() {
    if (turnBusy) return;
    turnBusy = true;
    stopVad();
    try {
      const blob = await stopRecorder();
      await hearBlob(blob, blob.type);
    } catch (err) {
      showErr(err.message || "could not hear");
      if (sessionOn) armTurn();
    } finally {
      turnBusy = false;
    }
  }

  async function startSession() {
    if (sessionOn || micStarting) return;
    if (state === "off") return showErr("talk is off");
    if (state === "dark" || state === "connect") return;
    showErr("");
    micStarting = true;
    $("hold").classList.add("hot");
    setState("listening");
    try {
      liveStream = await openMic();
      sessionOn = true;
      firstTurn = true;
      armTurn();
      wireVad(liveStream).catch(() => {});
    } catch (err) {
      sessionOn = false;
      $("hold").classList.remove("hot");
      showErr("mic refused — allow microphone, or pick the headphones as input");
      if (state !== "dark" && state !== "off" && state !== "connect") setState("idle");
    } finally {
      micStarting = false;
    }
  }

  function hangUp() {
    sessionOn = false;
    micStarting = false;
    stopVad();
    if (rec && rec.state === "recording") {
      try { rec.stop(); } catch (_) {}
    }
    rec = null;
    if (micSrc) {
      try { micSrc.disconnect(); } catch (_) {}
      micSrc = null;
    }
    if (liveStream) {
      liveStream.getTracks().forEach((t) => t.stop());
      liveStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
    }
    analyser = null;
    $("hold").classList.remove("hot");
    if (state !== "dark" && state !== "off" && state !== "connect") setState("idle");
  }

  function bargeIn() {
    if (abort) abort.abort();
    abort = null;
    stopAudio();
    speakBuf = "";
  }

  $("connectForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const offered = $("tokenIn").value.trim();
    if (!offered) return;
    try {
      await fetch(apiUrl("/api/connect"), {
        method: "POST",
        credentials: creds(),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: offered }),
      }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "bad token");
      });
      token = offered;
      localStorage.setItem(TOKEN_KEY, offered);
      hideConnect();
      await refresh();
    } catch (err) {
      showConnect(err.message || "bad token");
    }
  });

  async function setMode(mode) {
    try {
      paintStatus(await api("/api/talk/mode", {
        method: "POST",
        body: JSON.stringify({ mode, hand: "bryan" }),
      }));
    } catch (e) { showErr(e.message); }
  }
  $("modeBtn").addEventListener("click", () => {
    setMode($("modeBtn").dataset.on === "1" ? "talk" : "counsel");
  });
  $("planBtn").addEventListener("click", () => {
    setMode($("planBtn").dataset.on === "1" ? "talk" : "gameplan");
  });

  async function setGear(gear) {
    try {
      paintStatus(await api("/api/talk/gear", {
        method: "POST",
        body: JSON.stringify({ gear, hand: "bryan" }),
      }));
    } catch (e) { showErr(e.message); }
  }
  $("talkGear").addEventListener("click", () => setGear("talk"));
  $("thinkGear").addEventListener("click", () => setGear("think"));
  $("deepGear").addEventListener("click", () => setGear("deep"));

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    paintHomeBtn();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    paintHomeBtn();
  });
  paintHomeBtn();
  $("menuBtn").addEventListener("click", () => showChats(true));
  $("homeBtn").addEventListener("click", async () => {
    if (alreadyHome()) return;
    if (installPrompt) {
      installPrompt.prompt();
      try { await installPrompt.userChoice; } catch (_) {}
      installPrompt = null;
      paintHomeBtn();
      return;
    }
    $("installSheet").hidden = false;
  });
  $("installClose").addEventListener("click", () => {
    $("installSheet").hidden = true;
  });
  $("webBtn").addEventListener("click", async () => {
    const on = $("webBtn").dataset.on === "1";
    try {
      paintStatus(await api("/api/talk/web", {
        method: "POST",
        body: JSON.stringify({ web: !on, hand: "bryan" }),
      }));
    } catch (e) { showErr(e.message); }
  });
  $("chatClose").addEventListener("click", () => showChats(false));
  $("chatArchived").addEventListener("click", () => {
    showArchived = !showArchived;
    if (status) paintChats(status);
  });
  $("chatNew").addEventListener("click", async () => {
    try {
      if (abort) abort.abort();
      paintStatus(await api("/api/talk/new", { method: "POST", body: "{}" }));
      showChats(false);
    } catch (e) { showErr(e.message); }
  });
  $("chatList").addEventListener("click", async (e) => {
    const arch = e.target.closest("button[data-archive]");
    if (arch) {
      const id = Number(arch.dataset.archive);
      try {
        paintStatus(await api("/api/talk/archive", {
          method: "POST",
          body: JSON.stringify({ id, archived: !showArchived, hand: "bryan" }),
        }));
      } catch (err) { showErr(err.message); }
      return;
    }
    const btn = e.target.closest("button[data-id]");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (!id) return;
    try {
      if (abort) abort.abort();
      paintStatus(await api("/api/talk/open", {
        method: "POST",
        body: JSON.stringify({ id }),
      }));
      showChats(false);
    } catch (err) { showErr(err.message); }
  });

  $("armBtn").addEventListener("click", async () => {
    const on = status && status.armed;
    try {
      paintStatus(await api(on ? "/api/talk/kill" : "/api/talk/arm", {
        method: "POST",
        body: JSON.stringify({ hand: "bryan" }),
      }));
    } catch (e) { showErr(e.message); }
  });

  $("attachBtn").addEventListener("click", () => $("attachIn").click());
  $("attachIn").addEventListener("change", async () => {
    const files = Array.from($("attachIn").files || []);
    $("attachIn").value = "";
    for (const f of files) {
      try {
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => {
            const s = String(r.result || "");
            const i = s.indexOf(",");
            resolve(i >= 0 ? s.slice(i + 1) : s);
          };
          r.onerror = reject;
          r.readAsDataURL(f);
        });
        paintStatus(await api("/api/talk/attach", {
          method: "POST",
          body: JSON.stringify({ name: f.name, mime: f.type || "", data }),
        }));
      } catch (err) {
        showErr(err.message || "could not attach");
      }
    }
  });
  $("chips").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-detach]");
    if (!b) return;
    try {
      paintStatus(await api("/api/talk/detach", {
        method: "POST",
        body: JSON.stringify({ id: Number(b.dataset.detach) }),
      }));
    } catch (err) { showErr(err.message); }
  });
  $("typeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("typeIn").value.trim();
    const pending = (status && status.attachments && status.attachments.length) || 0;
    if (!text && !pending) return;
    $("typeIn").value = "";
    try { await streamTalk(text); } catch (err) { showErr(err.message); }
  });

  $("typeIn").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("typeForm").requestSubmit();
    }
  });

  const hold = $("hold");
  function onHold(e) {
    if (e) e.preventDefault();
    const now = performance.now();
    if (now - lastHoldAt < 80) return;
    lastHoldAt = now;
    if (micStarting) return;
    if (!sessionOn) {
      startSession();
      return;
    }
    if (state === "talking" || state === "thinking" || state === "hearing") {
      bargeIn();
      stopVad();
      stopRecorder();
      armTurn();
      return;
    }
    hangUp();
  }
  hold.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    onHold(e);
  });
  hold.addEventListener("click", onHold);

  async function boot() {
    const offered = new URLSearchParams(location.search).get("token");
    if (offered) {
      try {
        await fetch(apiUrl("/api/connect"), {
          method: "POST",
          credentials: creds(),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: offered }),
        });
        token = offered;
        localStorage.setItem(TOKEN_KEY, offered);
        history.replaceState({}, "", location.pathname);
      } catch (_) { /* overlay will ask */ }
    }
    try {
      const h = await fetch(apiUrl("/api/health"), { credentials: creds() }).then((r) => r.json());
      if (!h.ok) throw new Error("dark");
      if (!h.authed && !token) {
        showConnect("");
        return;
      }
      await refresh();
    } catch (_) {
      if (token) {
        try { await refresh(); return; } catch (__) {}
      }
      try {
        const h = await fetch(apiUrl("/api/health")).then((r) => r.json());
        if (h && h.ok && !h.authed) showConnect("");
        else setState("dark");
      } catch (__) {
        setState("dark");
      }
    }
  }

  boot();
})();
