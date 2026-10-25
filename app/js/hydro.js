// hydro.js —— 成员三 · 水文分析纯函数（不碰 DOM、不配色、无第三方库）
// 单独跑：在 app 目录执行 python -m http.server 8765，打开 http://localhost:8765/test_hydro.html
// 冒烟：test_hydro.html 显示「上坡流向 0、越界 0、内部汇 0、环路 0」，并出河网图。
//
// 导出（签名冻结）：
//   Hydro.computeHydro(z, w, h) -> {filled: Float32Array, dir: Int8Array, acc: Float32Array}
//   Hydro.riverMask(acc, w, h, thr) -> Uint8Array          thr = 上游格数（acc ≥ thr 为河道，acc 含本格）
//   Hydro.watershed(dir, w, h, ix, iy) -> {mask: Uint8Array, area_km2, outlet: [ix, iy]}
// 附加（可选，不用不影响）：
//   Hydro.setMeta(meta)                       登记 cell_area_m2（AOI1/AOI2 已内置）
//   Hydro.snapOutlet(acc, w, h, ix, iy, r=5)  在半径 r 内找汇流量最大的格，点歪了也能落到河道上 -> [ix, iy]
//   Hydro.DR / Hydro.DC                       D8 偏移表
//
// D8 编码（硬约定）：0 东 (0,+1)  1 东南 (+1,+1)  2 南 (+1,0)  3 西南 (+1,-1)
//                    4 西 (0,-1)  5 西北 (-1,-1)  6 北 (-1,0)  7 东北 (-1,+1)   -1 出口/汇
//                    (dr, dc)，dr 为正 = 向南（行号增大）
//
// 算法口径：
//   填洼  Priority-Flood + ε（Barnes 2014，带 pit 队列），ε = 1e-4，在 Float64 中计算，不整片拉平
//   D8    最陡下降，距离 1 / √2；并列按 东>东南>南>西南>西>西北>北>东北 取先者，结果可复现
//   汇流  每格初始 1，自上游向下游累加（拓扑序，等价于按 filled 从高到低累加）
//   输出 filled 为 Float32：ε=1e-4 小于 Float32 在 2000 m 以上的最小间隔，直接舍入会出现「相等」，
//         因此沿流向从出口往上游逐格保证 filled[上游] > filled[下游]（必要时上调 1 个 Float32 最小单位）。
//         dir 由 Float64 结果算出，与 Float32 filled 严格一致：按 filled 判上坡恒为 0。
(function (global) {
  'use strict';

  var DR = [0, 1, 1, 1, 0, -1, -1, -1];
  var DC = [1, 1, 0, -1, -1, -1, 0, 1];
  var INV = [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2];
  var EPS = 1e-4;

  // ---- 格网尺寸登记（与 terrain.js 共用）----
  var REG = global.__demGrid = global.__demGrid || {};
  var KNOWN = {
    '1260x1080': { dx_m: 28.01, dy_m: 30.71, cell_area_m2: 860.2 },
    '1800x1440': { dx_m: 82.29, dy_m: 92.12, cell_area_m2: 7579.8 }
  };
  function gridOf(w, h) { var k = w + 'x' + h; return REG[k] || KNOWN[k] || null; }
  function setMeta(meta) {
    if (!meta || !meta.width || !meta.height) throw new Error('Hydro.setMeta: 需要 {width, height, cell_area_m2}');
    REG[meta.width + 'x' + meta.height] = { dx_m: +meta.dx_m, dy_m: +meta.dy_m,
      cell_area_m2: meta.cell_area_m2 != null ? +meta.cell_area_m2 : meta.dx_m * meta.dy_m };
  }
  function need(arr, w, h, name, fn) {
    if (!arr || arr.length !== w * h) throw new Error('Hydro.' + fn + ': ' + name + ' 长度 ' + (arr && arr.length) + ' ≠ w×h ' + (w * h));
  }

  // Float32 的「下一个更大值」（仅用于有限值）
  var _f = new Float32Array(1), _i = new Int32Array(_f.buffer);
  function nextUp32(v) {
    _f[0] = v;
    if (_f[0] === 0) { _i[0] = 1; return _f[0]; }
    if (_f[0] > 0) _i[0] += 1; else _i[0] -= 1;
    return _f[0];
  }

  // ---- 1. 填洼：Priority-Flood + ε ----
  function fill64(z, w, h) {
    var n = w * h, f = new Float64Array(n), closed = new Uint8Array(n);
    for (var q = 0; q < n; q++) { var v = z[q]; f[q] = (v === v && v > -9000) ? v : -1e9; }  // 无效值当作最低的出口
    var heap = new Int32Array(n), hs = 0;                       // 最小堆（按 f）
    var pit = new Int32Array(n), ph = 0, pt = 0;                // pit 队列：每格最多入队一次，线性数组足够

    function push(c) {
      var i = hs++, fc = f[c];
      while (i > 0) { var p = (i - 1) >> 1, hp = heap[p]; if (f[hp] <= fc) break; heap[i] = hp; i = p; }
      heap[i] = c;
    }
    function pop() {
      var top = heap[0], last = heap[--hs];
      if (hs > 0) {
        var i = 0, fl = f[last];
        for (;;) {
          var l = 2 * i + 1; if (l >= hs) break;
          var r = l + 1, m = (r < hs && f[heap[r]] < f[heap[l]]) ? r : l;
          if (f[heap[m]] >= fl) break;
          heap[i] = heap[m]; i = m;
        }
        heap[i] = last;
      }
      return top;
    }

    // 种子：四条边 + 无效值格
    for (var x = 0; x < w; x++) {
      var t = x, b = (h - 1) * w + x;
      if (!closed[t]) { closed[t] = 1; push(t); }
      if (!closed[b]) { closed[b] = 1; push(b); }
    }
    for (var y = 1; y < h - 1; y++) {
      var lft = y * w, rgt = y * w + w - 1;
      if (!closed[lft]) { closed[lft] = 1; push(lft); }
      if (!closed[rgt]) { closed[rgt] = 1; push(rgt); }
    }
    for (q = 0; q < n; q++) if (f[q] === -1e9 && !closed[q]) { closed[q] = 1; push(q); }

    while (ph < pt || hs > 0) {
      var c = ph < pt ? pit[ph++] : pop();
      var fc = f[c], cy = (c / w) | 0, cx = c - cy * w, lim = fc + EPS;
      for (var k = 0; k < 8; k++) {
        var ny = cy + DR[k], nx = cx + DC[k];
        if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
        var ni = ny * w + nx;
        if (closed[ni]) continue;
        closed[ni] = 1;
        if (f[ni] <= lim) { f[ni] = lim; pit[pt++] = ni; }      // 洼地/平地：抬到 上游+ε，走 pit 队列
        else push(ni);
      }
    }
    return f;
  }

  // ---- 2. D8：最陡下降，并列取编码小者 ----
  function d8From(f, w, h) {
    var n = w * h, dir = new Int8Array(n);
    var OFF = DR.map(function (r, k) { return r * w + DC[k]; });
    for (var y = 0; y < h; y++) {
      var edgeRow = (y === 0 || y === h - 1);
      for (var x = 0; x < w; x++) {
        var c = y * w + x, fc = f[c], best = -1, bs = 0, k, s;
        if (!edgeRow && x > 0 && x < w - 1) {                    // 内部格：无需判越界
          for (k = 0; k < 8; k++) { s = (fc - f[c + OFF[k]]) * INV[k]; if (s > bs) { bs = s; best = k; } }
        } else {                                                 // 边缘格：只看格网内的邻居，绝不越界
          for (k = 0; k < 8; k++) {
            var ny = y + DR[k], nx = x + DC[k];
            if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
            s = (fc - f[ny * w + nx]) * INV[k]; if (s > bs) { bs = s; best = k; }
          }
        }
        dir[c] = best;
      }
    }
    return dir;
  }

  // ---- 3. 汇流：拓扑序累加（返回 acc 与上游→下游的处理顺序）----
  function accumulateOrder(dir, w, h) {
    var n = w * h, acc = new Float32Array(n), indeg = new Uint8Array(n), order = new Int32Array(n);
    var OFF = DR.map(function (r, k) { return r * w + DC[k]; });
    var c, d;
    for (c = 0; c < n; c++) { acc[c] = 1; d = dir[c]; if (d >= 0) indeg[c + OFF[d]]++; }
    var head = 0, tail = 0;
    for (c = 0; c < n; c++) if (indeg[c] === 0) order[tail++] = c;
    while (head < tail) {
      c = order[head++]; d = dir[c];
      if (d >= 0) { var t = c + OFF[d]; acc[t] += acc[c]; if (--indeg[t] === 0) order[tail++] = t; }
    }
    if (tail !== n) throw new Error('Hydro: 流向存在环路（' + (n - tail) + ' 格），请检查输入');
    return { acc: acc, order: order };
  }

  // ---- 对外：一次算完 ----
  function computeHydro(z, w, h) {
    need(z, w, h, 'z', 'computeHydro');
    var f64 = fill64(z, w, h);
    var dir = d8From(f64, w, h);
    var ao = accumulateOrder(dir, w, h);
    // Float64 → Float32：从下游往上游，保证沿流向严格下降
    var n = w * h, filled = new Float32Array(n), order = ao.order;
    var OFF = DR.map(function (r, k) { return r * w + DC[k]; });
    for (var i = n - 1; i >= 0; i--) {
      var c = order[i], v = Math.fround(f64[c]), d = dir[c];
      if (d >= 0) { var dn = filled[c + OFF[d]]; if (!(v > dn)) v = nextUp32(dn); }
      filled[c] = v;
    }
    return { filled: filled, dir: dir, acc: ao.acc };
  }

  function riverMask(acc, w, h, thr) {
    need(acc, w, h, 'acc', 'riverMask');
    thr = +thr;
    var n = w * h, m = new Uint8Array(n);
    for (var i = 0; i < n; i++) if (acc[i] >= thr) m[i] = 1;
    return m;
  }

  // ---- 流域：从出口沿 dir 反向遍历 ----
  function watershed(dir, w, h, ix, iy) {
    need(dir, w, h, 'dir', 'watershed');
    ix = Math.round(+ix); iy = Math.round(+iy);
    if (!(ix >= 0 && ix < w && iy >= 0 && iy < h)) throw new Error('Hydro.watershed: 出口 [' + ix + ',' + iy + '] 越界');
    var n = w * h, mask = new Uint8Array(n), stack = new Int32Array(n), sp = 0, cnt = 0;
    var s = iy * w + ix; mask[s] = 1; stack[sp++] = s;
    while (sp > 0) {
      var c = stack[--sp]; cnt++;
      var cy = (c / w) | 0, cx = c - cy * w;
      for (var k = 0; k < 8; k++) {
        var ny = cy + DR[k], nx = cx + DC[k];
        if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
        var ni = ny * w + nx;
        // 邻居位于 c 的 k 方向；它流向 c 意味着它的 dir 是 k 的反方向 (k+4)%8
        if (!mask[ni] && dir[ni] === ((k + 4) & 7)) { mask[ni] = 1; stack[sp++] = ni; }
      }
    }
    var g = gridOf(w, h), area;
    if (g) area = cnt * g.cell_area_m2 / 1e6;
    else { console.warn('Hydro.watershed: 未登记 cell_area_m2，面积为 NaN。请先调用 Hydro.setMeta(meta)'); area = NaN; }
    return { mask: mask, area_km2: area, outlet: [ix, iy], cells: cnt };
  }

  function snapOutlet(acc, w, h, ix, iy, r) {
    need(acc, w, h, 'acc', 'snapOutlet');
    r = r == null ? 5 : r; ix = Math.round(ix); iy = Math.round(iy);
    var bx = ix, by = iy, ba = -1;
    for (var y = Math.max(0, iy - r); y <= Math.min(h - 1, iy + r); y++)
      for (var x = Math.max(0, ix - r); x <= Math.min(w - 1, ix + r); x++) {
        if ((x - ix) * (x - ix) + (y - iy) * (y - iy) > r * r) continue;
        var a = acc[y * w + x]; if (a > ba) { ba = a; bx = x; by = y; }
      }
    return [bx, by];
  }

  // =====================================================================
  //  进阶分析（新增，纯函数；冻结的三个签名不变）
  // =====================================================================
  function stepLens(w, h) {
    var g = gridOf(w, h) || { dx_m: 30, dy_m: 30 };
    var dg = Math.sqrt(g.dx_m * g.dx_m + g.dy_m * g.dy_m);
    // 编码 0..7 对应的一步长度（米）：东西走 dx，南北走 dy，对角走斜边
    return [g.dx_m, dg, g.dy_m, dg, g.dx_m, dg, g.dy_m, dg];
  }
  function offsets(w) { return DR.map(function (r, k) { return r * w + DC[k]; }); }

  // ---- 水往哪流：从任一格沿 dir 追到出口 ----
  function flowPath(dir, w, h, ix, iy) {
    need(dir, w, h, 'dir', 'flowPath');
    var L = stepLens(w, h), OFF = offsets(w), c = Math.round(iy) * w + Math.round(ix), path = [c], len = 0, guard = w * h;
    while (dir[c] >= 0 && guard--) { len += L[dir[c]]; c += OFF[dir[c]]; path.push(c); }
    return { idx: Int32Array.from(path), length_km: len / 1000, outlet: [c % w, (c / w) | 0] };
  }

  // ---- Strahler 河流分级：只在河网格上，自源头向下游 ----
  function strahler(dir, river, w, h) {
    need(dir, w, h, 'dir', 'strahler'); need(river, w, h, 'river', 'strahler');
    var n = w * h, OFF = offsets(w), indeg = new Uint8Array(n), ord = new Uint8Array(n);
    var maxIn = new Uint8Array(n), nMax = new Uint8Array(n), q = new Int32Array(n), hd = 0, tl = 0, c, d, t;
    for (c = 0; c < n; c++) if (river[c] && (d = dir[c]) >= 0 && river[t = c + OFF[d]]) indeg[t]++;
    for (c = 0; c < n; c++) if (river[c] && !indeg[c]) { ord[c] = 1; q[tl++] = c; }
    var top = 0;
    while (hd < tl) {
      c = q[hd++]; if (ord[c] > top) top = ord[c];
      d = dir[c]; if (d < 0) continue;
      t = c + OFF[d]; if (!river[t]) continue;
      if (ord[c] > maxIn[t]) { maxIn[t] = ord[c]; nMax[t] = 1; } else if (ord[c] === maxIn[t]) nMax[t]++;
      if (--indeg[t] === 0) { ord[t] = nMax[t] >= 2 ? maxIn[t] + 1 : maxIn[t]; q[tl++] = t; }
    }
    return { order: ord, max: top };
  }

  // ---- 最长河：每格的最长上游流程，取全图最大者回溯 ----
  function longestRiver(dir, w, h) {
    need(dir, w, h, 'dir', 'longestRiver');
    var n = w * h, OFF = offsets(w), L = stepLens(w, h), indeg = new Uint8Array(n), len = new Float32Array(n);
    var q = new Int32Array(n), hd = 0, tl = 0, c, d, t;
    for (c = 0; c < n; c++) if ((d = dir[c]) >= 0) indeg[c + OFF[d]]++;
    for (c = 0; c < n; c++) if (!indeg[c]) q[tl++] = c;
    while (hd < tl) {
      c = q[hd++]; d = dir[c]; if (d < 0) continue;
      t = c + OFF[d]; var v = len[c] + L[d]; if (v > len[t]) len[t] = v;
      if (--indeg[t] === 0) q[tl++] = t;
    }
    var best = 0; for (c = 1; c < n; c++) if (len[c] > len[best]) best = c;
    // 从终点往上游回溯：每步选「上游长度 + 步长」恰为当前值的那个来水格
    var path = [best]; c = best;
    for (var guard = n; guard-- && len[c] > 0;) {
      var cy = (c / w) | 0, cx = c - cy * w, nextC = -1, bestV = -1;
      for (var k = 0; k < 8; k++) {
        var ny = cy + DR[k], nx = cx + DC[k]; if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
        var j = ny * w + nx; if (dir[j] !== ((k + 4) & 7)) continue;
        var cand = len[j] + L[dir[j]]; if (cand > bestV) { bestV = cand; nextC = j; }
      }
      if (nextC < 0) break; c = nextC; path.push(c);
    }
    path.reverse();                                             // 源头 → 出口
    return { idx: Int32Array.from(path), length_km: len[best] / 1000, mouth: [best % w, (best / w) | 0],
      source: [path[0] % w, (path[0] / w) | 0] };
  }

  // ---- 最陡河段：河网格上，沿流向走满 reach_m 的平均比降最大者（用原始高程） ----
  function steepestReach(z, dir, river, w, h, reach_m) {
    need(z, w, h, 'z', 'steepestReach');
    reach_m = reach_m || 1000;
    var n = w * h, OFF = offsets(w), L = stepLens(w, h), best = null;
    for (var c0 = 0; c0 < n; c0++) {
      if (!river[c0]) continue;
      var c = c0, dist = 0, guard = 10000;
      while (dist < reach_m && dir[c] >= 0 && guard--) { dist += L[dir[c]]; c += OFF[dir[c]]; }
      if (dist < reach_m * 0.95) continue;
      var grad = (z[c0] - z[c]) / dist;
      if (!best || grad > best.grad) best = { grad: grad, from: c0, to: c, dist: dist };
    }
    if (!best) return null;
    var p = flowPath(dir, w, h, best.from % w, (best.from / w) | 0), idx = [];
    for (var i = 0; i < p.idx.length; i++) { idx.push(p.idx[i]); if (p.idx[i] === best.to) break; }
    return { idx: Int32Array.from(idx), gradient_pct: best.grad * 100, drop_m: z[best.from] - z[best.to],
      length_km: best.dist / 1000, from: [best.from % w, (best.from / w) | 0], to: [best.to % w, (best.to / w) | 0] };
  }

  global.Hydro = {
    computeHydro: computeHydro, riverMask: riverMask, watershed: watershed,
    setMeta: setMeta, snapOutlet: snapOutlet, DR: DR.slice(), DC: DC.slice(), EPS: EPS,
    flowPath: flowPath, strahler: strahler, longestRiver: longestRiver, steepestReach: steepestReach
  };
})(typeof window !== 'undefined' ? window : globalThis);
