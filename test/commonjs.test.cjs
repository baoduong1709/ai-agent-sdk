'use strict';
// Backends compiled to CommonJS (NestJS, ts-node) load the SDK with require(), not import.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const entryPoints = {
  'agent-studio-sdk': ['createSDK', 'defineTool', 'ToolError', 'ModelError', 'MemorySessionStore'],
  'agent-studio-sdk/models': ['createModel', 'stripThinking'],
  'agent-studio-sdk/openai': ['createOpenAIModel'],
  'agent-studio-sdk/http-tool': ['defineHttpTool', 'httpStatusError'],
  'agent-studio-sdk/mcp': ['connectMcp'],
};

test('require() loads every entry point and returns the same module as import', async () => {
  for (const [path, names] of Object.entries(entryPoints)) {
    const required = require(path);
    const imported = await import(path);
    for (const name of names) {
      assert.equal(typeof required[name], 'function', `${path} exports ${name}`);
      assert.equal(required[name], imported[name], `${path} ${name} is one shared copy`);
    }
  }
});

test('a tool written in CommonJS can stop with ToolError and the agent reads its code', async () => {
  const { createSDK, defineTool, ToolError } = require('agent-studio-sdk');
  const tool = defineTool({
    name: 'leave_balance', description: 'Leave balance of an employee',
    parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
    execute() { throw new ToolError('forbidden', 'You may only view your own balance.'); },
  });
  const model = { async generate({ steps }) {
    if (steps.length) return { text: `Tool said ${steps[0].outputs[0].output.error.code}.` };
    return { toolCalls: [{ id: '1', name: 'leave_balance', arguments: '{"email":"lan@example.test"}' }] };
  } };
  const result = await createSDK({ model, tools: [tool] }).createAgent({ systemPrompt: 'Answer', tools: ['leave_balance'] })
    .run({ sessionId: '1', message: 'How many leave days does Lan have?' });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Tool said forbidden.');
});
