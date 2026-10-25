// render3d.js —— 成员二 · 三维地形渲染（three r150 UMD，全局 THREE，断网、无 ESM、无网络请求）
// 单独跑：双击 启动.bat，或在 app 目录执行 python -m http.server 8000，访问 http://localhost:8000/view3d.html
// 冒烟：页面状态栏打出 min/max，应与 meta.json 一致（AOI1 1779.2/2519.0，AOI2 797.6/5057.9）。
//
// 依赖顺序：lib/three.min.js → js/palette.js(可选，成员一) → js/orbit.js → js/render3d.js
//
// ── 对外接口（§3.2 冻结）──────────────────────────────────────────────
//   mount3D(container, {z, meta, ve = 2})   z: Float32Array，行优先、左上角起，长度 w×h
//   setVE(v)                                 1..6，实时改垂直夸大
//   screenshot() -> dataURL                  PNG，含「垂直夸大」角标与数据来源
// ── 附加接口（非冻结，可选用；推荐一律通过命名空间 Render3D.* 调用，避免与 2D 函数撞名）──
//   mount3D 第二参数另收 {segments = 512, fog = true, hover = true, onPick}
//        segments=256 为二级降级；onPick({ix, iy, elev}) 在三维里单击时回调，可与 2D 查询联动
//   Render3D.setView(name)        'default' | 'top' | 'nw' | 'se' | 'south'
//   Render3D.spin(on)             自动环绕（演示「转一圈」）
//   Render3D.pick3D(clientX, clientY) -> {ix, iy, elev} | null   elev 为 dem.bin 原生值（误差 0）
//   Render3D.setOverlay(mask, {name, color, alpha, thicken})   叠加河网/流域：mask 为 Uint8Array(w×h)，非 0 处上色；
//        thicken 为显示加粗像元数（默认按分辨率自动 0–2，检查断头时可传 0 并放大看）
//   Render3D.clearOverlay(name?)  不传 name 清除全部
//   Render3D.setDrape(canvas|null, {lit})  把 w×h 画布（如二维当前图层）贴到地表；null 恢复高程色带
//   mount3D 另收 {background}     场景背景色（默认浅灰 #dfe6ec），深色界面可传 '#0d1117'
//   Render3D.unmount3D()          释放 WebGL 资源
//   Render3D.info()               {fps, segments, vertices, ve, view, buildMs, paletteFrom, extent_km}
//
// 尺度约定：场景单位 = km。水平用 meta.dx_m/dy_m，垂直用 (高程 − min)/1000 × ve。
// 因此 ve=1 即真实比例，角标「垂直夸大 ×N」是真实的垂直夸大倍数（未按 max−min 归一化）。
(function (global) {
  'use strict';

  // ---------- 色带：优先成员一 palette.js（RAMP_HEX，其次 rampColor），避免两套配色 ----------
  var FALLBACK_RAMP = [
    [0.00, '#2f6b3a'],  // 深绿
    [0.25, '#8fb04f'],  // 黄绿
    [0.50, '#c8b46a'],  // 土黄
    [0.75, '#8a5a35'],  // 棕
    [1.00, '#ecebe6']   // 灰白
  ];

  function hexToRgb(h) {
    h = String(h).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255];
  }

  function buildRamp() {
    var stops = null, from = 'fallback';
    try {
      var R = global.RAMP_HEX;
      if (Array.isArray(R) && R.length >= 2) {
        // 兼容 [[t,'#hex'],…] 与 ['#hex',…] 两种写法
        stops = R.map(function (s, i) {
          return Array.isArray(s) ? { t: +s[0], c: hexToRgb(s[1]) } : { t: i / (R.length - 1), c: hexToRgb(s) };
        });
        from = 'palette.js RAMP_HEX';
      } else if (typeof global.rampColor === 'function') {
        // rampColor 返回值是 0–1 还是 0–255 契约没写，这里自动判断
        var raw = [], mx = 0;
        for (var i = 0; i <= 20; i++) { var c = global.rampColor(i / 20); raw.push(c); mx = Math.max(mx, c[0], c[1], c[2]); }
        var k = mx > 1.001 ? 1 / 255 : 1;
        stops = raw.map(function (c, i) { return { t: i / 20, c: [c[0] * k, c[1] * k, c[2] * k] }; });
        from = 'palette.js rampColor';
      }
    } catch (e) { console.warn('render3d: 读取 palette.js 失败，使用内置色带', e); stops = null; }
    if (!stops || stops.some(function (s) { return isNaN(s.t) || isNaN(s.c[0]); })) {
      stops = FALLBACK_RAMP.map(function (s) { return { t: s[0], c: hexToRgb(s[1]) }; });
      from = 'fallback';
    }
    stops.sort(function (a, b) { return a.t - b.t; });
    return { stops: stops, from: from };
  }

  function rampAt(stops, t, out) {
    if (t <= stops[0].t) { out[0] = stops[0].c[0]; out[1] = stops[0].c[1]; out[2] = stops[0].c[2]; return; }
    for (var i = 1; i < stops.length; i++) {
      if (t <= stops[i].t) {
        var a = stops[i - 1], b = stops[i], k = (t - a.t) / ((b.t - a.t) || 1);
        out[0] = a.c[0] + (b.c[0] - a.c[0]) * k;
        out[1] = a.c[1] + (b.c[1] - a.c[1]) * k;
        out[2] = a.c[2] + (b.c[2] - a.c[2]) * k;
        return;
      }
    }
    var l = stops[stops.length - 1].c; out[0] = l[0]; out[1] = l[1]; out[2] = l[2];
  }

  // ---------- 状态（单例：页面上同时只挂一个三维视图） ----------
  var S = null;
  var API = null;

  function fmtVE(v) { return (Math.round(v * 10) / 10).toString().replace(/\.0$/, ''); }
  function css(el, s) { el.style.cssText = s; return el; }
  var FONT = 'system-ui,"Microsoft YaHei",sans-serif';

  function unmount3D() {
    if (!S) return;
    cancelAnimationFrame(S.raf);
    S.ro && S.ro.disconnect();
    S.orbit && S.orbit.dispose();
    S.offPointer && S.offPointer();
    clearOverlay();
    setDrape(null);
    S.geom.dispose(); S.mat.dispose();
    S.renderer.dispose();
    S.renderer.forceContextLoss && S.renderer.forceContextLoss();
    S.overlays = null;
    S.els.forEach(function (el) { el && el.parentNode && el.parentNode.removeChild(el); });
    S = null;
  }

  function mount3D(container, opt) {
    if (!global.THREE) throw new Error('render3d: 缺少 THREE，请先加载 lib/three.min.js');
    if (!global.Orbit3D) throw new Error('render3d: 缺少 Orbit3D，请先加载 js/orbit.js');
    if (!container) throw new Error('render3d: container 为空');
    opt = opt || {};
    var z = opt.z, meta = opt.meta;
    if (!z || !meta) throw new Error('render3d: 需要 {z, meta}');
    var w = meta.width, h = meta.height;
    if (z.length !== w * h) throw new Error('render3d: z 长度 ' + z.length + ' ≠ w×h ' + (w * h));

    var segReq = opt.segments || 512, fogReq = opt.fog !== false;
    var bgReq = opt.background != null ? new THREE.Color(opt.background).getHex() : 0xdfe6ec;
    // 同一份数据、同样参数再次挂载（例如来回切 tab）→ 直接复用，不重建网格
    if (S && S.z === z && S.segReq === segReq && S.fog === fogReq && S.bg === bgReq) {
      if (S.container !== container) {
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        S.els.forEach(function (el) { container.appendChild(el); });
        S.ro && (S.ro.disconnect(), S.ro.observe(container));
        S.container = container;
      }
      S.onPick = opt.onPick || S.onPick;
      if (opt.ve != null) setVE(opt.ve);
      S.resize();
      return API;
    }
    unmount3D();

    var t0 = performance.now();
    var ve = opt.ve != null ? opt.ve : 2;
    var segLong = Math.max(16, Math.min(segReq, Math.max(w, h) - 1));
    // 长边 segLong 段，短边按比例，保证网格接近正方形（AOI1 → 512×439，AOI2 → 512×410）
    var segX = w >= h ? segLong : Math.max(8, Math.round(segLong * w / h));
    var segY = w >= h ? Math.max(8, Math.round(segLong * h / w)) : segLong;

    var NODATA = meta.nodata != null ? meta.nodata : -99999;
    var isNo = function (v) { return v !== v || v <= NODATA + 1 || v < -9000; };
    var zmin = meta.elev && meta.elev.min, zmax = meta.elev && meta.elev.max;
    if (zmin == null || zmax == null) {            // meta 缺 elev 时现算
      zmin = Infinity; zmax = -Infinity;
      for (var q = 0; q < z.length; q++) { var vq = z[q]; if (!isNo(vq)) { if (vq < zmin) zmin = vq; if (vq > zmax) zmax = vq; } }
    }
    var zr = (zmax - zmin) || 1;
    var Wkm = w * meta.dx_m / 1000, Hkm = h * meta.dy_m / 1000;

    // ---------- 几何：双线性采样 ----------
    var geom = new THREE.PlaneGeometry(Wkm, Hkm, segX, segY);   // 顶点从左上（西北）起，逐行向南
    var pos = geom.attributes.position.array;
    var nx = segX + 1, ny = segY + 1, nv = nx * ny;
    var hv = new Float32Array(nv);                              // 每个顶点的高程（m）
    var cx0 = new Int32Array(nx), cx1 = new Int32Array(nx), ctx = new Float32Array(nx);
    for (var i = 0; i < nx; i++) {
      var fx = i / segX * (w - 1), ix = Math.floor(fx);
      cx0[i] = ix; cx1[i] = Math.min(ix + 1, w - 1); ctx[i] = fx - ix;
    }
    for (var j = 0; j < ny; j++) {
      var fy = j / segY * (h - 1), iy = Math.floor(fy), iy1 = Math.min(iy + 1, h - 1), ty = fy - iy;
      var r0 = iy * w, r1 = iy1 * w;
      for (i = 0; i < nx; i++) {
        var a = z[r0 + cx0[i]], b = z[r0 + cx1[i]], c = z[r1 + cx0[i]], d = z[r1 + cx1[i]];
        if (isNo(a)) a = zmin; if (isNo(b)) b = zmin; if (isNo(c)) c = zmin; if (isNo(d)) d = zmin;
        var tx = ctx[i];
        var v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        var k = j * nx + i;
        hv[k] = v;
        pos[k * 3 + 2] = (v - zmin) / 1000;                     // km，未夸大；夸大用 mesh.scale.z
      }
    }
    geom.attributes.position.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    // ---------- 顶点色：高程色带 × 坡度明暗 ----------
    var ramp = buildRamp();
    var col = new Float32Array(nv * 3), rgb = [0, 0, 0];
    var sx = Wkm * 1000 / segX, sy = Hkm * 1000 / segY;       // 顶点间距（m）
    for (j = 0; j < ny; j++) {
      var jm = Math.max(j - 1, 0), jp = Math.min(j + 1, ny - 1);
      for (i = 0; i < nx; i++) {
        var im = Math.max(i - 1, 0), ip = Math.min(i + 1, nx - 1);
        k = j * nx + i;
        var gx = (hv[j * nx + ip] - hv[j * nx + im]) / ((ip - im) * sx);
        var gy = (hv[jp * nx + i] - hv[jm * nx + i]) / ((jp - jm) * sy);
        var slopeDeg = Math.atan(Math.sqrt(gx * gx + gy * gy)) * 57.29578;
        var shade = 1 - 0.55 * Math.min(slopeDeg / 45, 1);    // 坡度越大越暗，45° 以上压到 0.45
        rampAt(ramp.stops, (hv[k] - zmin) / zr, rgb);
        col[k * 3] = rgb[0] * shade; col[k * 3 + 1] = rgb[1] * shade; col[k * 3 + 2] = rgb[2] * shade;
      }
    }
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));

    var mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    var mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.x = -Math.PI / 2;                            // 本地 z → 世界 y（上），本地 y → 世界 -z（北）
    mesh.scale.z = ve;

    // ---------- 场景、光照、雾 ----------
    var BG = bgReq;                                            // 默认浅灰；深色界面可传 background
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.add(mesh);
    scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    var sun = new THREE.DirectionalLight(0xffffff, 0.95);
    var az = 315 * Math.PI / 180, el = 35 * Math.PI / 180, L = Math.max(Wkm, Hkm) * 2;
    sun.position.set(Math.sin(az) * Math.cos(el) * L, Math.sin(el) * L, -Math.cos(az) * Math.cos(el) * L);
    scene.add(sun);
    if (fogReq) scene.fog = new THREE.Fog(BG, 1, 2);

    // ---------- 渲染器、相机、DOM ----------
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    css(renderer.domElement, 'display:block;width:100%;height:100%;touch-action:none;');

    var badge = css(document.createElement('div'),
      'position:absolute;right:10px;bottom:10px;padding:4px 10px;background:rgba(0,0,0,.6);color:#fff;' +
      'font:13px/1.4 ' + FONT + ';border-radius:4px;pointer-events:none;');
    badge.className = 'r3d-badge';
    var credit = css(document.createElement('div'),
      'position:absolute;left:10px;bottom:10px;padding:2px 6px;background:rgba(255,255,255,.7);color:#333;' +
      'font:11px/1.4 ' + FONT + ';border-radius:3px;pointer-events:none;max-width:60%;');
    credit.className = 'r3d-credit';
    credit.textContent = (meta.name ? meta.name + ' · ' : '') + '数据：' + (meta.source || '未注明');
    var tip = css(document.createElement('div'),
      'position:absolute;display:none;padding:2px 6px;background:rgba(255,255,255,.92);color:#222;' +
      'font:12px/1.4 Consolas,' + FONT + ';border:1px solid #999;border-radius:3px;pointer-events:none;white-space:nowrap;');
    tip.className = 'r3d-tip';
    [renderer.domElement, badge, credit, tip].forEach(function (e) { container.appendChild(e); });

    var R0 = Math.max(Wkm, Hkm) * 1.25;
    var camera = new THREE.PerspectiveCamera(40, 1, R0 * 0.005, R0 * 20);

    S = {
      container: container, renderer: renderer, scene: scene, camera: camera, mesh: mesh, geom: geom, mat: mat,
      els: [renderer.domElement, badge, credit, tip], badge: badge, tip: tip,
      z: z, meta: meta, w: w, h: h, zmin: zmin, zmax: zmax, isNo: isNo,
      ve: ve, R0: R0, Wkm: Wkm, Hkm: Hkm, segReq: segReq, fog: fogReq, bg: bgReq, baseMat: mat, drape: null,
      segX: segX, segY: segY, nv: nv, dirty: true, spin: false, view: 'default',
      fps: 0, frames: 0, fpsT: performance.now(), raf: 0, ro: null, orbit: null,
      overlays: {}, onPick: opt.onPick || null, hover: opt.hover !== false
    };

    S.orbit = global.Orbit3D.create(camera, renderer.domElement, {
      azimuth: 200, elevation: 38, radius: R0, minRadius: R0 * 0.08, maxRadius: R0 * 6,
      onChange: function (st) {
        camera.near = st.radius * 0.005; camera.far = st.radius * 20; camera.updateProjectionMatrix();
        if (scene.fog) { scene.fog.near = st.radius * 0.9; scene.fog.far = st.radius * 3.2; }
        if (S) S.dirty = true;
      }
    });

    function resize() {
      if (!S) return;
      var cw = S.container.clientWidth, ch = S.container.clientHeight;
      if (!cw || !ch) return;                                  // tab 隐藏时跳过，显示后 ResizeObserver 会再触发
      renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));   // 拖到不同 DPR 的屏幕时跟着变
      renderer.setSize(cw, ch, false);
      camera.aspect = cw / ch; camera.updateProjectionMatrix();
      S.dirty = true;
    }
    S.resize = resize;
    if (global.ResizeObserver) { S.ro = new ResizeObserver(resize); S.ro.observe(container); }
    else global.addEventListener('resize', resize);
    renderer.setSize(800, 500, false);
    resize();

    // ---------- 悬停读高程 / 单击回调 ----------
    var hoverPending = null, downAt = null;
    function onMove(ev) {
      if (!S || !S.hover) return;
      if (ev.buttons) { tip.style.display = 'none'; return; }
      if (hoverPending) { hoverPending.x = ev.clientX; hoverPending.y = ev.clientY; return; }
      hoverPending = { x: ev.clientX, y: ev.clientY };
      requestAnimationFrame(function () {
        var p = hoverPending; hoverPending = null;
        if (!S) return;
        var r = pick3D(p.x, p.y);
        if (!r) { tip.style.display = 'none'; return; }
        var box = S.container.getBoundingClientRect();
        tip.textContent = '高程 ' + r.elev.toFixed(1) + ' m · 行 ' + r.iy + ' 列 ' + r.ix;
        tip.style.left = (p.x - box.left + 14) + 'px';
        tip.style.top = (p.y - box.top + 14) + 'px';
        tip.style.display = 'block';
      });
    }
    function onLeave() { tip.style.display = 'none'; }
    function onDown(ev) { downAt = { x: ev.clientX, y: ev.clientY }; }
    function onUp(ev) {
      if (!downAt || !S || !S.onPick) return;
      var moved = Math.abs(ev.clientX - downAt.x) + Math.abs(ev.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return;                                   // 拖拽不算单击
      var r = pick3D(ev.clientX, ev.clientY);
      if (r) S.onPick(r);
    }
    var cv = renderer.domElement;
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointerup', onUp);
    S.offPointer = function () {
      cv.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerleave', onLeave);
      cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointerup', onUp);
    };

    setVE(ve);

    // 按需渲染：相机/夸大变化或自动环绕时才画，静止时不占 GPU
    function loop() {
      if (!S) return;
      S.raf = requestAnimationFrame(loop);
      if (S.spin) S.orbit.rotate(0.35);
      if (!S.dirty) { S.frames = 0; S.fpsT = performance.now(); return; }   // 空闲帧清零，帧率只统计连续渲染
      S.dirty = false;
      renderer.render(scene, camera);
      S.frames++;
      var now = performance.now();
      if (now - S.fpsT >= 1000) { S.fps = Math.round(S.frames * 1000 / (now - S.fpsT)); S.frames = 0; S.fpsT = now; }
    }
    loop();

    S.buildMs = Math.round(performance.now() - t0);
    S.paletteFrom = ramp.from;
    return API;
  }

  function setVE(v) {
    if (!S) return;
    v = Math.max(1, Math.min(6, +v || 1));
    S.ve = v;
    S.mesh.scale.z = v;                                        // 叠加层是 mesh 的子对象，自动跟随
    S.badge.textContent = '垂直夸大 ×' + fmtVE(v);
    S.dirty = true;
  }

  var VIEWS = {
    'default': { azimuth: 200, elevation: 38 },
    'top':     { azimuth: 180, elevation: 89.5 },
    'nw':      { azimuth: 315, elevation: 35 },   // 从西北、迎着光看
    'se':      { azimuth: 135, elevation: 30 },   // 从东南看，阴坡朝向观众
    'south':   { azimuth: 180, elevation: 25 }
  };
  function setView(name) {
    if (!S) return;
    var p = VIEWS[name] || VIEWS['default'];
    S.view = VIEWS[name] ? name : 'default';
    // 俯视时夸大后的山顶离相机更近，拉远一点保证全幅入画
    var r = S.view === 'top' ? S.R0 * (1.15 + 0.03 * S.ve) : S.R0;
    S.orbit.set({ azimuth: p.azimuth, elevation: p.elevation, radius: r, resetTarget: true });
  }

  // 键盘微调：方位 dAz°、俯仰 dEl°、缩放系数 k（<1 拉近）
  function nudge(dAz, dEl, k) {
    if (!S) return;
    var g = S.orbit.get();
    S.orbit.set({ azimuth: g.azimuth + (dAz || 0), elevation: g.elevation + (dEl || 0), radius: g.radius * (k || 1) });
  }

  function spin(on) { if (S) { S.spin = on == null ? !S.spin : !!on; S.dirty = true; } return S ? S.spin : false; }

  // ---------- 拾取：屏幕坐标 → 栅格行列 + 原生高程 ----------
  // 在网格本地坐标里沿视线步进，按 dem.bin 全分辨率双线性高程求交，再取最近像元的原生值
  var _ray = null, _inv = null, _ndc = null;
  function sampleLocal(x, y) {
    var fx = (x / S.Wkm + 0.5) * (S.w - 1), fy = (0.5 - y / S.Hkm) * (S.h - 1);
    if (fx < 0 || fy < 0 || fx > S.w - 1 || fy > S.h - 1) return null;
    var x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, S.w - 1), y1 = Math.min(y0 + 1, S.h - 1);
    var tx = fx - x0, ty = fy - y0, z = S.z, w = S.w;
    var a = z[y0 * w + x0], b = z[y0 * w + x1], c = z[y1 * w + x0], d = z[y1 * w + x1];
    if (S.isNo(a)) a = S.zmin; if (S.isNo(b)) b = S.zmin; if (S.isNo(c)) c = S.zmin; if (S.isNo(d)) d = S.zmin;
    return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty - S.zmin) / 1000;
  }
  function pick3D(clientX, clientY) {
    if (!S) return null;
    var rect = S.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    _ray = _ray || new THREE.Raycaster(); _inv = _inv || new THREE.Matrix4(); _ndc = _ndc || new THREE.Vector2();
    _ndc.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    S.mesh.updateMatrixWorld();
    _ray.setFromCamera(_ndc, S.camera);
    _inv.copy(S.mesh.matrixWorld).invert();
    var o = _ray.ray.origin.clone().applyMatrix4(_inv);
    var dEnd = _ray.ray.origin.clone().add(_ray.ray.direction).applyMatrix4(_inv);
    var d = dEnd.sub(o);                                       // 本地坐标下的方向（含夸大缩放，不归一化）
    // 与包围盒 [-W/2,W/2]×[-H/2,H/2]×[0,zr] 求交，得到步进区间
    var lo = [-S.Wkm / 2, -S.Hkm / 2, 0], hi = [S.Wkm / 2, S.Hkm / 2, (S.zmax - S.zmin) / 1000 + 1e-6];
    var oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z], t0 = 0, t1 = Infinity;
    for (var a = 0; a < 3; a++) {
      if (Math.abs(dd[a]) < 1e-12) { if (oo[a] < lo[a] || oo[a] > hi[a]) return null; continue; }
      var ta = (lo[a] - oo[a]) / dd[a], tb = (hi[a] - oo[a]) / dd[a];
      if (ta > tb) { var tt = ta; ta = tb; tb = tt; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
    var N = 1200, prev = t0, hit = -1;
    for (var s = 0; s <= N; s++) {
      var t = t0 + (t1 - t0) * s / N;
      var px = oo[0] + dd[0] * t, py = oo[1] + dd[1] * t, pz = oo[2] + dd[2] * t;
      var hz = sampleLocal(px, py);
      if (hz != null && pz <= hz) { hit = t; break; }
      prev = t;
    }
    if (hit < 0) return null;
    var aT = prev, bT = hit;                                   // 二分细化
    for (var it = 0; it < 24; it++) {
      var m = (aT + bT) / 2, hm = sampleLocal(oo[0] + dd[0] * m, oo[1] + dd[1] * m);
      if (hm != null && oo[2] + dd[2] * m <= hm) bT = m; else aT = m;
    }
    var X = oo[0] + dd[0] * bT, Y = oo[1] + dd[1] * bT;
    var ix = Math.round((X / S.Wkm + 0.5) * (S.w - 1)), iy = Math.round((0.5 - Y / S.Hkm) * (S.h - 1));
    ix = Math.max(0, Math.min(S.w - 1, ix)); iy = Math.max(0, Math.min(S.h - 1, iy));
    return { ix: ix, iy: iy, elev: S.z[iy * S.w + ix] };
  }

  // ---------- 叠加层：河网 / 流域掩膜贴到三维地表 ----------
  function setOverlay(mask, o) {
    if (!S) return;
    o = o || {};
    var name = o.name || 'default';
    if (!mask || mask.length !== S.w * S.h) throw new Error('render3d.setOverlay: mask 长度应为 w×h = ' + (S.w * S.h));
    clearOverlay(name);
    var rgb = hexToRgb(o.color || '#1e6fff'), A = Math.round(255 * (o.alpha != null ? o.alpha : 0.9));
    var R = Math.round(rgb[0] * 255), G = Math.round(rgb[1] * 255), B = Math.round(rgb[2] * 255);
    var w = S.w, h = S.h, px = new Uint8Array(w * h * 4);
    // 加粗（仅影响显示）：细河道缩小显示时会断续，默认按纹理/屏幕比例自动加粗 0–2 像元；传 thicken:0 可关闭
    var th = o.thicken != null ? o.thicken : Math.max(0, Math.min(2, Math.round(Math.max(w, h) / 1000)));
    var src = mask;
    if (th > 0) {
      src = new Uint8Array(w * h);
      for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
        if (!mask[yy * w + xx]) continue;
        for (var dy = -th; dy <= th; dy++) for (var dx = -th; dx <= th; dx++) {
          var X2 = xx + dx, Y2 = yy + dy;
          if (X2 >= 0 && Y2 >= 0 && X2 < w && Y2 < h) src[Y2 * w + X2] = 1;
        }
      }
    }
    for (var y = 0; y < h; y++) {
      var s0 = y * w, dst = (h - 1 - y) * w;                   // 纹理第 0 行在底部，翻转使北在上
      for (var x = 0; x < w; x++) {
        var p = (dst + x) * 4;
        px[p] = R; px[p + 1] = G; px[p + 2] = B;               // 透明处也填同色，插值时不混入黑边
        px[p + 3] = src[s0 + x] ? A : 0;
      }
    }
    var tex = new THREE.DataTexture(px, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;                       // 放大时按像元显示，便于检查断头
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // 网格顶点落在像元中心，纹理坐标收进半个像元，保证叠加与高程逐像元对齐
    tex.repeat.set((w - 1) / w, (h - 1) / h);
    tex.offset.set(0.5 / w, 0.5 / h);
    tex.needsUpdate = true;
    var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    var m = new THREE.Mesh(S.geom, mat);
    m.renderOrder = 1 + Object.keys(S.overlays).length;
    S.mesh.add(m);                                             // 作为子对象，自动继承旋转和夸大
    S.overlays[name] = { mesh: m, tex: tex, mat: mat };
    S.dirty = true;
  }
  function clearOverlay(name) {
    if (!S || !S.overlays) return;
    Object.keys(S.overlays).forEach(function (k) {
      if (name && k !== name) return;
      var L = S.overlays[k];
      S.mesh.remove(L.mesh); L.tex.dispose(); L.mat.dispose();
      delete S.overlays[k];
    });
    S.dirty = true;
  }

  // ---------- 贴图：把任意 w×h 画布（如二维当前图层）贴到地表，替换高程色带 ----------
  // source: HTMLCanvasElement / ImageData（尺寸须为 w×h），传 null 恢复高程色带
  // opt.lit = true（默认）时保留三维光照明暗；二维图层已含晕渲时可传 false 避免重复阴影
  function setDrape(source, opt) {
    if (!S) return;
    opt = opt || {};
    if (S.drape) { S.drape.tex.dispose(); S.drape.mat.dispose(); S.drape = null; }
    if (!source) { S.mesh.material = S.baseMat; S.dirty = true; return; }
    var cv = source;
    if (!(source instanceof HTMLCanvasElement)) {                // ImageData → 画布
      cv = document.createElement('canvas'); cv.width = source.width; cv.height = source.height;
      cv.getContext('2d').putImageData(source, 0, 0);
    }
    if (cv.width !== S.w || cv.height !== S.h) throw new Error('render3d.setDrape: 画布须为 ' + S.w + '×' + S.h);
    var tex = new THREE.CanvasTexture(cv);                       // flipY 默认 true：画布第 0 行在北
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.repeat.set((S.w - 1) / S.w, (S.h - 1) / S.h);             // 顶点在像元中心，收半个像元对齐
    tex.offset.set(0.5 / S.w, 0.5 / S.h);
    var mat = opt.lit === false ? new THREE.MeshBasicMaterial({ map: tex }) : new THREE.MeshLambertMaterial({ map: tex });
    S.mesh.material = mat;
    S.drape = { tex: tex, mat: mat, canvas: cv };
    S.dirty = true;
  }
  // 源画布内容变了（例如二维切换了图层）时调用，避免重建纹理
  function refreshDrape() { if (S && S.drape) { S.drape.tex.needsUpdate = true; S.dirty = true; } }

  function screenshot() {
    if (!S) return null;
    S.renderer.render(S.scene, S.camera);             // 同一任务内立刻读，无需 preserveDrawingBuffer
    var src = S.renderer.domElement;
    var cv = document.createElement('canvas');
    cv.width = src.width; cv.height = src.height;
    var g = cv.getContext('2d'), dpr = src.width / (src.clientWidth || src.width);
    g.drawImage(src, 0, 0);
    var fs = Math.round(13 * dpr), pad = Math.round(8 * dpr);
    g.font = fs + 'px ' + FONT;
    g.textBaseline = 'middle';
    // 右下：垂直夸大
    var t1 = '垂直夸大 ×' + fmtVE(S.ve), w1 = g.measureText(t1).width + pad * 2, hh = fs + pad * 1.4;
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(cv.width - w1 - pad, cv.height - hh - pad, w1, hh);
    g.fillStyle = '#fff'; g.fillText(t1, cv.width - w1, cv.height - pad - hh / 2);
    // 左下：数据来源
    var t2 = (S.meta.name ? S.meta.name + ' · ' : '') + '数据：' + (S.meta.source || '未注明');
    g.font = Math.round(11 * dpr) + 'px ' + FONT;
    var w2 = g.measureText(t2).width + pad * 2;
    g.fillStyle = 'rgba(255,255,255,.75)'; g.fillRect(pad, cv.height - hh - pad, w2, hh);
    g.fillStyle = '#333'; g.fillText(t2, pad * 2, cv.height - pad - hh / 2);
    return cv.toDataURL('image/png');
  }

  function get3DInfo() {
    if (!S) return null;
    return { fps: S.fps, segments: [S.segX, S.segY], vertices: S.nv, ve: S.ve, view: S.view,
      buildMs: S.buildMs, paletteFrom: S.paletteFrom, overlays: Object.keys(S.overlays), draped: !!S.drape,
      extent_km: [+S.Wkm.toFixed(2), +S.Hkm.toFixed(2)] };
  }

  // ---------- 导出 ----------
  API = {
    mount3D: mount3D, setVE: setVE, screenshot: screenshot,
    setView: setView, spin: spin, pick3D: pick3D, setOverlay: setOverlay, clearOverlay: clearOverlay,
    setDrape: setDrape, refreshDrape: refreshDrape, nudge: nudge,
    unmount3D: unmount3D, info: get3DInfo
  };
  global.Render3D = API;
  // 契约要求的全局名：若已被别的模块占用（如成员一的 2D screenshot），不覆盖，提示改用 Render3D.*
  ['mount3D', 'setVE', 'screenshot'].forEach(function (n) {
    if (typeof global[n] === 'function' && !global[n].__r3d) {
      console.warn('render3d: 全局 ' + n + '() 已被其他模块占用，三维请用 Render3D.' + n + '()');
      return;
    }
    API[n].__r3d = true;
    global[n] = API[n];
  });
  global.get3DInfo = get3DInfo;                               // 兼容旧调用
})(window);
