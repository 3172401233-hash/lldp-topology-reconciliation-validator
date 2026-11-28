'use strict';

const {
  normalizeChassisId,
  normalizePortId,
  localPortKey,
  neighborIdentity,
} = require('./identifiers');

const DEFAULTS = {
  defaultTtl: 120, // 秒，通告缺失 TTL 时的兜底
  flapWindowMs: 5 * 60 * 1000, // 邻居快速回切判定窗口
  maxHistory: 1000,
};

/**
 * LLDP 对账器。
 *
 * 输入：本地端口、远端 chassis/port ID、TTL、最后一次通告时间、接口状态、拓扑快照。
 * 输出：当前有效邻居、与拓扑快照的差异（错误边、孤立节点、需要重采的设备）。
 *
 * 只消费采集到的 LLDP 数据，不发送任何真实 LLDP 帧。
 */
class LldpReconciler {
  /**
   * @param {import('./stateStore').StateStore} store
   * @param {object} [options]
   */
  constructor(store, options = {}) {
    this.store = store;
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * 录入一条 LLDP 通告（或接口状态变化）。
   * @param {object} adv
   * @param {string} adv.localDevice 本设备名
   * @param {string} adv.localPort 本地端口
   * @param {string} adv.remoteChassisId 远端 chassis ID
   * @param {string|number} [adv.remoteChassisSubtype]
   * @param {string} adv.remotePortId 远端 port ID
   * @param {string|number} [adv.remotePortSubtype]
   * @param {number} [adv.ttl] 秒
   * @param {number} [adv.lastAdvertisedAt] 毫秒时间戳；晚到通告会小于 now
   * @param {number} [adv.seq] 采集序号，用于丢弃乱序旧通告
   * @param {string} [adv.ifOperStatus] 'up' | 'down' | 'admin-down'
   * @param {number} [now] 当前毫秒时间戳
   * @returns {{record: object, event: string}}
   */
  ingest(adv, now = Date.now()) {
    const {
      localDevice,
      localPort,
      remoteChassisId,
      remoteChassisSubtype,
      remotePortId,
      remotePortSubtype,
      ttl,
      lastAdvertisedAt = now,
      seq = null,
      ifOperStatus = 'up',
    } = adv;

    if (!localDevice || !localPort) throw new TypeError('localDevice/localPort required');

    const key = localPortKey(localDevice, localPort);
    const chassis = normalizeChassisId(remoteChassisId, remoteChassisSubtype);
    const port = normalizePortId(remotePortId, remotePortSubtype);
    const identity = neighborIdentity(chassis, port);
    const effectiveTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : this.options.defaultTtl;
    const existing = this.store.getRecord(key);

    // 乱序 / 晚到的旧通告：同身份但时间戳或序号更老，直接忽略。
    if (existing && existing.identity === identity) {
      const olderSeq = seq != null && existing.seq != null && seq < existing.seq;
      const olderTs = lastAdvertisedAt < existing.lastAdvertisedAt;
      if (olderSeq || (seq == null && olderTs)) {
        return { record: existing, event: 'stale-duplicate' };
      }
    }

    let event = 'new';
    let flapping = false;
    let flapCount = 0;

    if (existing) {
      if (existing.identity === identity) {
        event = 'refresh';
        flapping = existing.flapping;
        flapCount = existing.flapCount;
      } else {
        // 端口复用 / 链路迁移：同一本地端口出现了不同的远端身份。
        event = 'replaced';
        this.store.appendHistory(
          {
            type: 'replaced',
            localPortKey: key,
            from: existing.identity,
            to: identity,
            at: now,
          },
          this.options.maxHistory,
        );
        // 邻居快速回切：在窗口内切回最近见过的身份，记为抖动而非新邻居。
        const seen = existing.recentIdentities ?? [];
        const prior = seen.find(
          (s) => s.identity === identity && now - s.at <= this.options.flapWindowMs,
        );
        if (prior) {
          flapping = true;
          flapCount = (existing.flapCount ?? 0) + 1;
          event = 'flap-back';
        }
      }
    }

    const recentIdentities = this.#mergeIdentities(existing, identity, now);

    const record = {
      key,
      localDevice: String(localDevice).toLowerCase(),
      localPort: normalizePortId(localPort),
      localPortRaw: localPort,
      remoteChassisId: chassis,
      remotePortId: port,
      remoteChassisRaw: remoteChassisId,
      remotePortRaw: remotePortId,
      identity,
      ttl: effectiveTtl,
      lastAdvertisedAt,
      seq,
      ifOperStatus,
      flapping,
      flapCount,
      recentIdentities,
      updatedAt: now,
    };
    this.store.putRecord(key, record);
    return { record, event };
  }

  /** 仅更新接口状态（链路 down 时邻居立即失效，不等 TTL）。 */
  updateInterfaceStatus(localDevice, localPort, ifOperStatus, now = Date.now()) {
    const key = localPortKey(localDevice, localPort);
    const existing = this.store.getRecord(key);
    if (!existing) return null;
    existing.ifOperStatus = ifOperStatus;
    existing.updatedAt = now;
    this.store.putRecord(key, existing);
    return existing;
  }

  #mergeIdentities(existing, identity, now) {
    const window = this.options.flapWindowMs;
    const seen = (existing?.recentIdentities ?? []).filter((s) => now - s.at <= window);
    if (!seen.some((s) => s.identity === identity)) {
      seen.push({ identity, at: now });
    } else {
      seen.find((s) => s.identity === identity).at = now;
    }
    return seen.slice(-8);
  }

