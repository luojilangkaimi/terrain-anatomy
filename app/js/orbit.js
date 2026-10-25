// orbit.js —— 成员二 · 轻量轨道相机（不依赖 OrbitControls）
// 单独跑：被 render3d.js 调用，无需单独打开；在 view3d.html 里左键拖拽=转向/俯仰，右键拖拽=平移，滚轮=缩放。
// 冒烟：控制台执行 Orbit3D.create(camera, canvas, {radius: 10}).get() 应返回 {azimuth, elevation, radius}。
(function (global) {
  'use strict';
  var DEG = Math.PI / 180;

  function create(camera, dom, opt) {
    opt = opt || {};
    var st = {
      azimuth: opt.azimuth != null ? opt.azimuth : 200,   // 相机所在罗盘方位，度：0=北，90=东，顺时针
      elevation: opt.elevation != null ? opt.elevation : 40, // 俯仰角，度
      radius: opt.radius || 10,
      minR: opt.minRadius || 0.1,
      maxR: opt.maxRadius || 1e4,
      target: new THREE.Vector3(0, 0, 0)
    };
    var onChange = opt.onChange || function () {};
    var drag = null;

    function apply() {
      st.elevation = Math.max(3, Math.min(89.5, st.elevation));
      st.radius = Math.max(st.minR, Math.min(st.maxR, st.radius));
      var a = st.azimuth * DEG, e = st.elevation * DEG;
      // 世界坐标：x=东，y=上，-z=北
      camera.position.set(
        st.target.x + st.radius * Math.cos(e) * Math.sin(a),
        st.target.y + st.radius * Math.sin(e),
        st.target.z - st.radius * Math.cos(e) * Math.cos(a)
      );
      camera.lookAt(st.target);
      onChange(st);
    }

    function down(ev) {
      drag = { x: ev.clientX, y: ev.clientY, btn: ev.button };
      dom.setPointerCapture && dom.setPointerCapture(ev.pointerId);
    }
    function move(ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      drag.x = ev.clientX; drag.y = ev.clientY;
      if (drag.btn === 0 && !ev.shiftKey) {          // 左键：转
        st.azimuth -= dx * 0.4;
        st.elevation += dy * 0.3;
      } else {                                        // 右键 / Shift+左键：平移
        // 水平前向 f=(-sin a, cos a)，右向 r = f×up = (-fz, fx)；拖动时场景跟手
        var k = st.radius * 0.0015, a = st.azimuth * DEG;
        var fx = -Math.sin(a), fz = Math.cos(a), rx = -fz, rz = fx;
        st.target.x += (-rx * dx + fx * dy) * k;
        st.target.z += (-rz * dx + fz * dy) * k;
      }
      apply();
    }
    function up() { drag = null; }
    function wheel(ev) {
      ev.preventDefault();
      st.radius *= Math.pow(1.0015, ev.deltaY);
      apply();
    }
    function ctx(ev) { ev.preventDefault(); }

    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    dom.addEventListener('contextmenu', ctx);
    apply();

    return {
      get: function () { return { azimuth: st.azimuth, elevation: st.elevation, radius: st.radius }; },
      set: function (o) {
        if (o.azimuth != null) st.azimuth = o.azimuth;
        if (o.elevation != null) st.elevation = o.elevation;
        if (o.radius != null) st.radius = o.radius;
        if (o.resetTarget) st.target.set(0, 0, 0);
        apply();
      },
      rotate: function (dAz) { st.azimuth += dAz; apply(); },
      dispose: function () {
        dom.removeEventListener('pointerdown', down);
        dom.removeEventListener('pointermove', move);
        dom.removeEventListener('pointerup', up);
        dom.removeEventListener('pointercancel', up);
        dom.removeEventListener('wheel', wheel);
        dom.removeEventListener('contextmenu', ctx);
      }
    };
  }

  global.Orbit3D = { create: create };
})(window);
