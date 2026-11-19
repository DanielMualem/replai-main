#!/usr/bin/env node
'use strict';

// Lightweight GitHub deploy webhook — zero external dependencies
// Listens on 127.0.0.1:9000 (Nginx proxies to it)

const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = 9000;
const HOST = '127.0.0.1';
const SECRET = process.env.DEPLOY_WEBHOOK_SECRET;
const REPO_DIR = '/opt/replai';
const BRANCH = 'main';

if (!SECRET) {
  console.error('DEPLOY_WEBHOOK_SECRET is required');
  process.exit(1);
}

let deploying = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function verifySignature(payload, signature) {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function deploy() {
  if (deploying) {
    log('Deploy already in progress, skipping');
    return;
  }
  deploying = true;
  log('Starting deploy...');

  const script = `
    cd ${REPO_DIR} &&
    git fetch origin ${BRANCH} &&
    git reset --hard origin/${BRANCH} &&
    npm install --production &&
    sudo systemctl restart replai
  `;

  execFile('/bin/bash', ['-c', script], { timeout: 120000 }, (err, stdout, stderr) => {
    deploying = false;
    if (err) {
      log(`Deploy FAILED: ${err.message}`);
      if (stderr) log(`stderr: ${stderr}`);
    } else {
      log('Deploy completed successfully');
    }
    if (stdout) log(`stdout: ${stdout}`);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/hooks/deploy') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const signature = req.headers['x-hub-signature-256'];

    if (!verifySignature(body, signature)) {
      log('Invalid signature — rejected');
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString());
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    const ref = payload.ref;
    if (ref !== `refs/heads/${BRANCH}`) {
      log(`Push to ${ref}, ignoring (only ${BRANCH} triggers deploy)`);
      res.writeHead(200);
      res.end('Ignored — not target branch');
      return;
    }

    log(`Push to ${BRANCH} detected — triggering deploy`);
    res.writeHead(200);
    res.end('Deploy triggered');
    deploy();
  });
});

server.listen(PORT, HOST, () => {
  log(`Deploy webhook listening on ${HOST}:${PORT}`);
});
