/* 成员一 · 数据加载。只认 data/<aoi>/{dem.bin, meta.json, stats.json} 这一种约定。 */
(function () {
  'use strict';

  async function getJSON(url) {
    var r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
    return r.json();
  }

  async function loadDem(base) {
    var meta = await getJSON(base + '/meta.json');
    var r = await fetch(base + '/dem.bin', { cache: 'no-cache' });
    if (!r.ok) throw new Error(base + '/dem.bin -> HTTP ' + r.status);
    var buf = await r.arrayBuffer();
    var z = new Float32Array(buf);
    var need = meta.width * meta.height;
    if (z.length !== need) {
      throw new Error('dem.bin 长度 ' + z.length + '，应为 ' + need + '（' + meta.width + '×' + meta.height + '）');
    }
    var stats = null;
    try { stats = await getJSON(base + '/stats.json'); } catch (e) { /* stats 可选 */ }

    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < z.length; i++) {
      var v = z[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { z: z, meta: meta, stats: stats, base: base, min: lo, max: hi };
  }

  // 屏幕/图像坐标 -> 经纬度（像素中心）
  function lonLatAt(meta, px, py) {
    return {
      lon: meta.x0 + (px + 0.5) * meta.dx_deg,
      lat: meta.y0 - (py + 0.5) * meta.dy_deg
    };
  }

  function elevAt(data, px, py) {
    var w = data.meta.width, h = data.meta.height;
    if (px < 0 || py < 0 || px >= w || py >= h) return null;
    return data.z[(py | 0) * w + (px | 0)];
  }

  window.Loader = { loadDem: loadDem, lonLatAt: lonLatAt, elevAt: elevAt };
})();
