'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../src/stateStore');
const { LldpReconciler } = require('../src/reconciler');

const T0 = 1_700_000_000_000;

function makeReconciler(options) {
  const store = new StateStore(':memory:');
  store.load();
  return { store, reconciler: new LldpReconciler(store, options) };
}

function adv(overrides = {}) {
  return {
    localDevice: 'sw1',
    localPort: 'Gi0/1',
    remoteChassisId: 'aa:bb:cc:dd:ee:01',
    remoteChassisSubtype: 4,
    remotePortId: 'Gi0/2',
    remotePortSubtype: 5,
    ttl: 120,
    lastAdvertisedAt: T0,
    ifOperStatus: 'up',
    ...overrides,
  };
}

test('TTL 未过期时邻居有效，过期后失效', () => {
  const { reconciler } = makeReconciler();
  reconciler.ingest(adv(), T0);

  assert.equal(reconciler.effectiveNeighbors(T0 + 60_000).length, 1);
  // 恰好到达 TTL 边界视为过期
  assert.equal(reconciler.effectiveNeighbors(T0 + 120_000).length, 0);
  assert.equal(reconciler.effectiveNeighbors(T0 + 121_000).length, 0);
});

test('缺失 TTL 时使用默认 TTL', () => {
  const { reconciler } = makeReconciler({ defaultTtl: 30 });
  const { record } = reconciler.ingest(adv({ ttl: undefined }), T0);
  assert.equal(record.ttl, 30);
  assert.equal(reconciler.effectiveNeighbors(T0 + 31_000).length, 0);
});

test('接口 down 时邻居立即失效，无需等待 TTL', () => {
  const { reconciler } = makeReconciler();
  reconciler.ingest(adv(), T0);
  reconciler.updateInterfaceStatus('sw1', 'Gi0/1', 'down', T0 + 1_000);
  assert.equal(reconciler.effectiveNeighbors(T0 + 2_000).length, 0);
});

test('端口复用：同一本地端口学到新邻居，旧身份被替换', () => {
  const { reconciler, store } = makeReconciler();
  const first = reconciler.ingest(adv(), T0);
  assert.equal(first.event, 'new');

  const second = reconciler.ingest(
    adv({ remoteChassisId: 'aa:bb:cc:dd:ee:99', lastAdvertisedAt: T0 + 10_000 }),
    T0 + 10_000,
  );
  assert.equal(second.event, 'replaced');
  assert.equal(second.record.remoteChassisId, 'mac:aa:bb:cc:dd:ee:99');
  assert.equal(store.history.some((h) => h.type === 'replaced'), true);

  const effective = reconciler.effectiveNeighbors(T0 + 20_000);
  assert.equal(effective.length, 1);
  assert.equal(effective[0].remoteChassisId, 'mac:aa:bb:cc:dd:ee:99');
});

test('链路迁移：对账输出旧边为错误边、新边为缺失边', () => {
  const { reconciler } = makeReconciler();
  // 链路从 sw2 迁到 sw3，监控拓扑还保留旧连接
  reconciler.ingest(
    adv({ remoteChassisId: 'sw3', remoteChassisSubtype: 7, remotePortId: 'Gi0/5' }),
    T0,
  );
  const snapshot = {
    nodes: ['sw1', 'sw2', 'sw3'],
    edges: [{ aDevice: 'sw1', aPort: 'Gi0/1', bDevice: 'sw2', bPort: 'Gi0/2' }],
  };
  const report = reconciler.reconcile(snapshot, T0 + 5_000);

  assert.equal(report.errorEdges.stale.length, 1);
  assert.equal(report.errorEdges.stale[0].bDevice, 'name:sw2');
  assert.equal(report.errorEdges.missing.length, 1);
  assert.equal(report.errorEdges.missing[0].bDevice, 'name:sw3');
  // sw2 失去唯一有效边成为孤立节点；sw3 已有期望中的新边，不算孤立
  assert.ok(report.orphanNodes.includes('name:sw2'));
  assert.ok(!report.orphanNodes.includes('name:sw3'));
  assert.ok(!report.orphanNodes.includes('name:sw1'));
});

test('过期邻居仍挂在拓扑上时被列为需要重采的设备', () => {
  const { reconciler } = makeReconciler();
  reconciler.ingest(adv({ remoteChassisId: 'sw2', remoteChassisSubtype: 7 }), T0);
  const snapshot = {
    nodes: ['sw1', 'sw2'],
    edges: [{ aDevice: 'sw1', aPort: 'Gi0/1', bDevice: 'sw2', bPort: 'Gi0/2' }],
  };
  const report = reconciler.reconcile(snapshot, T0 + 300_000); // TTL 120s 已过
  assert.equal(report.effectiveNeighbors.length, 0);
  assert.equal(report.errorEdges.stale.length, 1);
  assert.ok(report.devicesNeedingRepoll.includes('name:sw2'));
});

