'use strict';
/**
 * 渲染层里每一个 `api.x.y` 都必须真的被 preload 暴露出来。
 *
 * 为什么要单独一个脚本：preload 通过 contextBridge 挂到 window，属性名写错不会有
 * 任何编译期错误 —— 运行时才是一句 TypeError，而它发生在 async 事件回调里，Promise
 * 把它吞成一次未处理拒绝，界面只是"没反应"。这次"在加入歌单弹层里新建歌单并立即
 * 加入那首歌"就是这么坏的：app.js 调 `api.playlists.add(...)`，preload 里叫 `addSong`。
 * 冒烟点到它之前，19 项断言全绿。
 *
 * 离线、无网络、不依赖 Electron：把 preload.js 在 vm 里用假 electron 跑一遍，拿到
 * 真实暴露对象，再和 app.js 里出现过的调用链逐一比对。
 *
 * 用法：node scripts/preload-api-check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const noop = () => {};

function loadExposedApi() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  let exposed = null;
  const sandbox = {
    console,
    module: { exports: {} },
    exports: {},
    require(id) {
      if (id !== 'electron') throw new Error(`preload 只允许依赖 electron，出现了对 ${id} 的依赖`);
      return {
        contextBridge: { exposeInMainWorld: (_name, obj) => { exposed = obj; } },
        ipcRenderer: { invoke: noop, send: noop, on: noop, removeListener: noop },
      };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'src/preload.js' });
  if (!exposed) throw new Error('preload.js 没有调用 contextBridge.exposeInMainWorld');
  return exposed;
}

function collectRefs(file) {
  const src = fs.readFileSync(file, 'utf8');
  const refs = new Set();
  // `const api = window.primuse;` 之后的 api.<链>；只取标识符段，方法调用括号自然被排除。
  // 前面的 (?<!/) 之类靠捕获组实现：线路地址里的 ".../api.php" 不是调用，必须放过。
  for (const m of src.matchAll(/(^|[^/\w$.])api\.([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*)/g)) refs.add(m[2]);
  return [...refs].sort();
}

const api = loadExposedApi();
const files = fs.readdirSync(path.join(ROOT, 'src', 'renderer')).filter((f) => f.endsWith('.js'));
const missing = [];
let checked = 0;

for (const file of files) {
  for (const ref of collectRefs(path.join(ROOT, 'src', 'renderer', file))) {
    checked += 1;
    const segments = ref.split('.');
    let cursor = api;
    let ok = true;
    for (const seg of segments) {
      if (cursor === null || typeof cursor !== 'object' || !(seg in cursor)) {
        ok = false;
        break;
      }
      cursor = cursor[seg];
    }
    if (!ok) missing.push(`${file}: api.${ref}`);
  }
}

// 反向也看一眼：preload 暴露了但渲染层从没用过的，只提示不算失败（可能是主进程调试入口）
const unused = Object.keys(api).filter(
  (key) => typeof api[key] === 'object' && !files.some((f) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', f), 'utf8').includes(`api.${key}.`))
);

for (const line of missing) console.log(`  FAIL  ${line} —— preload 里没有这个入口`);
for (const key of unused) console.log(`  note  preload 的 ${key} 渲染层未使用`);
console.log(
  missing.length
    ? `[api-check] RESULT failed: ${missing.length}/${checked} 个调用链在 preload 里不存在`
    : `[api-check] RESULT ok: ${checked} 个 api.* 调用链全部能在 preload 里解析`
);
process.exit(missing.length ? 1 : 0);
