import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineClient, LINEError, splitText, validateMessages, verifySignature } from '../src/line.mjs';

const USER = `U${'1'.repeat(32)}`;
const GROUP = `C${'2'.repeat(32)}`;
const ROOM = `R${'3'.repeat(32)}`;
const TOKEN = 'sensitive-access-token';
const SECRET = 'sensitive-channel-secret';
const account = { accountId: 'test', channelAccessToken: TOKEN, channelSecret: SECRET };
const text = [{ type: 'text', text: 'Hello' }];
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

test('signature authenticates raw bytes and rejects edits, missing and malformed signatures', () => {
  const raw = Buffer.from('{ "events": [] }');
  const signature = createHmac('sha256', SECRET).update(raw).digest('base64');
  assert.equal(verifySignature(raw, signature, SECRET), true);
  assert.equal(verifySignature('{"events":[]}', signature, SECRET), false);
  assert.equal(verifySignature(raw, signature, 'wrong'), false);
  assert.equal(verifySignature(raw, signature.slice(1), SECRET), false);
  assert.equal(verifySignature(raw, '', SECRET), false);
  assert.equal(verifySignature(raw, signature, ''), false);
});

test('splits preserve every character and never introduce a split surrogate pair', () => {
  const original = `${'a'.repeat(4999)}😀\n${'日本語'.repeat(2000)}😀`;
  const chunks = splitText(original);
  assert.equal(chunks.join(''), original);
  assert(chunks.every((chunk) => chunk.length <= 5000));
  for (const chunk of chunks) {
    assert(!/[\uD800-\uDBFF]$/.test(chunk));
    assert(!/^[\uDC00-\uDFFF]/.test(chunk));
  }
  assert.deepEqual(splitText(''), []);
  assert.deepEqual(splitText('😀😀a', 2), ['😀', '😀', 'a']);
  assert.throws(() => splitText('a', 1), RangeError);
});

test('outbound validation accepts supported native families and enforces provider limits', () => {
  for (const message of [
    ...text,
    { type: 'image', originalContentUrl: 'https://example.com/i.png', previewImageUrl: 'https://example.com/p.png' },
    { type: 'video', originalContentUrl: 'https://example.com/v.mp4', previewImageUrl: 'https://example.com/p.png' },
    { type: 'audio', originalContentUrl: 'https://example.com/a.m4a', duration: 60000 },
    { type: 'sticker', packageId: '1', stickerId: '2' },
    { type: 'location', title: 'Office', address: 'Tokyo', latitude: 35.6, longitude: 139.7 },
    { type: 'template', altText: 'Confirm', template: { type: 'confirm', text: 'Continue?', actions: [
      { type: 'message', label: 'Yes', text: 'yes' }, { type: 'postback', label: 'No', data: 'no' },
    ] } },
    { type: 'flex', altText: 'Details', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'Details' }] } } },
  ]) assert.equal(validateMessages([message])[0], message);
  for (const messages of [
    [], Array(6).fill(text[0]), [{ type: 'text', text: 'a'.repeat(5001) }],
    [{ type: 'image', originalContentUrl: 'http://example.com/i.png', previewImageUrl: 'https://example.com/p.png' }],
    [{ type: 'image', originalContentUrl: 'https://127.0.0.1/i.png', previewImageUrl: 'https://example.com/p.png' }],
    [{ type: 'audio', originalContentUrl: 'https://example.com/a.mp3', duration: 0 }],
    [{ type: 'video', originalContentUrl: 'https://example.com/v.mp4' }],
    [{ type: 'location', title: 'A', address: 'B', latitude: 91, longitude: 0 }],
    [{ type: 'file', originalContentUrl: 'https://example.com/a.pdf' }],
  ]) assert.throws(() => validateMessages(messages), (error) => error instanceof LINEError && !error.retryable);
});

test('quick replies and nested Flex actions validate their own limits', () => {
  const item = { type: 'action', action: { type: 'postback', label: 'Choose', data: 'a' } };
  assert.doesNotThrow(() => validateMessages([{ ...text[0], quickReply: { items: Array(13).fill(item) } }]));
  assert.throws(() => validateMessages([{ ...text[0], quickReply: { items: Array(14).fill(item) } }]));
  assert.throws(() => validateMessages([{ ...text[0], quickReply: { items: [{ ...item, action: { ...item.action, label: 'a'.repeat(21) } }] } }]));
  assert.throws(() => validateMessages([{ type: 'flex', altText: 'A', contents: {
    type: 'bubble', footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'uri', label: 'A', uri: 'javascript:alert(1)' } }] },
  } }]));
  assert.throws(() => validateMessages([{ type: 'flex', altText: 'A', contents: { type: 'bubble', body: { type: 'box', contents: [{ type: 'text', text: 'a'.repeat(30001) }] } } }]));
});

test('push preserves caller retry key and exposes provider message IDs on initial and duplicate acceptance', async () => {
  const key = randomUUID();
  const calls = [];
  const client = new LineClient(account, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return json({ sentMessages: [{ id: '100', quoteToken: 'quote' }] }, calls.length === 1 ? 200 : 409,
      calls.length === 1 ? { 'x-line-request-id': 'first' } : { 'x-line-accepted-request-id': 'first' });
  } });
  const first = await client.push(`line:user:${USER}`, text, key);
  const second = await client.push(USER, text, key);
  assert.equal(first.accepted, true);
  assert.deepEqual(first.messageIds, ['100']);
  assert.equal(second.duplicate, true);
  assert.equal(second.acceptedRequestId, 'first');
  assert.deepEqual(second.messageIds, ['100']);
  assert(calls.every((call) => call.init.headers['X-Line-Retry-Key'] === key));
  assert.equal(calls[0].init.body, calls[1].init.body);
});

