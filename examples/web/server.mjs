import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
export function app() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/greeting') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ message: '你好，朋友' }));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>问候产品</title><h1>问候产品</h1>
      <form><label>你的名字<input name="name"></label><button>生成问候</button></form><p role="status"></p>
      <script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const name=new FormData(e.target).get('name');const r=await fetch('/api/greeting?name='+encodeURIComponent(name));document.querySelector('[role=status]').textContent=(await r.json()).message;};</script>`);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = app(); server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
}
