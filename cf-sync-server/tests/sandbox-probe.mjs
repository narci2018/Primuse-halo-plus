// 沙箱可行性探针（纯本地 Node，不碰 Cloudflare）。
//
// 目的：只回答一个问题 —— buildSandboxModule() 生成的模块，能不能真的执行洛雪音源并拿到直链。
// 具体验证三件事：
//  1. 模块顶层 `const globalThis = {...}` 遮蔽真实全局在 V8 里是否成立；
//  2. 用户脚本的 `const { EVENT_NAMES, on, send } = globalThis.lx` 是否拿到我们的沙箱；
//  3. on(request) 注册的处理器被 __request('musicUrl') 调用后，返回的是不是 http 直链。

import { buildSandboxModule } from "../functions/lib/lx.js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.resolve(here, "../../音源文件/忆音音源_v1.js");
const script = readFileSync(file, "utf8");
const sandbox = buildSandboxModule(script);
const outPath = path.join(here, ".sandbox-probe.mjs");
writeFileSync(outPath, sandbox);

const mod = await import(`${pathToFileURL(outPath).href}?v=${Date.now()}`);
console.log("module keys:", Object.keys(mod));
console.log("registry.inited:", JSON.stringify(mod.__registry.inited));

const platform = process.argv[3] || "netease";
const rawID = process.argv[4] || "3440441479";
const lxKey = { qq: "tx", netease: "wy", kugou: "kg", kuwo: "kw" }[platform] || "wy";
try {
  const url = await mod.__request("musicUrl", {
    source: lxKey,
    info: { musicInfo: { id: rawID, songmid: rawID, mid: rawID, hash: rawID }, type: "quality", quality: "320k" },
  });
  console.log("RESULT url:", String(url).slice(0, 160));
} catch (e) {
  console.log("RESULT error:", String(e && e.message ? e.message : e).slice(0, 300));
}
