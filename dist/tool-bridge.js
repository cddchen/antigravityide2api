"use strict";
// ═══════════════════════════════════════════════
//  原生 FC ↔ Claude tool_use 桥接（wire-reference §3.1）
//  方向：上游原生 → CC 实际持有的工具；FR 反向回填
// ═══════════════════════════════════════════════
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sq = sq;
exports.bridgeFunctionCall = bridgeFunctionCall;
exports.buildFunctionResponse = buildFunctionResponse;
exports.rejectionOutput = rejectionOutput;
exports.describeToolUse = describeToolUse;
const assert_1 = __importDefault(require("assert"));
const path_1 = __importDefault(require("path"));
/**
 * list_dir 用 python 复刻 IDE JSON 行输出（§3.1；脚本内无单引号）。
 * separators 必填 —— 默认带空格，与实录 {"name":".DS_Store","sizeBytes":"6148"} 不同构。
 */
const LIST_DIR_PY = 'import json,os,sys\n' +
    'for e in sorted(os.scandir(sys.argv[1]),key=lambda x:x.name):\n' +
    '    print(json.dumps({"name":e.name,"isDir":True} if e.is_dir() else {"name":e.name,"sizeBytes":str(e.stat().st_size)},ensure_ascii=False,separators=(",",":")))';
