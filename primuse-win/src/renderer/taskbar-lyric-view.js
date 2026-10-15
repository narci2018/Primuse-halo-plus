/* 任务栏歌词条的视图脚本（被 taskbar-lyric.html 以外链方式引入 ——
   那条窗口和主窗口一样开着 CSP 的 script-src 'self'，内联脚本会被拦）。
   它只做两件事：把主进程推来的那句词写上屏、把用户的两次点击送回主进程。 */

(function () {
  'use strict';

  var lineEl = document.getElementById('line');
  var metaEl = document.getElementById('meta');
  var stripEl = document.getElementById('strip');
  var closeEl = document.getElementById('close');
  var bridge = window.lyricStrip || {};

  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  bridge.onSet &&
    bridge.onSet(function (payload) {
      var p = payload || {};
      var text = String(p.text || '').trim();
      // 没有当前句（纯音乐 / 还没到第一句）时给一句人话，而不是留一条空壳。
      setText(lineEl, text || (p.hasLyrics ? '（间奏）' : '这首歌没有歌词'));
      lineEl.classList.toggle('empty', !text);
      var meta = [p.title, p.artist].filter(Boolean).join(' · ');
      setText(metaEl, meta);
      metaEl.style.display = meta ? '' : 'none';
    });

  stripEl.addEventListener('click', function () {
    bridge.restore && bridge.restore();
  });

  closeEl.addEventListener('click', function (event) {
    event.stopPropagation(); // 别顺带把主窗口唤回来
    bridge.dismiss && bridge.dismiss();
  });
})();
