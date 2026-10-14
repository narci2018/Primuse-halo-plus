#!/usr/bin/env node
/*
 * Free-Narci 桌面图标生成器（dev-only，产物入库，CI 不需要跑它）
 *
 * 为什么要有这个脚本：Windows 任务栏上那坨"白色图片"不是图标没设置，而是素材本身
 * 用错了来源 —— `build/icon.png` 直接拿的是 iPhone 的主图标
 * `primuse/IconDesign/AppIcons2026/00-folded-note.png`，而那份 README 写得很清楚：
 * "iOS masters are 1024×1024 **full-bleed RGB** PNGs with no baked platform corner mask"
 * —— iOS 图标必须是**不透明**的（系统自己加圆角、主屏壁纸会跟着染色）。
 * 把一张白底不透明的图放到深色任务栏上，就是一块白板，16px 下音符根本看不见。
 *
 * 桌面图标要的恰恰相反：**圆角外必须透明**，主体高对比、粗笔画。
 * 所以这里做三件事：
 *   1. 中心裁切 78% —— 同时去掉 AI 生成图右下角的水印和它自带的白底圆角；
 *   2. 自己按 SDF 画圆角 alpha（1px 抗锯齿），保证四角真透明、不留白边；
 *   3. 出 `icon.png`（1024，给 BrowserWindow / 托盘）+ `icon.ico`
 *      （16/20/24/32/40/48 用 32bpp DIB，64/128/256 用 PNG —— 小尺寸用 DIB 是最稳的，
 *       老 shell 扩展对 PNG 压缩的小 ICO 条目支持不一致）。
 *
 * 用法：node scripts/make-icon.js [master.png]
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BUILD = path.join(__dirname, '..', 'build');
const MASTER = path.resolve(process.argv[2] || path.join(BUILD, 'icon-master.png'));
const CROP_RATIO = 0.78; // 中心裁切比例：既要甩掉水印，也不能切到 F 主体
const RADIUS_RATIO = 0.215; // 圆角半径 / 边长，接近 Win11 的 squircle 观感
const DIB_SIZES = [16, 20, 24, 32, 40, 48]; // 32bpp BMP 条目（兼容性最好）
const PNG_SIZES = [64, 128, 256]; // PNG 条目（体积小到可以忽略，Vista+ 原生支持）

/* 圆角矩形 alpha：d<0 在内部，d>0 在外部；用 1px 线性过渡做抗锯齿。 */
function roundedAlpha(x, y, size, r) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - r);
  const dy = Math.abs(y - half) - (half - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  const d = outside + inside - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}

/* 给一张 RGBA 原始像素按 SDF 乘上 alpha，返回新的 Buffer。 */
function applyRoundedMask(raw, size) {
  const out = Buffer.from(raw);
  const r = size * RADIUS_RATIO;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const a = roundedAlpha(x + 0.5, y + 0.5, size, r);
      out[i + 3] = Math.round(out[i + 3] * a);
    }
  }
  return out;
}

/* ICO 里的单条 DIB：BITMAPINFOHEADER(biHeight=2*size) + BGRA 自下而上 + 1bpp AND 掩码。 */
function dibEntry(pixels, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 颜色 + 掩码两倍高，这是 ICO 内嵌 DIB 的约定
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  const bytes = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4; // 自下而上
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      // 预乘 alpha 在 32bpp 图标里不是必须的，这里按直通 RGBA→BGRA 写
      bytes[d] = pixels[s + 2];
      bytes[d + 1] = pixels[s + 1];
      bytes[d + 2] = pixels[s];
      bytes[d + 3] = pixels[s + 3];
    }
  }
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size); // 全 0 = 不使用掩码，走 alpha
  return Buffer.concat([header, bytes, mask]);
}

function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 1 = icon
  head.writeUInt16LE(entries.length, 4);
  const SIZE_OF_DIR = 16;
  let offset = head.length + entries.length * SIZE_OF_DIR;
  const dirs = [];
  entries.forEach(({ data, size }) => {
    const dir = Buffer.alloc(SIZE_OF_DIR);
    dir.writeUInt8(size >= 256 ? 0 : size, 0);
    dir.writeUInt8(size >= 256 ? 0 : size, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(size <= 48 ? 32 : 32, 6); // DIB 是 32bpp；PNG 条目这个字段同样写 32
    dir.writeUInt32LE(data.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += data.length;
    dirs.push(dir);
  });
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e.data)]);
}

/* 小尺寸专用处理：16/20/24 上那截紫（F 的下半）对深蓝底几乎没对比，缩到 16px 就糊成
 * 一坨。这里提亮 + 加饱和 + 轻微锐化，只作用于会进任务栏/标题栏的那几帧。 */
function frameFor(cropped, size) {
  const base = cropped.clone().resize(size, size, { fit: 'cover' }).ensureAlpha();
  if (size > 24) return base;
  return base.modulate({ brightness: 1.12, saturation: 1.35 }).sharpen({ sigma: 0.45 });
}

