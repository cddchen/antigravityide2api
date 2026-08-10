// T3 —— 桥接（含真实 shell 执行 + 夹具同构）
// 纯映射已在 dist/tool-bridge.js 自检覆盖；此处只做自检没做的。
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const bridge = await import(path.join(root, 'dist/tool-bridge.js'));
const { bridgeFunctionCall, buildFunctionResponse } = bridge;
const native = await import(path.join(root, 'dist/native-tools.js'));
const { NATIVE_TOOL_NAMES } = native;

const capture = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/ag-envelope.capture.json'), 'utf8'),
);
// list_dir FR outputHead 第 3 行（Created At / Completed At 之后第一行 JSON）
const listDirFr = capture.contentsSkeleton.find(
  (c) =>
    c.role === 'model' &&
    c.parts?.[0]?._kind === 'functionResponse' &&
    c.parts[0].name === 'list_dir',
);
assert.ok(listDirFr, 'capture 应含 list_dir FR');
const listDirLine3 = listDirFr.parts[0].outputHead.split('\n')[2];
// 夹具：{"name":".DS_Store","sizeBytes":"6148"} 紧凑 JSON
assert.equal(listDirLine3, '{"name":".DS_Store","sizeBytes":"6148"}');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ag-bridge-'));
}

// 3.1 list_dir 真实执行，第一行与夹具第 3 行同构（键序 name,sizeBytes；无空格；sizeBytes 字符串）
{
  const dir = mkTmp();
  try {
    // 已知大小文件 + 子目录；排序后 a-known 应在 subdir 前
    const known = path.join(dir, 'a-known.bin');
    fs.writeFileSync(known, Buffer.alloc(6148)); // 与夹具 sizeBytes 字符串同形
    fs.mkdirSync(path.join(dir, 'subdir'));

    const out = bridgeFunctionCall({
      id: 'tAyN1Fx2',
      name: 'list_dir',
      args: {
        DirectoryPath: dir,
        toolAction: 'Listing',
        toolSummary: 'List',
      },
    });
    assert.equal(out.kind, 'tool_use');
    const stdout = execSync(out.value.input.command, {
      encoding: 'utf8',
      shell: true,
    });
    const firstLine = stdout.split('\n').filter(Boolean)[0];
    // 逐字符：键序 name/sizeBytes、无空格、sizeBytes 是字符串
    const expected = `{"name":"a-known.bin","sizeBytes":"6148"}`;
    assert.equal(firstLine, expected, `list_dir first line: ${firstLine}`);
    // 同构检查：键序与夹具 line3 一致（parse + JSON.stringify 紧凑）
    const parsed = JSON.parse(firstLine);
    assert.deepEqual(Object.keys(parsed), ['name', 'sizeBytes']);
    assert.equal(typeof parsed.sizeBytes, 'string');
    assert.equal(JSON.stringify(parsed), firstLine); // 无空格
    // 与夹具行同构（相同键序与紧凑分隔）
    assert.deepEqual(Object.keys(JSON.parse(listDirLine3)), ['name', 'sizeBytes']);
    assert.equal(typeof JSON.parse(listDirLine3).sizeBytes, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3.2 grep_search Query='$(id)' 匹配字面量，输出不含 uid=
{
  const dir = mkTmp();
  try {
    const f = path.join(dir, 'inject.txt');
    fs.writeFileSync(f, 'before $(id) after\n');
    const out = bridgeFunctionCall({
      id: 'g1',
      name: 'grep_search',
      args: {
        Query: '$(id)',
        SearchPath: dir,
        MatchPerLine: true,
        toolAction: 'S',
        toolSummary: 'S',
      },
    });
    assert.equal(out.kind, 'tool_use');
    const stdout = execSync(out.value.input.command, {
      encoding: 'utf8',
      shell: true,
    });
    assert.ok(stdout.includes('$(id)'), `应匹配字面量 $(id): ${stdout}`);
    assert.ok(!stdout.includes('uid='), `不得注入执行: ${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3.3 Query="it's" 真实执行不报语法错
{
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'q.txt'), "it's fine\n");
    const out = bridgeFunctionCall({
      id: 'g2',
      name: 'grep_search',
      args: {
        Query: "it's",
        SearchPath: dir,
        MatchPerLine: true,
        toolAction: 'S',
        toolSummary: 'S',
      },
    });
    assert.equal(out.kind, 'tool_use');
    const stdout = execSync(out.value.input.command, {
      encoding: 'utf8',
      shell: true,
    });
    assert.ok(stdout.includes("it's"), `应匹配 it's: ${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3.4 SearchPath 是单文件时输出带 文件名:行号: 前缀（-H）
{
  const dir = mkTmp();
  try {
    const f = path.join(dir, 'one.txt');
    fs.writeFileSync(f, 'alpha\nbeta match here\ngamma\n');
    const out = bridgeFunctionCall({
      id: 'g3',
      name: 'grep_search',
      args: {
        Query: 'match',
        SearchPath: f,
        MatchPerLine: true,
        toolAction: 'S',
        toolSummary: 'S',
      },
    });
    assert.equal(out.kind, 'tool_use');
    const stdout = execSync(out.value.input.command, {
      encoding: 'utf8',
      shell: true,
    });
    // rg -H 单文件也带 path:line:
    assert.match(stdout, /one\.txt:2:/, `应有 文件名:行号: 前缀: ${stdout}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3.5 60 处匹配 → 恰好 50 行（head -50 是 total 非 per-file）
{
  const dir = mkTmp();
  try {
    const f = path.join(dir, 'many.txt');
    fs.writeFileSync(f, Array.from({ length: 60 }, (_, i) => `line-${i} HIT`).join('\n') + '\n');
    const out = bridgeFunctionCall({
      id: 'g4',
      name: 'grep_search',
      args: {
        Query: 'HIT',
        SearchPath: f,
        MatchPerLine: true,
        toolAction: 'S',
        toolSummary: 'S',
      },
    });
    assert.equal(out.kind, 'tool_use');
    const stdout = execSync(out.value.input.command, {
      encoding: 'utf8',
      shell: true,
    });
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 50, `应恰好 50 行，实际 ${lines.length}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3.6 rg 无匹配 → exit 1（管道需 pipefail 才能冒泡；head 单独吞掉退出码是陷阱本身），
//     但 buildFunctionResponse(..., '', true) 仍产出含 Completed At: 的成功 output
{
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'empty-ish.txt'), 'nothing here\n');
    const out = bridgeFunctionCall({
      id: 'g5',
      name: 'grep_search',
      args: {
        Query: 'zzz-no-match-zzz',
        SearchPath: dir,
        MatchPerLine: true,
        toolAction: 'S',
        toolSummary: 'S',
      },
    });
    assert.equal(out.kind, 'tool_use');
    // 桥接命令是 `rg … | head -50`；默认 sh 管道退出码取最后一棒 head=0，
    // 必须 pipefail 才能看到 rg 的 exit 1（即 CC Bash isError 的来源）
    let threw = false;
    try {
      execSync(out.value.input.command, {
        encoding: 'utf8',
        shell: '/bin/bash',
        env: { ...process.env, SHELLOPTS: 'pipefail' },
      });
    } catch (e) {
      threw = true;
      // bash pipefail 下 rg=1 会冒泡；status 可能是 1
      assert.ok(
        e.status === 1 || e.status === 2,
        `rg 无匹配 exit: ${e.status}`,
      );
    }
    // 若 bash 不读 SHELLOPTS，退而用显式 set -o pipefail
    if (!threw) {
      try {
        execSync(`set -o pipefail; ${out.value.input.command}`, {
          encoding: 'utf8',
          shell: '/bin/bash',
        });
      } catch (e) {
        threw = true;
        assert.ok(
          e.status === 1 || e.status === 2,
          `rg 无匹配 exit(pipefail): ${e.status}`,
        );
      }
    }
    assert.ok(threw, 'rg 无匹配应抛（pipefail 下）');
    const fr = buildFunctionResponse(
      {
        id: 'g5',
        name: 'grep_search',
        args: { Query: 'zzz-no-match-zzz', SearchPath: dir, MatchPerLine: true },
      },
      '',
      true,
    );
    assert.ok(
      fr.response.output.includes('Completed At:'),
      `无匹配仍应成功 output: ${fr.response.output}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3.7 grep_search FR 载荷每行可 JSON.parse，键恰为 {Filename,LineNumber,LineContent}
{
  const fr = buildFunctionResponse(
    {
      id: 'g6',
      name: 'grep_search',
      args: { Query: 'a', SearchPath: '/tmp', MatchPerLine: true },
    },
    'docs/a.md:12:hello world\nother/b.ts:3:xx\n',
    false,
  );
  const body = fr.response.output
    .split('\n')
    .slice(2) // 跳过 Created/Completed At
    .filter((l) => l.length > 0 && l.startsWith('{'));
  assert.ok(body.length >= 2, `FR 载荷行: ${body.join('|')}`);
  for (const line of body) {
    const obj = JSON.parse(line);
    assert.deepEqual(
      Object.keys(obj).sort(),
      ['Filename', 'LineContent', 'LineNumber'].sort(),
    );
  }
}

// 3.8 14 个原生工具逐个 bridge：6 tool_use / 8 reject；claudeName ∈ {Read,Bash,Write,Edit}
{
  const okNames = new Set(['Read', 'Bash', 'Write', 'Edit']);
  let toolUse = 0;
  let reject = 0;
  for (const name of NATIVE_TOOL_NAMES) {
    // 给足够假参数；越界相关测在 3.10
    const args = {
      AbsolutePath: '/tmp/x',
      CommandLine: 'echo',
      Cwd: '/tmp',
      TargetFile: '/tmp/ws/a.ts',
      CodeContent: 'x',
      TargetContent: 'a',
      ReplacementContent: 'b',
      DirectoryPath: '/tmp',
      Query: 'q',
      SearchPath: '/tmp',
      toolAction: 'A',
      toolSummary: 'S',
    };
    const out = bridgeFunctionCall({ id: 'x', name, args }, '/tmp/ws');
    if (out.kind === 'tool_use') {
      toolUse++;
      assert.ok(
        okNames.has(out.value.claudeName),
        `${name} → claudeName ${out.value.claudeName}`,
      );
    } else {
      reject++;
    }
  }
  assert.equal(toolUse, 6, `tool_use 应为 6，实际 ${toolUse}`);
  assert.equal(reject, 8, `reject 应为 8，实际 ${reject}`);
}

// 3.9 桥出的 claudeName 没有 LS/Grep/Glob
{
  const bridged = ['view_file', 'run_command', 'write_to_file', 'replace_file_content', 'list_dir', 'grep_search'];
  for (const name of bridged) {
    const out = bridgeFunctionCall(
      {
        id: 'n',
        name,
        args: {
          AbsolutePath: '/tmp/ws/f',
          CommandLine: 'true',
          TargetFile: '/tmp/ws/f',
          CodeContent: 'c',
          TargetContent: 'a',
          ReplacementContent: 'b',
          DirectoryPath: '/tmp',
          Query: 'q',
          SearchPath: '/tmp',
          toolAction: 'A',
          toolSummary: 'S',
        },
      },
      '/tmp/ws',
    );
    assert.equal(out.kind, 'tool_use');
    assert.ok(!['LS', 'Grep', 'Glob'].includes(out.value.claudeName), out.value.claudeName);
  }
}

// 3.10 write_to_file 目标 ../../etc/passwd（相对越界）也被 reject
{
  // 以 /tmp/ws 为 root；相对路径 resolve 后应出界
  const out = bridgeFunctionCall(
    {
      id: 'w',
      name: 'write_to_file',
      args: {
        TargetFile: '../../etc/passwd',
        CodeContent: 'x',
        toolAction: 'W',
        toolSummary: 'W',
      },
    },
    path.resolve('/tmp/ws'),
  );
  assert.equal(out.kind, 'reject', `相对越界应 reject，实际 ${JSON.stringify(out)}`);
  assert.ok(out.value.reason.includes('outside workspace'));
}

console.log('PASS test-bridge.mjs (10 assertion groups)');
