// terrain.js —— 成员三 · 地形分析纯函数（不碰 DOM、不配色、无第三方库）
// 单独跑：在 app 目录执行 python -m http.server 8765，打开 http://localhost:8765/test_hydro.html
// 冒烟：test_hydro.html 打出坡度均值 AOI1 ≈ 10.55°、AOI2 ≈ 26.24°（与 stats.json 差 ≤ 0.3°）。
//
// 导出（签名冻结）：
//   Terrain.slopeAspect(z, w, h, dx_m, dy_m) -> {slope: Float32Array(度), aspect: Float32Array(度，北=0 顺时针，平坦=-1)}
//   Terrain.profile(z, w, h, x0, y0, x1, y1) -> {pts: [{d_km, z}], len_km}     x=列，y=行（像元坐标）
// 附加（可选）：
//   Terrain.setMeta(meta)   登记 dx_m/dy_m/cell_area_m2；profile 的距离要用。AOI1/AOI2 已内置，不调也能用
//
// 约定：所有数组行优先、左上角起、长度 w×h，与 dem.bin 同序。
(function (global) {
  'use strict';

  // ---- 格网尺寸登记（terrain.js 与 hydro.js 共用同一个表）----
  var REG = global.__demGrid = global.__demGrid || {};
  var KNOWN = {                                   // 来自冻结的 meta.json，作后备
    '1260x1080': { dx_m: 28.01, dy_m: 30.71, cell_area_m2: 860.2 },
    '1800x1440': { dx_m: 82.29, dy_m: 92.12, cell_area_m2: 7579.8 }
  };
  function gridOf(w, h) { var k = w + 'x' + h; return REG[k] || KNOWN[k] || null; }
  function setMeta(meta) {
    if (!meta || !meta.width || !meta.height) throw new Error('Terrain.setMeta: 需要 {width, height, dx_m, dy_m}');
    var k = meta.width + 'x' + meta.height;
    REG[k] = { dx_m: +meta.dx_m, dy_m: +meta.dy_m,
      cell_area_m2: meta.cell_area_m2 != null ? +meta.cell_area_m2 : meta.dx_m * meta.dy_m };
  }

  function check(z, w, h, fn) {
    if (!z || z.length !== w * h) throw new Error('Terrain.' + fn + ': z 长度 ' + (z && z.length) + ' ≠ w×h ' + (w * h));
  }

  // ---- 坡度坡向：Horn 3×3，边缘按复制处理（与 stats.json 口径一致）----
  var R2D = 180 / Math.PI;
  function slopeAspect(z, w, h, dx_m, dy_m) {
    check(z, w, h, 'slopeAspect');
    if (!(dx_m > 0) || !(dy_m > 0)) throw new Error('Terrain.slopeAspect: dx_m/dy_m 必须为正');
    // 顺手登记格距，之后 profile 不传 meta 也能算距离
    var k = w + 'x' + h;
    if (!REG[k]) REG[k] = { dx_m: dx_m, dy_m: dy_m, cell_area_m2: (KNOWN[k] && KNOWN[k].cell_area_m2) || dx_m * dy_m };

    var n = w * h, slope = new Float32Array(n), aspect = new Float32Array(n);
    var kx = 1 / (8 * dx_m), ky = 1 / (8 * dy_m);
    for (var y = 0; y < h; y++) {
      var rm = (y > 0 ? y - 1 : 0) * w, r0 = y * w, rp = (y < h - 1 ? y + 1 : h - 1) * w;
      for (var x = 0; x < w; x++) {
        var xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1;
        var a = z[rm + xm], b = z[rm + x], c = z[rm + xp];
        var d = z[r0 + xm],                f = z[r0 + xp];
        var g = z[rp + xm], hh = z[rp + x], i = z[rp + xp];
        var gx = ((c + 2 * f + i) - (a + 2 * d + g)) * kx;    // 向东为正
        var gy = ((g + 2 * hh + i) - (a + 2 * b + c)) * ky;   // 向南为正（行号增大）
        var o = r0 + x;
        slope[o] = Math.atan(Math.sqrt(gx * gx + gy * gy)) * R2D;
        if (gx === 0 && gy === 0) { aspect[o] = -1; continue; }
        // 坡向 = 下坡方向的罗盘方位：东分量 -gx，北分量 +gy
        var as = Math.atan2(-gx, gy) * R2D;
        aspect[o] = as < 0 ? as + 360 : as;
      }
    }
    return { slope: slope, aspect: aspect };
  }

  // ---- 剖面：最近邻采样，至少 200 点，d_km 从起点累计 ----
  function profile(z, w, h, x0, y0, x1, y1) {
    check(z, w, h, 'profile');
    var cl = function (v, hi) { return Math.max(0, Math.min(hi, +v)); };
    x0 = cl(x0, w - 1); x1 = cl(x1, w - 1); y0 = cl(y0, h - 1); y1 = cl(y1, h - 1);
    var g = gridOf(w, h);
    if (!g) { console.warn('Terrain.profile: 未登记格距，按 1 m 计。请先调用 Terrain.setMeta(meta)'); g = { dx_m: 1, dy_m: 1 }; }
    var ddx = (x1 - x0) * g.dx_m, ddy = (y1 - y0) * g.dy_m;
    var len_km = Math.sqrt(ddx * ddx + ddy * ddy) / 1000;
    var pixLen = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
    var np = Math.max(200, Math.ceil(pixLen) + 1);              // 至少 200 点，且不低于像元分辨率
    var pts = new Array(np), d = 0, px = x0, py = y0;
    for (var s = 0; s < np; s++) {
      var t = s / (np - 1), fx = x0 + (x1 - x0) * t, fy = y0 + (y1 - y0) * t;
      if (s > 0) { var ex = (fx - px) * g.dx_m, ey = (fy - py) * g.dy_m; d += Math.sqrt(ex * ex + ey * ey) / 1000; }
      px = fx; py = fy;
      var ix = Math.round(fx), iy = Math.round(fy);
      pts[s] = { d_km: d, z: z[iy * w + ix], ix: ix, iy: iy };   // z 为 dem.bin 原生值；ix/iy 供 2D 画线用
    }
    return { pts: pts, len_km: len_km };
  }

  // =====================================================================
  //  进阶分析（新增，均为纯函数；不改上面两个冻结签名）
  // =====================================================================

  // ---- 滑动窗口最小/最大：可分离 + 单调队列，O(n)，与窗口大小无关 ----
  function slideLine(src, off, step, n, r, outMin, outMax) {
    var qmin = slideLine.qmin, qmax = slideLine.qmax;
    if (!qmin || qmin.length < n) { qmin = slideLine.qmin = new Int32Array(n); qmax = slideLine.qmax = new Int32Array(n); }
    var h1 = 0, t1 = 0, h2 = 0, t2 = 0, nxt = 0;
    for (var i = 0; i < n; i++) {
      var hi = Math.min(n - 1, i + r);
      while (nxt <= hi) {
        var v = src[off + nxt * step];
        while (t1 > h1 && src[off + qmin[t1 - 1] * step] >= v) t1--; qmin[t1++] = nxt;
        while (t2 > h2 && src[off + qmax[t2 - 1] * step] <= v) t2--; qmax[t2++] = nxt;
        nxt++;
      }
      var lo = i - r;
      while (qmin[h1] < lo) h1++;
      while (qmax[h2] < lo) h2++;
      outMin[off + i * step] = src[off + qmin[h1] * step];
      outMax[off + i * step] = src[off + qmax[h2] * step];
    }
  }
  function windowMinMax(z, w, h, rx, ry) {
    var n = w * h, a = new Float32Array(n), b = new Float32Array(n), mn = new Float32Array(n), mx = new Float32Array(n);
    for (var y = 0; y < h; y++) slideLine(z, y * w, 1, w, rx, a, b);       // 行方向：a=行最小，b=行最大
    // 列方向：对行最小取最小、对行最大取最大（另一路输出丢弃）
    var dump = new Float32Array(n), x;
    for (x = 0; x < w; x++) slideLine(a, x, w, h, ry, mn, dump);
    for (x = 0; x < w; x++) slideLine(b, x, w, h, ry, dump, mx);
    return { min: mn, max: mx };
  }

  // ---- 地貌分类：起伏度（窗口内最大−最小高程）分级 ----
  // 分级参照李炳元等（2008，地理学报）中国陆地基本地貌类型的起伏度阈值：30 / 200 / 500 / 1000 / 2500 m
  var LANDFORM = [
    { id: 1, name: '平原',       lo: 0,    hi: 30 },
    { id: 2, name: '丘陵',       lo: 30,   hi: 200 },
    { id: 3, name: '小起伏山地', lo: 200,  hi: 500 },
    { id: 4, name: '中起伏山地', lo: 500,  hi: 1000 },
    { id: 5, name: '大起伏山地', lo: 1000, hi: 2500 },
    { id: 6, name: '极大起伏山地', lo: 2500, hi: Infinity }
  ];
  function landform(z, w, h, opt) {
    check(z, w, h, 'landform');
    opt = opt || {};
    var g = gridOf(w, h) || { dx_m: opt.dx_m || 30, dy_m: opt.dy_m || 30 };
    var R = opt.radius_m || 1000;                               // 默认 2 km × 2 km 窗口
    var rx = Math.max(1, Math.round(R / g.dx_m)), ry = Math.max(1, Math.round(R / g.dy_m));
    var th = opt.thresholds || [30, 200, 500, 1000, 2500];
    var mm = windowMinMax(z, w, h, rx, ry), n = w * h;
    var cls = new Uint8Array(n), relief = new Float32Array(n), cnt = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < n; i++) {
      var r = mm.max[i] - mm.min[i], c = 1;
      while (c <= th.length && r >= th[c - 1]) c++;
      relief[i] = r; cls[i] = c; cnt[c]++;
    }
    var classes = LANDFORM.map(function (L, k) {
      return { id: L.id, name: L.name, lo: k ? th[k - 1] : 0, hi: k < th.length ? th[k] : Infinity,
        cells: cnt[L.id], pct: cnt[L.id] / n * 100 };
    });
    return { cls: cls, relief: relief, classes: classes, window_m: [rx * 2 * g.dx_m + g.dx_m, ry * 2 * g.dy_m + g.dy_m] };
  }

  // ---- 平坦水面：3×3 完全水平的连片区（≥ minArea_km2），外扩 1 格补湖岸 ----
  function flatWater(z, w, h, minArea_km2) {
    check(z, w, h, 'flatWater');
    var g = gridOf(w, h), cellA = g ? g.cell_area_m2 : 900, n = w * h;
    var minCells = Math.max(50, Math.round((minArea_km2 == null ? 0.5 : minArea_km2) * 1e6 / cellA));
    var flat = new Uint8Array(n), x, y;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      var i = y * w + x, v = z[i];
      if (z[i - 1] === v && z[i + 1] === v && z[i - w] === v && z[i + w] === v &&
          z[i - w - 1] === v && z[i - w + 1] === v && z[i + w - 1] === v && z[i + w + 1] === v) flat[i] = 1;
    }
    var lab = new Int32Array(n), stack = new Int32Array(n), keep = new Uint8Array(n), id = 0, bodies = [];
    for (var s = 0; s < n; s++) {
      if (!flat[s] || lab[s]) continue;
      id++; var sp = 0, cnt = 0, list = []; stack[sp++] = s; lab[s] = id;
      while (sp) {
        var c = stack[--sp]; cnt++; list.push(c);
        var cy = (c / w) | 0, cx = c - cy * w;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var nx2 = cx + dx, ny2 = cy + dy; if (nx2 < 0 || ny2 < 0 || nx2 >= w || ny2 >= h) continue;
          var j = ny2 * w + nx2; if (flat[j] && !lab[j]) { lab[j] = id; stack[sp++] = j; }
        }
      }
      if (cnt >= minCells) {
        for (var q = 0; q < list.length; q++) keep[list[q]] = 1;
        bodies.push({ cells: cnt, area_km2: cnt * cellA / 1e6, elev: z[s] });
      }
    }
    var out = new Uint8Array(n);                                // 外扩 1 格
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (!keep[y * w + x]) continue;
      for (var yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
        for (var xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) out[yy * w + xx] = 1;
    }
    bodies.sort(function (a, b) { return b.cells - a.cells; });
    return { mask: out, bodies: bodies };
  }

  // ---- 视域分析：向外围每个格发射线（R2 法），含地球曲率与大气折射（k=0.13） ----
  function viewshed(z, w, h, ox, oy, opt) {
    check(z, w, h, 'viewshed');
    opt = opt || {};
    ox = Math.round(ox); oy = Math.round(oy);
    var g = gridOf(w, h) || { dx_m: 30, dy_m: 30, cell_area_m2: 900 };
    var hObs = opt.observer_h != null ? opt.observer_h : 1.7, hTgt = opt.target_h || 0;
    var curv = opt.curvature !== false, K = (1 - 0.13) / (2 * 6371000);
    var maxD = opt.max_dist_m || Infinity;
    var n = w * h, vis = new Uint8Array(n), seen = new Uint8Array(n);
    var z0 = z[oy * w + ox] + hObs;
    vis[oy * w + ox] = 1; seen[oy * w + ox] = 1;
    function ray(tx, ty) {
      var ddx = tx - ox, ddy = ty - oy, steps = Math.max(Math.abs(ddx), Math.abs(ddy));
      if (!steps) return;
      var ux = ddx / steps, uy = ddy / steps, mdx = ux * g.dx_m, mdy = uy * g.dy_m, stepD = Math.sqrt(mdx * mdx + mdy * mdy);
      var maxA = -Infinity;
      for (var s = 1; s <= steps; s++) {
        var d = s * stepD; if (d > maxD) break;
        var cx = Math.round(ox + ux * s), cy = Math.round(oy + uy * s), c = cy * w + cx;
        var drop = curv ? d * d * K : 0, ground = z[c] - drop;
        var aT = (ground + hTgt - z0) / d;
        if (aT >= maxA) vis[c] = 1;
        seen[c] = 1;
        var aG = (ground - z0) / d; if (aG > maxA) maxA = aG;
      }
    }
    var x, y;
    for (x = 0; x < w; x++) { ray(x, 0); ray(x, h - 1); }
    for (y = 1; y < h - 1; y++) { ray(0, y); ray(w - 1, y); }
    // 极少数没被任何射线经过的格：取同行左侧最近已判定格（只影响显示，不到 0.1%）
    var cntV = 0, gaps = 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var i = y * w + x;
      if (!seen[i]) { gaps++; vis[i] = x > 0 ? vis[i - 1] : 0; }
      if (vis[i]) cntV++;
    }
    return { mask: vis, visible_cells: cntV, visible_km2: cntV * g.cell_area_m2 / 1e6, pct: cntV / n * 100,
      observer: [ox, oy], observer_elev: z[oy * w + ox], observer_h: hObs, gaps: gaps };
  }

  // ---- 分区统计：给定掩膜内的高程/坡度统计 + 面积—高程曲线（面高积分 HI） ----
  function zonalStats(z, w, h, mask, slope) {
    check(z, w, h, 'zonalStats');
    var g = gridOf(w, h), n = w * h, cnt = 0, s = 0, ss = 0, mn = Infinity, mx = -Infinity;
    for (var i = 0; i < n; i++) {
      if (!mask[i]) continue;
      var v = z[i]; cnt++; s += v; if (v < mn) mn = v; if (v > mx) mx = v;
      if (slope) ss += slope[i];
    }
    if (!cnt) return null;
    var mean = s / cnt, span = (mx - mn) || 1, B = 20, hist = new Float64Array(B);
    for (i = 0; i < n; i++) if (mask[i]) hist[Math.min(B - 1, Math.floor((z[i] - mn) / span * B))]++;
    // 面积—高程曲线：x = 高于该高程的面积比例，y = 相对高程
    var curve = [], acc = 0;
    for (var k = B - 1; k >= 0; k--) { acc += hist[k]; curve.push({ a: acc / cnt, h: k / B }); }
    curve.unshift({ a: 0, h: 1 });
    return { cells: cnt, area_km2: g ? cnt * g.cell_area_m2 / 1e6 : NaN, zmin: mn, zmax: mx, zmean: mean,
      relief: mx - mn, slope_mean: slope ? ss / cnt : null, hi: (mean - mn) / span, hypso: curve };
  }

  global.Terrain = { slopeAspect: slopeAspect, profile: profile, setMeta: setMeta,
    landform: landform, flatWater: flatWater, viewshed: viewshed, zonalStats: zonalStats,
    windowMinMax: windowMinMax, LANDFORM: LANDFORM };
})(typeof window !== 'undefined' ? window : globalThis);
