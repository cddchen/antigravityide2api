#!/usr/bin/env node
// antigravityide2api CLI —— 前台 / 后台生命周期 + token 提取
// 注意：禁止静态 import server（编译期可能还不存在），运行期 require / spawn server.js

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { loadTokenFile } from './auth';
import config from './config';
import { extractAndSaveToken } from './extract-token';
import {
  ensureConfigDir,
  getConfigDir,
  getDefaultTokenPath,
  maskToken,
  tokenFileExists,
} from './token-paths';
import {
  DEFAULT_TRIM_WORDS,
  addTrimWords,
  clearTrimWords,
  getTrimWordsPath,
  loadTrimWordsFile,
  parseTrimWordsSpec,
  removeTrimWords,
  resolveTrimWords,
} from './trim-words';

const PID_FILE_NAME = 'server.pid';
const LOG_FILE_NAME = 'server.log';
const STARTUP_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const HEALTH_POLL_MS = 300;

function printHelp(): void {
  console.log(`Usage:
  antigravityide2api              前台启动
  antigravityide2api start-fg     前台启动
  antigravityide2api start        后台启动（daemon）
  antigravityide2api stop         停止后台进程
  antigravityide2api status       查看 token / 进程状态
  antigravityide2api extract-token  从本机 Antigravity IDE 提取凭证
  antigravityide2api trim-words           查看过滤词（默认 ∪ 文件 ∪ env）
  antigravityide2api trim-words add WORD  追加持久化过滤词
  antigravityide2api trim-words rm WORD   删除持久化过滤词
  antigravityide2api trim-words clear     清空持久化过滤词
  antigravityide2api --help

Env:
  PORT HOST API_KEY TOKEN_FILE DEFAULT_MODEL WORKSPACE_ROOT
  REQUEST_TIMEOUT PENDING_TIMEOUT ANTIGRAVITY_BASE IDE_VERSION ANTIGRAVITY_SYSTEM
  ANTIGRAVITY_TRIM_WORDS
  IDE_VERSION 默认从本机 product.json 的 ideVersion 读取，不必再手写
  ANTIGRAVITY_TRIM_WORDS 额外过滤词（逗号或 JSON 数组）；命中后换零宽，不删整段；匹配不区分大小写
`);
}

function getRuntimePaths(tokenPath: string): { pidFile: string; logFile: string; configDir: string } {
  const configDir = getConfigDir(tokenPath);
  return {
    configDir,
    pidFile: path.join(configDir, PID_FILE_NAME),
    logFile: path.join(configDir, LOG_FILE_NAME),
  };
}

function ensureTokenFileOrExit(tokenPath: string): void {
  if (tokenFileExists(tokenPath)) return;
  console.error(`  token 文件不存在: ${tokenPath}`);
  console.error('  请先运行: node dist/cli.js extract-token');
  process.exit(1);
}

function readPid(pidFile: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function removePidFile(pidFile: string): void {
  try {
    fs.rmSync(pidFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function serverJsPath(): string {
  return path.join(__dirname, 'server.js');
}

/** 探测 /health，host 为 0.0.0.0 时改打 127.0.0.1 */
function waitForHealth(host: string, port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      child.off('exit', onExit);
      child.off('error', onError);
      if (err) reject(err);
      else resolve();
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`后台进程启动后退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`));
    };
    const onError = (error: Error): void => {
      finish(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);

    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }

    const tick = (): void => {
      if (settled) return;
      if (Date.now() - startedAt >= timeoutMs) {
        finish(new Error(`等待服务启动超时（${timeoutMs / 1000}s），请查看日志`));
        return;
      }
      const req = http.get(
        { host: probeHost, port, path: '/health', timeout: 1000 },
        (res) => {
          res.resume();
          // 任意 HTTP 响应都视为已监听（API_KEY 也可能拦 /health）
          if (res.statusCode && res.statusCode > 0) {
            finish();
            return;
          }
          setTimeout(tick, HEALTH_POLL_MS);
        },
      );
      req.on('error', () => setTimeout(tick, HEALTH_POLL_MS));
      req.on('timeout', () => {
        req.destroy();
        setTimeout(tick, HEALTH_POLL_MS);
      });
    };
    tick();
  });
}

function waitForProcessExit(pid: number): Promise<boolean> {
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
function startForeground(): void {
  const p = serverJsPath();
  if (!fs.existsSync(p)) {
    console.error(`  找不到 ${p}，请先 npm run build（并确保 src/server.ts 已就绪）`);
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(p) as { startServer?: () => void | Promise<void> };
  if (typeof mod.startServer !== 'function') {
    console.error(`  ${p} 未导出 startServer()`);
    process.exit(1);
  }
  void Promise.resolve(mod.startServer()).catch((e: Error) => {
    console.error(`  启动失败: ${e.message}`);
    process.exit(1);
  });
}

async function startBackground(tokenPath: string): Promise<void> {
  const { pidFile, logFile } = getRuntimePaths(tokenPath);
  const existingPid = readPid(pidFile);
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`  已在后台运行（PID ${existingPid}）`);
    console.log(`  日志: ${logFile}`);
    console.log(`  http://${config.server.host}:${config.server.port}`);
    return;
  }
  if (existingPid || fs.existsSync(pidFile)) {
    removePidFile(pidFile);
  }

  ensureConfigDir(tokenPath);
  const serverPath = serverJsPath();
  if (!fs.existsSync(serverPath)) {
    console.error(`  找不到 ${serverPath}，请先 npm run build`);
    process.exit(1);
  }

  const logFd = fs.openSync(logFile, 'a');
  let child: ChildProcess;
  try {
    // 直接 spawn server.js，避免 import server.ts
    child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, TOKEN_FILE: tokenPath },
    });
  } finally {
    fs.closeSync(logFd);
  }

  if (!child.pid) {
    console.error('  无法获取后台进程 PID');
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');
  try {
    await waitForHealth(config.server.host, config.server.port, STARTUP_TIMEOUT_MS, child);
  } catch (e) {
    removePidFile(pidFile);
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    console.error(`  启动失败: ${(e as Error).message}`);
    console.error(`  查看日志: ${logFile}`);
    process.exitCode = 1;
    return;
  }

  child.unref();
  console.log(`  已在后台启动（PID ${child.pid}）`);
  console.log(`  http://${config.server.host}:${config.server.port}`);
  console.log(`  日志: ${logFile}`);
}

