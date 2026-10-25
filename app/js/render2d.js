/* render2d.js —— 二维解剖台渲染器（Canvas 2D）
 *
 * 三层结构，各自只在需要时重算：
 *   base     逐像素底图（晕渲 / 高程 / 坡度 / 坡向 / 地貌），原生分辨率 w×h，切图层时淡入
 *   overlay  逐像素叠加（水面、分级河网、流域、视域），原生分辨率 w×h
 *   vector   屏幕空间矢量（水流路径、最长河、最陡河段、剖面线、标记点、经纬网），任意缩放都清晰
 *
 * 分析值一律不经过这里：查询、坡度、剖面、流域都读 dem.bin 原生值；本文件只负责「看」。
 * 对外 API 与旧版兼容：setData / setSlope / setLayer / setRivers / setBasin / setProfileLine /
 *   resize / fit / exportPNG / screenToImg / imgToScreen / zoomAt / onHover / onClick / onViewChange / lastRenderMs / layer
 */
(function () {
  'use strict';

  var PAL = window.Palette;
  var UI = PAL.UI;
  var rgb = PAL.hexToRgb;

  function Map2D(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.z = null; this.meta = null; this.min = 0; this.max = 1;
    this.slope = null; this.aspect = null; this.landform = null; this.shade = null;
    this.rivers = null; this.riverOrder = null; this.water = null; this.basin = null; this.viewshed = null;
    this.paths = {};          // name -> {idx: Int32Array, color, width, dash}
    this.markers = [];        // [{x, y, kind, label}]
    this.profileLine = null; this.profileHover = null;
    this.graticule = false;
    this.layer = 'hillshade';
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.base = document.createElement('canvas');
    this.prevBase = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this._fade = null; this._anim = null; this._raf = 0;
    this.onClick = null; this.onHover = null; this.onViewChange = null;
    this._drag = null; this._fitted = true;
    this._bind();
    var self = this;
    if (window.ResizeObserver) new ResizeObserver(function () { self.resize(); }).observe(canvas);
    else window.addEventListener('resize', function () { self.resize(); });
  }

  /* ================= 数据 ================= */

  Map2D.prototype.setData = function (data) {
    this.z = data.z; this.meta = data.meta;
    this.min = data.meta.elev ? data.meta.elev.min : data.min;
    this.max = data.meta.elev ? data.meta.elev.max : data.max;
    this.slope = this.aspect = this.landform = null;
    this.rivers = this.riverOrder = this.water = this.basin = this.viewshed = null;
    this.paths = {}; this.markers = []; this.profileLine = null; this.profileHover = null;
    var w = this.meta.width, h = this.meta.height;
    [this.base, this.prevBase, this.overlay].forEach(function (c) { c.width = w; c.height = h; });
    this._computeShade();
    this._fade = null;
    this.renderBase(true);
    this.renderOverlay();
    this.fit();
  };

  // 晕渲强度：方位 315°、高度 45°，Horn 梯度；只算一次，各图层复用
  Map2D.prototype._computeShade = function () {
    var w = this.meta.width, h = this.meta.height, z = this.z, dx = this.meta.dx_m, dy = this.meta.dy_m;
    var sh = new Float32Array(w * h);
    var az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
    var lx = Math.sin(az) * Math.cos(alt), ly = Math.cos(az) * Math.cos(alt), lz = Math.sin(alt);
    for (var r = 0; r < h; r++) {
      var rU = (r > 0 ? r - 1 : 0) * w, r0 = r * w, rD = (r < h - 1 ? r + 1 : h - 1) * w;
      for (var c = 0; c < w; c++) {
        var cL = c > 0 ? c - 1 : 0, cR = c < w - 1 ? c + 1 : w - 1;
        var gx = ((z[rU + cR] + 2 * z[r0 + cR] + z[rD + cR]) - (z[rU + cL] + 2 * z[r0 + cL] + z[rD + cL])) / (8 * dx);
        var gn = ((z[rU + cL] + 2 * z[rU + c] + z[rU + cR]) - (z[rD + cL] + 2 * z[rD + c] + z[rD + cR])) / (8 * dy); // 向北为正
        var nl = Math.sqrt(gx * gx + gn * gn + 1);
        var v = (-gx * lx - gn * ly + lz) / nl;
        sh[r0 + c] = v < 0 ? 0 : v;
      }
    }
    this.shade = sh;
  };

  Map2D.prototype.setSlope = function (slope, aspect) {
    this.slope = slope; this.aspect = aspect || null;
    if (this.layer === 'slope' || this.layer === 'aspect') this.renderBase();
  };
  Map2D.prototype.setLandform = function (cls) { this.landform = cls; if (this.layer === 'landform') this.renderBase(); };
  Map2D.prototype.setLayer = function (name) {
    if (this.layer === name) return;
    this.layer = name; this.renderBase(); this.draw();
  };
  Map2D.prototype.setRivers = function (mask, order) { this.rivers = mask; this.riverOrder = order || null; this.renderOverlay(); this.draw(); };
  Map2D.prototype.setWater = function (mask) { this.water = mask; this.renderOverlay(); this.draw(); };
  Map2D.prototype.setBasin = function (mask) { this.basin = mask; this.renderOverlay(); this.draw(); };
  Map2D.prototype.setViewshed = function (mask) { this.viewshed = mask; this.renderOverlay(); this.draw(); };
  Map2D.prototype.setPath = function (name, p) { if (p) this.paths[name] = p; else delete this.paths[name]; this.draw(); };
  Map2D.prototype.clearPaths = function () { this.paths = {}; this.draw(); };
  Map2D.prototype.setMarkers = function (list) { this.markers = list || []; this.draw(); };
  Map2D.prototype.setGraticule = function (on) { this.graticule = !!on; this.draw(); };
  Map2D.prototype.setProfileLine = function (line) { this.profileLine = line; if (!line) this.profileHover = null; this.draw(); };
  Map2D.prototype.setProfileHover = function (pt) { this.profileHover = pt; this.draw(); };

  /* ================= 底图 ================= */

  Map2D.prototype.renderBase = function (noFade) {
    var t0 = performance.now();
    var w = this.meta.width, h = this.meta.height, z = this.z, sh = this.shade;
    // 先把旧底图存起来做淡入
    if (!noFade) {
      var pc = this.prevBase.getContext('2d'); pc.clearRect(0, 0, w, h); pc.drawImage(this.base, 0, 0);
    }
    var bctx = this.base.getContext('2d');
    var img = bctx.createImageData(w, h), d = img.data;
    var lo = this.min, span = Math.max(1e-6, this.max - this.min);
    var layer = this.layer, slope = this.slope, aspect = this.aspect, lf = this.landform;
    for (var i = 0, n = w * h; i < n; i++) {
      var c, s = sh[i];
      if (layer === 'elevation') c = PAL.rampColor((z[i] - lo) / span);
      else if (layer === 'slope') c = slope ? PAL.slopeColor(slope[i]) : [110, 116, 122];
      else if (layer === 'aspect') c = aspect ? PAL.aspectColor(aspect[i]) : [110, 116, 122];
      else if (layer === 'landform') {
        c = lf ? PAL.landformColor(lf[i]) : [110, 116, 122];
        var k = 0.55 + 0.5 * s; c = [c[0] * k, c[1] * k, c[2] * k];          // 叠一点晕渲，便于读地形
      } else {
        var base = PAL.rampColor((z[i] - lo) / span), b = 0.36 + 0.7 * s;
        c = [base[0] * b, base[1] * b, base[2] * b];
      }
      var p = i * 4;
      d[p] = c[0] > 255 ? 255 : c[0]; d[p + 1] = c[1] > 255 ? 255 : c[1]; d[p + 2] = c[2] > 255 ? 255 : c[2]; d[p + 3] = 255;
    }
    bctx.putImageData(img, 0, 0);
    this.lastRenderMs = Math.round(performance.now() - t0);
    if (!noFade) this._fade = { t0: performance.now(), dur: 220 };
    this.draw();
    if (this.onBaseChange) this.onBaseChange();
  };

  /* ================= 叠加（逐像素） ================= */

  Map2D.prototype.renderOverlay = function () {
    if (!this.meta) return;
    var w = this.meta.width, h = this.meta.height, n = w * h;
    var ctx = this.overlay.getContext('2d', { willReadFrequently: true });
    var im = ctx.createImageData(w, h), d = im.data, i, p;
    function put(i, c, a) { var q = i * 4; d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; d[q + 3] = a; }

    if (this.viewshed) {
      var vc = rgb(UI.viewshed);
      for (i = 0; i < n; i++) if (this.viewshed[i]) put(i, vc, 110); else put(i, [0, 0, 0], 70);
    }
    if (this.basin) {
      var bc = rgb(UI.basin), be = rgb(UI.basinEdge), B = this.basin;
      for (i = 0; i < n; i++) if (B[i]) put(i, bc, 88);
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
        i = y * w + x; if (!B[i]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !B[i - 1] || !B[i + 1] || !B[i - w] || !B[i + w]) put(i, be, 240);
      }
    }
    if (this.water) {
      var wc = rgb(UI.water), we = rgb(UI.waterEdge), W = this.water;
      for (i = 0; i < n; i++) {
        if (!W[i]) continue;
        var edge = (i % w === 0 || i % w === w - 1 || !W[i - 1] || !W[i + 1] || !W[i - w] || !W[i + w]);
        put(i, edge ? we : wc, edge ? 230 : 215);
      }
    }
    if (this.rivers) {
      var R = this.rivers, O = this.riverOrder, W2 = this.water, cols = UI.river.map(rgb);
      for (i = 0; i < n; i++) {
        if (!R[i] || (W2 && W2[i])) continue;                 // 水面上的河道不画（ε 填洼在湖面上只会给出直线）
        var o = O ? Math.max(1, O[i]) : 3, col = cols[Math.min(cols.length - 1, o - 1)], a = O ? Math.min(255, 150 + o * 22) : 230;
        put(i, col, a);
        if (O && o >= 4) {                                    // 高级别河道加粗 1 像元
          var rx = i % w, ry = (i / w) | 0;
          if (rx + 1 < w && !R[i + 1]) put(i + 1, col, a);
          if (ry + 1 < h && !R[i + w]) put(i + w, col, a);
        }
      }
    }
    ctx.putImageData(im, 0, 0);
    if (this.onBaseChange) this.onBaseChange();
  };

  /* ================= 视图 ================= */

  Map2D.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var oldW = this._cssW || rect.width, oldH = this._cssH || rect.height;
    var center = this.meta ? this.screenToImg(oldW / 2, oldH / 2) : null;
    var W = Math.max(1, Math.round(rect.width * this.dpr)), H = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    if (this._fitted) this.fit();
    else if (center) {
      this.view.tx = rect.width / 2 - center.x * this.view.scale;
      this.view.ty = rect.height / 2 - center.y * this.view.scale;
      this.draw();
    }
    this._cssW = rect.width; this._cssH = rect.height;
  };

  Map2D.prototype.fitScale = function () {
    var rect = this.canvas.getBoundingClientRect();
    return Math.min(rect.width / this.meta.width, rect.height / this.meta.height) * 0.94;
  };

  Map2D.prototype.fit = function (animate) {
    if (!this.meta) return;
    var rect = this.canvas.getBoundingClientRect(), s = this.fitScale();
    var target = { scale: s, tx: (rect.width - this.meta.width * s) / 2, ty: (rect.height - this.meta.height * s) / 2 };
    if (animate) this._animateTo(target); else { this.view = target; this.draw(); }
    this._fitted = true; this._cssW = rect.width; this._cssH = rect.height;
  };

  // 飞到某个像元，缩放到 scale（默认放大到能看清 ~ 1/3 幅宽）
  Map2D.prototype.flyTo = function (px, py, scale) {
    if (!this.meta) return;
    var rect = this.canvas.getBoundingClientRect();
    var s = scale || Math.max(this.fitScale() * 2.5, this.view.scale);
    this._animateTo({ scale: s, tx: rect.width / 2 - (px + 0.5) * s, ty: rect.height / 2 - (py + 0.5) * s });
    this._fitted = false;
  };
  // 让一组像元整体入画
  Map2D.prototype.flyToBox = function (x0, y0, x1, y1, pad) {
    var rect = this.canvas.getBoundingClientRect(); pad = pad || 0.15;
    var bw = Math.max(8, x1 - x0), bh = Math.max(8, y1 - y0);
    var s = Math.min(rect.width / (bw * (1 + 2 * pad)), rect.height / (bh * (1 + 2 * pad)), 12);
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    this._animateTo({ scale: s, tx: rect.width / 2 - cx * s, ty: rect.height / 2 - cy * s });
    this._fitted = false;
  };

  Map2D.prototype._animateTo = function (target) {
    var from = { scale: this.view.scale, tx: this.view.tx, ty: this.view.ty };
    this._anim = { from: from, to: target, t0: performance.now(), dur: 420 };
    this._kick();
  };

  Map2D.prototype._kick = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function step() {
      self._raf = 0;
      var now = performance.now(), more = false;
      if (self._anim) {
        var A = self._anim, t = Math.min(1, (now - A.t0) / A.dur), e = 1 - Math.pow(1 - t, 3);
        // 缩放按对数插值，平移按屏幕中心插值，视觉上更稳
        var ls = Math.log(A.from.scale) + (Math.log(A.to.scale) - Math.log(A.from.scale)) * e;
        self.view.scale = Math.exp(ls);
        self.view.tx = A.from.tx + (A.to.tx - A.from.tx) * e;
        self.view.ty = A.from.ty + (A.to.ty - A.from.ty) * e;
        if (t >= 1) self._anim = null; else more = true;
      }
      if (self._fade && now - self._fade.t0 < self._fade.dur) more = true;
      self._drawNow();
      if (more) self._kick();
      else self._fade = null;
    });
  };

  Map2D.prototype.draw = function () { this._kick(); };

  Map2D.prototype._drawNow = function () {
    if (!this.meta) return;
    var ctx = this.ctx, rect = this.canvas.getBoundingClientRect(), V = this.view;
    var W = this.meta.width * V.scale, H = this.meta.height * V.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = V.scale < 2;
    // 地图投影阴影，让图幅从背景里浮起来
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 18; ctx.fillStyle = '#000';
    ctx.fillRect(V.tx, V.ty, W, H); ctx.restore();
    if (this._fade) {
      var t = Math.min(1, (performance.now() - this._fade.t0) / this._fade.dur);
      ctx.drawImage(this.prevBase, V.tx, V.ty, W, H);
      ctx.globalAlpha = t; ctx.drawImage(this.base, V.tx, V.ty, W, H); ctx.globalAlpha = 1;
    } else ctx.drawImage(this.base, V.tx, V.ty, W, H);
    ctx.drawImage(this.overlay, V.tx, V.ty, W, H);
    this.drawVectors(ctx, V.scale, V.tx, V.ty, rect.width, rect.height);
    if (this.onViewChange) this.onViewChange(V.scale);
  };

  /* ================= 矢量层（屏幕空间） ================= */

  Map2D.prototype.drawVectors = function (ctx, s, tx, ty, vw, vh, opt) {
    opt = opt || {};
    var w = this.meta.width, self = this;
    var X = function (px) { return tx + (px + 0.5) * s; }, Y = function (py) { return ty + (py + 0.5) * s; };
    var lw = opt.lineScale || 1;

    if (this.graticule || opt.graticule) this._drawGraticule(ctx, s, tx, ty, vw, vh, opt);

    // 路径：先描深色晕边，再画彩色主线
    Object.keys(this.paths).forEach(function (k) {
      var P = self.paths[k], idx = P.idx; if (!idx || idx.length < 2) return;
      ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      for (var i = 0; i < idx.length; i++) { var c = idx[i], px = c % w, py = (c / w) | 0; if (i) ctx.lineTo(X(px), Y(py)); else ctx.moveTo(X(px), Y(py)); }
      ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = ((P.width || 2.5) + 2.5) * lw; ctx.stroke();
      if (P.dash) ctx.setLineDash(P.dash.map(function (v) { return v * lw; }));
      ctx.strokeStyle = P.color; ctx.lineWidth = (P.width || 2.5) * lw; ctx.stroke();
      ctx.restore();
    });

    if (this.profileLine) {
      var L = this.profileLine;
      ctx.save(); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(X(L.x0), Y(L.y0)); ctx.lineTo(X(L.x1), Y(L.y1));
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4.5 * lw; ctx.stroke();
      ctx.strokeStyle = UI.profile; ctx.lineWidth = 2 * lw; ctx.stroke();
      [[L.x0, L.y0, 'A'], [L.x1, L.y1, 'B']].forEach(function (p) { self._pin(ctx, X(p[0]), Y(p[1]), UI.profile, p[2], lw); });
      if (this.profileHover) {
        var hp = this.profileHover;
        ctx.beginPath(); ctx.arc(X(hp.ix), Y(hp.iy), 6 * lw, 0, 6.2832);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2 * lw; ctx.strokeStyle = '#111'; ctx.stroke();
      }
      ctx.restore();
    }

    this.markers.forEach(function (m) {
      var color = m.color || '#fff';
      if (m.kind === 'observer') {
        ctx.save(); ctx.beginPath(); ctx.arc(X(m.x), Y(m.y), 7 * lw, 0, 6.2832);
        ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2.5 * lw; ctx.strokeStyle = '#111'; ctx.stroke();
        ctx.beginPath(); ctx.arc(X(m.x), Y(m.y), 2.5 * lw, 0, 6.2832); ctx.fillStyle = '#111'; ctx.fill(); ctx.restore();
      } else self._pin(ctx, X(m.x), Y(m.y), color, m.label, lw);
    });
  };

  Map2D.prototype._pin = function (ctx, x, y, color, label, lw) {
    lw = lw || 1;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, 5.5 * lw, 0, 6.2832);
    ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2 * lw; ctx.strokeStyle = '#0b0f14'; ctx.stroke();
    if (label) {
      ctx.font = '600 ' + (11 * lw) + 'px system-ui, "Microsoft YaHei", sans-serif';
      var tw = ctx.measureText(label).width + 10 * lw, bx = x + 9 * lw, by = y - 22 * lw;
      ctx.fillStyle = 'rgba(11,15,20,0.88)'; roundRect(ctx, bx, by, tw, 17 * lw, 4 * lw); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 1 * lw; ctx.stroke();
      ctx.fillStyle = '#f2f5f8'; ctx.textBaseline = 'middle'; ctx.fillText(label, bx + 5 * lw, by + 8.5 * lw);
    }
    ctx.restore();
  };

  // 经纬网：按可见范围自动选 0.01° / 0.02° / 0.05° / 0.1° / 0.2° / 0.5° 间隔
  Map2D.prototype._drawGraticule = function (ctx, s, tx, ty, vw, vh, opt) {
    var m = this.meta, lw = (opt && opt.lineScale) || 1;
    var lon0 = m.x0, lat0 = m.y0, lon1 = m.x0 + m.width * m.dx_deg, lat1 = m.y0 - m.height * m.dy_deg;
    var pxPerDeg = s / m.dx_deg, steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1], step = steps[steps.length - 1];
    for (var k = 0; k < steps.length; k++) if (steps[k] * pxPerDeg >= 90 * lw) { step = steps[k]; break; }
    var dec = step < 0.1 ? 2 : 1;
    var X = function (lon) { return tx + (lon - lon0) / m.dx_deg * s; }, Y = function (lat) { return ty + (lat0 - lat) / m.dy_deg * s; };
    var xa = Math.max(tx, 0), xb = Math.min(tx + m.width * s, vw), ya = Math.max(ty, 0), yb = Math.min(ty + m.height * s, vh);
    ctx.save();
    ctx.strokeStyle = UI.grid; ctx.lineWidth = 1 * lw; ctx.setLineDash([4 * lw, 4 * lw]);
    ctx.font = (10 * lw) + 'px Consolas, monospace'; ctx.fillStyle = 'rgba(235,240,245,0.85)';
    for (var lon = Math.ceil(lon0 / step) * step; lon <= lon1 + 1e-9; lon += step) {
      var x = X(lon); if (x < xa || x > xb) continue;
      ctx.beginPath(); ctx.moveTo(x, ya); ctx.lineTo(x, yb); ctx.stroke();
      ctx.fillText(lon.toFixed(dec) + '°E', x + 3 * lw, ya + 12 * lw);
    }
    for (var lat = Math.ceil(lat1 / step) * step; lat <= lat0 + 1e-9; lat += step) {
      var y = Y(lat); if (y < ya || y > yb) continue;
      ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke();
      ctx.fillText(lat.toFixed(dec) + '°N', xa + 3 * lw, y - 3 * lw);
    }
    ctx.restore();
  };

  /* ================= 坐标与交互 ================= */

  Map2D.prototype.screenToImg = function (sx, sy) { return { x: (sx - this.view.tx) / this.view.scale, y: (sy - this.view.ty) / this.view.scale }; };
  Map2D.prototype.imgToScreen = function (px, py) { return { x: this.view.tx + px * this.view.scale, y: this.view.ty + py * this.view.scale }; };

  Map2D.prototype.zoomAt = function (sx, sy, factor) {
    var ns = Math.max(0.05, Math.min(40, this.view.scale * factor)), k = ns / this.view.scale;
    this.view.tx = sx - (sx - this.view.tx) * k;
    this.view.ty = sy - (sy - this.view.ty) * k;
    this.view.scale = ns; this._fitted = false; this._anim = null;
    this.draw();
  };
  Map2D.prototype.zoomCenter = function (factor) {
    var r = this.canvas.getBoundingClientRect(); this.zoomAt(r.width / 2, r.height / 2, factor);
  };

  Map2D.prototype._bind = function () {
    var self = this, cv = this.canvas;
    cv.style.touchAction = 'none';
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = cv.getBoundingClientRect();
      self.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0018, -e.deltaY));
    }, { passive: false });
    cv.addEventListener('pointerdown', function (e) {
      var r = cv.getBoundingClientRect();
      self._drag = { x: e.clientX - r.left, y: e.clientY - r.top, tx: self.view.tx, ty: self.view.ty, moved: 0, id: e.pointerId };
      self._anim = null;
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', function (e) {
      var r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (self._drag) {
        var dx = x - self._drag.x, dy = y - self._drag.y;
        self._drag.moved = Math.max(self._drag.moved, Math.abs(dx) + Math.abs(dy));
        if (self._drag.moved > 4) {
          self.view.tx = self._drag.tx + dx; self.view.ty = self._drag.ty + dy;
          self._fitted = false; cv.style.cursor = 'grabbing'; self.draw();
        }
        return;
      }
      if (self.onHover) self.onHover(self.screenToImg(x, y), e);
    });
    cv.addEventListener('pointerup', function (e) {
      if (!self._drag) return;
      var moved = self._drag.moved; self._drag = null; cv.style.cursor = '';
      if (moved > 4) return;                                   // 位移 > 4 px 视为平移，不触发点选
      var r = cv.getBoundingClientRect();
      if (self.onClick) self.onClick(self.screenToImg(e.clientX - r.left, e.clientY - r.top), e);
    });
    cv.addEventListener('pointercancel', function () { self._drag = null; });
    cv.addEventListener('pointerleave', function () { if (self.onLeave) self.onLeave(); });
    cv.addEventListener('dblclick', function () { self.fit(true); });
  };

  /* ================= 导出与合成 ================= */

  // 原生分辨率的「底图 + 叠加」画布，供三维贴图使用
  Map2D.prototype.composite = function (target) {
    var w = this.meta.width, h = this.meta.height, c = target || document.createElement('canvas');
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    var g = c.getContext('2d'); g.clearRect(0, 0, w, h); g.drawImage(this.base, 0, 0); g.drawImage(this.overlay, 0, 0);
    return c;
  };

  // 兼容旧接口：当前视图截屏 + 页脚
  Map2D.prototype.exportPNG = function (sourceText) {
    var out = document.createElement('canvas');
    out.width = this.canvas.width; out.height = this.canvas.height;
    var c = out.getContext('2d'); c.drawImage(this.canvas, 0, 0);
    var h = 24 * this.dpr;
    c.fillStyle = 'rgba(8,10,13,0.78)'; c.fillRect(0, out.height - h, out.width, h);
    c.fillStyle = '#cfd6dd'; c.font = (11 * this.dpr) + 'px "Consolas", monospace'; c.textBaseline = 'middle';
    c.fillText(sourceText, 10 * this.dpr, out.height - h / 2);
    return out.toDataURL('image/png');
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  Map2D.roundRect = roundRect;

  window.Map2D = Map2D;
})();
