import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { desktopRequest } from '../../cli/src/commands/desktopCall';

test('desktop calls use the local authenticated bridge and do not follow redirects', async () => {
  const token = 'fixture_token_that_is_long_enough_12345';
  let received = '';
  let redirected = false;
  const destination = http.createServer((_request, response) => { redirected = true; response.end('{}'); });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const destinationPort = (destination.address() as { port: number }).port;
  const server = http.createServer((request, response) => {
    received = request.headers.authorization ?? '';
    if (request.url !== '/mcp') { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"exists":true}' }] } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    assert.deepEqual(await desktopRequest(port, token, 'get_website_draft', { projectId: 'p1' }, 5), { exists: true });
    assert.equal(received, `Bearer ${token}`);
    const redirect = http.createServer((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/` }); response.end(); });
    redirect.listen(0, '127.0.0.1');
    await once(redirect, 'listening');
    try { await assert.rejects(desktopRequest((redirect.address() as { port: number }).port, token, 'get_website_draft', {}, 5)); }
    finally { redirect.close(); }
    assert.equal(redirected, false);
  } finally { server.close(); destination.close(); }
});
