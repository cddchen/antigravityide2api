"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractLocalToken = extractLocalToken;
exports.writeTokenFile = writeTokenFile;
exports.extractAndSaveToken = extractAndSaveToken;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const token_paths_1 = require("./token-paths");
const ACCESS_RE = /ya29\.[A-Za-z0-9._\-]+/;
const REFRESH_RE = /1\/\/[A-Za-z0-9._\-]+/;
const B64_CHUNK_RE = /[A-Za-z0-9+/_\-]{24,}={0,2}/g;
const MAX_DEPTH = 6;
function idePaths() {
    const home = os_1.default.homedir();
    if (process.platform === 'darwin') {
        const base = path_1.default.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage');
        return { db: path_1.default.join(base, 'state.vscdb'), storage: path_1.default.join(base, 'storage.json') };
    }
    if (process.platform === 'win32') {
        const base = path_1.default.join(process.env.APPDATA || '', 'Antigravity IDE', 'User', 'globalStorage');
        return { db: path_1.default.join(base, 'state.vscdb'), storage: path_1.default.join(base, 'storage.json') };
    }
    const base = path_1.default.join(home, '.config', 'Antigravity IDE', 'User', 'globalStorage');
    return { db: path_1.default.join(base, 'state.vscdb'), storage: path_1.default.join(base, 'storage.json') };
}
/** 只读 sqlite，严禁写回 IDE DB */
function readOauthBlob(dbPath) {
    if (!fs_1.default.existsSync(dbPath)) {
        throw new Error(`未找到 Antigravity IDE 数据库: ${dbPath}\n请先安装并登录 Antigravity IDE`);
    }
    let out;
    try {
        out = (0, child_process_1.execSync)(`sqlite3 ${JSON.stringify(dbPath)} "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.oauthToken';"`, { encoding: 'utf8' }).trim();
    }
    catch (e) {
        const err = e;
        if (/sqlite3/i.test(err.message) || err.message.includes('ENOENT')) {
            throw new Error('需要 sqlite3 命令行工具才能读取 Antigravity 凭证（macOS 一般自带；Linux 请安装 sqlite3）');
        }
        throw new Error(`读取 Antigravity IDE DB 失败: ${err.message}`);
    }
    if (!out) {
        throw new Error('未找到 oauthToken — 请先在 Antigravity IDE 中登录 Google 账号');
    }
    return out;
}
function tryDecodeBase64(s) {
    const cleaned = s.replace(/\s+/g, '');
    if (cleaned.length < 16)
        return null;
    // 拒绝明显非 base64
    if (!/^[A-Za-z0-9+/_\-]+={0,2}$/.test(cleaned))
        return null;
    try {
        const buf = Buffer.from(cleaned, 'base64');
        // 解码后太短 / 全零无意义
        if (buf.length < 8)
            return null;
        // latin1 保留二进制，便于在 protobuf 里扫 ASCII token
        return buf.toString('latin1');
    }
    catch {
        return null;
    }
}
/**
 * BFS：整串尝试 base64 解码，解码内容里继续找 base64 段递归，
 * 直到扫到 ya29.* 与 1//*。深度上限 6。
 */
function scanTokens(raw) {
    let accessToken = '';
    let refreshToken = '';
    const queue = [{ s: raw, depth: 0 }];
    const seen = new Set();
    while (queue.length > 0) {
        const item = queue.shift();
        if (item.depth > MAX_DEPTH)
            continue;
        // 截断超长 key，避免 Set 爆内存
        const key = item.s.length > 4096 ? item.s.slice(0, 4096) : item.s;
        if (seen.has(key))
            continue;
        seen.add(key);
        if (!accessToken) {
            const m = item.s.match(ACCESS_RE);
            if (m)
                accessToken = m[0];
        }
        if (!refreshToken) {
            const m = item.s.match(REFRESH_RE);
            if (m)
                refreshToken = m[0];
        }
        if (accessToken && refreshToken)
            break;
        if (item.depth >= MAX_DEPTH)
            continue;
        // 整串 + 内嵌 base64 段
        const candidates = new Set();
        candidates.add(item.s.replace(/\s+/g, ''));
        const chunks = item.s.match(B64_CHUNK_RE);
        if (chunks) {
            for (const c of chunks)
                candidates.add(c);
        }
        for (const c of candidates) {
            const decoded = tryDecodeBase64(c);
            if (decoded && decoded !== item.s) {
                queue.push({ s: decoded, depth: item.depth + 1 });
            }
        }
    }
    if (!accessToken || !refreshToken) {
        throw new Error(`oauthToken 中扫不到完整凭证（access=${accessToken ? 'ok' : '缺'}, refresh=${refreshToken ? 'ok' : '缺'}）。请确认 IDE 已登录`);
    }
    return { accessToken, refreshToken };
}
function readMachineId(storagePath) {
    if (!fs_1.default.existsSync(storagePath)) {
        console.warn(`  警告: storage.json 不存在（${storagePath}），machineId 将为空`);
        return undefined;
    }
    try {
        const storage = JSON.parse(fs_1.default.readFileSync(storagePath, 'utf8'));
        const mid = storage['telemetry.machineId'];
        if (typeof mid === 'string' && mid)
            return mid;
        console.warn('  警告: storage.json 中无 telemetry.machineId');
        return undefined;
    }
    catch {
        console.warn('  警告: 解析 storage.json 失败，machineId 将为空');
        return undefined;
    }
}
/** 从本机 Antigravity IDE 提取 OAuth token（只读，不写 vscdb） */
function extractLocalToken(name = 'account-1') {
    const { db, storage } = idePaths();
    const blob = readOauthBlob(db);
    const { accessToken, refreshToken } = scanTokens(blob);
    const machineId = readMachineId(storage);
    return {
        name,
        accessToken,
        refreshToken,
        machineId,
    };
}
/** 写 token 文件，强制 0600（已存在文件时 mode 参数不生效，需 chmod） */
function writeTokenFile(entry, tokenPath = (0, token_paths_1.getDefaultTokenPath)()) {
    (0, token_paths_1.ensureConfigDir)(tokenPath);
    const payload = { tokens: [entry] };
    fs_1.default.writeFileSync(tokenPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs_1.default.chmodSync(tokenPath, 0o600);
    return tokenPath;
}
/** 提取并保存；打印时 token 必须脱敏 */
function extractAndSaveToken(tokenPath = (0, token_paths_1.getDefaultTokenPath)()) {
    const entry = extractLocalToken('account-1');
    const savedPath = writeTokenFile(entry, tokenPath);
    console.log(JSON.stringify({
        name: entry.name,
        accessToken: (0, token_paths_1.maskToken)(entry.accessToken),
        refreshToken: (0, token_paths_1.maskToken)(entry.refreshToken),
        machineId: entry.machineId || '<none>',
    }, null, 2));
    console.log(`  已写入 ${savedPath} (0600)`);
    return { tokenPath: savedPath, entry };
}
//# sourceMappingURL=extract-token.js.map