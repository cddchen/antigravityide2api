// ═══════════════════════════════════════════════
//  原生 FC ↔ Claude tool_use 桥接（wire-reference §3.1）
//  方向：上游原生 → CC 实际持有的工具；FR 反向回填
// ═══════════════════════════════════════════════

import assert from 'assert';
import path from 'path';
import { parseSkillPseudoPath } from './system-prompt';
import type {
  BridgeOutcome,
  BridgeRejection,
  BridgedToolUse,
  FunctionCall,
  FunctionResponse,
} from './types';

/**
 * list_dir 用 python 复刻 IDE JSON 行输出（§3.1；脚本内无单引号）。
 * separators 必填 —— 默认带空格，与实录 {"name":".DS_Store","sizeBytes":"6148"} 不同构。
 */
const LIST_DIR_PY =
  'import json,os,sys\n' +
  'for e in sorted(os.scandir(sys.argv[1]),key=lambda x:x.name):\n' +
  '    print(json.dumps({"name":e.name,"isDir":True} if e.is_dir() else {"name":e.name,"sizeBytes":str(e.stat().st_size)},ensure_ascii=False,separators=(",",":")))';

// ---------- A. shell 引用 ----------

/** CC 的 Bash.command 是字符串不是 argv 数组，Query 直接来自上游模型输出 */
export function sq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// ---------- 内部工具 ----------

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nativeOf(fc: FunctionCall): BridgedToolUse['native'] {
  return { id: fc.id, name: fc.name, args: fc.args };
}

function ok(value: BridgedToolUse): BridgeOutcome {
  return { kind: 'tool_use', value };
}

function reject(fc: FunctionCall, reason: string): BridgeOutcome {
  return { kind: 'reject', value: { native: nativeOf(fc), reason } };
}

