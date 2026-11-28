'use strict';

// LLDP chassis / port ID 归一化。
// 不同厂商会上报不同 subtype（MAC、接口名、本地分配字符串、网络地址），
// 对账前必须统一成稳定 key，否则同一台设备会被当成两个邻居。

const MAC_RE = /^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{12}$|^(?:[0-9a-fA-F]{4}\.){2}[0-9a-fA-F]{4}$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function normalizeMac(raw) {
  const hex = String(raw).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return null;
  return hex.replace(/(..)/g, '$1:').slice(0, -1);
}

// 常见接口名缩写展开：Gi0/1 与 GigabitEthernet0/1 视为同一端口。
const IF_ALIASES = [
  [/^gi(?:g(?:abit)?)?(?:e(?:thernet)?)?/i, 'gigabitethernet'],
  [/^te(?:ngig(?:abit)?)?(?:e(?:thernet)?)?/i, 'tengigabitethernet'],
  [/^fa(?:st)?(?:e(?:thernet)?)?/i, 'fastethernet'],
  [/^eth(?:ernet)?/i, 'ethernet'],
  [/^po(?:rt-?channel)?/i, 'port-channel'],
  [/^lo(?:opback)?/i, 'loopback'],
  [/^vl(?:an)?/i, 'vlan'],
  [/^mgmt?/i, 'management'],
  [/^xe?-?/i, 'xe-'],
  [/^et-?/i, 'et-'],
  [/^ge-?/i, 'ge-'],
];

function normalizeIfName(raw) {
  const text = String(raw).trim();
  for (const [re, canonical] of IF_ALIASES) {
    if (re.test(text)) {
      return text.replace(re, canonical).toLowerCase().replace(/\s+/g, '');
    }
  }
  return text.toLowerCase().replace(/\s+/g, '');
}

function looksLikeIfName(raw) {
  return /^[a-zA-Z][a-zA-Z-]*-?\d/.test(String(raw).trim());
}

/**
 * 归一化 chassis ID。
 * @param {string} id 原始 ID
 * @param {string|number} [subtype] LLDP chassis ID subtype（4=MAC, 5=网络地址, 7=本地分配）
 * @returns {string} 稳定 key，形如 "mac:aa:bb:..." / "name:sw1" / "ip:10.0.0.1"
 */
function normalizeChassisId(id, subtype) {
  if (id == null || id === '') throw new TypeError('chassis id is required');
  const raw = String(id).trim();
  const sub = Number(subtype);

  if (sub === 4 || MAC_RE.test(raw)) {
    const mac = normalizeMac(raw);
    if (mac) return `mac:${mac}`;
  }
  if (sub === 5 || IPV4_RE.test(raw) || raw.includes(':')) {
    if (IPV4_RE.test(raw)) return `ip:${raw}`;
    if (/^[0-9a-fA-F:]+$/.test(raw) && raw.includes(':') && !MAC_RE.test(raw)) {
      return `ip:${raw.toLowerCase()}`;
    }
  }
  return `name:${raw.toLowerCase()}`;
}

/**
 * 归一化 port ID。
 * @param {string} id 原始 ID
 * @param {string|number} [subtype] LLDP port ID subtype（3=MAC, 5=接口名, 7=本地分配）
 */
function normalizePortId(id, subtype) {
  if (id == null || id === '') throw new TypeError('port id is required');
  const raw = String(id).trim();
  const sub = Number(subtype);

  if (Number.isInteger(sub) && sub >= 1 && sub <= 7) {
    // 显式 subtype 优先：3=MAC, 5=接口名, 7=本地分配
    if (sub === 3) {
      const mac = normalizeMac(raw);
      if (mac) return `mac:${mac}`;
    }
    if (sub === 5) return `if:${normalizeIfName(raw)}`;
    if (sub === 7) return `local:${raw.toLowerCase()}`;
  }
  if (MAC_RE.test(raw)) {
    const mac = normalizeMac(raw);
    if (mac) return `mac:${mac}`;
  }
  if (looksLikeIfName(raw)) {
    return `if:${normalizeIfName(raw)}`;
  }
  return `local:${raw.toLowerCase()}`;
}

/** 本地端口 key（本设备上的端口标识，用于状态存储的键）。 */
function localPortKey(device, port) {
  return `${String(device).toLowerCase()}|${normalizePortId(port)}`;
}

/** 邻居身份 key（远端 chassis + port），用于判断端口复用 / 迁移。 */
function neighborIdentity(remoteChassisId, remotePortId) {
  return `${remoteChassisId}>>${remotePortId}`;
}

module.exports = {
  normalizeMac,
  normalizeIfName,
  normalizeChassisId,
  normalizePortId,
  localPortKey,
  neighborIdentity,
};
