#!/usr/bin/env node
"use strict";
// antigravityide2api CLI —— 前台 / 后台生命周期 + token 提取
// 注意：禁止静态 import server（编译期可能还不存在），运行期 require / spawn server.js
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const auth_1 = require("./auth");
const config_1 = __importDefault(require("./config"));
const extract_token_1 = require("./extract-token");
const token_paths_1 = require("./token-paths");
const PID_FILE_NAME = 'server.pid';
const LOG_FILE_NAME = 'server.log';
const STARTUP_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;
const HEALTH_POLL_MS = 300;
function printHelp() {
    console.log(`Usage:
  antigravityide2api              前台启动
  antigravityide2api start-fg     前台启动
  antigravityide2api start        后台启动（daemon）
  antigravityide2api stop         停止后台进程
  antigravityide2api status       查看 token / 进程状态
  antigravityide2api extract-token  从本机 Antigravity IDE 提取凭证
  antigravityide2api --help

Env:
  PORT HOST API_KEY TOKEN_FILE DEFAULT_MODEL WORKSPACE_ROOT
  REQUEST_TIMEOUT PENDING_TIMEOUT ANTIGRAVITY_BASE IDE_VERSION ANTIGRAVITY_SYSTEM
`);
}
function getRuntimePaths(tokenPath) {
    const configDir = (0, token_paths_1.getConfigDir)(tokenPath);
    return {
        configDir,
        pidFile: path_1.default.join(configDir, PID_FILE_NAME),
        logFile: path_1.default.join(configDir, LOG_FILE_NAME),
    };
}
function ensureTokenFileOrExit(tokenPath) {
    if ((0, token_paths_1.tokenFileExists)(tokenPath))
        return;
    console.error(`  token 文件不存在: ${tokenPath}`);
    console.error('  请先运行: node dist/cli.js extract-token');
    process.exit(1);
}
function readPid(pidFile) {
    try {
        const pid = Number.parseInt(fs_1.default.readFileSync(pidFile, 'utf8').trim(), 10);
        return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    }
    catch {
        return null;
    }
}
function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
function removePidFile(pidFile) {
    try {
        fs_1.default.rmSync(pidFile);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
}
function serverJsPath() {
    return path_1.default.join(__dirname, 'server.js');
}
/** 探测 /health，host 为 0.0.0.0 时改打 127.0.0.1 */
function waitForHealth(host, port, timeoutMs, child) {
    const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err) => {
            if (settled)
                return;
            settled = true;
            child.off('exit', onExit);
            child.off('error', onError);
            if (err)
                reject(err);
            else
                resolve();
        };
        const onExit = (code, signal) => {
            finish(new Error(`后台进程启动后退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`));
        };
        const onError = (error) => {
            finish(error);
        };
        child.once('exit', onExit);
        child.once('error', onError);
        if (child.exitCode !== null || child.signalCode !== null) {
            onExit(child.exitCode, child.signalCode);
            return;
        }
        const tick = () => {
            if (settled)
                return;
            if (Date.now() - startedAt >= timeoutMs) {
                finish(new Error(`等待服务启动超时（${timeoutMs / 1000}s），请查看日志`));
                return;
            }
            const req = http_1.default.get({ host: probeHost, port, path: '/health', timeout: 1000 }, (res) => {
                res.resume();
                // 任意 HTTP 响应都视为已监听（API_KEY 也可能拦 /health）
                if (res.statusCode && res.statusCode > 0) {
                    finish();
                    return;
                }
                setTimeout(tick, HEALTH_POLL_MS);
            });
            req.on('error', () => setTimeout(tick, HEALTH_POLL_MS));
            req.on('timeout', () => {
                req.destroy();
                setTimeout(tick, HEALTH_POLL_MS);
            });
        };
        tick();
    });
}
function waitForProcessExit(pid) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (!isProcessRunning(pid)) {
                clearInterval(timer);
                resolve(true);
                return;
            }
            if (Date.now() - startedAt >= STOP_TIMEOUT_MS) {
                clearInterval(timer);
                resolve(false);
            }
        }, 100);
    });
}
/** 运行期 require，规避对 server.ts 的编译期依赖 */
function startForeground() {
    const p = serverJsPath();
    if (!fs_1.default.existsSync(p)) {
        console.error(`  找不到 ${p}，请先 npm run build（并确保 src/server.ts 已就绪）`);
        process.exit(1);
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(p);
    if (typeof mod.startServer !== 'function') {
        console.error(`  ${p} 未导出 startServer()`);
        process.exit(1);
    }
    void Promise.resolve(mod.startServer()).catch((e) => {
        console.error(`  启动失败: ${e.message}`);
        process.exit(1);
    });
}
async function startBackground(tokenPath) {
    const { pidFile, logFile } = getRuntimePaths(tokenPath);
    const existingPid = readPid(pidFile);
    if (existingPid && isProcessRunning(existingPid)) {
        console.log(`  已在后台运行（PID ${existingPid}）`);
        console.log(`  日志: ${logFile}`);
        console.log(`  http://${config_1.default.server.host}:${config_1.default.server.port}`);
        return;
    }
    if (existingPid || fs_1.default.existsSync(pidFile)) {
        removePidFile(pidFile);
    }
    (0, token_paths_1.ensureConfigDir)(tokenPath);
    const serverPath = serverJsPath();
    if (!fs_1.default.existsSync(serverPath)) {
        console.error(`  找不到 ${serverPath}，请先 npm run build`);
        process.exit(1);
    }
    const logFd = fs_1.default.openSync(logFile, 'a');
    let child;
    try {
        // 直接 spawn server.js，避免 import server.ts
        child = (0, child_process_1.spawn)(process.execPath, [serverPath], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, TOKEN_FILE: tokenPath },
        });
    }
    finally {
        fs_1.default.closeSync(logFd);
    }
    if (!child.pid) {
        console.error('  无法获取后台进程 PID');
        process.exitCode = 1;
        return;
    }
    fs_1.default.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');
    try {
        await waitForHealth(config_1.default.server.host, config_1.default.server.port, STARTUP_TIMEOUT_MS, child);
    }
    catch (e) {
        removePidFile(pidFile);
        try {
            process.kill(child.pid, 'SIGTERM');
        }
        catch {
            /* ignore */
        }
        console.error(`  启动失败: ${e.message}`);
        console.error(`  查看日志: ${logFile}`);
        process.exitCode = 1;
        return;
    }
    child.unref();
    console.log(`  已在后台启动（PID ${child.pid}）`);
    console.log(`  http://${config_1.default.server.host}:${config_1.default.server.port}`);
    console.log(`  日志: ${logFile}`);
}
async function stopBackground(tokenPath) {
    const { pidFile } = getRuntimePaths(tokenPath);
    const pid = readPid(pidFile);
    if (!pid || !isProcessRunning(pid)) {
        removePidFile(pidFile);
        console.log('  未在后台运行');
        return;
    }
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch (e) {
        console.error(`  停止失败: ${e.message}`);
        process.exitCode = 1;
        return;
    }
    if (!(await waitForProcessExit(pid))) {
        console.error(`  进程 ${pid} 在 ${STOP_TIMEOUT_MS / 1000} 秒内未退出`);
        process.exitCode = 1;
        return;
    }
    removePidFile(pidFile);
    console.log(`  已停止（PID ${pid}）`);
}
function printStatus(tokenPath) {
    const { pidFile, logFile } = getRuntimePaths(tokenPath);
    const exists = (0, token_paths_1.tokenFileExists)(tokenPath);
    console.log(`  token 路径: ${tokenPath}`);
    console.log(`  token 存在: ${exists ? '是' : '否'}`);
    if (exists) {
        try {
            const tf = (0, auth_1.loadTokenFile)(tokenPath);
            console.log(`  账号数: ${tf.tokens.length}`);
            for (const t of tf.tokens) {
                console.log(`    - ${t.name}: access=${(0, token_paths_1.maskToken)(t.accessToken)} refresh=${(0, token_paths_1.maskToken)(t.refreshToken)} projectId=${t.projectId || '<none>'}`);
            }
        }
        catch (e) {
            console.log(`  账号数: 读取失败（${e.message}）`);
        }
    }
    else {
        console.log('  账号数: 0');
    }
    const pid = readPid(pidFile);
    const running = !!(pid && isProcessRunning(pid));
    if (!running && pid)
        removePidFile(pidFile);
    console.log(`  进程: ${running ? `运行中 PID ${pid}` : '未运行'}`);
    console.log(`  端口: ${config_1.default.server.host}:${config_1.default.server.port}`);
    if (running)
        console.log(`  日志: ${logFile}`);
}
async function main() {
    const args = process.argv.slice(2).filter((a) => a !== '--');
    const cmd = args[0];
    if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
        printHelp();
        return;
    }
    const tokenPath = (0, token_paths_1.getDefaultTokenPath)();
    if (cmd === 'extract-token') {
        try {
            (0, extract_token_1.extractAndSaveToken)(tokenPath);
        }
        catch (e) {
            console.error(`  ${e.message}`);
            process.exitCode = 1;
        }
        return;
    }
    // status / stop 是诊断命令，缺 token 也要能看，printStatus 自己处理不存在的情况
    if (cmd === 'status') {
        printStatus(tokenPath);
        return;
    }
    if (cmd === 'stop') {
        await stopBackground(tokenPath);
        return;
    }
    // 启动类命令才要求 token 文件存在
    ensureTokenFileOrExit(tokenPath);
    process.env.TOKEN_FILE = process.env.TOKEN_FILE || tokenPath;
    if (cmd === 'start') {
        await startBackground(tokenPath);
        return;
    }
    // 无参数 / start-fg → 前台
    if (!cmd || cmd === 'start-fg') {
        startForeground();
        return;
    }
    console.error(`  未知命令: ${cmd}`);
    printHelp();
    process.exitCode = 1;
}
void main().catch((e) => {
    console.error(`  ${e.message}`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map