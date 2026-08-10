"use strict";
// ═══════════════════════════════════════════════
//  运行期配置（全部可 env 覆盖）
// ═══════════════════════════════════════════════
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const os_1 = __importDefault(require("os"));
const IDE_VERSION = process.env.IDE_VERSION || '2.1.1';
/** UA: antigravity/ide/2.1.1 darwin/arm64 */
function buildUserAgent() {
    return `antigravity/ide/${IDE_VERSION} ${process.platform}/${process.arch}`;
}
/** loadCodeAssist 的 platform 枚举：DARWIN_ARM64 / LINUX_X64 / WINDOWS_X64 */
function buildPlatformEnum() {
    const osPart = { darwin: 'DARWIN', win32: 'WINDOWS', linux: 'LINUX' }[process.platform] || 'LINUX';
    const archPart = process.arch === 'arm64' ? 'ARM64' : 'X64';
    return `${osPart}_${archPart}`;
}
const config = {
    antigravity: {
        baseUrl: process.env.ANTIGRAVITY_BASE || 'https://daily-cloudcode-pa.googleapis.com',
        ideVersion: IDE_VERSION,
        userAgent: buildUserAgent(),
        platformEnum: buildPlatformEnum(),
        defaultModel: process.env.DEFAULT_MODEL || 'gemini-3.6-flash-high',
        requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '300000', 10),
        pendingTimeout: parseInt(process.env.PENDING_TIMEOUT || '600000', 10),
        maxOutputTokens: 65536,
    },
    /** Write/Edit 落盘边界；空 = 用 CC 抽出的 cwd */
    workspaceRoot: process.env.WORKSPACE_ROOT || '',
    /** full | trimmed | short —— 见 wire-reference §1.5 */
    systemMode: (process.env.ANTIGRAVITY_SYSTEM || 'trimmed'),
    server: {
        port: parseInt(process.env.PORT || '3000', 10),
        host: process.env.HOST || '127.0.0.1',
        apiKey: process.env.API_KEY || '',
    },
    homedir: os_1.default.homedir(),
};
exports.default = config;
//# sourceMappingURL=config.js.map