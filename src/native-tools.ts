// ═══════════════════════════════════════════════
//  原生 14 tools —— 从抓包夹具加载，顺序即指纹
//  形状：docs/native-tools.capture.json（数组，索引 0..13）
// ═══════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { ToolEntry } from './types';

/** dist/ 与 src/ 都能定位到仓库 docs/ */
function resolveCapturePath(): string {
  const candidates = [
    path.join(__dirname, '..', 'docs', 'native-tools.capture.json'),
    path.join(__dirname, '..', '..', 'docs', 'native-tools.capture.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `native-tools.capture.json 未找到；尝试过: ${candidates.join(', ')}`,
  );
}

function loadAndAssert(): ToolEntry[] {
  const raw = JSON.parse(fs.readFileSync(resolveCapturePath(), 'utf8'));

  // 夹具是数组；若将来变成 {"0":…,"13":…} 也兼容
  let tools: ToolEntry[];
  if (Array.isArray(raw)) {
    tools = raw as ToolEntry[];
  } else if (raw && typeof raw === 'object') {
    tools = [];
    for (let i = 0; i < 14; i++) {
      const item = (raw as Record<string, ToolEntry>)[String(i)];
      if (!item) {
        throw new Error(`native-tools.capture.json 缺键 "${i}"`);
      }
      tools.push(item);
    }
  } else {
    throw new Error('native-tools.capture.json 既非数组也非对象');
  }

  if (tools.length !== 14) {
    throw new Error(`原生 tools 应为 14 项，实际 ${tools.length}`);
  }

  for (let i = 0; i < tools.length; i++) {
    const decls = tools[i]?.functionDeclarations;
    if (!Array.isArray(decls) || decls.length !== 1) {
      throw new Error(
        `tools[${i}] 应恰好 1 个 functionDeclaration，实际 ${decls?.length ?? 0}`,
      );
    }
    const required = decls[0]?.parameters?.required;
    if (!Array.isArray(required)) {
      throw new Error(`tools[${i}].parameters.required 缺失`);
    }
    if (!required.includes('toolAction') || !required.includes('toolSummary')) {
      throw new Error(
        `tools[${i}] (${decls[0].name}) required 必须含 toolAction 与 toolSummary，实际 ${JSON.stringify(required)}`,
      );
    }
  }

  return tools;
}

const TOOLS: ToolEntry[] = loadAndAssert();

/** 14 个名字，顺序与 capture 索引 0..13 一致（从夹具派生，非硬编码） */
export const NATIVE_TOOL_NAMES: readonly string[] = TOOLS.map(
  (t) => t.functionDeclarations[0].name,
);

const NATIVE_NAME_SET = new Set(NATIVE_TOOL_NAMES);

/** 返回 14 项原生 ToolEntry（只读缓存；顺序 = capture 0..13） */
export function getNativeTools(): ToolEntry[] {
  return TOOLS;
}

export function isNativeTool(name: string): boolean {
  return NATIVE_NAME_SET.has(name);
}