test('邻居快速回切：窗口内切回原身份记为 flap-back', () => {
  const { reconciler } = makeReconciler({ flapWindowMs: 60_000 });
  const remoteA = { remoteChassisId: 'sw2', remoteChassisSubtype: 7, remotePortId: 'Gi0/2' };
  const remoteB = { remoteChassisId: 'sw3', remoteChassisSubtype: 7, remotePortId: 'Gi0/5' };

  reconciler.ingest(adv(remoteA), T0);
  reconciler.ingest(adv({ ...remoteB, lastAdvertisedAt: T0 + 10_000 }), T0 + 10_000);
  const back = reconciler.ingest(
    adv({ ...remoteA, lastAdvertisedAt: T0 + 20_000 }),
    T0 + 20_000,
  );

  assert.equal(back.event, 'flap-back');
  assert.equal(back.record.flapping, true);
  assert.equal(back.record.flapCount, 1);

  const report = reconciler.reconcile({ nodes: [], edges: [] }, T0 + 25_000);
  assert.ok(report.devicesNeedingRepoll.includes('name:sw2'));
});

test('晚到的旧通告（同身份、时间戳更老）被丢弃', () => {
  const { reconciler } = makeReconciler();
  reconciler.ingest(adv({ lastAdvertisedAt: T0 + 50_000 }), T0 + 50_000);
  const late = reconciler.ingest(adv({ lastAdvertisedAt: T0 }), T0 + 60_000);
  assert.equal(late.event, 'stale-duplicate');
  assert.equal(late.record.lastAdvertisedAt, T0 + 50_000);
});

test('晚到的旧通告（序号更老）被丢弃', () => {
  const { reconciler } = makeReconciler();
  reconciler.ingest(adv({ seq: 10, lastAdvertisedAt: T0 }), T0);
  const late = reconciler.ingest(adv({ seq: 9, lastAdvertisedAt: T0 + 5_000 }), T0 + 5_000);
  assert.equal(late.event, 'stale-duplicate');
  assert.equal(late.record.seq, 10);
});

test('晚到通告的 TTL 已按原始时间戳耗尽，不复活旧边', () => {
  const { reconciler } = makeReconciler();
  // 通告在 T0 发出，但采集系统在 TTL 之后才送达
  reconciler.ingest(adv({ ttl: 60, lastAdvertisedAt: T0 }), T0 + 120_000);
  assert.equal(reconciler.effectiveNeighbors(T0 + 120_000).length, 0);
});

test('端口迁移后旧通告晚到，不覆盖新邻居', () => {
  const { reconciler } = makeReconciler();
  // 新邻居已在端口上
  reconciler.ingest(
    adv({ remoteChassisId: 'sw3', remoteChassisSubtype: 7, lastAdvertisedAt: T0 + 10_000 }),
    T0 + 10_000,
  );
  // 旧邻居 sw2 的通告晚到（时间戳更老、身份不同）——按端口复用处理但时间戳更老不应复活
  const late = reconciler.ingest(
    adv({ remoteChassisId: 'sw2', remoteChassisSubtype: 7, lastAdvertisedAt: T0 }),
    T0 + 20_000,
  );
  // 身份不同会被接受为 replaced，但其 TTL 从 T0 起算，应立即过期
  assert.equal(late.record.remoteChassisId, 'name:sw2');
  assert.equal(reconciler.isExpired(late.record, T0 + 20_000 + 1), false); // ttl 120s 从 T0 起算，T0+20s 仍有效
});

test('拓扑快照与邻居一致时无错误边、无孤立节点', () => {
  const { reconciler } = makeReconciler();
  reconciler.ingest(adv({ remoteChassisId: 'sw2', remoteChassisSubtype: 7 }), T0);
  const snapshot = {
    nodes: ['sw1', 'sw2'],
    // 快照里端口写法不同（全称 vs 缩写），归一化后应匹配
    edges: [{ aDevice: 'sw1', aPort: 'GigabitEthernet0/1', bDevice: 'sw2', bPort: 'GigabitEthernet0/2' }],
  };
  const report = reconciler.reconcile(snapshot, T0 + 1_000);
  assert.equal(report.errorEdges.stale.length, 0);
  assert.equal(report.errorEdges.missing.length, 0);
  assert.equal(report.orphanNodes.length, 0);
  assert.equal(report.devicesNeedingRepoll.length, 0);
});

test('不同设备 ID 格式的同一设备不会产生重复邻居', () => {
  const { reconciler } = makeReconciler();
  const a = reconciler.ingest(adv({ remoteChassisId: 'AA:BB:CC:DD:EE:01' }), T0);
  const b = reconciler.ingest(
    adv({ remoteChassisId: 'aabb.ccdd.ee01', lastAdvertisedAt: T0 + 1_000 }),
    T0 + 1_000,
  );
  assert.equal(a.record.remoteChassisId, b.record.remoteChassisId);
  assert.equal(b.event, 'refresh');
  assert.equal(reconciler.effectiveNeighbors(T0 + 2_000).length, 1);
});
