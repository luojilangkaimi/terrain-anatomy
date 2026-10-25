/* 成员一 · 共用色带。2D 与 3D 必须用同一套，不许各自配色。 */
(function () {
  'use strict';

  // 高程色带：深绿 → 黄绿 → 土黄 → 棕 → 灰白
  var RAMP_HEX = [
    [0.00, '#1d4a3a'],
    [0.28, '#4f7c3f'],
    [0.52, '#9aa04e'],
    [0.74, '#8c6239'],
    [1.00, '#e6e1d6']
  ];

  // 坡度色带（度）
  var SLOPE_HEX = [
    [0, '#2f7d3a'],
    [15, '#d8c95a'],
    [30, '#c46a2b'],
    [45, '#9c2f2a'],
    [60, '#5e1b1b']
  ];

  function hexToRgb(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  var RAMP_RGB = RAMP_HEX.map(function (s) { return [s[0], hexToRgb(s[1])]; });
  var SLOPE_RGB = SLOPE_HEX.map(function (s) { return [s[0], hexToRgb(s[1])]; });

  function interp(stops, t) {
    if (t <= stops[0][0]) return stops[0][1];
    if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
    for (var i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        var a = stops[i - 1], b = stops[i];
        var f = (t - a[0]) / (b[0] - a[0]);
        return [
          a[1][0] + (b[1][0] - a[1][0]) * f,
          a[1][1] + (b[1][1] - a[1][1]) * f,
          a[1][2] + (b[1][2] - a[1][2]) * f
        ];
      }
    }
    return stops[stops.length - 1][1];
  }

  // t: 0..1 归一化高程
  function rampColor(t) {
    return interp(RAMP_RGB, t < 0 ? 0 : t > 1 ? 1 : t);
  }

  // deg: 坡度（度）
  function slopeColor(deg) {
    return interp(SLOPE_RGB, deg);
  }

  // 坡向：8 方位 + 平坦
  function aspectColor(deg) {
    if (deg == null || isNaN(deg) || deg < 0) return [150, 150, 150];
    var hue = deg;                       // 0=N, 90=E, 180=S, 270=W
    var h = hue / 60, c = 0.55, x = c * (1 - Math.abs(h % 2 - 1)), m = 0.72 - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 1) { r = c; g = x; }
    else if (h < 2) { r = x; g = c; }
    else if (h < 3) { g = c; b = x; }
    else if (h < 4) { g = x; b = c; }
    else if (h < 5) { r = x; b = c; }
    else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  // 地貌分类（与 Terrain.LANDFORM 的 id 1..6 对应）：由绿到褐到雪白，起伏越大越深
  var LANDFORM_HEX = [
    [1, '平原', '#9cc58a'],
    [2, '丘陵', '#d5cf86'],
    [3, '小起伏山地', '#c79f63'],
    [4, '中起伏山地', '#9c6b43'],
    [5, '大起伏山地', '#6e4234'],
    [6, '极大起伏山地', '#e8e4dc']
  ];
  var LANDFORM_RGB = [null].concat(LANDFORM_HEX.map(function (s) { return hexToRgb(s[2]); }));
  function landformColor(id) { return LANDFORM_RGB[id] || [128, 128, 128]; }

  // 叠加层与矢量要素的统一用色（2D、3D、导出图共用）
  var UI = {
    river: ['#8fd8ff', '#6cc8fb', '#46b2f3', '#2b97e6', '#1f7fd6', '#1a6cc4', '#155cb0'],  // Strahler 1..7
    water: '#2f86d0', waterEdge: '#a6dcff',
    basin: '#ffb030', basinEdge: '#ffd65c',
    viewshed: '#ffe066', observer: '#ffffff',
    flow: '#ff5c8a', longest: '#27e1c1', steep: '#ff4d3d', profile: '#ffd166',
    peak: '#ffffff', grid: 'rgba(230,236,242,0.28)'
  };

  window.Palette = {
    RAMP_HEX: RAMP_HEX,
    SLOPE_HEX: SLOPE_HEX,
    LANDFORM_HEX: LANDFORM_HEX,
    UI: UI,
    hexToRgb: hexToRgb,
    rampColor: rampColor,
    slopeColor: slopeColor,
    aspectColor: aspectColor,
    landformColor: landformColor
  };
  // 同时挂全局，供 render3d.js 自动读取，保证 2D/3D 同一套色带
  window.RAMP_HEX = RAMP_HEX;
  window.rampColor = rampColor;
})();
