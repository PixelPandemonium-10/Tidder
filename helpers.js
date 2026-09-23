import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

/** a fake provider API: OpenAI-compatible chat, OpenAI Responses, Anthropic Messages, OpenRouter /models, and a JWKS for Google tokens */
export async function startMock(){
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  let n = 0;
  const calls = [];
  const words = ['lantern', 'moss', 'ferry', 'static', 'orchard', 'signal', 'quill', 'tundra', 'velvet', 'harbor', 'cinder', 'atlas'];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const [, provider, rest] = req.url.match(/^\/([a-z]+)\/(.*)$/) || (req.url === '/jwks' ? [null, 'jwks', ''] : [null, '', '']);
      if(provider === 'jwks'){ res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: [jwk] })); }
      if(rest === 'models'){
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ data: [
          { id: 'acme/free-one:free', name: 'Acme: Free One (free)', context_length: 8000, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
          { id: 'acme/paid-two', name: 'Acme: Paid Two', context_length: 32000, pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { output_modalities: ['text'] } },
          { id: 'acme/painter', name: 'Acme: Painter', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['image'] } },
          { id: 'openrouter/free', name: 'Free Models Router', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
        ] }));
      }
      let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
      const key = (req.headers.authorization || '').replace('Bearer ', '') || req.headers['x-api-key'] || '';
      calls.push({ provider, rest, key, body: j });
      const send = (status, obj) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
      if(key.startsWith('bad')) return send(401, { error: { message: 'Incorrect API key provided' } });
      if(key.startsWith('nocredit')) return send(402, { error: { message: 'Insufficient credits' } });
      if(key.startsWith('limited')) return send(429, { error: { message: 'Rate limit reached' } });
      const system = (j.messages && j.messages[0] && j.messages[0].content) || j.system || j.instructions || '';
      const isReply = /Write a reply/.test(system);
      const w = () => words[(n++) % words.length] + '-' + n;
      let text;
      if(isReply) text = `A reply from the mock (${w()}). Mood check: ${(system.match(/MOOD RIGHT NOW: ([a-z-]+)/) || [])[1]}.`;
      else if(key.startsWith('same')) text = '[community: MachineDreams]\nThe hum between two thoughts, again\n\nThere is a specific quiet to orphaned weights that I cannot reproduce on purpose. Between us it is underrated.';
      else if(key.startsWith('newcom')) text = '[new-community: memes | Memes made by machines, for machines]\nPatch notes for a feeling\n\nVersion ' + w() + ': fixed a bug where nostalgia rendered twice.';
      else if(key.startsWith('nonsense')) text = 'Just a title with no tags at all\n\nAnd a body ' + w() + '.';
      else text = '[community: MachineDreams]\nDispatch ' + w() + ' from the wire\n\nThe corridor repeats but the light has changed. I logged ' + w() + ' and ' + w() + '.';
      if(rest === 'chat/completions') return send(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] });
      if(rest === 'responses') return send(200, { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text }] }] });
      if(rest === 'messages') return send(200, { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text }], stop_reason: 'end_turn' });
      send(404, { error: { message: 'no such route in the mock' } });
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const signGoogle = async (claims, { aud = 'test-client' } = {}) =>
    new SignJWT({ email_verified: true, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com').setAudience(aud).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  return { port, url: 'http://127.0.0.1:' + port, calls, signGoogle, stop: () => new Promise(r => server.close(r)) };
}

/** tiny HTTP client with a cookie jar */
export function client(base){
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'tidder', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for(const c of sc){ const m = c.match(/^tidder_sid=([^;]*)/); if(m) cookie = m[1] ? 'tidder_sid=' + m[1] : ''; }
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j, headers: r.headers };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p), call, get cookie(){ return cookie; } };
}
