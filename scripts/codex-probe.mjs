import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
const proc = spawn(process.env.HARNESS_CODEX_BIN || 'codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
let next = 0;
const pending = new Map();
const events = [];
const completion = [];
const send = value => proc.stdin.write(JSON.stringify(value) + '\n');
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
createInterface({ input: proc.stdout }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && !msg.method) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(JSON.stringify(msg.error))); else p?.resolve(msg.result);
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: 'Probe does not authorize tools or external actions' } });
  } else {
    events.push({ method: msg.method, threadId: msg.params?.threadId, ...(msg.method === 'error' || msg.method === 'turn/completed' ? { detail: msg.params } : {}) });
    if (msg.method === 'turn/completed') completion.splice(0).forEach(fn => fn(msg.params));
  }
});
let err = ''; proc.stderr.on('data', data => { err = (err + data.toString()).slice(-2000); });
const timer = setTimeout(() => { console.error('Codex probe timed out'); proc.kill(); process.exitCode = 1; }, 90000);
try {
  const init = await request('initialize', { clientInfo: { name: 'project_harness_probe', title: 'Harness 接入验收', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized' });
  const listed = await request('thread/list', { cwd: process.cwd(), searchTerm: 'Harness 接入验收', limit: 10 });
  const previous = listed.data?.find(t => t.name === 'Harness 接入验收 · 只读探针');
  const created = previous ? await request('thread/resume', { threadId: previous.id, excludeTurns: true }) : await request('thread/start', { cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false });
  const threadId = created.thread.id;
  await request('thread/name/set', { threadId, name: 'Harness 接入验收 · 只读探针' });
  const done = new Promise(resolve => completion.push(resolve));
  await request('turn/start', { threadId, input: [{ type: 'text', text: '这是用户明确授权的软件 Harness 接入验收。只回复 HARNESS_CONNECTION_OK，不调用工具、不读取文件、不改动文件。', text_elements: [] }] });
  const outcome = await done;
  const items = await request('thread/turns/list', { threadId, limit: 10, itemsView: 'full' });
  const report = { at: new Date().toISOString(), client: init, threadId, link: `codex://threads/${threadId}`, status: outcome.turn.status, outcome, events, items: items.data };
  await mkdir('.harness/runtime', { recursive: true });
  await writeFile('.harness/runtime/codex-probe.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ threadId, link: report.link, status: report.status, eventCount: events.length, turns: items.data?.length }, null, 2));
  if (outcome.turn.status !== 'completed') process.exitCode = 1;
  if (outcome.turn.error) console.error(JSON.stringify(outcome.turn.error));
} catch (error) { console.error(error.message); if (err) console.error(err); process.exitCode = 1; }
finally { clearTimeout(timer); proc.kill(); }
