/* ============================================================
   Roman Balandin Realty — scroll-controlled cinematic film
   ============================================================ */
(() => {
  'use strict';

  /* ---------------- Config ---------------- */

  const TOTAL_FRAMES = 301;                       // extracted at 10 fps from tour.mp4
  const IS_MOBILE = window.matchMedia(
    '(max-width: 768px), ((pointer: coarse) and (max-width: 1024px))'
  ).matches;
  const FRAME_STEP  = IS_MOBILE ? 2 : 1;          // mobile: load every other frame
  const DPR_CAP     = IS_MOBILE ? 1 : 1.5;        // source is 1280x720 — nothing gained past this
  const SMOOTHING   = 0.16;                       // frame-index lerp per rAF tick
  const CONCURRENCY = 10;                         // parallel image loads
  const REDUCED     = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const framePath = n => 'frames/frame_' + String(n).padStart(4, '0') + '.jpg';

  /* The frame numbers this device will actually use */
  const frameNumbers = [];
  for (let n = 1; n <= TOTAL_FRAMES; n += FRAME_STEP) frameNumbers.push(n);
  const N = frameNumbers.length;

  /* Reveal the site once the opening stretch is ready and enough of the
     rest is buffered — remaining frames keep loading in the background. */
  const GATE_PREFIX = Math.ceil(N * 0.15);
  const GATE_TOTAL  = Math.ceil(N * 0.40);

  /* ---------------- Elements ---------------- */

  const canvas      = document.getElementById('film');
  const ctx         = canvas.getContext('2d');
  const filmSection = document.getElementById('film-scroll');
  const stage       = filmSection.querySelector('.stage');
  const scrim       = document.getElementById('scrim');
  const loader      = document.getElementById('loader');
  const loaderNum   = document.getElementById('loader-num');
  const loaderFill  = document.getElementById('loader-fill');
  const exploreBtn  = document.getElementById('explore-btn');

  /* Text overlays mapped to scroll progress (0 → 1) */
  const overlays = [
    { el: document.getElementById('ov-hero'), start: 0.00, end: 0.15, holdStart: true },
    { el: document.getElementById('ov-1'),    start: 0.20, end: 0.34 },                  // drone descending
    { el: document.getElementById('ov-2'),    start: 0.40, end: 0.54 },                  // entering the house
    { el: document.getElementById('ov-3'),    start: 0.63, end: 0.78 },                  // interior
    { el: document.getElementById('ov-4'),    start: 0.86, end: 1.001, holdEnd: true },  // pool reveal
  ];
  const finale = overlays[overlays.length - 1];

  /* ---------------- Frame loading ---------------- */

  const images      = new Array(N);
  const loadedFlags = new Uint8Array(N);
  let loadedCount = 0;   // successfully decoded
  let settled     = 0;   // load OR error — loader can never stall
  let contig      = 0;   // contiguous loaded prefix
  let nextToQueue = 0;
  let inFlight    = 0;
  let revealed    = false;
  let shownPct    = 0;

  function setLoaderPct(v) {
    if (v <= shownPct) return;
    shownPct = v;
    loaderNum.textContent = v;
    loaderFill.style.width = v + '%';
  }

  function loadOne(i) {
    inFlight++;
    const img = new Image();
    img.decoding = 'async';
    img.onload  = () => settle(i, true,  img);
    img.onerror = () => settle(i, false, img);
    img.src = framePath(frameNumbers[i]);
  }

  function settle(i, ok, img) {
    inFlight--;
    settled++;
    if (ok) {
      images[i] = img;
      loadedFlags[i] = 1;
      loadedCount++;
      while (contig < N && loadedFlags[contig]) contig++;
      if (i === 0) needsDraw = true;               // paint frame 1 behind the loader
    }
    setLoaderPct(Math.floor((settled / N) * 100));
    if (!revealed && ((contig >= GATE_PREFIX && loadedCount >= GATE_TOTAL) || settled === N)) {
      revealed = true;
      finishLoader();
    }
    pump();
  }

  function pump() {
    while (inFlight < CONCURRENCY && nextToQueue < N) loadOne(nextToQueue++);
  }

  /* Sweep the counter to 100, then fade the loader and unlock scrolling */
  function finishLoader() {
    const from = shownPct;
    const t0 = performance.now();
    const dur = REDUCED ? 0 : 550;
    const step = t => {
      const k = dur ? Math.min(1, (t - t0) / dur) : 1;
      setLoaderPct(Math.round(from + (100 - from) * k));
      if (k < 1) { requestAnimationFrame(step); return; }
      loader.classList.add('done');
      document.body.classList.remove('is-loading');
    };
    requestAnimationFrame(step);
  }

  /* ---------------- Canvas ---------------- */

  let stageW = 0, stageH = 0, scrollRange = 1;
  let needsDraw = true;

  function measure() {
    stageW = stage.clientWidth;
    stageH = stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    canvas.width  = Math.max(1, Math.round(stageW * dpr));
    canvas.height = Math.max(1, Math.round(stageH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    scrollRange = Math.max(1, filmSection.offsetHeight - stageH);
    needsDraw = true;
  }

  /* object-fit: cover */
  function draw(i) {
    const img = images[i];
    if (!img) return;
    const s  = Math.max(stageW / img.naturalWidth, stageH / img.naturalHeight);
    const dw = img.naturalWidth  * s;
    const dh = img.naturalHeight * s;
    ctx.clearRect(0, 0, stageW, stageH);
    ctx.drawImage(img, (stageW - dw) / 2, (stageH - dh) / 2, dw, dh);
  }

  /* Nearest decoded frame if the exact one isn't in yet */
  function nearestLoaded(i) {
    if (loadedFlags[i]) return i;
    for (let d = 1; d < N; d++) {
      if (i - d >= 0 && loadedFlags[i - d]) return i - d;
      if (i + d <  N && loadedFlags[i + d]) return i + d;
    }
    return -1;
  }

  /* ---------------- Overlays ---------------- */

  const smoothstep = a => a * a * (3 - 2 * a);

  function overlayOpacity(o, p) {
    if (p < o.start || p > o.end) return 0;
    const f = (o.end - o.start) * 0.28;
    const aIn  = o.holdStart ? 1 : Math.min(1, (p - o.start) / f);
    const aOut = o.holdEnd   ? 1 : Math.min(1, (o.end - p) / f);
    return smoothstep(Math.max(0, Math.min(aIn, aOut)));
  }

  let btnActive = false;

  function updateOverlays(p) {
    let maxOp = 0;
    for (const o of overlays) {
      const op = overlayOpacity(o, p);
      if (op > maxOp) maxOp = op;

      /* gentle vertical drift through each text's window */
      const t = Math.max(0, Math.min(1, (p - o.start) / (o.end - o.start)));
      let off = (0.5 - t) * 36;
      if (o.holdStart) off = Math.min(0, off);
      if (o.holdEnd)   off = Math.max(0, off);

      if (op !== o._op || off !== o._off) {
        o._op = op; o._off = off;
        o.el.style.opacity = op.toFixed(3);
        o.el.style.transform = 'translate3d(0,' + off.toFixed(1) + 'px,0)';
      }
    }
    scrim.style.opacity = (maxOp * 0.55).toFixed(3);

    const act = finale._op > 0.5;
    if (act !== btnActive) {
      btnActive = act;
      finale.el.classList.toggle('interactive', act);
      exploreBtn.tabIndex = act ? 0 : -1;
    }
  }

  /* ---------------- Main loop ---------------- */

  let current = 0;        // smoothed fractional frame index
  let drawnIndex = -1;

  function tick() {
    const p = Math.min(1, Math.max(0, window.scrollY / scrollRange));
    const targetFrame = p * (N - 1);

    if (REDUCED) {
      current = targetFrame;
    } else {
      current += (targetFrame - current) * SMOOTHING;
      if (Math.abs(targetFrame - current) < 0.05) current = targetFrame;
    }

    const idx = Math.round(current);
    if (idx !== drawnIndex || needsDraw) {
      const use = nearestLoaded(idx);
      if (use >= 0) {
        draw(use);
        drawnIndex = idx;
        needsDraw = false;
      }
    }

    updateOverlays(N > 1 ? current / (N - 1) : 0);
    requestAnimationFrame(tick);
  }

  /* ---------------- Content interactions ---------------- */

  exploreBtn.addEventListener('click', () => {
    document.getElementById('services')
      .scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
  });

  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.18 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  const form = document.getElementById('contact-form');
  form.addEventListener('submit', e => {
    e.preventDefault();
    form.reset();
    const note = document.getElementById('form-note');
    note.textContent = 'Thank you — we’ll be in touch within one business day.';
    note.classList.add('show');
  });

  /* Tiny state hook for debugging / automated checks */
  window.__rbState = () => ({
    frames: N, loaded: loadedCount, settled, contig, revealed,
    drawnIndex, current: +current.toFixed(2),
    scrollY: window.scrollY, scrollRange
  });

  /* ---------------- Init ---------------- */

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  measure();
  window.addEventListener('resize', measure);

  pump();                      // start preloading frames
  requestAnimationFrame(tick); // start the render loop
})();