async function stopBackground(tokenPath: string): Promise<void> {
  const { pidFile } = getRuntimePaths(tokenPath);
  const pid = readPid(pidFile);
  if (!pid || !isProcessRunning(pid)) {
    removePidFile(pidFile);
    console.log('  未在后台运行');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    console.error(`  停止失败: ${(e as Error).message}`);
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

function printStatus(tokenPath: string): void {
  const { pidFile, logFile } = getRuntimePaths(tokenPath);
  const exists = tokenFileExists(tokenPath);
  console.log(`  token 路径: ${tokenPath}`);
  console.log(`  token 存在: ${exists ? '是' : '否'}`);

  if (exists) {
    try {
      const tf = loadTokenFile(tokenPath);
      console.log(`  账号数: ${tf.tokens.length}`);
      for (const t of tf.tokens) {
        console.log(
          `    - ${t.name}: access=${maskToken(t.accessToken)} refresh=${maskToken(t.refreshToken)} projectId=${t.projectId || '<none>'}`,
        );
      }
    } catch (e) {
      console.log(`  账号数: 读取失败（${(e as Error).message}）`);
    }
  } else {
    console.log('  账号数: 0');
  }

  const pid = readPid(pidFile);
  const running = !!(pid && isProcessRunning(pid));
  if (!running && pid) removePidFile(pidFile);
  console.log(`  进程: ${running ? `运行中 PID ${pid}` : '未运行'}`);
  console.log(`  端口: ${config.server.host}:${config.server.port}`);
  if (running) console.log(`  日志: ${logFile}`);
}

function printWordList(label: string, words: readonly string[], extra = ''): void {
  console.log(`  ${label} (${words.length})${extra ? ` ${extra}` : ''}`);
  if (words.length === 0) {
    console.log('    (无)');
    return;
  }
  for (const w of words) console.log(`    - ${JSON.stringify(w)}`);
}

function runTrimWordsCommand(args: string[]): void {
  const filePath = getTrimWordsPath();
  const sub = args[0];
  const rest = args.slice(1);

  const fail = (msg: string): void => {
    console.error(`  ${msg}`);
    process.exitCode = 1;
  };

  try {
    if (!sub || sub === 'list') {
      let fromEnv: string[] = [];
      try {
        fromEnv = parseTrimWordsSpec(process.env.ANTIGRAVITY_TRIM_WORDS);
      } catch (e) {
        fail(`ANTIGRAVITY_TRIM_WORDS 无效: ${(e as Error).message}`);
        return;
      }
      const fromFile = loadTrimWordsFile(filePath, { strict: true });
      printWordList('默认', DEFAULT_TRIM_WORDS, '仅 trimmed 模式');
      printWordList('文件', fromFile, filePath);
      printWordList('环境 ANTIGRAVITY_TRIM_WORDS', fromEnv);
      printWordList('生效', resolveTrimWords());
      console.log(
        '  命中后替换为等长零宽字符，不删整段；匹配不区分大小写。改文件后需重启服务。',
      );
      return;
    }
    if (sub === 'add') {
      if (rest.length === 0) {
        fail('trim-words add 需要至少一个词');
        return;
      }
      const next = addTrimWords(rest, filePath);
      console.log(`  已写入 ${filePath} (${next.length})`);
      for (const w of next) console.log(`    - ${JSON.stringify(w)}`);
      return;
    }
    if (sub === 'rm' || sub === 'remove') {
      if (rest.length === 0) {
        fail('trim-words rm 需要至少一个词');
        return;
      }
      const next = removeTrimWords(rest, filePath);
      console.log(`  已写入 ${filePath} (${next.length})`);
      for (const w of next) console.log(`    - ${JSON.stringify(w)}`);
      return;
    }
    if (sub === 'clear') {
      clearTrimWords(filePath);
      console.log(`  已清空 ${filePath}`);
      return;
    }
    fail(`未知 trim-words 子命令: ${sub}`);
    printHelp();
  } catch (e) {
    fail((e as Error).message);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const cmd = args[0];

  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return;
  }

  const tokenPath = getDefaultTokenPath();

  if (cmd === 'trim-words') {
    runTrimWordsCommand(args.slice(1));
    return;
  }

  if (cmd === 'extract-token') {
    try {
      extractAndSaveToken(tokenPath);
    } catch (e) {
      console.error(`  ${(e as Error).message}`);
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

void main().catch((e: Error) => {
  console.error(`  ${e.message}`);
  process.exitCode = 1;
});
