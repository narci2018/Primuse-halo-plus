'use strict';
const asar = require('@electron/asar');
const path = require('path');

const archive = path.join(__dirname, '../dist/win-unpacked/resources/app.asar');
const list = asar.listPackage(archive).map((p) => p.split(path.sep).join('/'));

const required = [
  '/package.json',
  '/src/main/main.js',
  '/src/main/aggregated.js',
  '/src/main/daoliyu.js',
  '/src/main/proxy.js',
  '/src/main/store.js',
  '/src/main/sync.js',
  '/src/main/httpx.js',
  '/src/preload.js',
  '/src/renderer/index.html',
  '/src/renderer/app.js',
  '/src/renderer/styles.css',
  '/src/renderer/icon.png',
];

for (const file of required) console.log(`${list.includes(file) ? 'OK  ' : 'MISS'} ${file}`);

const haloAssets = ['/major.js', '/index.html', '/styles.css', '/admin/index.html', '/functions/'];
const leaked = haloAssets.filter((a) => list.includes(a) || list.some((p) => p.startsWith(`${a}/`)));
console.log(`包内条目 ${list.length}；HALO 网页资产泄漏: ${leaked.length ? leaked.join(', ') : '无'}`);
console.log(list.includes('/major.js') || list.some((p) => p.startsWith('/admin/')) ? 'FAIL 混入了 HALO 网页' : 'PASS 只有 Primuse 自己的文件');
process.exit(required.every((f) => list.includes(f)) && !leaked.length ? 0 : 1);
