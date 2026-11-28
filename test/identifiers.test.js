'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeChassisId,
  normalizePortId,
  normalizeIfName,
} = require('../src/identifiers');

test('不同格式的 MAC 地址归一化为同一 chassis key', () => {
  const expected = 'mac:aa:bb:cc:dd:ee:ff';
  assert.equal(normalizeChassisId('AA:BB:CC:DD:EE:FF'), expected);
  assert.equal(normalizeChassisId('aa-bb-cc-dd-ee-ff'), expected);
  assert.equal(normalizeChassisId('aabbccddeeff'), expected);
  assert.equal(normalizeChassisId('aabb.ccdd.eeff'), expected);
  assert.equal(normalizeChassisId('AA-BB-CC-DD-EE-FF', 4), expected);
});

test('网络地址与本地分配 chassis ID', () => {
  assert.equal(normalizeChassisId('10.0.0.1', 5), 'ip:10.0.0.1');
  assert.equal(normalizeChassisId('10.0.0.1'), 'ip:10.0.0.1');
  assert.equal(normalizeChassisId('Switch-Rack-7', 7), 'name:switch-rack-7');
});

test('接口名缩写与全称视为同一端口', () => {
  assert.equal(normalizeIfName('Gi0/1'), normalizeIfName('GigabitEthernet0/1'));
  assert.equal(normalizeIfName('Te1/0/1'), normalizeIfName('TenGigabitEthernet1/0/1'));
  assert.equal(normalizeIfName('Fa0/24'), normalizeIfName('FastEthernet0/24'));
  assert.equal(normalizeIfName('ge-0/0/1'), normalizeIfName('ge-0/0/1'));
});

test('port ID 按 subtype 与格式归一化', () => {
  assert.equal(normalizePortId('Gi0/1', 5), 'if:gigabitethernet0/1');
  assert.equal(normalizePortId('GigabitEthernet0/1'), 'if:gigabitethernet0/1');
  assert.equal(normalizePortId('AA:BB:CC:DD:EE:01', 3), 'mac:aa:bb:cc:dd:ee:01');
  assert.equal(normalizePortId('slot-7-port-3', 7), 'local:slot-7-port-3');
});

test('空 ID 抛错', () => {
  assert.throws(() => normalizeChassisId(''), TypeError);
  assert.throws(() => normalizePortId(null), TypeError);
});