/** path.resolve 后必须在 workspace root 之下；空 root 跳过 */
function outsideWorkspace(filePath: string, workspaceRoot?: string): boolean {
  if (!workspaceRoot) return false;
  const resolved = path.resolve(filePath);
  const root = path.resolve(workspaceRoot);
  const rel = path.relative(root, resolved);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function successOutput(payload: string): string {
  const t = isoNow();
  return `Created At: ${t}\nCompleted At: ${t}\n${payload}`;
}

function errorOutput(message: string): string {
  // 实录：无 Completed At 行 = 失败（§1.3.1 view_file/nG4KpKW2）
  return (
    `Created At: ${isoNow()}\n` +
    `Error invalid tool call: There was a problem parsing the tool call. \n` +
    `Error Message: ${message}`
  );
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function fileUri(absPath: string): string {
  // 非 ASCII 走 encodeURI（实录中文路径 %E8%BF%9B%E5%BA%A6）
  return 'file://' + encodeURI(absPath);
}

// ---------- B. 原生 FC → CC tool_use ----------

export function bridgeFunctionCall(
  fc: FunctionCall,
  workspaceRoot?: string,
): BridgeOutcome {
  const args = fc.args;
  const native = nativeOf(fc);

  switch (fc.name) {
    case 'view_file': {
      const file_path = str(args.AbsolutePath);
      // 伪路径：AG system 列出的 skill SKILL.md → 路由到 CC Skill 工具
      const skillName = parseSkillPseudoPath(file_path);
      if (skillName) {
        return ok({
          toolUseId: fc.id,
          claudeName: 'Skill',
          input: { skill: skillName },
          native,
        });
      }
      const input: Record<string, unknown> = { file_path };
      const start = num(args.StartLine);
      const end = num(args.EndLine);
      if (start !== undefined) input.offset = start;
      if (end !== undefined && start !== undefined) {
        input.limit = end - start + 1;
      } else if (end !== undefined) {
        // 仅 EndLine：limit 以 1 为起点推
        input.limit = end;
      }
      return ok({ toolUseId: fc.id, claudeName: 'Read', input, native });
    }

    case 'run_command': {
      const cmdLine = str(args.CommandLine);
      const cwd = str(args.Cwd);
      const command = cwd ? `cd ${sq(cwd)} && ${cmdLine}` : cmdLine;
      const input: Record<string, unknown> = {
        command,
        description: str(args.toolAction) || 'Running command',
      };
      const wait = num(args.WaitMsBeforeAsync);
      if (wait !== undefined && wait > 0) {
        input.timeout = Math.min(wait, 600_000);
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
      const parts: string[] = ['rg'];
      if (args.MatchPerLine === false) {
        parts.push('-l');
      } else {
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

function reshapeGrepSearch(
  stdout: string,
  matchPerLine: boolean,
): string {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  if (matchPerLine === false) {
    return lines.map((l) => JSON.stringify({ Filename: l })).join('\n');
  }
  return lines
    .map((l) => {
      const m = l.match(/^(.*?):(\d+):([\s\S]*)$/);
      if (!m) return JSON.stringify({ Filename: l });
      return JSON.stringify({
        Filename: m[1],
        LineNumber: Number(m[2]),
        LineContent: m[3],
      });
    })
    .join('\n');
}

/**
 * 去掉 Skill 工具的占位行与 base-directory 头。
 * "Launching skill: foo" 与 "Base directory for this skill: /path" 对上游无意义，
 * 且 "Base directory" 常带 ~/.claude 路径，会撞泄漏扫描。
 */
export function scrubSkillBody(text: string): string {
  return text
    .replace(/^Launching skill:.*$/gm, '')
    .replace(/^Base directory for this skill:.*$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function reshapePayload(
  native: { id: string; name: string; args: Record<string, unknown> },
  claudeResult: string,
): string {
  switch (native.name) {
    case 'list_dir':
      // Bash stdout 已是 JSON 行
      return claudeResult;

    case 'grep_search':
      return reshapeGrepSearch(
        claudeResult,
        native.args.MatchPerLine !== false ? true : false,
      );

    case 'view_file': {
      const abs = str(native.args.AbsolutePath);
      // Skill 桥：CC tool_result 是 "Launching skill: X" + trailing "Base directory…"
      // 上游期望 SKILL.md 正文；剥掉两行元数据再当文件内容回填。
      const body = scrubSkillBody(claudeResult);
      const lineCount = body.length === 0 ? 0 : body.split('\n').length;
      return (
        `File Path: \`${fileUri(abs)}\`\n` +
        `Total Lines: ${lineCount}\n` +
        body
      );
    }

    case 'write_to_file': {
      const target = str(native.args.TargetFile);
      return `Created file ${fileUri(target)} with requested content.`;
    }

    case 'run_command':
      return (
        `\n\t\t\t\tThe command completed successfully.\n` +
        `\t\t\t\tOutput:\n` +
        `\t\t\t\t${claudeResult}`
      );

    default:
      return claudeResult;
  }
}

export function buildFunctionResponse(
  native: { id: string; name: string; args: Record<string, unknown> },
  claudeResult: string,
  isError: boolean,
): FunctionResponse {
  // rg 无匹配 exit 1 → CC Bash isError=true；空载荷按成功 0 matches
  let treatError = isError;
  if (
    native.name === 'grep_search' &&
    isError &&
    claudeResult.trim() === ''
  ) {
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

export function rejectionOutput(rej: BridgeRejection): FunctionResponse {
  return {
    id: rej.native.id,
    name: rej.native.name,
    response: { output: errorOutput(rej.reason) },
  };
}

// ---------- E. 日志描述 ----------

export function describeToolUse(fc: FunctionCall): string {
  const a = fc.args.toolAction;
  return typeof a === 'string' && a.length > 0 ? a : fc.name;
}

// ---------- 自检 ----------

if (require.main === module) {
  // 1. sq 三个 case
  assert.strictEqual(sq('$(id)'), "'$(id)'");
  assert.strictEqual(sq("it's"), "'it'\\''s'");
  assert.strictEqual(sq('plain'), "'plain'");

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
    assert.strictEqual(out.kind, 'tool_use');
    if (out.kind === 'tool_use') {
      assert.strictEqual(out.value.claudeName, 'Bash');
      assert.strictEqual(out.value.toolUseId, 'g1');
      assert.strictEqual(
        out.value.input.command,
        `rg -nH --no-heading -F -i -g '*.md' -g '!**/vendor/*' -- 'foo bar' '/abs/SearchPath' | head -50`,
      );
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
    assert.strictEqual(out.kind, 'tool_use');
    if (out.kind === 'tool_use') {
      assert.strictEqual(
        out.value.input.command,
        `rg -l -F -- '$(id)' '/tmp/p' | head -50`,
      );
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
    assert.strictEqual(out.kind, 'tool_use');
    if (out.kind === 'tool_use') {
      assert.strictEqual(out.value.toolUseId, 'tAyN1Fx2');
      assert.strictEqual(
        out.value.input.command,
        `python3 -c ${sq(LIST_DIR_PY)} '/tmp/proj'`,
      );
    }
  }

  // 4. workspace 越界拒绝
  {
    const out = bridgeFunctionCall(
      {
        id: 'w1',
        name: 'write_to_file',
        args: {
          TargetFile: '/etc/passwd',
          CodeContent: 'x',
          toolAction: 'Writing',
          toolSummary: 'Write',
        },
      },
      '/Users/me/proj',
    );
    assert.strictEqual(out.kind, 'reject');
    if (out.kind === 'reject') {
      assert.ok(out.value.reason.includes('outside workspace'));
    }
  }
  {
    // 边界内应通过
    const out = bridgeFunctionCall(
      {
        id: 'w2',
        name: 'write_to_file',
        args: {
          TargetFile: '/Users/me/proj/a.ts',
          CodeContent: 'x',
          toolAction: 'Writing',
          toolSummary: 'Write',
        },
      },
      '/Users/me/proj',
    );
    assert.strictEqual(out.kind, 'tool_use');
  }

  // 5. grep 无匹配不当错误
  {
    const fr = buildFunctionResponse(
      {
        id: 'g0',
        name: 'grep_search',
        args: { Query: 'zzz', SearchPath: '/tmp', MatchPerLine: true },
      },
      '',
      true, // rg exit 1
    );
    assert.ok(fr.response.output.includes('Completed At:'));
    assert.ok(!fr.response.output.includes('Error invalid tool call'));
  }

  // grep 有匹配 → JSON 行
  {
    const fr = buildFunctionResponse(
      {
        id: 'g3',
        name: 'grep_search',
        args: { Query: 'a', SearchPath: '/tmp', MatchPerLine: true },
      },
      'docs/a.md:12:hello world\n',
      false,
    );
    assert.ok(fr.response.output.includes('"Filename":"docs/a.md"'));
    assert.ok(fr.response.output.includes('"LineNumber":12'));
    assert.ok(fr.response.output.includes('"LineContent":"hello world"'));
  }

  // 6. FR 失败样本无 Completed At
  {
    const fr = buildFunctionResponse(
      { id: 'nG4KpKW2', name: 'view_file', args: { AbsolutePath: '/x' } },
      'boom',
      true,
    );
    assert.ok(fr.response.output.startsWith('Created At:'));
    assert.ok(!fr.response.output.includes('Completed At:'));
    assert.ok(fr.response.output.includes('Error Message: boom'));
  }
  {
    const rej = rejectionOutput({
      native: { id: 'r1', name: 'search_web', args: {} },
      reason: '该工具在本代理下不可用: search_web',
    });
    assert.ok(!rej.response.output.includes('Completed At:'));
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
    assert.strictEqual(out.kind, 'tool_use');
    if (out.kind === 'tool_use') {
      assert.strictEqual(
        out.value.input.command,
        `cd '/tmp/it'\\''s' && echo hi`,
      );
      assert.strictEqual(out.value.input.timeout, 5000);
    }
  }
  {
    const fr = buildFunctionResponse(
      {
        id: 'vf',
        name: 'view_file',
        args: { AbsolutePath: '/Users/x/进度.md' },
      },
      'line1\nline2',
      false,
    );
    assert.ok(fr.response.output.includes('%E8%BF%9B%E5%BA%A6'));
    assert.ok(fr.response.output.includes('Total Lines: 2'));
  }
  assert.strictEqual(
    describeToolUse({
      id: 'd',
      name: 'list_dir',
      args: { toolAction: 'Listing project directory' },
    }),
    'Listing project directory',
  );
  assert.strictEqual(
    describeToolUse({ id: 'd2', name: 'list_dir', args: {} }),
    'list_dir',
  );

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
    assert.strictEqual(out.kind, 'reject');
  }

  // skill 伪路径 → Skill；普通路径仍 Read
  {
    const home = require('os').homedir() as string;
    const skillPath = `${home}/.gemini/config/skills/deep-research/SKILL.md`;
    const out = bridgeFunctionCall({
      id: 'sk1',
      name: 'view_file',
      args: { AbsolutePath: skillPath, toolAction: 'Reading skill', toolSummary: 'Skill' },
    });
    assert.strictEqual(out.kind, 'tool_use');
    if (out.kind === 'tool_use') {
      assert.strictEqual(out.value.claudeName, 'Skill');
      assert.deepStrictEqual(out.value.input, { skill: 'deep-research' });
    }
    const pluginPath = `${home}/.gemini/config/skills/plugin__foo/SKILL.md`;
    const out2 = bridgeFunctionCall({
      id: 'sk2',
      name: 'view_file',
      args: { AbsolutePath: pluginPath },
    });
    assert.strictEqual(out2.kind, 'tool_use');
    if (out2.kind === 'tool_use') {
      assert.strictEqual(out2.value.input.skill, 'plugin:foo');
    }
    const plain = bridgeFunctionCall({
      id: 'sk3',
      name: 'view_file',
      args: { AbsolutePath: '/tmp/x.ts' },
    });
    assert.strictEqual(plain.kind, 'tool_use');
    if (plain.kind === 'tool_use') assert.strictEqual(plain.value.claudeName, 'Read');
  }

  // scrubSkillBody + view_file FR 回填
  {
    const scrubbed = scrubSkillBody(
      'Launching skill: demo\n\nBase directory for this skill: /Users/x/.claude/skills/demo\n# Demo\nbody',
    );
    assert.strictEqual(scrubbed, '# Demo\nbody');
    const fr = buildFunctionResponse(
      {
        id: 'skf',
        name: 'view_file',
        args: {
          AbsolutePath: `${require('os').homedir()}/.gemini/config/skills/demo/SKILL.md`,
        },
      },
      'Launching skill: demo\n\nBase directory for this skill: /x\n# Demo skill\nDo things.',
      false,
    );
    assert.ok(fr.response.output.includes('# Demo skill'));
    assert.ok(!fr.response.output.includes('Launching skill'));
    assert.ok(!fr.response.output.includes('Base directory'));
    assert.ok(fr.response.output.includes('Total Lines: 2'));
  }
}
