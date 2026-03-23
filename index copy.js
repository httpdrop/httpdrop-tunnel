#!/usr/bin/env node
'use strict';
/**
 * @httpdrop/tunnel — CLI
 *
 * Uso:
 *   npx @httpdrop/tunnel --token mapi_xxx --port 3000
 *   npx @httpdrop/tunnel --token mapi_xxx --port 8080 --host https://httpdrop.dev
 *
 * O que faz:
 *   1. Conecta via WebSocket no servidor httpdrop
 *   2. Recebe requests externos encaminhados pelo servidor
 *   3. Faz fetch em localhost:PORT e devolve a resposta
 *   4. Exibe log no terminal em tempo real
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const net    = require('net');

// ── Parse de args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf('--' + name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const TOKEN       = getArg('token', process.env.HTTPDROP_TOKEN || '');
const PORT        = parseInt(getArg('port', '3000'), 10);
const SERVER_HOST = getArg('host', 'https://httpdrop.dev').replace(/\/$/, '');
const HELP        = args.includes('--help') || args.includes('-h');

if (HELP || !TOKEN) {
  console.log(`
  httpdrop tunnel — expõe localhost para a internet

  Uso:
    npx @httpdrop/tunnel --token <TOKEN> --port <PORT>

  Opções:
    --token   Token de API do httpdrop (obrigatório)
              Gere em: httpdrop.dev → Tokens
    --port    Porta local para encaminhar (padrão: 3000)
    --host    Servidor httpdrop (padrão: https://httpdrop.dev)

  Exemplos:
    npx @httpdrop/tunnel --token mapi_abc123 --port 3000
    npx @httpdrop/tunnel --token mapi_abc123 --port 8080
  `);
  process.exit(TOKEN ? 0 : 1);
}

// ── Estado ────────────────────────────────────────────────────────────────────
let reconnectDelay = 1000;
let connected      = false;
let tunnelUrl      = null;

// ── Cores no terminal ────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  bold:   '\x1b[1m',
};

function log(method, path, status, ms) {
  const statusColor = status >= 500 ? c.red : status >= 400 ? c.yellow : c.green;
  const methodColor = { GET: c.blue, POST: c.green, DELETE: c.red, PUT: c.yellow, PATCH: c.cyan }[method] || c.gray;
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `  ${c.gray}→${c.reset} ${methodColor}${pad(method, 7)}${c.reset}` +
    ` ${c.bold}${path}${c.reset}` +
    ` ${statusColor}${status}${c.reset}` +
    ` ${c.gray}${ms}ms${c.reset}`
  );
}

// ── Banner ────────────────────────────────────────────────────────────────────
function printBanner(url) {
  console.log('');
  console.log(`  ${c.green}${c.bold}✓ Tunnel ativo!${c.reset}`);
  console.log('');
  console.log(`  ${c.gray}URL pública:${c.reset}  ${c.bold}${c.cyan}${url}${c.reset}`);
  console.log(`  ${c.gray}Porta local:${c.reset}  localhost:${PORT}`);
  console.log('');
  console.log(`  ${c.gray}Cole essa URL no Stripe, GitHub ou qualquer serviço de webhook.${c.reset}`);
  console.log(`  ${c.gray}Ctrl+C para encerrar.${c.reset}`);
  console.log('');
  console.log(`  ${c.gray}${'─'.repeat(50)}${c.reset}`);
  console.log('');
}

// ── WS helpers ────────────────────────────────────────────────────────────────
function wsFrame(data) {
  const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126)        header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) header = Buffer.from([0x81, 0xfe, (len >> 8) & 0xff, len & 0xff]);
  else                  header = Buffer.from([0x81, 0xff, 0,0,0,0,(len>>24)&0xff,(len>>16)&0xff,(len>>8)&0xff,len&0xff]);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function wsParseFrame(buf) {
  if (buf.length < 2) return null;
  const masked  = (buf[1] & 0x80) !== 0;
  let   len     = buf[1] & 0x7f;
  let   offset  = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = (buf[2] << 8) | buf[3]; offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    offset = 10;
  }
  const total = offset + (masked ? 4 : 0) + len;
  if (buf.length < total) return null;
  let data = buf.slice(offset + (masked ? 4 : 0), total);
  if (masked) {
    const mask = buf.slice(offset, offset + 4);
    data = Buffer.from(data);
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  }
  return { data: data.toString('utf8'), consumed: total };
}

// ── Fazer fetch no localhost ──────────────────────────────────────────────────
function fetchLocal(method, path, headers, body) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'localhost',
      port:     PORT,
      path:     path,
      method:   method,
      headers:  { ...headers, host: `localhost:${PORT}` },
    };

    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({
          status:  res.statusCode,
          headers: res.headers,
          body:    Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('error', err => {
      resolve({
        status:  502,
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ error: 'Local server error', message: err.message }),
      });
    });

    req.setTimeout(25000, () => {
      req.destroy();
      resolve({
        status:  504,
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ error: 'Local server timeout' }),
      });
    });

    if (body) req.write(body);
    req.end();
  });
}

// ── Conectar ao servidor httpdrop ─────────────────────────────────────────────
function connect() {
  const wsUrl   = SERVER_HOST.replace('https://', 'wss://').replace('http://', 'ws://') + '/tunnel-ws';
  const isHttps = wsUrl.startsWith('wss://');
  const urlObj  = new URL(wsUrl.replace('wss://', 'https://').replace('ws://', 'http://'));

  const wsKey    = crypto.randomBytes(16).toString('base64');
  const reqOpts  = {
    hostname: urlObj.hostname,
    port:     urlObj.port || (isHttps ? 443 : 80),
    path:     urlObj.pathname,
    method:   'GET',
    headers: {
      'host':                   urlObj.hostname,
      'upgrade':                'websocket',
      'connection':             'Upgrade',
      'sec-websocket-key':      wsKey,
      'sec-websocket-version':  '13',
      'authorization':          `Bearer ${TOKEN}`,
    },
  };

  console.log(`  ${c.gray}Conectando em ${SERVER_HOST}...${c.reset}`);

  const transport = isHttps ? https : http;
  const req = transport.request(reqOpts);

  req.on('error', err => {
    console.error(`  ${c.red}✗ Erro de conexão:${c.reset} ${err.message}`);
    scheduleReconnect();
  });

  req.on('upgrade', (res, socket) => {
    connected = true;
    reconnectDelay = 1000;

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const frame = wsParseFrame(buf);
        if (!frame) break;
        buf = buf.slice(frame.consumed);
        handleMessage(socket, frame.data);
      }
    });

    const cleanup = () => {
      if (!connected) return;
      connected = false;
      tunnelUrl = null;
      console.log(`\n  ${c.yellow}Tunnel desconectado.${c.reset}`);
      scheduleReconnect();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    // Ping a cada 25s para manter o socket vivo
    const pingInterval = setInterval(() => {
      if (!socket.writable) { clearInterval(pingInterval); return; }
      try { socket.write(Buffer.from([0x89, 0x00])); } catch(_) {} // ping frame
    }, 25000);
  });

  req.end();
}

// ── Processar mensagem do servidor ────────────────────────────────────────────
async function handleMessage(socket, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }

  if (msg.event === 'connected') {
    tunnelUrl = msg.tunnelUrl;
    printBanner(tunnelUrl);
    return;
  }

  if (msg.event === 'request') {
    const { requestId, method, path, headers, body } = msg;
    const start = Date.now();

    process.stdout.write(`  ${c.gray}encaminhando: ${method} ${path}${c.reset}\n`);
    const response = await fetchLocal(method, path, headers || {}, body || null);
    const ms = Date.now() - start;

    log(method, path, response.status, ms);

    socket.write(wsFrame(JSON.stringify({
      requestId,
      status:  response.status,
      headers: response.headers,
      body:    response.body,
    })));
  }
}

// ── Reconexão com backoff exponencial ────────────────────────────────────────
function scheduleReconnect() {
  console.log(`  ${c.gray}Reconectando em ${reconnectDelay / 1000}s...${c.reset}`);
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    connect();
  }, reconnectDelay);
}

// ── Iniciar ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`  ${c.bold}httpdrop tunnel${c.reset} ${c.gray}v1.0.0${c.reset}`);
console.log(`  ${c.gray}token: ${TOKEN.slice(0, 12)}...  porta: ${PORT}${c.reset}`);
console.log('');

connect();

process.on('SIGINT', () => {
  console.log(`\n  ${c.gray}Encerrando tunnel...${c.reset}\n`);
  process.exit(0);
});