test('accepted retry conflict remains successful even if its receipt cannot be parsed', async () => {
  const client = new LineClient(account, { fetchImpl: async () => new Response('invalid JSON', {
    status: 409, headers: { 'x-line-accepted-request-id': 'accepted' },
  }) });
  const result = await client.push(USER, text, randomUUID());
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.receiptComplete, false);
});

test('reply fallback eligibility distinguishes an invalid token from a rejected rich payload', async () => {
  for (const [body, expected] of [['Invalid reply token', true], ['The request body has 1 error(s)', false]]) {
    const client = new LineClient(account, { fetchImpl: async () => json({ message: body }, 400) });
    await assert.rejects(client.reply('reply', text), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.invalidReplyToken, expected);
      assert.equal(error.uncertain, false);
      assert.equal(error.retryable, false);
      return true;
    });
  }
});

test('network and server failures preserve uncertain reply outcomes and never expose credentials', async () => {
  const offline = new LineClient(account, { fetchImpl: async () => { throw new Error(`Failed Bearer ${TOKEN}`); } });
  await assert.rejects(offline.reply('reply', text), (error) => error.uncertain && !error.retryable && !String(error).includes(TOKEN));
  await assert.rejects(offline.push(USER, text, randomUUID()), (error) => error.uncertain && error.retryable);
  const refused = new LineClient(account, { fetchImpl: async () => json({ message: `${TOKEN} ${SECRET}` }, 401) });
  await assert.rejects(refused.push(USER, text), (error) => {
    assert(!String(error).includes(TOKEN));
    assert(!JSON.stringify(error).includes(SECRET));
    assert.equal(error.retryable, false);
    assert.equal(error.uncertain, false);
    return true;
  });
  assert(!JSON.stringify(refused).includes(TOKEN));
  const server = new LineClient(account, { fetchImpl: async () => json({ message: 'Internal server error' }, 500) });
  await assert.rejects(server.reply('reply', text), (error) => error.uncertain && !error.retryable);
});

test('successful send with corrupt receipt is committed and cannot be safely replayed', async () => {
  const client = new LineClient(account, { fetchImpl: async () => new Response('not json') });
  await assert.rejects(client.reply('reply', text), (error) => error.accepted && error.uncertain && !error.retryable);
});

test('client validates before issuing requests and loading uses direct-user endpoint only', async () => {
  const calls = [];
  const client = new LineClient(account, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return json({ displayName: 'Bot' });
  } });
  await assert.rejects(client.push(USER.toLowerCase(), text));
  await assert.rejects(client.push(USER, Array(6).fill(text[0])));
  await assert.rejects(client.loading(GROUP));
  assert.equal(calls.length, 0);
  await client.loading(USER);
  await client.profile(USER, { groupId: GROUP });
  await client.profile(USER, { roomId: ROOM });
  await client.botInfo();
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/chat/loading/start');
  assert.deepEqual(JSON.parse(calls[0].init.body), { chatId: USER, loadingSeconds: 20 });
  assert(calls[1].url.endsWith(`/group/${GROUP}/member/${USER}`));
  assert(calls[2].url.endsWith(`/room/${ROOM}/member/${USER}`));
  assert(calls[3].url.endsWith('/info'));
});

test('media download persists complete bytes with private file mode and normalized MIME', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-line-media-'));
  try {
    const client = new LineClient(account, { fetchImpl: async () => new Response('image data', {
      headers: { 'content-type': 'Image/PNG; charset=binary', 'content-length': '10' },
    }) });
    const result = await client.download('123', join(dir, 'image.bin'), 10);
    assert.equal(result.size, 10);
    assert.equal(result.contentType, 'image/png');
    assert.equal(await readFile(result.path, 'utf8'), 'image data');
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), ['image.bin']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('media header and actual stream sizes are enforced and partial files are removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-line-limit-'));
  try {
    for (const headers of [{ 'content-length': '20' }, {}]) {
      const client = new LineClient(account, { fetchImpl: async () => new Response('too large', { headers }) });
      await assert.rejects(client.download('123', join(dir, 'file.bin'), 4), (error) => error.code === 'MEDIA_TOO_LARGE' && !error.retryable);
      assert.deepEqual(await readdir(dir), []);
    }
    const mismatch = new LineClient(account, { fetchImpl: async () => new Response('abc', { headers: { 'content-length': '4' } }) });
    await assert.rejects(mismatch.download('123', join(dir, 'file.bin')), (error) => error.code === 'CONTENT_LENGTH_MISMATCH' && error.retryable);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('media output refuses symlinks without damaging their destination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-line-symlink-'));
  try {
    const original = join(dir, 'original');
    const link = join(dir, 'media');
    await writeFile(original, 'original');
    await symlink(original, link);
    const client = new LineClient(account, { fetchImpl: async () => new Response('new') });
    await assert.rejects(client.download('123', link), (error) => error.code === 'INVALID_MEDIA_TARGET');
    assert.equal(await readFile(original, 'utf8'), 'original');
    assert.deepEqual((await readdir(dir)).sort(), ['media', 'original']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('preparing media is polled rather than passed to the agent as empty content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-line-ready-'));
  try {
    let count = 0;
    const client = new LineClient(account, { fetchImpl: async () => ++count === 1 ? new Response(null, { status: 202 }) : new Response('ready') });
    const result = await client.download('123', join(dir, 'media'));
    assert.equal(count, 2);
    assert.equal(result.size, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
