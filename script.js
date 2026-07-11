/* ============================================================
   Roman Balandin Realty — scroll-controlled cinematic film
   ============================================================ */
(() => {
  'use strict';

  /* ---------------- Config ---------------- */

  const IS_MOBILE = window.matchMedia(
    '(max-width: 768px), ((pointer: coarse) and (max-width: 1024px))'
  ).matches;
  /* Desktop: 1920x1080 frames at 10fps. Mobile: 1280x720 at 5fps (lighter). */
  const FRAME_DIR   = IS_MOBILE ? 'frames-sm' : 'frames';
  const N           = IS_MOBILE ? 150 : 301;
  const DPR_CAP     = 2;                          // sharp on scaled/retina displays
  const CONCURRENCY = 12;                         // parallel image loads
  const REDUCED     = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Decode-ahead window (pre-decoded ImageBitmaps around the playhead) */
  const HAS_IB      = typeof createImageBitmap === 'function';
  const AHEAD       = IS_MOBILE ? 14 : 20;
  const BEHIND      = IS_MOBILE ? 6  : 8;
  const MAX_DECODES = 4;

  const framePath = i => FRAME_DIR + '/frame_' + String(i + 1).padStart(4, '0') + '.jpg';

  /* Reveal once the opening 45% is fully buffered and 60% overall is in —
     scrolling can no longer outrun the network. Rest streams in background. */
  const GATE_PREFIX = Math.ceil(N * 0.45);
  const GATE_TOTAL  = Math.ceil(N * 0.60);

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
    img.src = framePath(i);
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

  /* ---------------- Decode-ahead bitmap cache ----------------
     Pre-decodes JPEGs into ImageBitmaps around the playhead so
     drawImage never pays a synchronous decode mid-scroll.        */

  const bitmaps = new Map();   // idx -> ImageBitmap | Promise
  let pendingDecodes = 0;
  let decodeDir = 1;

  function maybeDecode(idx) {
    if (bitmaps.has(idx) || !loadedFlags[idx] || pendingDecodes >= MAX_DECODES) return;
    pendingDecodes++;
    const p = createImageBitmap(images[idx]).then(bm => {
      if (bitmaps.get(idx) === p) bitmaps.set(idx, bm);
      else bm.close();
    }).catch(() => {
      if (bitmaps.get(idx) === p) bitmaps.delete(idx);
    }).finally(() => { pendingDecodes--; });
    bitmaps.set(idx, p);
  }

  function ensureWindow(center) {
    if (!HAS_IB) return;
    const fwd = decodeDir >= 0;
    const lo = Math.max(0,     center - (fwd ? BEHIND : AHEAD));
    const hi = Math.min(N - 1, center + (fwd ? AHEAD  : BEHIND));
    for (const [k, v] of bitmaps) {
      if (k < lo - 3 || k > hi + 3) {
        if (v && typeof v.close === 'function') v.close();
        bitmaps.delete(k);
      }
    }
    /* fill in the direction of travel first */
    if (fwd) {
      for (let i = center; i <= hi; i++) maybeDecode(i);
      for (let i = center - 1; i >= lo; i--) maybeDecode(i);
    } else {
      for (let i = center; i >= lo; i--) maybeDecode(i);
      for (let i = center + 1; i <= hi; i++) maybeDecode(i);
    }
  }

  /* Best drawable source for a frame: decoded bitmap, else raw image */
  function frameSource(i) {
    const bm = bitmaps.get(i);
    if (bm && typeof bm.close === 'function') return bm;
    return loadedFlags[i] ? images[i] : null;
  }

  /* ---------------- Canvas ---------------- */

  let bw = 0, bh = 0, scrollRange = 1;
  let needsDraw = true;

  function measure() {
    const cssW = stage.clientWidth;
    const cssH = stage.clientHeight;
    /* Backing beyond ~1.25x the 1080p source adds nothing visible —
       cap it so draws stay cheap on scaled/4K displays. */
    const capH = IS_MOBILE ? Infinity : 1350;
    const dpr = Math.max(0.75, Math.min(
      window.devicePixelRatio || 1, DPR_CAP, capH / Math.max(1, cssH)
    ));
    bw = Math.max(1, Math.round(cssW * dpr));
    bh = Math.max(1, Math.round(cssH * dpr));
    canvas.width  = bw;
    canvas.height = bh;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    scrollRange = Math.max(1, filmSection.offsetHeight - cssH);
    if (aboutSec) {
      vh = window.innerHeight;
      const r = aboutSec.getBoundingClientRect();
      aboutMid  = r.top + window.scrollY + r.height / 2;
      aboutSpan = (r.height + vh) / 2;
    }
    needsDraw = true;
  }

  /* object-fit: cover (backing-pixel space; pre-scaled bitmaps blit 1:1) */
  function coverDraw(src) {
    const iw = src.naturalWidth  || src.width;
    const ih = src.naturalHeight || src.height;
    const s  = Math.max(bw / iw, bh / ih);
    ctx.drawImage(src, (bw - iw * s) / 2, (bh - ih * s) / 2, iw * s, ih * s);
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

  /* Cross-fade between the two frames around the fractional playhead —
     10fps stills read as continuous, motion-blurred film. */
  function drawBlended(pos) {
    const i = Math.floor(pos);
    const j = Math.min(N - 1, i + 1);
    const f = pos - i;

    let si = frameSource(i);
    let sj = (f > 0.02 && j !== i) ? frameSource(j) : null;

    if (!si) {
      const nb = nearestLoaded(i);
      if (nb < 0) return false;
      si = frameSource(nb);
      sj = null;
      if (!si) return false;
    }

    ctx.globalAlpha = 1;
    coverDraw(si);
    if (sj) {
      ctx.globalAlpha = f;
      coverDraw(sj);
      ctx.globalAlpha = 1;
    }
    return true;
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

  let current = 0;            // smoothed fractional frame index
  let lastDrawnPos = -1;

  function tick() {
    const p = Math.min(1, Math.max(0, window.scrollY / scrollRange));
    const exact = p * (N - 1);

    /* When scrolling has (nearly) stopped, settle on a WHOLE frame —
       resting on a fractional position would show two frames blended
       (a permanent double exposure). Blend only exists while moving. */
    const target = Math.abs(exact - current) < 0.6 ? Math.round(exact) : exact;
    const delta = target - current;

    if (REDUCED) {
      current = Math.round(exact);
    } else {
      /* adaptive smoothing: glide on slow scrolls, snap on fast flicks
         so the film never trails the scroll wheel */
      const k = Math.min(0.5, 0.14 + Math.abs(delta) * 0.006);
      current += delta * k;
      if (Math.abs(target - current) < 0.02) current = target;
    }

    if (delta > 0.5) decodeDir = 1;
    else if (delta < -0.5) decodeDir = -1;
    ensureWindow(Math.round(current));

    if (needsDraw || Math.abs(current - lastDrawnPos) > 0.003) {
      if (drawBlended(current)) {
        lastDrawnPos = current;
        needsDraw = false;
      }
    }

    updateOverlays(N > 1 ? current / (N - 1) : 0);
    aboutParallax();
    requestAnimationFrame(tick);
  }

  /* ---------------- Content interactions ---------------- */

  exploreBtn.addEventListener('click', () => {
    document.getElementById('services')
      .scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
  });

  /* ---- About-section cinematics ---- */

  /* Split a heading into masked words for the cascade reveal (keeps <br>) */
  function cascadeSplit(el) {
    const frag = document.createDocumentFragment();
    let w = 0;
    for (const node of [...el.childNodes]) {
      if (node.nodeType === 3) {
        for (const part of node.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); continue; }
          const outer = document.createElement('span');
          outer.className = 'cw';
          const inner = document.createElement('span');
          inner.className = 'cwi';
          inner.textContent = part;
          inner.style.setProperty('--wd', (w++ * 110) + 'ms');
          outer.appendChild(inner);
          frag.appendChild(outer);
        }
      } else {
        frag.appendChild(node.cloneNode(false));
      }
    }
    el.textContent = '';
    el.appendChild(frag);
  }
  document.querySelectorAll('.cascade').forEach(cascadeSplit);

  /* Parallax drift: columns separate slightly, gold glow floats */
  const aboutSec  = document.getElementById('about');
  const aboutMain = document.querySelector('.about-main');
  const awardsCol = document.querySelector('#about .awards');
  const aboutGlow = document.querySelector('#about .section-glow');
  let aboutMid = 0, aboutSpan = 1, vh = window.innerHeight;

  function aboutParallax() {
    if (REDUCED || !aboutSec) return;
    const rel = Math.max(-1, Math.min(1,
      (window.scrollY + vh / 2 - aboutMid) / aboutSpan));
    aboutMain.style.transform = 'translate3d(0,' + (rel * -14).toFixed(1) + 'px,0)';
    awardsCol.style.transform = 'translate3d(0,' + (rel *  20).toFixed(1) + 'px,0)';
    aboutGlow.style.transform = 'translate3d(0,' + (rel * -80).toFixed(1) + 'px,0)';
  }

  /* Gold count-up for the stats band */
  function countUp(el) {
    const target = parseInt(el.dataset.count, 10);
    if (REDUCED) { el.textContent = target.toLocaleString('en-US'); return; }
    const t0 = performance.now(), dur = 1800;
    (function step(t) {
      const k = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(target * eased).toLocaleString('en-US');
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        e.target.querySelectorAll('[data-count]').forEach(countUp);
        /* gold light-sweep once the cascade words have settled */
        if (e.target.classList.contains('cascade') && !REDUCED) {
          const el = e.target;
          setTimeout(() => {
            el.classList.add('shimmer-on');
            el.addEventListener('animationend',
              () => el.classList.remove('shimmer-on'), { once: true });
          }, 1600);
        }
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.18 });
  document.querySelectorAll('.reveal, .line-draw').forEach(el => io.observe(el));

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
    drawnIndex: Math.round(lastDrawnPos), current: +current.toFixed(2),
    bitmaps: bitmaps.size, scrollY: window.scrollY, scrollRange
  });

  /* ---------------- Init ---------------- */

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  measure();
  window.addEventListener('resize', measure);

  pump();                      // start preloading frames
  requestAnimationFrame(tick); // start the render loop
})();
