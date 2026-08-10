"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOKEN_FILE_NAME = exports.CONFIG_DIR_NAME = void 0;
exports.getDefaultTokenPath = getDefaultTokenPath;
exports.getConfigDir = getConfigDir;
exports.ensureConfigDir = ensureConfigDir;
exports.tokenFileExists = tokenFileExists;
exports.maskToken = maskToken;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
exports.CONFIG_DIR_NAME = '.antigravityide2api';
exports.TOKEN_FILE_NAME = 'token.json';
/** TOKEN_FILE 环境变量 > ~/.antigravityide2api/token.json */
function getDefaultTokenPath() {
    if (process.env.TOKEN_FILE?.trim()) {
        return path_1.default.resolve(process.env.TOKEN_FILE.trim());
    }
    return path_1.default.join(os_1.default.homedir(), exports.CONFIG_DIR_NAME, exports.TOKEN_FILE_NAME);
}
function getConfigDir(tokenPath = getDefaultTokenPath()) {
    return path_1.default.dirname(tokenPath);
}
function ensureConfigDir(tokenPath = getDefaultTokenPath()) {
    fs_1.default.mkdirSync(path_1.default.dirname(tokenPath), { recursive: true, mode: 0o700 });
}
function tokenFileExists(tokenPath = getDefaultTokenPath()) {
    try {
        return fs_1.default.existsSync(tokenPath) && fs_1.default.statSync(tokenPath).isFile();
    }
    catch {
        return false;
    }
}
/** 日志脱敏：ya29.abcd…wxyz */
function maskToken(t) {
    if (!t)
        return '<none>';
    return t.length <= 14 ? '<redacted>' : `${t.slice(0, 8)}…${t.slice(-4)}`;
}
//# sourceMappingURL=token-paths.js.map