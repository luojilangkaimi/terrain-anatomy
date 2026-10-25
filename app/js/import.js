/* 导入入口：仅路线图展示，不做实际文件解析
   真正的 GeoTIFF 直读在路线图上，这里只负责把方向讲清楚。 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var modal = $('#importModal'), btn = $('#btnImport'), closeBtn = $('#closeImport');
  if (!modal || !btn) return;

  function open() { modal.hidden = false; if (closeBtn) closeBtn.focus(); }
  function close() { modal.hidden = true; }

  btn.addEventListener('click', function (e) { e.preventDefault(); open(); });
  if (closeBtn) closeBtn.addEventListener('click', close);
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) { e.stopPropagation(); close(); }
  }, true);

  window.ImportUI = { open: open, close: close };
})();
