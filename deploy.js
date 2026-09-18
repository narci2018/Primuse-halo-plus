// Primuse 歌单同步服务 Cloudflare 一键部署脚本 (Node.js 原生版，跨平台防乱码)
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
};

function log(msg, color = "") {
  console.log(`${color}${msg}${colors.reset}`);
}

function run(command, cwd = __dirname, inherit = false) {
  try {
    if (inherit) {
      const res = spawnSync(command, { cwd, shell: true, stdio: "inherit" });
      return { status: res.status, output: "" };
    }
    const output = execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { status: 0, output: output.trim() };
  } catch (err) {
    return { status: err.status || 1, output: (err.stdout || "") + (err.stderr || "") };
  }
}

async function main() {
  log("\n==========================================================", colors.cyan);
  log("       Primuse 歌单同步服务 - Cloudflare 一键自动部署      ", colors.bold + colors.yellow);
  log("==========================================================\n", colors.cyan);

  const projectDir = path.join(__dirname, "cf-sync-server");
  if (!fs.existsSync(projectDir)) {
    log(`[X] 错误: 未找到 ${projectDir} 目录！`, colors.red);
    process.exit(1);
  }

  // 1. 检查 Cloudflare 登录状态
  log("[1/4] 检查 Cloudflare 账号登录状态...", colors.green);
  const whoami = run("npx --yes wrangler whoami");
  if (whoami.status !== 0 || !whoami.output.includes("You are logged in")) {
    log("  -> 未登录 Cloudflare 账号，正在拉起系统浏览器进行授权...", colors.yellow);
    log("  -> 请在弹出的浏览器页面中点击 'Allow' 允许授权...", colors.yellow);
    run("npx --yes wrangler login", __dirname, true);
    log("  -> 授权流程结束，继续部署...\n", colors.green);
  } else {
    log("  -> Cloudflare 账号已登录！\n", colors.green);
  }

  // 2. 准备 D1 数据库
  log("[2/4] 准备 Cloudflare D1 数据库 (primuse-sync-db)...", colors.green);
  const dbName = "primuse-sync-db";
  let dbId = "";

  const listRes = run("npx --yes wrangler d1 list --json");
  if (listRes.status === 0) {
    try {
      const list = JSON.parse(listRes.output);
      const found = list.find((db) => db.name === dbName);
      if (found) {
        dbId = found.uuid;
        log(`  -> 找到已有数据库 [${dbName}], ID: ${dbId}`, colors.green);
      }
    } catch {}
  }

  if (!dbId) {
    log(`  -> 正在创建 D1 数据库 [${dbName}]...`, colors.yellow);
    const createRes = run(`npx --yes wrangler d1 create ${dbName} --json`);
    if (createRes.status === 0) {
      try {
        const created = JSON.parse(createRes.output);
        dbId = created.uuid;
      } catch {}
    }
    if (!dbId) {
      const match = createRes.output.match(/database_id\s*=\s*"([a-f0-9\-]+)"/);
      if (match) dbId = match[1];
    }
    if (dbId) {
      log(`  -> 数据库创建成功！ID: ${dbId}`, colors.green);
    } else {
      log("  -> 提示: 将使用自动建表模式部署", colors.yellow);
    }
  }

  // 更新 wrangler.toml
  const wranglerTomlPath = path.join(projectDir, "wrangler.toml");
  if (fs.existsSync(wranglerTomlPath) && dbId) {
    let toml = fs.readFileSync(wranglerTomlPath, "utf-8");
    toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`);
    fs.writeFileSync(wranglerTomlPath, toml, "utf-8");
  }

  // 3. 执行 SQL 初始化
  log("\n[3/4] 初始化数据表结构 (device_playlists)...", colors.green);
  const schemaPath = path.join(projectDir, "schema.sql");
  if (fs.existsSync(schemaPath) && dbId) {
    log("  -> 正在同步数据表...", colors.yellow);
    run(`npx --yes wrangler d1 execute ${dbName} --remote --file="${schemaPath}" -y`, projectDir, true);
    log("  -> 数据表初始化完成！\n", colors.green);
  } else {
    log("  -> 跳过手动建表，接口启动时将自动创建表结构。\n", colors.yellow);
  }

  // 4. 部署至 Cloudflare Pages
  log("[4/4] 正在发布部署至 Cloudflare Pages...", colors.green);
  const projectName = "primuse-sync-server";

  log("  -> 正在上传文件至 Cloudflare Pages...", colors.yellow);
  const deployRes = run(`npx --yes wrangler pages deploy public --project-name=${projectName} --commit-dirty=true`, projectDir);

  console.log(deployRes.output);

  let pagesUrl = "";
  const lines = deployRes.output.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/https:\/\/[a-zA-Z0-9\.\-]+\.pages\.dev/);
    if (match) {
      pagesUrl = match[0];
      break;
    }
  }

  if (!pagesUrl) {
    pagesUrl = `https://${projectName}.pages.dev`;
  }

  const apiUrl = `${pagesUrl}/api/sync-playlists`;

  log("\n==========================================================", colors.cyan);
  log("                  部署流程执行完毕！                       ", colors.bold + colors.green);
  log("==========================================================\n", colors.cyan);

  log("您的 Cloudflare Pages 首页 URL:", colors.yellow);
  log(`  ${pagesUrl}\n`, colors.cyan);

  log("【重点】您的歌单同步 API 完整 URL:", colors.bold + colors.yellow);
  log(`  ${apiUrl}\n`, colors.bold + colors.green);

  log(`请复制上方【${apiUrl}】并发送给我，我将把它设置为 Primuse App 的默认歌单同步地址！`, colors.magenta);
  log("==========================================================\n", colors.cyan);
}

main().catch((err) => {
  log(`[X] 部署异常: ${err.message}`, colors.red);
  process.exit(1);
});
