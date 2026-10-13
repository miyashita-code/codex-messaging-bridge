import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';

function channelConfig(channel, options = {}) {
  const config = normalizeConfig({ channels: { line: { enabled: false }, [channel]: { enabled: true, ...options } } }, { env: {} });
  return channel === 'line' ? config.accounts : config.discordAccounts;
}

test('both channels inherit pairing TTL while explicit null or finite account overrides remain distinct', () => {
  for (const channel of ['line', 'discord']) {
    assert.equal(channelConfig(channel)[0].pairingCodeTtlMs, 3600000);
    const finite = channelConfig(channel, { pairingCodeTtlMs: 90000, accounts: { inherited: {}, perpetual: { pairingCodeTtlMs: null }, custom: { pairingCodeTtlMs: 2500 } } });
    assert.deepEqual(finite.map(account => account.pairingCodeTtlMs), [90000, null, 2500]);
    const perpetual = channelConfig(channel, { pairingCodeTtlMs: null, accounts: { inherited: {}, finite: { pairingCodeTtlMs: 60000 } } });
    assert.deepEqual(perpetual.map(account => account.pairingCodeTtlMs), [null, 60000]);
  }
});

test('invalid pairing TTL cannot become accidental no-expiry in config or direct storage calls', () => {
  const store = new Store(':memory:');
  try {
    for (const invalid of [0, -1, 1.5, '60000', true, false, NaN, Infinity, -Infinity, {}, [], Number.MAX_SAFE_INTEGER]) {
      for (const channel of ['line', 'discord']) assert.throws(() => channelConfig(channel, { pairingCodeTtlMs: invalid }), /pairingCodeTtlMs/);
      assert.throws(() => store.pairing('default', 'U1', invalid), /pairingCodeTtlMs/);
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM pairings').get().n, 0);
  } finally { store.close(); }
});

test('custom pairing TTL approves before the deadline and is replaced at the exact expiry boundary', (t) => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const store = new Store(':memory:');
  try {
    const approved = store.pairing('default', 'U1', 2500);
    const expiring = store.pairing('default', 'U2', 2500);
    assert.equal(store.db.prepare('SELECT expires FROM pairings WHERE code=?').get(expiring.code).expires, now + 2500);
    now += 2499;
    assert.ok(store.approve(approved.code));
    assert.equal(store.pairing('default', 'U2', null).code, expiring.code, 'a pending challenge keeps its original expiry when configuration changes');
    now++;
    assert.equal(store.approve(expiring.code), undefined);
    const renewed = store.pairing('default', 'U2', 2500);
    assert.equal(renewed.created, true);
    assert.notEqual(renewed.code, expiring.code);
    assert.equal(store.db.prepare('SELECT expires FROM pairings WHERE code=?').get(renewed.code).expires, now + 2500);
    assert.equal(store.paired('default', 'U1'), true, 'approved access remains granted after the code expires');
  } finally { store.close(); }
});

test('no-expiry challenges remain stable through cleanup and restart and approve after a long delay', (t) => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const dir = mkdtempSync(join(tmpdir(), 'pairing-persistence-'));
  const database = join(dir, 'bridge.sqlite');
  let store = new Store(database);
  try {
    const permanent = store.pairing('default', 'U1', null);
    const finite = store.pairing('default', 'U2');
    assert.equal(store.db.prepare('SELECT expires FROM pairings WHERE code=?').get(permanent.code).expires, null);
    now += 100 * 365 * 86400000;
    store.close(); store = new Store(database);
    store.recoverProcessing();
    assert.equal(store.pairing('default', 'U1').code, permanent.code);
    assert.equal(store.pairing('default', 'U1').created, false);
    assert.equal(store.db.prepare('SELECT code FROM pairings WHERE code=?').get(finite.code), undefined, 'expired finite codes are cleaned while permanent codes survive');
    assert.deepEqual({ ...store.approve(permanent.code) }, { account_id: 'default', user_id: 'U1' });
    assert.equal(store.approve(permanent.code), undefined);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the three pending-code cap includes no-expiry codes and remains independent across channel/account namespaces', () => {
  const store = new Store(':memory:');
  try {
    const namespaces = ['default', 'work', 'discord:default', 'discord:work'];
    const issued = [];
    for (const account of namespaces) {
      const first = store.pairing(account, 'same-user', null);
      issued.push(first.code);
      store.pairing(account, 'second-user', null); store.pairing(account, 'third-user', null);
      assert.equal(store.pairing(account, 'fourth-user', null).code, undefined);
      assert.equal(store.pairing(account, 'same-user', 60000).code, first.code);
    }
    assert.equal(new Set(issued).size, 4);
    store.approve(issued[0]);
    assert.equal(store.paired('default', 'same-user'), true);
    assert.equal(store.paired('discord:default', 'same-user'), false);
    assert.equal(store.pairing('default', 'fourth-user', null).created, true);
    assert.equal(store.pairing('discord:default', 'fourth-user', null).created, false);
    assert.equal(store.revoke('discord:default', 'second-user'), true);
    assert.equal(store.pairing('discord:default', 'fourth-user', null).created, true);
  } finally { store.close(); }
});
