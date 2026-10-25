/* ui.js —— 界面与集成（唯一操作 DOM 的文件）。分析一律调用 Terrain / Hydro 纯函数。 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var PAL = window.Palette, UI = PAL.UI;
  var DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  var LAYER_NAME = { hillshade: '晕渲', elevation: '高程', slope: '坡度', aspect: '坡向', landform: '地貌分类' };
  var MODE_TIP = { query: '单击任意点：追踪水往哪流', basin: '单击山谷：自动吸附到河道并划出流域', profile: '依次单击起点 A、终点 B', viewshed: '单击观察点：计算可见范围' };

  var App = { aoi: 'aoi1', view: '2d', mode: 'query', token: 0, T: {}, res: {} };
  window.__app = App;

  function tick() { return new Promise(function (r) { setTimeout(r, 16); }); }
  function fmt(v, d) { return (+v).toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600); }
  function tag(ok) { return '<span class="' + (ok ? 'pass' : 'fail') + '">' + (ok ? 'PASS' : 'FAIL') + '</span>'; }
  function lonlat(x, y) { return window.Loader.lonLatAt(App.data.meta, x, y); }
  function cellKm2() { return App.data.meta.cell_area_m2 / 1e6; }

  /* ================= 启动 ================= */
  App.init = function () {
    App.map = new window.Map2D($('#map'));
    App.map.onHover = App.onHover;
    App.map.onClick = App.onClick;
    App.map.onViewChange = App.updateScale;
    App.map.onBaseChange = function () { if (App.view === '3d' && $('#drapeSel').value) App.applyDrape(); };

    $$('.aoi').forEach(function (b) { b.addEventListener('click', function () { if (b.dataset.aoi !== App.aoi) App.load(b.dataset.aoi); }); });
    $('#layers').addEventListener('click', function (e) { var b = e.target.closest('button[data-layer]'); if (b && !b.disabled) App.setLayer(b.dataset.layer); });
    $('#tools').addEventListener('click', function (e) { var b = e.target.closest('button[data-mode]'); if (b && !b.disabled) App.setMode(b.dataset.mode); });
    $('#tglRiver').addEventListener('change', App.updateRivers);
    $('#tglWater').addEventListener('change', function () { App.map.setWater(this.checked ? App.water : null); App.updateRivers(); });
    $('#tglGrid').addEventListener('change', function () { App.map.setGraticule(this.checked); });
    $('#thr').addEventListener('input', App.updateRivers);
    $('#btnClear').addEventListener('click', App.clearResults);
    $('#zoomIn').addEventListener('click', function () { App.map.zoomCenter(1.4); });
    $('#zoomOut').addEventListener('click', function () { App.map.zoomCenter(1 / 1.4); });
    $('#btnReset').addEventListener('click', function () { App.map.fit(true); });
    $('#btnExport').addEventListener('click', function () { App.view === '3d' ? App.export3d() : App.exportMap(); });
    $('#btnCheck').addEventListener('click', function () { App.updateCheck(true); });
    $('#chipCheck').addEventListener('click', function () { App.updateCheck(true); $('#check').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    $('#closeProfile').addEventListener('click', function () { $('#profilebox').classList.remove('show'); App.map.setProfileLine(null); App.res.profile = null; });
    $('#btnHelp').addEventListener('click', function () { $('#helpModal').hidden = false; });
    $('#closeHelp').addEventListener('click', function () { $('#helpModal').hidden = true; });
    $('#helpModal').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
    $$('.tab').forEach(function (b) { b.addEventListener('click', function () { App.switchView(b.dataset.view); }); });

    // 三维
    $('#ve3d').addEventListener('input', function () { $('#veVal').textContent = '×' + this.value; if (window.Render3D) Render3D.setVE(+this.value); });
    $('#views3d').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]'); if (!b || !window.Render3D) return;
      $$('#views3d button').forEach(function (x) { x.classList.toggle('on', x === b); }); Render3D.setView(b.dataset.v);
    });
    $('#btnSpin').addEventListener('click', App.toggleSpin);
    $('#btnRiver3d').addEventListener('click', App.toggleRiver3d);
    $('#drapeSel').addEventListener('change', App.applyDrape);
    $('#btnPng3d').addEventListener('click', App.export3d);
    setInterval(function () { if (App.view === '3d' && window.Render3D) { var i = Render3D.info(); $('#fps3d').textContent = i && i.fps ? i.fps + ' fps' : ''; } }, 800);

    window.addEventListener('keydown', App.onKey);
    $('#profile').addEventListener('pointermove', App.onProfileHover);
    $('#profile').addEventListener('pointerleave', function () { App.map.setProfileHover(null); App.drawProfile(); });
    window.addEventListener('resize', function () { if (App.res.profile) App.drawProfile(); });
    App.load('aoi1');
  };

  /* ================= 加载流水线 ================= */
  var STEPS = [['dem', '读取 DEM（dem.bin 原生值）'], ['slope', '坡度 / 坡向（Horn 3×3）'], ['hydro', '水文：填洼 → D8 → 汇流'],
    ['landform', '地貌分类与水面识别'], ['river', '河网与 Strahler 分级'], ['poi', '兴趣点挑战']];

  App.load = async function (name) {
    var tk = ++App.token;
    App.aoi = name; App.res = {}; App.T = {};
    $$('.aoi').forEach(function (b) { var on = b.dataset.aoi === name; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    $('#ldTitle').textContent = '载入 ' + (name === 'aoi1' ? 'AOI1 云大后山' : 'AOI2 三江并流');
    $('#ldSteps').innerHTML = STEPS.map(function (s) { return '<li data-s="' + s[0] + '"><span>' + s[1] + '</span><em></em></li>'; }).join('');
    $('#loading').classList.add('show');
    $('#profilebox').classList.remove('show'); $('#resultCard').hidden = true;
    var step = async function (k, fn) {
      var li = $('#ldSteps li[data-s="' + k + '"]'); li.className = 'active'; await tick();
      var t0 = performance.now(); var r = await fn(); App.T[k] = Math.round(performance.now() - t0);
      if (tk !== App.token) throw new Error('cancel');
      li.className = 'done'; li.querySelector('em').textContent = App.T[k] + ' ms'; return r;
    };
    try {
      var d = await step('dem', function () { return window.Loader.loadDem('data/' + name); });
      App.data = d; var m = d.meta, w = m.width, h = m.height;
      Terrain.setMeta(m); Hydro.setMeta(m);
      App.dataCheck = App.checkData(d);
      App.map.setData(d);
      if (window.Render3D) { Render3D.clearOverlay(); Render3D.spin(false); App._mounted3d = null; $('#btnSpin').classList.remove('on'); $('#btnRiver3d').classList.remove('on'); }
      await step('slope', function () { var r = Terrain.slopeAspect(d.z, w, h, m.dx_m, m.dy_m); App.slope = r.slope; App.aspect = r.aspect; App.map.setSlope(r.slope, r.aspect); });
      await step('hydro', function () { App.hydro = Hydro.computeHydro(d.z, w, h); App.hydroCheck = App.checkHydro(); });
      await step('landform', function () {
        App.lf = Terrain.landform(d.z, w, h); App.map.setLandform(App.lf.cls);
        App.waterRes = Terrain.flatWater(d.z, w, h, 0.5); App.water = App.waterRes.mask;
        App.map.setWater($('#tglWater').checked ? App.water : null);
      });
      await step('river', function () { App.updateRivers(); });
      await step('poi', function () { App.computePOI(); });
      $$('#layers button, #tools button').forEach(function (b) { b.disabled = false; });
      $('#thr').disabled = false;
      $('#loading').classList.remove('show');
      App.setLayer(App.map.layer || 'hillshade', true);
      App.renderInfo(); App.renderHistogram(); App.renderPOI(); App.updateCheck();
      App.setMode(App.mode);
      console.log('[数据通路] ' + name + ' ' + w + '×' + h + ' min=' + d.min.toFixed(1) + ' max=' + d.max.toFixed(1) + ' z.length=' + d.z.length, App.T);
      if (App.view === '3d') App.mount3D();
    } catch (e) {
      if (e.message === 'cancel') return;
      $('#ldTitle').textContent = '加载失败：' + e.message;
      $('#ldSteps').innerHTML = '<li>请用本地服务器打开（python -m http.server），不要双击 file://</li>';
      console.error(e);
    }
  };

  /* ================= 河网与兴趣点 ================= */
  App.threshold = function () { return Math.round(Math.pow(10, 2 + (+$('#thr').value / 100) * 2.5)); };
  App.updateRivers = function () {
    if (!App.hydro) return;
    var m = App.data.meta, thr = App.threshold();
    var mask = Hydro.riverMask(App.hydro.acc, m.width, m.height, thr), so = Hydro.strahler(App.hydro.dir, mask, m.width, m.height), n = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i]) n++;
    App.rivers = { mask: mask, order: so.order, max: so.max, cells: n, thr: thr };
    App.map.setRivers($('#tglRiver').checked ? mask : null, so.order);
    $('#thrVal').textContent = '≥ ' + fmt(thr) + ' 格';
    $('#thrHint').textContent = '≈ ' + fmt(thr * cellKm2(), 2) + ' km² 汇水面积 · 河道 ' + fmt(n) + ' 格 · 最高 ' + so.max + ' 级';
    App.renderLegend();
    if (App.view === '3d' && $('#btnRiver3d').classList.contains('on')) App.river3d(true);
  };

  App.computePOI = function () {
    var d = App.data, z = d.z, m = d.meta, w = m.width, h = m.height, hy = App.hydro, P = [];
    var hi = 0, lo = 0; for (var i = 1; i < z.length; i++) { if (z[i] > z[hi]) hi = i; if (z[i] < z[lo]) lo = i; }
    P.push({ k: 'peak', icon: 'i-peak', name: '最高峰', v: fmt(z[hi], 1) + ' m', x: hi % w, y: (hi / w) | 0 });
    P.push({ k: 'low', icon: 'i-low', name: '最低点', v: fmt(z[lo], 1) + ' m', x: lo % w, y: (lo / w) | 0 });
    var ob = -1; for (i = 0; i < z.length; i++) if (hy.dir[i] < 0 && (ob < 0 || hy.acc[i] > hy.acc[ob])) ob = i;
    P.push({ k: 'basin', icon: 'i-basin', name: '最大流域', v: fmt(hy.acc[ob] * cellKm2(), 1) + ' km²', x: ob % w, y: (ob / w) | 0 });
    var lr = Hydro.longestRiver(hy.dir, w, h);
    P.push({ k: 'long', icon: 'i-long', name: '最长河', v: fmt(lr.length_km, 1) + ' km', path: lr.idx, x: lr.mouth[0], y: lr.mouth[1], src: lr.source });
    var main = Hydro.riverMask(hy.acc, w, h, 1000), so = Hydro.strahler(hy.dir, main, w, h).order, big = new Uint8Array(main.length);
    for (i = 0; i < big.length; i++) big[i] = so[i] >= 3 ? 1 : 0;
    var st = Hydro.steepestReach(z, hy.dir, big, w, h, 1000);
    if (st) P.push({ k: 'steep', icon: 'i-steep', name: '最陡河段', sub: '≥3 级河道 · 1 km', v: fmt(st.gradient_pct, 1) + '%', path: st.idx, x: st.from[0], y: st.from[1], st: st });
    if (App.waterRes.bodies.length) P.push({ k: 'water', icon: 'i-water', name: '最大水面', v: fmt(App.waterRes.bodies[0].area_km2, 1) + ' km²', sub: '水位 ' + App.waterRes.bodies[0].elev + ' m' });
    App.poi = P;
  };

  App.renderPOI = function () {
    $('#poiList').innerHTML = App.poi.map(function (p, i) {
      return '<li><button data-i="' + i + '"><svg><use href="#' + p.icon + '"/></svg><span class="n">' + p.name + (p.sub ? '<small>' + p.sub + '</small>' : '') + '</span><span class="v">' + p.v + '</span></button></li>';
    }).join('');
    $$('#poiList button').forEach(function (b) { b.addEventListener('click', function () { App.showPOI(App.poi[+b.dataset.i], b); }); });
  };

  App.showPOI = function (p, btn) {
    $$('#poiList button').forEach(function (x) { x.classList.toggle('on', x === btn); });
    var m = App.data.meta, w = m.width, h = m.height;
    App.map.setPath('poi', null);
    if (p.k === 'basin') { App.doBasin(p.x, p.y, true); return; }
    if (p.path) {
      App.map.setPath('poi', { idx: p.path, color: p.k === 'long' ? UI.longest : UI.steep, width: p.k === 'long' ? 3 : 4.5 });
      var x0 = w, y0 = h, x1 = 0, y1 = 0; for (var i = 0; i < p.path.length; i++) { var c = p.path[i], x = c % w, y = (c / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      App.map.flyToBox(x0, y0, x1, y1);
    } else if (p.x != null) App.map.flyTo(p.x, p.y);
    if (p.x != null) App.map.setMarkers([{ x: p.x, y: p.y, label: p.name + ' ' + p.v, color: '#fff' }]);
    var body = '<div class="big">' + p.v + '</div><div class="res-sub">' + p.name + (p.sub ? ' · ' + p.sub : '') + '</div><dl class="kv">';
    if (p.x != null) { var ll = lonlat(p.x, p.y); body += '<dt>位置</dt><dd>' + ll.lon.toFixed(4) + '°E ' + ll.lat.toFixed(4) + '°N</dd><dt>行列</dt><dd>' + p.x + ', ' + p.y + '</dd><dt>高程</dt><dd>' + fmt(App.data.z[p.y * w + p.x], 2) + ' m</dd>'; }
    if (p.k === 'long') body += '<dt>源头</dt><dd>' + p.src.join(', ') + '</dd><dt>格数</dt><dd>' + fmt(p.path.length) + '</dd>';
    if (p.k === 'steep') body += '<dt>落差</dt><dd>' + fmt(p.st.drop_m, 1) + ' m / ' + fmt(p.st.length_km, 2) + ' km</dd><dt>终点</dt><dd>' + p.st.to.join(', ') + '</dd>';
    body += '</dl><div class="hint">依据：' + ({ peak: 'dem.bin 全幅最大值', low: 'dem.bin 全幅最小值', long: '逐格最长上游流程（D8）回溯', steep: 'Strahler ≥3 级河道沿流向 1 km 平均比降', water: '3×3 完全水平连片区' }[p.k] || '') + '</div>';
    App.showResult(p.name, body);
  };

  /* ================= 图层 / 模式 ================= */
  App.setLayer = function (name, silent) {
    $$('#layers button').forEach(function (b) { var on = b.dataset.layer === name; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    App.map.setLayer(name); App.renderLegend();
  };
  App.setMode = function (mode) {
    App.mode = mode;
    $$('#tools button').forEach(function (b) { var on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $('#modeName').textContent = { query: '水往哪流', basin: '划流域', profile: '剖面', viewshed: '视域' }[mode];
    $('#optViewshed').hidden = mode !== 'viewshed';
    $('#map').classList.toggle('cross', mode !== 'query');
    App._pA = null;
    var tip = $('#modeTip'); tip.textContent = MODE_TIP[mode]; tip.classList.add('show');
    clearTimeout(App._tipT); App._tipT = setTimeout(function () { tip.classList.remove('show'); }, 2600);
  };
  App.clearResults = function () {
    App.res = {}; App.map.setBasin(null); App.map.setViewshed(null); App.map.clearPaths(); App.map.setMarkers([]); App.map.setProfileLine(null);
    $('#profilebox').classList.remove('show'); $('#resultCard').hidden = true; $$('#poiList button').forEach(function (x) { x.classList.remove('on'); });
    if (window.Render3D) Render3D.clearOverlay('watershed');
    App.updateCheck();
  };
  App.showResult = function (title, html) { $('#resultTitle').textContent = title; $('#resultBody').innerHTML = html; $('#resultCard').hidden = false; };

  /* ================= 悬停与点击 ================= */
  App.cellInfo = function (x, y) {
    var d = App.data, m = d.meta, w = m.width, i = y * w + x, ll = lonlat(x, y), r = { ll: ll, x: x, y: y, z: d.z[i] };
    if (App.slope) { r.slope = App.slope[i]; r.aspect = App.aspect[i]; }
    if (App.lf) { r.lf = Terrain.LANDFORM[App.lf.cls[i] - 1].name; r.relief = App.lf.relief[i]; }
    if (App.hydro) r.accKm2 = App.hydro.acc[i] * cellKm2();
    if (App.rivers && App.rivers.mask[i]) r.order = App.rivers.order[i];
    if (App.water && App.water[i]) r.water = true;
    return r;
  };
  App.onHover = function (p) {
    if (!App.data) return;
    var m = App.data.meta, x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) return;
    var c = App.cellInfo(x, y);
    // 高程显示原生 Float32 值（两位小数即可无损表达到 cm），满足「与 dem.bin 误差 0」
    $('#status').innerHTML = '<span>经纬 <b>' + c.ll.lon.toFixed(5) + '°E ' + c.ll.lat.toFixed(5) + '°N</b></span>' +
      '<span>高程 <b>' + c.z.toFixed(2) + ' m</b></span>' + (c.slope != null ? '<span>坡度 <b>' + c.slope.toFixed(1) + '°</b></span>' : '') +
      '<span>行列 <b>' + x + ', ' + y + '</b></span>';
    if (!App._pinned) App.renderQuery(c, '悬停');
  };
  App.renderQuery = function (c, label) {
    $('#queryMode').textContent = label;
    var asp = c.aspect == null ? '—' : c.aspect < 0 ? '平坦' : c.aspect.toFixed(0) + '° ' + DIRS[Math.round(c.aspect / 45) % 8];
    $('#queryKV').innerHTML = '<dt>高程</dt><dd><b>' + c.z.toFixed(2) + '</b> m <small>原生值</small></dd>' +
      '<dt>坡度</dt><dd>' + (c.slope != null ? c.slope.toFixed(1) + '°' : '—') + '</dd><dt>坡向</dt><dd>' + asp + '</dd>' +
      '<dt>地貌</dt><dd>' + (c.lf ? c.lf + ' <small>起伏 ' + c.relief.toFixed(0) + ' m</small>' : '—') + '</dd>' +
      '<dt>汇水面积</dt><dd>' + (c.accKm2 != null ? fmt(c.accKm2, 3) + ' km²' : '—') + '</dd>' +
      '<dt>水系</dt><dd>' + (c.water ? '水面' : c.order ? c.order + ' 级河道' : '坡面') + '</dd>' +
      '<dt>经纬度</dt><dd>' + c.ll.lon.toFixed(5) + ', ' + c.ll.lat.toFixed(5) + '</dd><dt>行列</dt><dd>' + c.x + ', ' + c.y + '</dd>';
  };

  App.onClick = function (p) {
    if (!App.data || !App.hydro) return;
    var m = App.data.meta, x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) return;
    App._pinned = true; App.renderQuery(App.cellInfo(x, y), '已固定 · 单击别处更新');
    if (App.mode === 'query') App.doFlow(x, y);
    else if (App.mode === 'basin') App.doBasin(x, y);
    else if (App.mode === 'profile') {
      if (!App._pA) { App._pA = { x: x, y: y }; App.map.setProfileLine({ x0: x, y0: y, x1: x, y1: y }); toast('已定起点 A，再点终点 B'); }
      else { var a = App._pA; App._pA = null; App.doProfile(a.x, a.y, x, y); }
    } else if (App.mode === 'viewshed') App.doViewshed(x, y);
  };

  App.doFlow = function (x, y) {
    var d = App.data, m = d.meta, w = m.width, fp = Hydro.flowPath(App.hydro.dir, w, m.height, x, y);
    var o = fp.outlet, z0 = d.z[y * w + x], z1 = d.z[o[1] * w + o[0]], maxO = 0;
    for (var i = 0; i < fp.idx.length; i++) if (App.rivers.mask[fp.idx[i]]) maxO = Math.max(maxO, App.rivers.order[fp.idx[i]]);
    App.map.setPath('flow', { idx: fp.idx, color: UI.flow, width: 2.6 });
    App.map.setMarkers([{ x: x, y: y, label: '起点', color: UI.flow }, { x: o[0], y: o[1], label: '出口', color: '#fff' }]);
    var side = o[1] === 0 ? '北边界' : o[1] === m.height - 1 ? '南边界' : o[0] === 0 ? '西边界' : o[0] === w - 1 ? '东边界' : '内部';
    App.res.flow = { len: fp.length_km, drop: z0 - z1 };
    App.showResult('水往哪流', '<div class="big">' + fmt(fp.length_km, 2) + '<small>km 流程</small></div><div class="res-sub">沿 D8 流向追踪到研究区' + side + '</div><dl class="kv">' +
      '<dt>落差</dt><dd>' + fmt(z0 - z1, 1) + ' m</dd><dt>平均比降</dt><dd>' + fmt((z0 - z1) / (fp.length_km * 1000) * 1000, 1) + ' ‰</dd>' +
      '<dt>途经河道</dt><dd>' + (maxO ? '最高 ' + maxO + ' 级' : '未入河网') + '</dd><dt>格数</dt><dd>' + fmt(fp.idx.length) + '</dd>' +
      '<dt>出口</dt><dd>' + o.join(', ') + ' · ' + fmt(z1, 1) + ' m</dd></dl>');
  };

  App.doBasin = function (x, y, noSnap) {
    var d = App.data, m = d.meta, w = m.width, h = m.height, hy = App.hydro;
    var o = noSnap ? [x, y] : Hydro.snapOutlet(hy.acc, w, h, x, y, 5);       // 点歪也能落到河道上
    var t0 = performance.now(), ws = Hydro.watershed(hy.dir, w, h, o[0], o[1]), ms = Math.round(performance.now() - t0);
    var zs = Terrain.zonalStats(d.z, w, h, ws.mask, App.slope), maxO = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (var i = 0; i < ws.mask.length; i++) if (ws.mask[i]) {
      if (App.rivers.mask[i] && App.rivers.order[i] > maxO) maxO = App.rivers.order[i];
      var cx = i % w, cy = (i / w) | 0; if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
    }
    App.res.basin = { ws: ws, zs: zs, o: o };
    App.map.setBasin(ws.mask); App.map.setMarkers([{ x: o[0], y: o[1], label: '出口', color: UI.basinEdge }]);
    if (noSnap) App.map.flyToBox(x0, y0, x1, y1);
    var ll = lonlat(o[0], o[1]);
    App.showResult('流域', '<div class="big">' + fmt(ws.area_km2, ws.area_km2 < 10 ? 3 : 1) + '<small>km²</small></div>' +
      '<div class="res-sub">' + fmt(ws.cells) + ' 格 × ' + m.cell_area_m2 + ' m²' + (noSnap ? '' : ' · 出口已吸附到半径 5 格内汇流最大处') + '</div><dl class="kv">' +
      '<dt>出口</dt><dd>' + ll.lon.toFixed(4) + '°E ' + ll.lat.toFixed(4) + '°N<br><small>行列 ' + o.join(', ') + '</small></dd>' +
      '<dt>出口高程</dt><dd>' + fmt(zs.zmin === d.z[o[1] * w + o[0]] ? zs.zmin : d.z[o[1] * w + o[0]], 1) + ' m</dd>' +
      '<dt>最高点</dt><dd>' + fmt(zs.zmax, 1) + ' m</dd><dt>相对高差</dt><dd>' + fmt(zs.relief, 0) + ' m</dd>' +
      '<dt>平均坡度</dt><dd>' + zs.slope_mean.toFixed(2) + '°</dd><dt>主河道</dt><dd>' + (maxO ? maxO + ' 级（Strahler）' : '—') + '</dd>' +
      '<dt>面高积分</dt><dd>HI = ' + zs.hi.toFixed(3) + ' <small>' + (zs.hi > 0.6 ? '幼年期' : zs.hi > 0.35 ? '壮年期' : '老年期') + '</small></dd><dt>耗时</dt><dd>' + ms + ' ms</dd></dl>' +
      '<canvas class="mini" id="hypso"></canvas><div class="hint">面积—高程曲线：横轴为高于该高程的面积比例</div>');
    App.drawHypso(zs.hypso);
    if (window.Render3D && App._mounted3d) Render3D.setOverlay(ws.mask, { name: 'watershed', color: UI.basin, alpha: 0.45, thicken: 0 });
    toast('流域 ' + fmt(ws.area_km2, 2) + ' km² · 出口 ' + o.join(', '));
    App.updateCheck();
  };

  App.drawHypso = function (curve) {
    var cv = $('#hypso'); if (!cv) return;
    var W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr;
    var g = cv.getContext('2d'); g.scale(dpr, dpr);
    var L = 24, B = 14, X = function (a) { return L + a * (W - L - 8); }, Y = function (v) { return H - B - v * (H - B - 8); };
    g.strokeStyle = '#2c3a49'; g.beginPath(); g.moveTo(L, 6); g.lineTo(L, H - B); g.lineTo(W - 6, H - B); g.stroke();
    g.beginPath(); curve.forEach(function (p, i) { i ? g.lineTo(X(p.a), Y(p.h)) : g.moveTo(X(p.a), Y(p.h)); });
    g.lineTo(X(1), Y(0)); g.lineTo(X(0), Y(0)); g.closePath(); g.fillStyle = 'rgba(255,176,48,.22)'; g.fill();
    g.beginPath(); curve.forEach(function (p, i) { i ? g.lineTo(X(p.a), Y(p.h)) : g.moveTo(X(p.a), Y(p.h)); }); g.strokeStyle = UI.basin; g.lineWidth = 1.8; g.stroke();
    g.fillStyle = '#7f8d9b'; g.font = '9px Consolas'; g.fillText('h/H', 0, 12); g.fillText('a/A', W - 26, H - 2);
  };

  App.doViewshed = function (x, y) {
    var d = App.data, m = d.meta, hObs = Math.max(0, +$('#obsH').value || 1.7);
    var t0 = performance.now(), v = Terrain.viewshed(d.z, m.width, m.height, x, y, { observer_h: hObs }), ms = Math.round(performance.now() - t0);
    App.res.viewshed = v; App.T.viewshed = ms;
    App.map.setViewshed(v.mask); App.map.setMarkers([{ x: x, y: y, kind: 'observer', color: '#fff' }]);
    App.showResult('视域', '<div class="big">' + fmt(v.visible_km2, 2) + '<small>km² 可见</small></div><div class="res-sub">占研究区 ' + v.pct.toFixed(2) + '% · 计算 ' + ms + ' ms</div><dl class="kv">' +
      '<dt>观察点</dt><dd>' + x + ', ' + y + ' · 地面 ' + fmt(v.observer_elev, 1) + ' m</dd><dt>观察高度</dt><dd>' + hObs + ' m</dd>' +
      '<dt>方法</dt><dd>外围逐格射线 + 地球曲率与折射 k=0.13</dd></dl>');
    App.updateCheck();
  };

  /* ================= 剖面 ================= */
  App.doProfile = function (x0, y0, x1, y1) {
    var d = App.data, m = d.meta, w = m.width, r = Terrain.profile(d.z, w, m.height, x0, y0, x1, y1);
    var ok = 0, N = 10; for (var k = 0; k < N; k++) { var p = r.pts[Math.round(k * (r.pts.length - 1) / (N - 1))]; if (p.z === d.z[p.iy * w + p.ix]) ok++; }
    var zs = r.pts.map(function (p) { return p.z; }), lo = Math.min.apply(null, zs), hi = Math.max.apply(null, zs), up = 0, dn = 0;
    for (k = 1; k < zs.length; k++) { var dz = zs[k] - zs[k - 1]; if (dz > 0) up += dz; else dn -= dz; }
    App.res.profile = { r: r, lo: lo, hi: hi, up: up, dn: dn, check: ok, line: { x0: x0, y0: y0, x1: x1, y1: y1 } };
    App.map.setProfileLine(App.res.profile.line);
    $('#profileStats').textContent = '长 ' + fmt(r.len_km, 2) + ' km · 最高 ' + fmt(hi, 1) + ' m · 最低 ' + fmt(lo, 1) + ' m · 累计爬升 ' + fmt(up, 0) + ' m · 抽查 ' + ok + '/' + N + ' 与原生值一致';
    $('#profilebox').classList.add('show');
    App.drawProfile(); App.updateCheck();
  };
  App.drawProfile = function (hoverI) {
    var P = App.res.profile; if (!P) return;
    var cv = $('#profile'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    var g = cv.getContext('2d'); g.scale(dpr, dpr);
    var L = 52, R = 14, T = 12, B = 26, pts = P.r.pts, len = P.r.len_km;
    var span = Math.max(1, P.hi - P.lo), pad = span * 0.08, lo = P.lo - pad, hi = P.hi + pad;
    var X = function (dk) { return L + dk / (len || 1) * (W - L - R); }, Y = function (z) { return H - B - (z - lo) / (hi - lo) * (H - T - B); };
    g.font = '10px Consolas, monospace'; g.fillStyle = '#7f8d9b'; g.strokeStyle = 'rgba(255,255,255,.06)';
    var nice = function (r) { var p = Math.pow(10, Math.floor(Math.log10(r))), n = r / p; return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p; };
    var zs = nice((hi - lo) / 4); for (var z = Math.ceil(lo / zs) * zs; z <= hi; z += zs) { g.beginPath(); g.moveTo(L, Y(z)); g.lineTo(W - R, Y(z)); g.stroke(); g.fillText(fmt(z) + ' m', 4, Y(z) + 3); }
    var ds = nice(len / 6); for (var dk = 0; dk <= len + 1e-9; dk += ds) { g.beginPath(); g.moveTo(X(dk), T); g.lineTo(X(dk), H - B); g.stroke(); g.fillText(dk.toFixed(ds < 1 ? 1 : 0) + ' km', X(dk) - 12, H - 8); }
    var grad = g.createLinearGradient(0, T, 0, H - B); grad.addColorStop(0, 'rgba(255,209,102,.35)'); grad.addColorStop(1, 'rgba(255,209,102,.02)');
    g.beginPath(); pts.forEach(function (p, i) { i ? g.lineTo(X(p.d_km), Y(p.z)) : g.moveTo(X(p.d_km), Y(p.z)); });
    g.lineTo(X(len), H - B); g.lineTo(X(0), H - B); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath(); pts.forEach(function (p, i) { i ? g.lineTo(X(p.d_km), Y(p.z)) : g.moveTo(X(p.d_km), Y(p.z)); }); g.strokeStyle = UI.profile; g.lineWidth = 1.6; g.stroke();
    // 图表的垂直夸大 = 竖向每米像素 / 横向每米像素
    var ve = ((H - T - B) / (hi - lo)) / ((W - L - R) / (len * 1000 || 1));
    g.fillStyle = '#ffd166'; g.fillText('A', L + 3, T + 10); g.fillText('B', W - R - 9, T + 10);
    g.fillStyle = '#b8c4cf'; g.fillText('垂直夸大 ×' + (ve >= 10 ? ve.toFixed(0) : ve.toFixed(1)), W - R - 92, H - B - 6);
    if (hoverI != null) {
      var q = pts[hoverI], hx = X(q.d_km), hy = Y(q.z);
      g.strokeStyle = 'rgba(255,255,255,.5)'; g.beginPath(); g.moveTo(hx, T); g.lineTo(hx, H - B); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 3.5, 0, 6.28); g.fill();
      var txt = q.d_km.toFixed(2) + ' km · ' + q.z.toFixed(2) + ' m', tw = g.measureText(txt).width + 10, bx = Math.min(hx + 8, W - tw - 4);
      g.fillStyle = 'rgba(11,15,20,.92)'; g.fillRect(bx, T + 2, tw, 16); g.fillStyle = '#fff'; g.fillText(txt, bx + 5, T + 13);
    }
  };
  App.onProfileHover = function (e) {
    var P = App.res.profile; if (!P) return;
    var r = $('#profile').getBoundingClientRect(), L = 52, R = 14, f = (e.clientX - r.left - L) / (r.width - L - R);
    if (f < 0 || f > 1) return;
    var i = Math.round(f * (P.r.pts.length - 1)); App.drawProfile(i); App.map.setProfileHover(P.r.pts[i]);
  };

  /* ================= 面板 ================= */
  App.renderInfo = function () {
    var m = App.data.meta;
    $('#info').innerHTML = '<dt>数据</dt><dd>' + m.name + '</dd><dt>尺寸</dt><dd>' + m.width + ' × ' + m.height + '</dd>' +
      '<dt>像元</dt><dd>' + m.dx_m.toFixed(2) + ' × ' + m.dy_m.toFixed(2) + ' m</dd><dt>范围</dt><dd>' + m.x0.toFixed(2) + '–' + (m.x0 + m.width * m.dx_deg).toFixed(2) + '°E<br>' +
      (m.y0 - m.height * m.dy_deg).toFixed(2) + '–' + m.y0.toFixed(2) + '°N</dd><dt>高程</dt><dd>' + m.elev.min.toFixed(1) + ' / ' + m.elev.mean.toFixed(1) + ' / ' + m.elev.max.toFixed(1) + ' m</dd>' +
      '<dt>坐标系</dt><dd>' + m.crs + '</dd><dt>来源</dt><dd>' + m.source + '</dd>';
  };
  App.updateScale = function (scale) {
    if (!App.data) return;
    var mpp = App.data.meta.dx_m / scale, target = 110 * mpp, pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, target)))), n = target / pow;
    var val = (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow, px = val / mpp;
    $('#scalebar').innerHTML = '<i style="width:' + Math.max(24, px).toFixed(0) + 'px"></i><span>' + (val >= 1000 ? val / 1000 + ' km' : Math.round(val) + ' m') + '</span>';
  };
  App.renderLegend = function () {
    if (!App.data) return;
    var layer = App.map.layer, html = '', m = App.data.meta;
    $('#legendName').textContent = LAYER_NAME[layer];
    var grad = function (stops, f) { return 'linear-gradient(90deg,' + stops.map(function (s) { return s[1] + ' ' + (f(s[0]) * 100).toFixed(1) + '%'; }).join(',') + ')'; };
    if (layer === 'slope') {
      html = '<div class="grad" style="background:' + grad(PAL.SLOPE_HEX, function (v) { return v / 60; }) + '"></div><div class="grad-ticks"><span>0°</span><span>15°</span><span>30°</span><span>45°</span><span>≥60°</span></div>';
    } else if (layer === 'aspect') {
      html = '<canvas class="rose" id="rose" width="220" height="150"></canvas>';
    } else if (layer === 'landform') {
      html = '<div class="cat">' + App.lf.classes.filter(function (c) { return c.cells; }).map(function (c) {
        return '<i style="background:' + PAL.LANDFORM_HEX[c.id - 1][2] + '"></i><span>' + c.name + ' <em>' + c.lo + '–' + (isFinite(c.hi) ? c.hi : '') + ' m</em></span><em>' + c.pct.toFixed(1) + '%</em>';
      }).join('') + '</div><div class="hint">起伏度窗口 ' + (App.lf.window_m[0] / 1000).toFixed(1) + ' km，阈值参照李炳元等（2008）</div>';
    } else {
      html = '<div class="grad" style="background:' + grad(PAL.RAMP_HEX, function (v) { return v; }) + '"></div><div class="grad-ticks"><span>' + fmt(m.elev.min) + '</span><span>' + fmt((m.elev.min + m.elev.max) / 2) + '</span><span>' + fmt(m.elev.max) + ' m</span></div>' +
        (layer === 'hillshade' ? '<div class="hint">晕渲：光源方位 315°、高度 45°</div>' : '');
    }
    $('#legend').innerHTML = html;
    if (layer === 'aspect') App.drawRose();
    var ol = '';
    if (App.rivers && $('#tglRiver').checked) ol += '<div class="ol-row"><span class="sw" style="background:linear-gradient(90deg,' + UI.river.slice(0, Math.max(2, App.rivers.max)).join(',') + ')"></span>河网 1–' + App.rivers.max + ' 级（Strahler）</div>';
    if (App.waterRes && App.waterRes.bodies.length && $('#tglWater').checked) ol += '<div class="ol-row"><span class="sw" style="background:' + UI.water + '"></span>水面（DEM 连片水平区）</div>';
    ol += '<div class="ol-row"><span class="sw" style="background:' + UI.basin + '"></span>流域　<span class="sw" style="background:' + UI.flow + '"></span>水流路径　<span class="sw" style="background:' + UI.viewshed + '"></span>可见</div>';
    $('#legendOverlay').innerHTML = ol;
  };
  App.drawRose = function () {
    var cv = $('#rose'); if (!cv) return; var g = cv.getContext('2d'), cx = 110, cy = 75, r = 52;
    for (var k = 0; k < 8; k++) {
      var a0 = (k * 45 - 22.5 - 90) * Math.PI / 180, a1 = (k * 45 + 22.5 - 90) * Math.PI / 180, c = PAL.aspectColor(k * 45);
      g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, a0, a1); g.closePath(); g.fillStyle = 'rgb(' + c.map(Math.round).join(',') + ')'; g.fill();
      var am = (k * 45 - 90) * Math.PI / 180; g.fillStyle = '#d5dee6'; g.font = '11px sans-serif'; g.textAlign = 'center'; g.fillText(DIRS[k], cx + Math.cos(am) * (r + 13), cy + Math.sin(am) * (r + 13) + 4);
    }
    g.beginPath(); g.arc(cx, cy, 10, 0, 6.28); g.fillStyle = 'rgb(150,150,150)'; g.fill(); g.fillStyle = '#111'; g.font = '9px sans-serif'; g.fillText('平', cx, cy + 3);
  };

  App.renderHistogram = function () {
    var cv = $('#hist'), g = cv.getContext('2d'), d = App.data; if (!d || !d.stats) return;
    var bins = d.stats.slope_bins_deg, ref = d.stats.slope_hist_pct, cnt = new Array(bins.length - 1).fill(0), n = 0, sum = 0;
    for (var i = 0; i < App.slope.length; i++) { var s = App.slope[i]; sum += s; n++; for (var b = 0; b < cnt.length; b++) if (s >= bins[b] && s < bins[b + 1]) { cnt[b]++; break; } }
    var live = cnt.map(function (c) { return c / n * 100; }), delta = 0; live.forEach(function (v, k) { delta = Math.max(delta, Math.abs(v - ref[k])); });
    App.histDelta = delta; App.slopeMean = sum / n;
    var W = cv.width, H = cv.height, L = 30, B = 30, T = 14, bw = (W - L - 8) / live.length, mx = Math.max.apply(null, live.concat(ref)) * 1.12;
    g.clearRect(0, 0, W, H); g.font = '17px Consolas, monospace';
    for (var k = 0; k < live.length; k++) {
      var x = L + k * bw, hl = live[k] / mx * (H - T - B), hr = ref[k] / mx * (H - T - B);
      g.fillStyle = '#37b6e0'; g.fillRect(x + bw * 0.18, H - B - hl, bw * 0.64, hl);
      g.strokeStyle = '#c9d6e2'; g.lineWidth = 2; g.strokeRect(x + bw * 0.1, H - B - hr, bw * 0.8, hr);
      g.fillStyle = '#7f8d9b'; g.fillText(bins[k], x - 4, H - 8);
    }
    g.fillText(bins[bins.length - 1] + '°', W - 34, H - 8);
    g.fillStyle = '#5d6b79'; g.fillText(Math.round(mx) + '%', 0, T + 6);
    $('#histHint').innerHTML = '均值 <b>' + App.slopeMean.toFixed(2) + '°</b>（参考 ' + d.stats.slope_mean_deg + '°）· 逐箱最大差 <b>' + delta.toFixed(3) + ' pp</b>';
  };

  /* ================= 自检 ================= */
  App.checkData = function (d) { var z0 = 0, nan = 0; for (var i = 0; i < d.z.length; i++) { if (d.z[i] === 0) z0++; if (!isFinite(d.z[i])) nan++; } return { lenOk: d.z.length === d.meta.width * d.meta.height, zeros: z0, nan: nan }; };
  App.checkHydro = function () {
    var h = App.hydro, m = App.data.meta, w = m.width, ht = m.height, z = h.filled, up = 0, edge = 0, inner = 0, oob = 0, maxAcc = 0;
    for (var r = 0; r < ht; r++) for (var c = 0; c < w; c++) {
      var i = r * w + c, d = h.dir[i]; if (h.acc[i] > maxAcc) maxAcc = h.acc[i];
      if (d < 0) { if (r === 0 || c === 0 || r === ht - 1 || c === w - 1) edge++; else inner++; continue; }
      var nr = r + Hydro.DR[d], nc = c + Hydro.DC[d];
      if (d > 7 || nr < 0 || nc < 0 || nr >= ht || nc >= w) { oob++; continue; }
      if (z[nr * w + nc] > z[i]) up++;
    }
    return { uphill: up, outOfBounds: oob, edgeOutlets: edge, innerSinks: inner, maxAcc: maxAcc };
  };
  App.updateCheck = function (log) {
    var d = App.data; if (!d || !App.hydroCheck) return;
    var dc = App.dataCheck, hc = App.hydroCheck, st = d.stats, rows = [], all = true;
    var add = function (k, ok, v) { if (ok === false) all = false; rows.push('<dt>' + k + '</dt><dd>' + (ok == null ? '' : tag(ok)) + ' ' + v + '</dd>'); };
    add('数据长度', dc.lenOk, fmt(d.z.length) + ' 格');
    add('0/NaN 格', dc.zeros === 0 && dc.nan === 0, dc.zeros + ' / ' + dc.nan);
    add('坡度均值', Math.abs(App.slopeMean - st.slope_mean_deg) <= 0.3, App.slopeMean.toFixed(2) + '° / 参考 ' + st.slope_mean_deg + '°');
    add('分箱最大差', App.histDelta <= 0.5, App.histDelta.toFixed(3) + ' pp');
    add('上坡/越界', hc.uphill === 0 && hc.outOfBounds === 0, hc.uphill + ' / ' + hc.outOfBounds);
    add('内部汇', hc.innerSinks === 0, hc.innerSinks + ' 个 <small>边界出口 ' + fmt(hc.edgeOutlets) + '</small>');
    if (App.res.profile) add('剖面抽查', App.res.profile.check === 10, App.res.profile.check + '/10 与原生值一致');
    if (App.res.viewshed) add('视域', App.T.viewshed <= 300, App.T.viewshed + ' ms <small>门槛 300</small>');
    add('性能', null, '水文 ' + App.T.hydro + ' · 坡度 ' + App.T.slope + ' · 地貌 ' + App.T.landform + ' ms');
    $('#check').innerHTML = rows.join('');
    var chip = $('#chipCheck'); chip.className = 'chip ' + (all ? 'ok' : 'bad'); chip.querySelector('span').textContent = all ? '自检全部通过' : '自检有未通过项';
    if (log) { console.log('[自检] ' + App.aoi + ' ' + (all ? 'ALL PASS' : 'FAIL'), JSON.stringify({ slope: App.slopeMean, delta: App.histDelta, hydro: hc })); toast(all ? '自检全部通过' : '自检有未通过项'); }
    App.allPass = all;
  };

  /* ================= 三维 ================= */
  App.switchView = function (v) {
    App.view = v;
    $$('.tab').forEach(function (b) { var on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    $('#view3d').classList.toggle('show', v === '3d');
    if (v !== '3d') return;
    if (!window.Render3D) { $('#ph3d').style.display = 'flex'; return; }
    if (App._mounted3d !== App.aoi) App.mount3D(); else Render3D.setVE(+$('#ve3d').value);
    if ($('#drapeSel').value) App.applyDrape();
  };
  App.mount3D = function () {
    if (!window.Render3D || !App.data) return;
    try {
      Render3D.mount3D($('#mount3d'), { z: App.data.z, meta: App.data.meta, ve: +$('#ve3d').value || 2, background: '#0b0f14', onPick: App.pick3D });
      App._mounted3d = App.aoi; $('#ph3d').style.display = 'none';
      if ($('#drapeSel').value) App.applyDrape();
      if (App.res.basin) Render3D.setOverlay(App.res.basin.ws.mask, { name: 'watershed', color: UI.basin, alpha: 0.45, thicken: 0 });
    } catch (e) { $('#ph3d').textContent = '三维挂载失败：' + e.message; $('#ph3d').style.display = 'flex'; console.error(e); }
  };
  App.applyDrape = function () {
    if (!window.Render3D || !App._mounted3d) return;
    if (!$('#drapeSel').value) { Render3D.setDrape(null); return; }
    App._drapeCv = App.map.composite(App._drapeCv);
    Render3D.setDrape(App._drapeCv, { lit: App.map.layer !== 'hillshade' });
  };
  App.pick3D = function (r) { if (r && App.hydro) { App.doBasin(r.ix, r.iy); } };
  App.toggleSpin = function () { if (!window.Render3D) return; var on = Render3D.spin(); $('#btnSpin').classList.toggle('on', !!on); };
  App.river3d = function (on) {
    if (!on) { Render3D.clearOverlay('river'); return; }
    Render3D.setOverlay(App.rivers.mask, { name: 'river', color: UI.river[3], thicken: 1 });
  };
  App.toggleRiver3d = function () { if (!window.Render3D || !App.rivers) return; var b = $('#btnRiver3d'), on = !b.classList.contains('on'); b.classList.toggle('on', on); App.river3d(on); };

  /* ================= 导出 ================= */
  function download(url, name) { var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function wrap(g, text, x, y, maxW, lh) { var line = ''; for (var i = 0; i < text.length; i++) { var t = line + text[i]; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y); y += lh; line = text[i]; } else line = t; } g.fillText(line, x, y); return y + lh; }

  App.exportMap = function () {
    if (!App.data) return;
    var M = App.map, m = App.data.meta, w = m.width, h = m.height, k = Math.min(1, 1500 / w), mw = Math.round(w * k), mh = Math.round(h * k);
    var pad = 48, top = 104, side = 360, W = pad + mw + pad + side + pad, H = Math.max(top + mh + 70, 900);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H; var g = cv.getContext('2d');
    g.fillStyle = '#f6f4ef'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#16202a'; g.font = '700 30px system-ui, "Microsoft YaHei", sans-serif'; g.fillText('地形解剖师 · ' + m.name, pad, 52);
    g.fillStyle = '#5b6672'; g.font = '16px system-ui, "Microsoft YaHei", sans-serif';
    g.fillText(LAYER_NAME[M.layer] + '图 · ' + m.width + '×' + m.height + ' 分析栅格 · ' + new Date().toLocaleString('zh-CN'), pad, 80);
    var mx = pad, my = top;
    g.save(); g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 14; g.fillRect(mx, my, mw, mh); g.restore();
    g.imageSmoothingEnabled = true; g.drawImage(M.base, mx, my, mw, mh); g.drawImage(M.overlay, mx, my, mw, mh);
    M.drawVectors(g, k, mx, my, W, H, { graticule: true, lineScale: 1.3 });
    g.strokeStyle = '#16202a'; g.lineWidth = 1.5; g.strokeRect(mx, my, mw, mh);
    // 右侧图廓
    var sx = mx + mw + pad, sy = my;
    g.fillStyle = '#16202a'; g.font = '700 17px system-ui, "Microsoft YaHei", sans-serif'; g.fillText('图例 · ' + LAYER_NAME[M.layer], sx, sy + 6); sy += 22;
    var gw = side - 10;
    if (M.layer === 'landform') {
      App.lf.classes.filter(function (c) { return c.cells; }).forEach(function (c) { g.fillStyle = PAL.LANDFORM_HEX[c.id - 1][2]; g.fillRect(sx, sy, 18, 14); g.fillStyle = '#16202a'; g.font = '14px system-ui, "Microsoft YaHei"'; g.fillText(c.name + '  ' + c.pct.toFixed(1) + '%', sx + 26, sy + 12); sy += 22; });
    } else {
      var stops = M.layer === 'slope' ? PAL.SLOPE_HEX.map(function (s) { return [s[0] / 60, s[1]]; }) : PAL.RAMP_HEX, lg = g.createLinearGradient(sx, 0, sx + gw, 0);
      if (M.layer === 'aspect') { for (var a = 0; a <= 8; a++) { var c = PAL.aspectColor((a % 8) * 45); lg.addColorStop(a / 8, 'rgb(' + c.map(Math.round).join(',') + ')'); } }
      else stops.forEach(function (s) { lg.addColorStop(s[0], s[1]); });
      g.fillStyle = lg; g.fillRect(sx, sy, gw, 16); g.strokeStyle = '#888'; g.strokeRect(sx, sy, gw, 16); sy += 32;
      g.fillStyle = '#3b4652'; g.font = '13px Consolas';
      var lab = M.layer === 'slope' ? ['0°', '30°', '≥60°'] : M.layer === 'aspect' ? ['北', '南', '北'] : [fmt(m.elev.min) + ' m', fmt((m.elev.min + m.elev.max) / 2), fmt(m.elev.max) + ' m'];
      g.fillText(lab[0], sx, sy - 4); g.fillText(lab[1], sx + gw / 2 - 16, sy - 4); g.fillText(lab[2], sx + gw - 54, sy - 4);
    }
    sy += 8; g.font = '13px system-ui, "Microsoft YaHei"';
    [[UI.river[3], '河网（Strahler 分级）'], [UI.water, '水面'], [UI.basin, '流域'], [UI.flow, '水流路径'], [UI.viewshed, '可见区']].forEach(function (r) { g.fillStyle = r[0]; g.fillRect(sx, sy, 24, 6); g.fillStyle = '#16202a'; g.fillText(r[1], sx + 32, sy + 7); sy += 20; });
    // 比例尺 + 指北针
    sy += 16; var mpp = m.dx_m / k, tgt = 220 * mpp, p10 = Math.pow(10, Math.floor(Math.log10(tgt))), nv = tgt / p10, val = (nv >= 5 ? 5 : nv >= 2 ? 2 : 1) * p10, bpx = val / mpp;
    for (var q = 0; q < 4; q++) { g.fillStyle = q % 2 ? '#f6f4ef' : '#16202a'; g.fillRect(sx + q * bpx / 4, sy, bpx / 4, 8); } g.strokeStyle = '#16202a'; g.strokeRect(sx, sy, bpx, 8);
    g.fillStyle = '#16202a'; g.font = '13px Consolas'; g.fillText('0', sx - 3, sy + 24); g.fillText((val >= 1000 ? val / 1000 + ' km' : val + ' m'), sx + bpx - 20, sy + 24);
    g.beginPath(); g.moveTo(sx + gw - 20, sy - 30); g.lineTo(sx + gw - 8, sy + 10); g.lineTo(sx + gw - 20, sy + 2); g.lineTo(sx + gw - 32, sy + 10); g.closePath(); g.fill();
    g.font = '700 14px sans-serif'; g.fillText('N', sx + gw - 25, sy + 28); sy += 52;
    // 分析结果
    var R = App.res, lines = [];
    if (R.basin) lines.push('流域：' + fmt(R.basin.ws.area_km2, 2) + ' km²，出口 ' + R.basin.o.join(',') + '，HI ' + R.basin.zs.hi.toFixed(3) + '，平均坡度 ' + R.basin.zs.slope_mean.toFixed(1) + '°');
    if (R.flow) lines.push('水流路径：' + fmt(R.flow.len, 2) + ' km，落差 ' + fmt(R.flow.drop, 0) + ' m');
    if (R.viewshed) lines.push('视域：可见 ' + fmt(R.viewshed.visible_km2, 2) + ' km²（' + R.viewshed.pct.toFixed(1) + '%），观察高 ' + R.viewshed.observer_h + ' m');
    if (R.profile) lines.push('剖面：' + fmt(R.profile.r.len_km, 2) + ' km，' + fmt(R.profile.lo, 0) + '–' + fmt(R.profile.hi, 0) + ' m，抽查 ' + R.profile.check + '/10 一致');
    lines.push('坡度均值 ' + App.slopeMean.toFixed(2) + '°（参考 ' + App.data.stats.slope_mean_deg + '°），逐箱最大差 ' + App.histDelta.toFixed(3) + ' pp');
    g.font = '700 15px system-ui, "Microsoft YaHei"'; g.fillText('分析摘要', sx, sy); sy += 22; g.font = '13px system-ui, "Microsoft YaHei"'; g.fillStyle = '#2b3540';
    lines.forEach(function (t) { sy = wrap(g, '· ' + t, sx, sy, gw, 19); });
    sy += 10; g.fillStyle = '#16202a'; g.font = '700 15px system-ui, "Microsoft YaHei"'; g.fillText('数据与方法', sx, sy); sy += 22; g.font = '12.5px system-ui, "Microsoft YaHei"'; g.fillStyle = '#4a5560';
    ['数据：' + m.source, '坐标系：' + m.crs + '，范围 ' + m.x0.toFixed(2) + '–' + (m.x0 + w * m.dx_deg).toFixed(2) + '°E，' + (m.y0 - h * m.dy_deg).toFixed(2) + '–' + m.y0.toFixed(2) + '°N',
      '坡度：Horn 3×3，纬度校正像元；填洼 Priority-Flood+ε；流向 D8；地貌：起伏度分级（李炳元等，2008）'].forEach(function (t) { sy = wrap(g, t, sx, sy, gw, 18); });
    g.fillStyle = '#8a929a'; g.font = '12px system-ui, "Microsoft YaHei"';
    g.fillText('示意图 · 未叠加行政区划，非标准地图 · 基于公开数据的演示性分析，不构成官方评价', pad, H - 24);
    download(cv.toDataURL('image/png'), '地形解剖_' + App.aoi + '_' + M.layer + '.png');
    toast('已导出出版级地图');
  };

  App.export3d = function () {
    if (!window.Render3D || !App._mounted3d) return;
    var img = new Image(), m = App.data.meta;
    img.onload = function () {
      var W = img.width, top = 70, cv = document.createElement('canvas'); cv.width = W; cv.height = img.height + top;
      var g = cv.getContext('2d'); g.fillStyle = '#0b0f14'; g.fillRect(0, 0, W, cv.height); g.drawImage(img, 0, top);
      g.fillStyle = '#e8eef3'; g.font = '700 26px system-ui, "Microsoft YaHei"'; g.fillText('地形解剖师 · 三维沙盘 · ' + m.name, 24, 40);
      g.fillStyle = '#8b98a5'; g.font = '14px system-ui, "Microsoft YaHei"'; g.fillText('垂直夸大 ×' + $('#ve3d').value + ' · 表面：' + ($('#drapeSel').value ? LAYER_NAME[App.map.layer] : '高程色带') + ' · ' + new Date().toLocaleString('zh-CN'), 24, 62);
      download(cv.toDataURL('image/png'), '三维沙盘_' + App.aoi + '.png');
    };
    img.src = Render3D.screenshot();
  };

  /* ================= 键盘 ================= */
  App.onKey = function (e) {
    var t = e.target; if (t && /INPUT|SELECT|TEXTAREA/.test(t.tagName)) return;
    var k = e.key;
    if (k === 'Escape') { $('#helpModal').hidden = true; App.setMode('query'); return; }
    if (k === '?') { $('#helpModal').hidden = false; return; }
    if (k === 't' || k === 'T') { App.switchView(App.view === '3d' ? '2d' : '3d'); return; }
    if (App.view === '3d' && window.Render3D) {
      var map3 = { ArrowLeft: [-10, 0, 1], ArrowRight: [10, 0, 1], ArrowUp: [0, 5, 1], ArrowDown: [0, -5, 1], '+': [0, 0, 0.85], '=': [0, 0, 0.85], '-': [0, 0, 1.18] };
      if (map3[k]) { e.preventDefault(); Render3D.nudge.apply(null, map3[k]); return; }
      if (k === ' ') { e.preventDefault(); App.toggleSpin(); return; }
      if (k === 'e' || k === 'E') App.export3d();
      return;
    }
    var layers = ['hillshade', 'elevation', 'slope', 'aspect', 'landform'];
    if (k >= '1' && k <= '5') { var b = $('#layers button[data-layer="' + layers[+k - 1] + '"]'); if (!b.disabled) App.setLayer(layers[+k - 1]); return; }
    var modes = { q: 'query', b: 'basin', p: 'profile', v: 'viewshed' }, lk = k.toLowerCase();
    if (modes[lk] && App.hydro) App.setMode(modes[lk]);
    else if (lk === 'c') App.clearResults();
    else if (lk === 'r') App.map.fit(true);
    else if (lk === 'g') { var gr = $('#tglGrid'); gr.checked = !gr.checked; App.map.setGraticule(gr.checked); }
    else if (lk === 'e') App.exportMap();
    else if (k === '+' || k === '=') App.map.zoomCenter(1.4);
    else if (k === '-') App.map.zoomCenter(1 / 1.4);
  };

  window.addEventListener('DOMContentLoaded', App.init);
})();
