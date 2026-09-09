// T2 —— SSE 解析（喂假帧，不发网络）
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const client = await import(path.join(root, 'dist/antigravity-client.js'));
const {
  parseSseLine,
  createStreamAcc,
  accumulateFrame,
  AntigravityError,
  SseLineReader,
} = client;

// 2.1 多帧 text 增量按序拼接（§1.4）
{
  const acc = createStreamAcc();
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] }, finishReason: null }],
    },
  });
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'lo ' }] }, finishReason: null }],
    },
  });
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'world' }] }, finishReason: null }],
    },
  });
  assert.equal(acc.text, 'Hello world');
}

// 2.2 FC part 进 fcParts 后 thoughtSignature 字符串相等且引用相同（§1.3 硬规则 2）
{
  const acc = createStreamAcc();
  const part = {
    functionCall: { id: 'tAyN1Fx2', name: 'list_dir', args: { DirectoryPath: '/tmp' } },
    thoughtSignature: 'EuULCuILARFNMg/sig-must-keep',
  };
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [part] }, finishReason: null }],
    },
  });
  assert.equal(acc.fcParts.length, 1);
  assert.equal(acc.fcParts[0].thoughtSignature, part.thoughtSignature);
  assert.strictEqual(acc.fcParts[0], part);
}

// 2.3 末帧 {thoughtSignature, text:''} + STOP：text/fcParts 不变（§1.4）
{
  const acc = createStreamAcc();
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: null }],
    },
  });
  const fc = {
    functionCall: { id: 'x', name: 'list_dir', args: {} },
    thoughtSignature: 'sig',
  };
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [fc] }, finishReason: null }],
    },
  });
  const textBefore = acc.text;
  const fcLenBefore = acc.fcParts.length;
  accumulateFrame(acc, {
    response: {
      candidates: [
        {
          content: { role: 'model', parts: [{ thoughtSignature: 'X', text: '' }] },
          finishReason: 'STOP',
        },
      ],
    },
  });
  assert.equal(acc.text, textBefore);
  assert.equal(acc.fcParts.length, fcLenBefore);
  assert.equal(acc.finishReason, 'STOP');
}

// 2.4 usageMetadata 三帧递增值 → 最终等于最后一帧（覆盖，不是求和）（§1.4）
{
  const acc = createStreamAcc();
  for (const n of [5, 12, 21]) {
    accumulateFrame(acc, {
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: '.' }] }, finishReason: null }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: n,
          totalTokenCount: 100 + n,
          thoughtsTokenCount: 3,
          cachedContentTokenCount: 50,
        },
      },
    });
  }
  assert.equal(acc.usage.completionTokens, 21);
  assert.equal(acc.usage.promptTokens, 100);
}

// 2.5 finishReason 取最后一个非 null（§1.4）
{
  const acc = createStreamAcc();
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'a' }] }, finishReason: null }],
    },
  });
  assert.equal(acc.finishReason, null);
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text: 'b' }] }, finishReason: 'STOP' }],
    },
  });
  assert.equal(acc.finishReason, 'STOP');
  accumulateFrame(acc, {
    response: {
      candidates: [
        { content: { role: 'model', parts: [{ text: 'c' }] }, finishReason: 'MAX_TOKENS' },
      ],
    },
  });
  assert.equal(acc.finishReason, 'MAX_TOKENS');
}

// 2.6 parseSseLine
{
  const obj = parseSseLine('data: {"a":1}');
  assert.deepEqual(obj, { a: 1 });
  assert.equal(parseSseLine(''), null);
  assert.equal(parseSseLine(': ping'), null);
}

// 2.7 一帧含 2 个 FC part（仅第一个带 sig）→ 两个都进 fcParts，顺序不变（§1.3 硬规则 3）
{
  const acc = createStreamAcc();
  const p1 = {
    functionCall: { id: 'a', name: 'list_dir', args: {} },
    thoughtSignature: 'only-first',
  };
  const p2 = {
    functionCall: { id: 'b', name: 'view_file', args: {} },
  };
  accumulateFrame(acc, {
    response: {
      candidates: [{ content: { role: 'model', parts: [p1, p2] }, finishReason: null }],
    },
  });
  assert.equal(acc.fcParts.length, 2);
  assert.strictEqual(acc.fcParts[0], p1);
  assert.strictEqual(acc.fcParts[1], p2);
  assert.equal(acc.fcParts[0].thoughtSignature, 'only-first');
  assert.equal(acc.fcParts[1].thoughtSignature, undefined);
}

// 2.8 frame.error = {code:401} → AntigravityError.status === 401
{
  let err;
  try {
    accumulateFrame(createStreamAcc(), { error: { code: 401, message: 'unauth' } });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AntigravityError, 'must be AntigravityError');
  assert.equal(err.status, 401);
}

// 2.9 400 且 message 含 thought_signature → 提示会话不可恢复（§1.3）
{
  let err;
  try {
    accumulateFrame(createStreamAcc(), {
      error: {
        code: 400,
        message: 'Function call is missing a thought_signature in functionCall parts',
        status: 'INVALID_ARGUMENT',
      },
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof AntigravityError);
  assert.equal(err.status, 400);
  assert.match(err.message, /不可恢复|thoughtSignature 丢失/);
}

// 2.10 UTF-8 跨 chunk：3 字节汉字/制表符切在中间不得变成 U+FFFD
{
  const feed = (bytes, size) => {
    const r = new SseLineReader();
    const out = [];
    for (let i = 0; i < bytes.length; i += size) {
      out.push(...r.push(bytes.subarray(i, i + size)));
    }
    const rest = r.end();
    if (rest) out.push(rest);
    return out;
  };

  const text = '质结拟功付─┬';
  const sse = Buffer.from(
    `data: {"response":{"candidates":[{"content":{"parts":[{"text":${JSON.stringify(text)}}]}}]}}\n`,
    'utf8',
  );
  const idx = sse.indexOf(Buffer.from('质'));
  const r = new SseLineReader();
  assert.equal(r.push(sse.subarray(0, idx + 2)).length, 0);
  const lines = r.push(sse.subarray(idx + 2));
  assert.equal(lines.length, 1);
  assert.equal(parseSseLine(lines[0]).response.candidates[0].content.parts[0].text, text);

  const contents = `${'质'.repeat(4000)}结拟功付${'─'.repeat(80)}┬`;
  const fcLine = Buffer.from(
    `data: ${JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'w1',
                    name: 'write_to_file',
                    args: { Contents: contents },
                  },
                },
              ],
            },
          },
        ],
      },
    })}\n`,
    'utf8',
  );
  for (const size of [1, 2, 7, 4096]) {
    const gotLines = feed(fcLine, size);
    assert.equal(gotLines.length, 1, `chunk ${size}`);
    const got = parseSseLine(gotLines[0]).response.candidates[0].content.parts[0].functionCall.args
      .Contents;
    assert.equal(got, contents, `chunk ${size} must not insert U+FFFD`);
    assert.equal(got.includes('�'), false);
  }
}

console.log('PASS test-sse.mjs (10 assertion groups)');
