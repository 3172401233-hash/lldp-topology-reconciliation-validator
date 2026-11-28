'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StateStore } = require('../src/stateStore');
const { LldpReconciler } = require('../src/reconciler');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lldp-')), 'state.json');
}

test('状态落盘后重新加载，记录与历史完整保留', () => {
  const file = tmpFile();
  const store = new StateStore(file);
  store.load();
  const reconciler = new LldpReconciler(store);
  reconciler.ingest(
    {
      localDevice: 'sw1',
      localPort: 'Gi0/1',
      remoteChassisId: 'sw2',
      remotePortId: 'Gi0/2',
      ttl: 120,
      lastAdvertisedAt: 1_700_000_000_000,
    },
    1_700_000_000_000,
  );
  store.save();
  assert.ok(fs.existsSync(file));

  const reloaded = new StateStore(file);
  reloaded.load();
  const r2 = new LldpReconciler(reloaded);
  const effective = r2.effectiveNeighbors(1_700_000_001_000);
  assert.equal(effective.length, 1);
  assert.equal(effective[0].remoteChassisId, 'name:sw2');
});

test('损坏的状态文件被备份并重置，不会抛错', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const store = new StateStore(file);
  store.load();
  assert.deepEqual(store.records, {});
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('corrupt'));
  assert.equal(backups.length, 1);
});

test('状态文件不存在时从空状态开始', () => {
  const store = new StateStore(tmpFile());
  store.load();
  assert.deepEqual(store.records, {});
  assert.deepEqual(store.history, []);
});

test('expire 清理过期记录并写入历史', () => {
  const store = new StateStore(':memory:');
  store.load();
  const reconciler = new LldpReconciler(store);
  reconciler.ingest(
    {
      localDevice: 'sw1',
      localPort: 'Gi0/1',
      remoteChassisId: 'sw2',
      remotePortId: 'Gi0/2',
      ttl: 10,
      lastAdvertisedAt: 1_000,
    },
    1_000,
  );
  const expired = reconciler.expire(1_000 + 11_000);
  assert.equal(expired.length, 1);
  assert.equal(Object.keys(store.records).length, 0);
  assert.equal(store.history.at(-1).type, 'expired');
});
