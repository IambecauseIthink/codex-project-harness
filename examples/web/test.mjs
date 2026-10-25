import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './server.mjs';
test('默认问候与真实 HTTP 入口', async () => {
  const server = app(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await (await fetch(base + '/api/greeting')).json()).message, '你好，朋友');
    const html = await (await fetch(base)).text(); assert.match(html, /生成问候/); assert.match(html, /name="name"/);
  } finally { await new Promise(r => server.close(r)); }
});