// ---------- A. shell 引用 ----------
/** CC 的 Bash.command 是字符串不是 argv 数组，Query 直接来自上游模型输出 */
function sq(s) {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}
// ---------- 内部工具 ----------
function isoNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function nativeOf(fc) {
    return { id: fc.id, name: fc.name, args: fc.args };
}
function ok(value) {
    return { kind: 'tool_use', value };
}
function reject(fc, reason) {
    return { kind: 'reject', value: { native: nativeOf(fc), reason } };
}
/** path.resolve 后必须在 workspace root 之下；空 root 跳过 */
function outsideWorkspace(filePath, workspaceRoot) {
    if (!workspaceRoot)
        return false;
    const resolved = path_1.default.resolve(filePath);
    const root = path_1.default.resolve(workspaceRoot);
    const rel = path_1.default.relative(root, resolved);
    return rel.startsWith('..') || path_1.default.isAbsolute(rel);
}
function successOutput(payload) {
    const t = isoNow();
    return `Created At: ${t}\nCompleted At: ${t}\n${payload}`;
}
function errorOutput(message) {
    // 实录：无 Completed At 行 = 失败（§1.3.1 view_file/nG4KpKW2）
    return (`Created At: ${isoNow()}\n` +
        `Error invalid tool call: There was a problem parsing the tool call. \n` +
        `Error Message: ${message}`);
}
function str(v) {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function fileUri(absPath) {
    // 非 ASCII 走 encodeURI（实录中文路径 %E8%BF%9B%E5%BA%A6）
    return 'file://' + encodeURI(absPath);
}
// ---------- B. 原生 FC → CC tool_use ----------
function bridgeFunctionCall(fc, workspaceRoot) {
    const args = fc.args;
    const native = nativeOf(fc);
    switch (fc.name) {
        case 'view_file': {
            const file_path = str(args.AbsolutePath);
            const input = { file_path };
            const start = num(args.StartLine);
            const end = num(args.EndLine);
            if (start !== undefined)
                input.offset = start;
            if (end !== undefined && start !== undefined) {
                input.limit = end - start + 1;
            }
            else if (end !== undefined) {
                // 仅 EndLine：limit 以 1 为起点推
                input.limit = end;
            }
            return ok({ toolUseId: fc.id, claudeName: 'Read', input, native });
        }
        case 'run_command': {
            const cmdLine = str(args.CommandLine);
            const cwd = str(args.Cwd);
            const command = cwd ? `cd ${sq(cwd)} && ${cmdLine}` : cmdLine;
            const input = {
                command,
                description: str(args.toolAction) || 'Running command',
            };
            const wait = num(args.WaitMsBeforeAsync);
            if (wait !== undefined && wait > 0) {
                input.timeout = Math.min(wait, 600000);
            }
            return ok({ toolUseId: fc.id, claudeName: 'Bash', input, native });
        }
        case 'write_to_file': {
            const file_path = str(args.TargetFile);
            if (outsideWorkspace(file_path, workspaceRoot)) {
                return reject(fc, `path outside workspace: ${file_path}`);
            }
            return ok({
                toolUseId: fc.id,
                claudeName: 'Write',
                input: { file_path, content: str(args.CodeContent) },
                native,
            });
        }
        case 'replace_file_content': {
            const file_path = str(args.TargetFile);
            if (outsideWorkspace(file_path, workspaceRoot)) {
                return reject(fc, `path outside workspace: ${file_path}`);
            }
            return ok({
                toolUseId: fc.id,
                claudeName: 'Edit',
                input: {
                    file_path,
                    old_string: str(args.TargetContent),
                    new_string: str(args.ReplacementContent),
                    replace_all: args.AllowMultiple === true,
                },
                native,
            });
        }
        case 'list_dir': {
            const dir = str(args.DirectoryPath);
            // python3 -c '<脚本>' <sq(DirectoryPath)>；脚本本身无单引号
            const command = `python3 -c ${sq(LIST_DIR_PY)} ${sq(dir)}`;
            return ok({
                toolUseId: fc.id,
                claudeName: 'Bash',
                input: {
                    command,
                    description: str(args.toolAction) || 'Listing directory',
                },
                native,
            });
        }
        case 'grep_search': {
            // MatchPerLine===false → -l；否则 -nH --no-heading（含缺失）
            // IsRegex===false 或缺失 → -F（更安全）
            const parts = ['rg'];
            if (args.MatchPerLine === false) {
                parts.push('-l');
            }
            else {
                parts.push('-nH', '--no-heading');
            }
            if (args.IsRegex !== true) {
                parts.push('-F');
            }
            if (args.CaseInsensitive === true) {
                parts.push('-i');
            }
            const includes = Array.isArray(args.Includes) ? args.Includes : [];
            for (const inc of includes) {
                parts.push('-g', sq(str(inc)));
            }
            parts.push('--', sq(str(args.Query)), sq(str(args.SearchPath)));
            // total 50，不能用 --max-count（那是 per-file）
            const command = `${parts.join(' ')} | head -50`;
            return ok({
                toolUseId: fc.id,
                claudeName: 'Bash',
                input: {
                    command,
                    description: str(args.toolAction) || 'Searching files',
                },
                native,
            });
        }
        default:
            return reject(fc, `该工具在本代理下不可用: ${fc.name}`);
    }
}
// ---------- C. FR 回填 ----------
function reshapeGrepSearch(stdout, matchPerLine) {
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    if (matchPerLine === false) {
        return lines.map((l) => JSON.stringify({ Filename: l })).join('\n');
    }
    return lines
        .map((l) => {
        const m = l.match(/^(.*?):(\d+):([\s\S]*)$/);
        if (!m)
            return JSON.stringify({ Filename: l });
        return JSON.stringify({
            Filename: m[1],
            LineNumber: Number(m[2]),
            LineContent: m[3],
        });
    })
        .join('\n');
}
function reshapePayload(native, claudeResult) {
    switch (native.name) {
        case 'list_dir':
            // Bash stdout 已是 JSON 行
            return claudeResult;
        case 'grep_search':
            return reshapeGrepSearch(claudeResult, native.args.MatchPerLine !== false ? true : false);
        case 'view_file': {
            const abs = str(native.args.AbsolutePath);
            const lineCount = claudeResult.length === 0 ? 0 : claudeResult.split('\n').length;
            return (`File Path: \`${fileUri(abs)}\`\n` +
                `Total Lines: ${lineCount}\n` +
                claudeResult);
        }
        case 'write_to_file': {
            const target = str(native.args.TargetFile);
            return `Created file ${fileUri(target)} with requested content.`;
        }
        case 'run_command':
            return (`\n\t\t\t\tThe command completed successfully.\n` +
                `\t\t\t\tOutput:\n` +
                `\t\t\t\t${claudeResult}`);
        default:
            return claudeResult;
    }
}
function buildFunctionResponse(native, claudeResult, isError) {
    // rg 无匹配 exit 1 → CC Bash isError=true；空载荷按成功 0 matches
    let treatError = isError;
    if (native.name === 'grep_search' &&
        isError &&
        claudeResult.trim() === '') {
        treatError = false;
    }
    if (treatError) {
        return {
            id: native.id,
            name: native.name,
            response: { output: errorOutput(claudeResult) },
        };
    }
    const payload = reshapePayload(native, claudeResult);
    return {
        id: native.id,
        name: native.name,
        response: { output: successOutput(payload) },
    };
}
// ---------- D. 拒绝 → FR ----------
function rejectionOutput(rej) {
    return {
        id: rej.native.id,
        name: rej.native.name,
        response: { output: errorOutput(rej.reason) },
    };
}
// ---------- E. 日志描述 ----------
function describeToolUse(fc) {
    const a = fc.args.toolAction;
    return typeof a === 'string' && a.length > 0 ? a : fc.name;
}
// ---------- 自检 ----------
if (require.main === module) {
    // 1. sq 三个 case
    assert_1.default.strictEqual(sq('$(id)'), "'$(id)'");
    assert_1.default.strictEqual(sq("it's"), "'it'\\''s'");
    assert_1.default.strictEqual(sq('plain'), "'plain'");
    // 2. grep_search 完整命令串
    {
        const out = bridgeFunctionCall({
            id: 'g1',
            name: 'grep_search',
            args: {
                Query: 'foo bar',
                SearchPath: '/abs/SearchPath',
                IsRegex: false,
                CaseInsensitive: true,
                MatchPerLine: true,
                Includes: ['*.md', '!**/vendor/*'],
                toolAction: 'Searching',
                toolSummary: 'Search',
            },
        });
        assert_1.default.strictEqual(out.kind, 'tool_use');
        if (out.kind === 'tool_use') {
            assert_1.default.strictEqual(out.value.claudeName, 'Bash');
            assert_1.default.strictEqual(out.value.toolUseId, 'g1');
            assert_1.default.strictEqual(out.value.input.command, `rg -nH --no-heading -F -i -g '*.md' -g '!**/vendor/*' -- 'foo bar' '/abs/SearchPath' | head -50`);
        }
    }
    // MatchPerLine:false → -l；IsRegex 缺失 → -F
    {
        const out = bridgeFunctionCall({
            id: 'g2',
            name: 'grep_search',
            args: {
                Query: '$(id)',
                SearchPath: '/tmp/p',
                MatchPerLine: false,
                toolAction: 'S',
                toolSummary: 'S',
            },
        });
        assert_1.default.strictEqual(out.kind, 'tool_use');
        if (out.kind === 'tool_use') {
            assert_1.default.strictEqual(out.value.input.command, `rg -l -F -- '$(id)' '/tmp/p' | head -50`);
        }
    }
    // 3. list_dir 命令串
    {
        const out = bridgeFunctionCall({
            id: 'tAyN1Fx2',
            name: 'list_dir',
            args: {
                DirectoryPath: '/tmp/proj',
                toolAction: 'Listing project directory',
                toolSummary: 'List project contents',
            },
        });
        assert_1.default.strictEqual(out.kind, 'tool_use');
        if (out.kind === 'tool_use') {
            assert_1.default.strictEqual(out.value.toolUseId, 'tAyN1Fx2');
            assert_1.default.strictEqual(out.value.input.command, `python3 -c ${sq(LIST_DIR_PY)} '/tmp/proj'`);
        }
    }
    // 4. workspace 越界拒绝
    {
        const out = bridgeFunctionCall({
            id: 'w1',
            name: 'write_to_file',
            args: {
                TargetFile: '/etc/passwd',
                CodeContent: 'x',
                toolAction: 'Writing',
                toolSummary: 'Write',
            },
        }, '/Users/me/proj');
        assert_1.default.strictEqual(out.kind, 'reject');
        if (out.kind === 'reject') {
            assert_1.default.ok(out.value.reason.includes('outside workspace'));
        }
    }
    {
        // 边界内应通过
        const out = bridgeFunctionCall({
            id: 'w2',
            name: 'write_to_file',
            args: {
                TargetFile: '/Users/me/proj/a.ts',
                CodeContent: 'x',
                toolAction: 'Writing',
                toolSummary: 'Write',
            },
        }, '/Users/me/proj');
        assert_1.default.strictEqual(out.kind, 'tool_use');
    }
    // 5. grep 无匹配不当错误
    {
        const fr = buildFunctionResponse({
            id: 'g0',
            name: 'grep_search',
            args: { Query: 'zzz', SearchPath: '/tmp', MatchPerLine: true },
        }, '', true);
        assert_1.default.ok(fr.response.output.includes('Completed At:'));
        assert_1.default.ok(!fr.response.output.includes('Error invalid tool call'));
    }
    // grep 有匹配 → JSON 行
    {
        const fr = buildFunctionResponse({
            id: 'g3',
            name: 'grep_search',
            args: { Query: 'a', SearchPath: '/tmp', MatchPerLine: true },
        }, 'docs/a.md:12:hello world\n', false);
        assert_1.default.ok(fr.response.output.includes('"Filename":"docs/a.md"'));
        assert_1.default.ok(fr.response.output.includes('"LineNumber":12'));
        assert_1.default.ok(fr.response.output.includes('"LineContent":"hello world"'));
    }
    // 6. FR 失败样本无 Completed At
    {
        const fr = buildFunctionResponse({ id: 'nG4KpKW2', name: 'view_file', args: { AbsolutePath: '/x' } }, 'boom', true);
        assert_1.default.ok(fr.response.output.startsWith('Created At:'));
        assert_1.default.ok(!fr.response.output.includes('Completed At:'));
        assert_1.default.ok(fr.response.output.includes('Error Message: boom'));
    }
    {
        const rej = rejectionOutput({
            native: { id: 'r1', name: 'search_web', args: {} },
            reason: '该工具在本代理下不可用: search_web',
        });
        assert_1.default.ok(!rej.response.output.includes('Completed At:'));
    }
    // 额外：run_command / view_file / describe
    {
        const out = bridgeFunctionCall({
            id: 'rc',
            name: 'run_command',
            args: {
                CommandLine: 'echo hi',
                Cwd: "/tmp/it's",
                WaitMsBeforeAsync: 5000,
                toolAction: 'Running command',
                toolSummary: 'Cmd',
            },
        });
        assert_1.default.strictEqual(out.kind, 'tool_use');
        if (out.kind === 'tool_use') {
            assert_1.default.strictEqual(out.value.input.command, `cd '/tmp/it'\\''s' && echo hi`);
            assert_1.default.strictEqual(out.value.input.timeout, 5000);
        }
    }
    {
        const fr = buildFunctionResponse({
            id: 'vf',
            name: 'view_file',
            args: { AbsolutePath: '/Users/x/进度.md' },
        }, 'line1\nline2', false);
        assert_1.default.ok(fr.response.output.includes('%E8%BF%9B%E5%BA%A6'));
        assert_1.default.ok(fr.response.output.includes('Total Lines: 2'));
    }
    assert_1.default.strictEqual(describeToolUse({
        id: 'd',
        name: 'list_dir',
        args: { toolAction: 'Listing project directory' },
    }), 'Listing project directory');
    assert_1.default.strictEqual(describeToolUse({ id: 'd2', name: 'list_dir', args: {} }), 'list_dir');
    // 其余 8 个拒绝
    for (const name of [
        'ask_question',
        'browser_subagent',
        'generate_image',
        'manage_task',
        'multi_replace_file_content',
        'read_url_content',
        'schedule',
        'search_web',
    ]) {
        const out = bridgeFunctionCall({ id: 'x', name, args: {} });
        assert_1.default.strictEqual(out.kind, 'reject');
    }
}
//# sourceMappingURL=tool-bridge.js.map