  /** 记录是否过期：lastAdvertisedAt + ttl 早于 now。 */
  isExpired(record, now = Date.now()) {
    return record.lastAdvertisedAt + record.ttl * 1000 <= now;
  }

  /** 记录是否有效：未过期且接口 up。 */
  isEffective(record, now = Date.now()) {
    return !this.isExpired(record, now) && record.ifOperStatus !== 'down' && record.ifOperStatus !== 'admin-down';
  }

  /** 当前全部有效邻居。 */
  effectiveNeighbors(now = Date.now()) {
    return Object.values(this.store.records).filter((r) => this.isEffective(r, now));
  }

  /** 清理过期记录（可选；默认保留记录用于对账，只是不再视为有效）。 */
  expire(now = Date.now()) {
    const expired = [];
    for (const [key, record] of Object.entries(this.store.records)) {
      if (this.isExpired(record, now)) {
        expired.push(record);
        delete this.store.records[key];
        this.store.appendHistory(
          { type: 'expired', localPortKey: key, identity: record.identity, at: now },
          this.options.maxHistory,
        );
      }
    }
    return expired;
  }

  /**
   * 与监控拓扑快照对账。
   * @param {object} snapshot { nodes: string[], edges: [{aDevice,aPort,bDevice,bPort}] }
   * @param {number} [now]
   * @returns {{effectiveNeighbors: object[], errorEdges: object, orphanNodes: string[], devicesNeedingRepoll: string[]}}
   */
  reconcile(snapshot, now = Date.now()) {
    const nodes = (snapshot?.nodes ?? []).map((n) => String(n).toLowerCase());
    const edges = snapshot?.edges ?? [];
    const records = Object.values(this.store.records);
    const effective = records.filter((r) => this.isEffective(r, now));

    // 期望边：由有效邻居推导，key 与设备顺序无关。
    const expectedEdges = new Map();
    for (const r of effective) {
      const remoteDevice = r.remoteChassisId;
      const localKey = normalizeChassisId(r.localDevice);
      const edgeKey = LldpReconciler.edgeKey(localKey, r.localPort, remoteDevice, r.remotePortId);
      expectedEdges.set(edgeKey, {
        aDevice: localKey,
        aPort: r.localPort,
        bDevice: remoteDevice,
        bPort: r.remotePortId,
      });
    }

    // 快照边归一化。
    const snapshotEdges = new Map();
    for (const e of edges) {
      const aDev = String(e.aDevice).toLowerCase();
      const bDev = String(e.bDevice).toLowerCase();
      const aPort = normalizePortId(e.aPort);
      const bPort = normalizePortId(e.bPort);
      // 快照里的设备名可能是原始 chassis ID，统一归一化。
      const aKey = normalizeChassisId(e.aDevice);
      const bKey = normalizeChassisId(e.bDevice);
      snapshotEdges.set(LldpReconciler.edgeKey(aKey, aPort, bKey, bPort), {
        aDevice: aKey,
        aPort,
        bDevice: bKey,
        bPort,
      });
    }

    const staleEdges = [];
    for (const [key, edge] of snapshotEdges) {
      if (!expectedEdges.has(key)) staleEdges.push(edge);
    }
    const missingEdges = [];
    for (const [key, edge] of expectedEdges) {
      if (!snapshotEdges.has(key)) missingEdges.push(edge);
    }

    // 孤立节点：移除错误边后没有任何有效边相连的拓扑节点。
    const validIncident = new Set();
    for (const edge of expectedEdges.values()) {
      validIncident.add(edge.aDevice);
      validIncident.add(edge.bDevice);
    }
    const orphanNodes = nodes
      .map((n) => normalizeChassisId(n))
      .filter((n) => !validIncident.has(n));

    // 需要重采的设备：
    // 1) 记录已过期但快照里仍有它的边（监控还保留旧连接，需要 SNMP/重采确认）；
    // 2) 接口 down 但快照边仍存在；
    // 3) 端口抖动（快速回切）的远端设备。
    const repoll = new Set();
    for (const r of records) {
      const expired = this.isExpired(r, now);
      const ifDown = r.ifOperStatus === 'down' || r.ifOperStatus === 'admin-down';
      if (!expired && !ifDown && !r.flapping) continue;
      const localKey = normalizeChassisId(r.localDevice);
      const stillInSnapshot = [...snapshotEdges.values()].some(
        (e) =>
          (e.aDevice === localKey && e.aPort === r.localPort) ||
          (e.bDevice === localKey && e.bPort === r.localPort) ||
          e.aDevice === r.remoteChassisId ||
          e.bDevice === r.remoteChassisId,
      );
      if ((expired || ifDown) && stillInSnapshot) repoll.add(r.remoteChassisId);
      if (r.flapping) repoll.add(r.remoteChassisId);
    }

    return {
      effectiveNeighbors: effective,
      errorEdges: { stale: staleEdges, missing: missingEdges },
      orphanNodes,
      devicesNeedingRepoll: [...repoll],
    };
  }

  static edgeKey(aDevice, aPort, bDevice, bPort) {
    const endA = `${aDevice}|${aPort}`;
    const endB = `${bDevice}|${bPort}`;
    return endA < endB ? `${endA}~~${endB}` : `${endB}~~${endA}`;
  }
}

module.exports = { LldpReconciler, DEFAULTS };