async function main() {
  const info = await sharp(MASTER).metadata();
  const side = Math.round(Math.min(info.width, info.height) * CROP_RATIO);
  const left = Math.round((info.width - side) / 2);
  const top = Math.round((info.height - side) / 2);
  const cropped = sharp(MASTER).extract({ left, top, width: side, height: side });
  console.log(`母图 ${info.width}x${info.height} → 中心裁切 ${side}x${side} @(${left},${top})`);

  // 1) 1024 的 PNG：给 BrowserWindow / 托盘 / 关于页用
  const masterSize = 1024;
  const masterRaw = await frameFor(cropped, masterSize)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const masterMasked = applyRoundedMask(masterRaw.data, masterSize);
  const masterPng = await sharp(masterMasked, { raw: { width: masterSize, height: masterSize, channels: 4 } })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(BUILD, 'icon.png'), masterPng);

  // 1b) 运行时要能读到的那份：`files` 只打包 `src/**/*` 和 package.json，
  //     build/ 进不了 asar —— BrowserWindow / Tray 指向 build/icon.png 的话，
  //     装好的 App 里那个路径根本不存在，托盘会退化成一张空图（看不见图标）。
  //     所以额外落一份到 src/renderer/icon.png，跟界面资源一起进包。
  const runtimeSize = 256;
  const runtimeRaw = await frameFor(cropped, runtimeSize).raw().toBuffer({ resolveWithObject: true });
  const runtimePng = await sharp(applyRoundedMask(runtimeRaw.data, runtimeSize), {
    raw: { width: runtimeSize, height: runtimeSize, channels: 4 },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'icon.png'), runtimePng);

  // 2) ICO：小尺寸 DIB + 大尺寸 PNG
  const entries = [];
  for (const size of DIB_SIZES) {
    const raw = await frameFor(cropped, size)
      .raw()
      .toBuffer({ resolveWithObject: true });
    entries.push({ size, data: dibEntry(applyRoundedMask(raw.data, size), size) });
  }
  for (const size of PNG_SIZES) {
    const raw = await frameFor(cropped, size)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const png = await sharp(applyRoundedMask(raw.data, size), {
      raw: { width: size, height: size, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    entries.push({ size, data: png });
  }
  const out = ico(entries);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), out);
  console.log(
    `icon.ico：${entries.length} 帧（${entries.map((e) => e.size).join('/')}）· ${(out.length / 1024).toFixed(0)} KB · ` +
      `icon.png ${(masterPng.length / 1024).toFixed(0)} KB`
  );

  // 3) 验收图：深色 / 浅色任务栏各排一行，肉眼看过才算数（"断言全绿而屏幕一坨"的教训）
  const ordered = [...entries].sort((a, b) => a.size - b.size);
  const row = async (background) => {
    const height = 300;
    let x = 24;
    const parts = [];
    for (const e of ordered) {
      parts.push({
        input: e.size <= 48 ? await rawDibToPng(e.data, e.size) : e.data,
        left: x,
        top: Math.round((height - e.size) / 2),
      });
      x += e.size + 26;
    }
    return sharp({ create: { width: x + 24, height, channels: 4, background } })
      .composite(parts)
      .png()
      .toBuffer();
  };
  fs.writeFileSync(path.join(BUILD, 'icon-preview-dark.png'), await row('#1b1b1f'));
  fs.writeFileSync(path.join(BUILD, 'icon-preview-light.png'), await row('#e9e9ee'));

  // 4) 小尺寸放大 6 倍（最近邻，不插值）——用的必须是 ICO 里**真正那一帧**，
  //    不是"从 1024 再缩一次"的近似，否则验收的是另一张图。
  const small = ordered.filter((e) => e.size <= 48);
  const magnified = async (background, file) => {
    let x = 16;
    const parts = [];
    for (const e of small) {
      const one = e.size <= 48 ? await rawDibToPng(e.data, e.size) : e.data;
      const big = await sharp(one).resize(e.size * 6, e.size * 6, { kernel: sharp.kernel.nearest }).png().toBuffer();
      parts.push({ input: big, left: x, top: 16 });
      x += e.size * 6 + 20;
    }
    const img = await sharp({ create: { width: x + 16, height: 320, channels: 4, background } })
      .composite(parts)
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(BUILD, file), img);
  };
  await magnified('#1b1b1f', 'icon-preview-small6x.png');
  await magnified('#f2f2f7', 'icon-preview-small6x-light.png');
  console.log(
    `预览图：build/icon-preview-dark.png / icon-preview-light.png（${ordered.map((e) => e.size).join(' · ')} px）`
  );
}

/* DIB 条目还原成 PNG，只为生成预览图。 */
async function rawDibToPng(dib, size) {
  const px = Buffer.alloc(size * size * 4);
  const body = dib.subarray(40, 40 + size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4;
      px[d] = body[s + 2];
      px[d + 1] = body[s + 1];
      px[d + 2] = body[s];
      px[d + 3] = body[s + 3];
    }
  }
  return sharp(px, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
