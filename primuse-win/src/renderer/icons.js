'use strict';
/*
 * SF Symbols → 内联 SVG。
 * iPhone 版满屏都是 systemImage（house.fill / books.vertical / play.circle.fill / repeat.1 …），
 * Windows 没有 SF，用 Segoe 字形又依赖具体字体版本，所以这里自己画：24×24 viewBox、
 * currentColor 描边或填充，形状尽量贴近原符号，尺寸与 weight 交给 CSS。
 * key 名沿用 SF 的命名，方便和 Swift 源码对照 —— 看到 `icon('play.circle.fill')` 就能想起出处。
 */

const ICONS = {
  'house.fill': '<path d="M12 3.1 3.3 10.2v10.5h6.2v-6h5v6h6.2V10.2Z"/>',
  'books.vertical':
    '<path d="M3.6 4.8h3.1v14.4H3.6zM9.1 4.8h3.1v14.4H9.1z"/><path d="m15.1 5.6 3-.8 3.3 13.9-3 .8z"/>',
  magnifyingglass:
    '<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.6 15.6 4.9 4.9"/></g>',
  gearshape:
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="3.3"/><circle cx="12" cy="12" r="8.4" stroke-dasharray="2.6 3.1"/></g>',
  'play.fill': '<path d="M7.6 4.7 19.2 12 7.6 19.3Z"/>',
  'pause.fill': '<path d="M6.9 5.1h3.5v13.8H6.9zM13.6 5.1h3.5v13.8h-3.5z"/>',
  'stop.fill': '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2"/>',
  'play.circle.fill': '<circle cx="12" cy="12" r="9.6"/><path d="M10.1 7.9 16.6 12l-6.5 4.1Z" fill="var(--on-accent,#fff)"/>',
  'pause.circle.fill':
    '<circle cx="12" cy="12" r="9.6"/><path d="M9.1 8.3h2v7.4h-2zM13.1 8.3h2v7.4h-2z" fill="var(--on-accent,#fff)"/>',
  'backward.fill': '<path d="M5.4 5.6h2.3v12.8H5.4zM19.4 5.6 9.6 12l9.8 6.4Z"/>',
  'forward.fill': '<path d="M16.3 5.6h2.3v12.8h-2.3zM4.6 5.6 14.4 12 4.6 18.4Z"/>',
  shuffle:
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 6.8h3.3l3.4 4.9 3.4 4.9h3.9"/><path d="M3.4 16.6h3.3l3.4-4.9 3.4-4.9h3.9"/><path d="M17.4 4.3v3.2h-3.2M17.4 19.7v-3.2h-3.2"/></g>',
  repeat:
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 10h10.2a3.2 3.2 0 0 1 3.2 3.2"/><path d="M7.6 7.5 5 10l2.6 2.5"/><path d="M18.8 14.4H8.6a3.2 3.2 0 0 1-3.2-3.2"/><path d="M16.4 11.9 19 14.4l-2.6 2.5"/></g>',
  'repeat.1':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 10h10.2a3.2 3.2 0 0 1 3.2 3.2"/><path d="M7.6 7.5 5 10l2.6 2.5"/><path d="M18.8 14.4H8.6a3.2 3.2 0 0 1-3.2-3.2"/><path d="M16.4 11.9 19 14.4l-2.6 2.5"/></g><text x="12" y="17.4" font-size="7.4" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none">1</text>',
  heart:
    '<path d="M12 20.3 4.4 12.7a4.4 4.4 0 0 1 6.2-6.2l1.4 1.3 1.4-1.3a4.4 4.4 0 1 1 6.2 6.2Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
  'heart.fill': '<path d="M12 20.3 4.4 12.7a4.4 4.4 0 0 1 6.2-6.2l1.4 1.3 1.4-1.3a4.4 4.4 0 1 1 6.2 6.2Z"/>',
  ellipsis:
    '<g><circle cx="5.6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.4" cy="12" r="1.7"/></g>',
  'list.bullet':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M8.6 6.6h11M8.6 12h11M8.6 17.4h11"/><path d="M4.4 6.6h.02M4.4 12h.02M4.4 17.4h.02" stroke-width="2.6"/></g>',
  'quote.bubble':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M4 5.4h16v10.9H9.8L5.2 19.6v-3.3H4z"/><path d="M8 9.6h7M8 12.4h4.4" stroke-linecap="round"/></g>',
  'speaker.wave.2.fill':
    '<path d="M4 9.4h2.8L11 5.6v12.8L6.8 14.6H4zM14 9a4.2 4.2 0 0 1 0 6M17 6.6a7.6 7.6 0 0 1 0 10.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M4 9.4h2.8L11 5.6v12.8L6.8 14.6H4z"/>',
  'speaker.fill': '<path d="M5 9.4h2.8L12 5.6v12.8L7.8 14.6H5z"/><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M15.4 10.4a3 3 0 0 1 0 3.2"/></g>',
  'chevron.right': '<path d="M9.2 5.4 16 12l-6.8 6.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  'chevron.left': '<path d="M14.8 5.4 8 12l6.8 6.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  'chevron.down': '<path d="M5.4 9.2 12 16l6.6-6.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  plus: '<path d="M12 5.2v13.6M5.2 12h13.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  'plus.circle.fill':
    '<circle cx="12" cy="12" r="9.6"/><path d="M12 7.6v8.8M7.6 12h8.8" fill="none" stroke="var(--on-accent,#fff)" stroke-width="2.1" stroke-linecap="round"/>',
  checkmark:
    '<path d="m5 12.6 4.6 4.6L19 7.6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  xmark: '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  folder: '<path d="M3.4 6.6h6l1.8 2h9.4v10.4H3.4z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
  'folder.fill': '<path d="M3.4 6.6h6l1.8 2h9.4v10.4H3.4z"/>',
  clock:
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.4 2.2"/></g>',
  'music.note': '<path d="M9.4 18.6a3 3 0 1 1-3-3 3 3 0 0 1 1.6.4V6.2l9-1.8v9.4a3 3 0 1 1-3-3c.5 0 1 .1 1.4.3V7.4l-6 1.2Z"/>',
  'music.note.list':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M10 7.4h10M10 12h10M10 16.6h6"/><path d="M6.6 17.4V7.6l3.4-.8"/></g><circle cx="5.4" cy="17.8" r="2.1"/>',
  'text.badge.plus':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.4 6.4h11M4.4 10.4h11M4.4 14.4h6.4"/><circle cx="17.6" cy="16.4" r="3.6"/><path d="M17.6 14.8v3.2M16 16.4h3.2"/></g>',
  'text.line.last.and.arrowtriangle.forward':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 6.6h11M4.4 11h7"/><path d="M4.4 17.4h9.4"/><path d="m17 13.6 3.4 3.8-3.4 3.8"/></g>',
  'text.line.first.and.arrowtriangle.forward':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 17.4h11M4.4 13h7"/><path d="M4.4 6.6h9.4"/><path d="m17 2.8 3.4 3.8L17 10.4"/></g>',
  'tray.and.arrow.down':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6v9.2M8.4 9.2 12 12.8l3.6-3.6"/><path d="M4 15.4v4.2h16v-4.2"/></g>',
  'plus.rectangle.on.folder':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.6 6.4h5.6l1.6 2h9.6v10.4H3.6z"/><path d="M12.6 12.6v4.4M10.4 14.8h4.4" stroke-linecap="round"/></g>',
  'square.and.arrow.up':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.4V3.8M8.4 7.2 12 3.6l3.6 3.6"/><path d="M5 12.4v7.2h14v-7.2"/></g>',
  trash:
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 6.8h14.8M9.4 6.8V4.6h5.2v2.2"/><path d="M6.6 6.8 7.6 20h8.8l1-13.2M10.4 10.4v6M13.6 10.4v6"/></g>',
  info: { circle: '' },
  'info.circle':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 10.8v5M12 7.9h.02" stroke-width="2.1"/></g>',
  tag: '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M11 4.4 4.4 11a2 2 0 0 0 0 2.8l5.8 5.8a2 2 0 0 0 2.8 0l6.6-6.6V4.4z"/><circle cx="8.4" cy="8.4" r="1.3"/></g>',
  sparkles:
    '<path d="M12 3.4 13.6 8 18 9.6 13.6 11.2 12 15.8 10.4 11.2 6 9.6l4.4-1.6zM5.4 15 6.2 17.4 8.6 18.2 6.2 19 5.4 21.4 4.6 19 2.2 18.2 4.6 17.4zM18 14.2l.6 2 2 .6-2 .6-.6 2-.6-2-2-.6 2-.6z"/>',
  'wand.and.stars':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m5 19 9.6-9.6"/><path d="M13 4.4 14 7l2.6 1-2.6 1-1 2.6-1-2.6L9.4 8 12 7z"/><path d="M18.6 12.4 19.2 14l1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/></g>',
  'arrow.clockwise':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M19.4 12a7.4 7.4 0 1 1-2.2-5.2"/><path d="M19.4 4.6v4.2h-4.2"/></g>',
  'arrow.up.arrow.down':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m6.4 9.4 2.6-2.8 2.6 2.8M9 6.6v11"/><path d="m12.4 14.6 2.6 2.8 2.6-2.8M15 17.4v-11"/></g>',
  'line.3.horizontal.decrease.circle':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.6"/><path d="M8.2 9.2h7.6M9.6 12h4.8M11 14.8h2"/></g>',
  'play.rectangle':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.2"/><path d="M10.6 9.4 14.6 12l-4 2.6Z" fill="currentColor" stroke="none"/></g>',
  'viewfinder.rectangular':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 8V4.6H8M16 4.6h4.4V8M20.4 16v3.4H16M8 19.4H3.6V16"/><path d="M8.4 12h7.2"/></g>',
  wifi:
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M2.6 8.6a13 13 0 0 1 18.8 0M6 12a8.4 8.4 0 0 1 12 0M9.4 15.4a3.8 3.8 0 0 1 5.2 0"/><path d="M12 18.8h.02" stroke-width="2.4"/></g>',
  globe:
    '<g fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2M12 3.4a12 12 0 0 1 0 17.2 12 12 0 0 1 0-17.2Z"/></g>',
  'externaldrive':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="9" width="18" height="9" rx="2.2"/><path d="M6.4 12.4h.02M9.6 12.4h.02" stroke-width="2.2" stroke-linecap="round"/></g>',
  'network.browser':
    '<g fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.2" y="4.6" width="17.6" height="11" rx="2"/><path d="M8 19.4h8" stroke-linecap="round"/><path d="M12 15.6v3.8"/></g>',
  'moon.zzz':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.4 4.6a7.4 7.4 0 1 0 4.2 11.2A7.6 7.6 0 0 1 13.4 4.6Z"/><path d="M17 3.6h3.4l-3.4 3.6h3.4"/></g>',
  speedometer:
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 16.6a9 9 0 1 1 16 0"/><path d="M12 16.6 15.6 9"/></g>',
  'pencil.circle':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="m9 15 .8-2.6 4.4-4.4 1.8 1.8-4.4 4.4z" stroke-linecap="round"/></g>',
  'square.stack':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="7" y="7" width="12" height="12" rx="2"/><path d="M11 4.4h8a2 2 0 0 1 2 2v6"/></g>',
  'person.2':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="9.4" cy="8.6" r="3.4"/><path d="M3.6 19.4a5.8 5.8 0 0 1 11.6 0"/><path d="M16.2 5.6a3.2 3.2 0 0 1 0 6M17.6 19.4a5.6 5.6 0 0 0-2-4"/></g>',
  'chart.bar':
    '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 19V11M11 19V5M17 19v-6"/></g>',
  'checkmark.circle':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="m8.4 12.2 2.6 2.6 4.6-5.4"/></g>',
  // 批量选择态（SongBatchActionBar / 行左侧圆圈勾）—— fill 版才有"已选中"的分量
  'checkmark.circle.fill':
    '<g><circle cx="12" cy="12" r="9.2" fill="currentColor"/><path d="m8.2 12.2 2.7 2.7 4.9-5.7" fill="none" stroke="var(--bg-2, #fff)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>',
  // 关于页「构建」（SettingsView 用的是 hammer 符号）
  hammer:
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.6 3.6 21 10l-2.6 2.6-1.8-1.8-6.4 6.4 1.8 1.8L7.6 22 3 17.4l3.4-3.4 1.8 1.8 6.4-6.4-1.8-1.8z"/><path d="m11.4 8.2 4.4 4.4"/></g>',
  'exclamationmark.triangle':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.2 21 19.4H3Z"/><path d="M12 9.6v4.2M12 16.6h.02"/></g>',
  // 下面几个是"云端音乐源"这几屏新用的：清单/首页文案/可用性三态都要有各自的形状，
  // 少了任何一个，icon() 会静默回落到 music.note —— 音符图标表示"未检出"是看不懂的。
  cloud:
    '<path d="M7.2 18.6a4.1 4.1 0 0 1-.35-8.18 5.5 5.5 0 0 1 10.6-1.2 3.9 3.9 0 0 1 .55 7.76l-.28.06Z"/>',
  link:
    '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.2 13.8a4.3 4.3 0 0 1 0-6.1l2.1-2.1a4.3 4.3 0 0 1 6.1 6.1l-1.2 1.2"/><path d="M13.8 10.2a4.3 4.3 0 0 1 0 6.1l-2.1 2.1a4.3 4.3 0 0 1-6.1-6.1l1.2-1.2"/></g>',
  'play.circle':
    '<g fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="8.4"/><path d="M10.2 8.6 15.9 12l-5.7 3.4Z" fill="currentColor" stroke="none"/></g>',
  'questionmark.circle':
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"/><path d="M9.9 9.6a2.2 2.2 0 1 1 3.5 1.9c-.9.7-1.4 1.2-1.4 2.3"/><path d="M12 16.6h.02"/></g>',
  textformat:
    '<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4.6 6.4h10.2M9.7 6.4v11.2"/><path d="M17.4 11.2h4.2M19.5 11.2v6.4"/></g>',
  // 需求 8「任务栏歌词」设置项：一条横胶囊里放一行字，故意做成"扁条"而不是气泡
  //（气泡已经被 quote.bubble 占了，两个开关挨在一起时必须一眼分得出谁是谁）。
  'captions.bubble':
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.6" y="8.6" width="18.8" height="6.8" rx="3.4"/><path d="M6.4 12h6.6" stroke-linecap="round" stroke-width="2"/><path d="M16.8 12h.02" stroke-linecap="round" stroke-width="2.6"/></g>',
};

function icon(name, cls) {
  const body = ICONS[name] || ICONS['music.note'];
  return `<svg class="ico-svg${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}
