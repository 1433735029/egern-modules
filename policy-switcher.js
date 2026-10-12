/**
 * Egern 定时策略节点切换脚本
 * 
 * 功能：
 *   - 按用户配置的时间表，定时切换策略组中选中的节点
 *   - 自动探测 Egern 本地 API（兼容 Surge / Clash 风格端点）
 *   - 切换成功/失败均发通知
 *   - 用 ctx.storage 记录状态，避免重复切换
 * 
 * 环境变量（通过模块 env_schema 配置）：
 *   POLICY_GROUP    - 策略组名称，如 "Proxy"
 *   SCHEDULE        - 时间表，格式 "08:00|香港01,20:00|日本01,23:00|新加坡01"
 *   NOTIFY_ON_SWITCH - 切换成功是否通知 "true"/"false"（默认 true）
 *   NOTIFY_ON_FAIL  - 切换失败是否通知 "true"/"false"（默认 true）
 *   API_PORT        - 手动指定 API 端口，留空则自动探测
 */

export default async function(ctx) {
  // ========== 1. 读取配置 ==========
  const groupName = (ctx.env.POLICY_GROUP || '综合利用EMBY4837').trim();
  const scheduleStr = (ctx.env.SCHEDULE || '10:00|Matrix-美西-4837🇺🇸AnyTLS1,19:00|HKS-🇭🇰CDT优化').trim();
  const notifyOnSwitch = (ctx.env.NOTIFY_ON_SWITCH || 'true') !== 'false';
  const notifyOnFail = (ctx.env.NOTIFY_ON_FAIL || 'true') !== 'false';
  const customPort = (ctx.env.API_PORT || '').trim();

  if (!scheduleStr) {
    console.log('[PolicySwitcher] SCHEDULE 为空，跳过');
    return;
  }

  // ========== 2. 解析时间表 ==========
  // 格式: "08:00|香港01,20:00|日本01,23:00|新加坡01"
  const schedule = [];
  for (const part of scheduleStr.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [timeStr, ...nodeParts] = trimmed.split('|');
    const nodeName = nodeParts.join('|').trim();
    const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || !nodeName) {
      console.log(`[PolicySwitcher] 忽略无效条目: ${trimmed}`);
      continue;
    }
    schedule.push({
      hour: parseInt(m[1], 10),
      minute: parseInt(m[2], 10),
      node: nodeName,
      minutes: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
    });
  }

  if (schedule.length === 0) {
    console.log('[PolicySwitcher] 时间表解析后为空');
    return;
  }

  // 按时间排序
  schedule.sort((a, b) => a.minutes - b.minutes);

  // ========== 3. 确定当前应该使用的节点 ==========
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  let targetNode = null;
  let nextSwitch = null;

  for (let i = 0; i < schedule.length; i++) {
    if (currentMinutes >= schedule[i].minutes) {
      targetNode = schedule[i].node;
    }
  }

  // 如果当前时间早于最早的计划时间，使用最后一个（昨天的最后一个时段）
  if (!targetNode) {
    targetNode = schedule[schedule.length - 1].node;
  }

  // 计算下一次切换时间
  for (const item of schedule) {
    if (item.minutes > currentMinutes) {
      nextSwitch = item;
      break;
    }
  }
  if (!nextSwitch) {
    nextSwitch = schedule[0]; // 明天的第一个
  }

  // ========== 4. 检查是否需要切换 ==========
  const stateKey = `ps_state_${groupName}`;
  const state = ctx.storage.getJSON(stateKey) || {};
  const lastNode = state.currentNode;
  const lastSwitchDate = state.lastSwitchDate;

  // 今天是否已经切换过
  const todayStr = now.toISOString().slice(0, 10);

  if (lastNode === targetNode && lastSwitchDate === todayStr) {
    console.log(`[PolicySwitcher] 今日已切换至 ${targetNode}，无需重复`);
    return;
  }

  console.log(`[PolicySwitcher] 目标节点: ${targetNode}（上次: ${lastNode || '无'}）`);

  // ========== 5. 尝试通过本地 API 切换 ==========
  const ports = customPort ? [customPort] : ['3080', '6171', '9090'];
  let switched = false;
  let apiError = '';

  for (const port of ports) {
    if (switched) break;

    // --- 尝试 Surge 风格 API: POST /v1/policy_groups/select ---
    try {
      const url = `http://127.0.0.1:${port}/v1/policy_groups/select`;
      const resp = await ctx.http.post(url, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: groupName, policy: targetNode }),
        timeout: 3000,
        policy: 'DIRECT',
      });
      if (resp.status >= 200 && resp.status < 300) {
        switched = true;
        console.log(`[PolicySwitcher] Surge API 切换成功 (port ${port})`);
        break;
      }
      apiError = `Surge API returned ${resp.status}`;
    } catch (e) {
      // 端口不通，继续尝试
    }

    // --- 尝试 Clash 风格 API: PUT /proxies/{group} ---
    try {
      const url = `http://127.0.0.1:${port}/proxies/${encodeURIComponent(groupName)}`;
      const resp = await ctx.http.put(url, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: targetNode }),
        timeout: 3000,
        policy: 'DIRECT',
      });
      if (resp.status >= 200 && resp.status < 300) {
        switched = true;
        console.log(`[PolicySwitcher] Clash API 切换成功 (port ${port})`);
        break;
      }
      apiError = `Clash API returned ${resp.status}`;
    } catch (e) {
      // 继续尝试下一个端口
    }

    // --- 尝试 Egern 风格 API: POST /v1/policy_groups/{group}/select ---
    try {
      const url = `http://127.0.0.1:${port}/v1/policy_groups/${encodeURIComponent(groupName)}/select`;
      const resp = await ctx.http.post(url, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: targetNode }),
        timeout: 3000,
        policy: 'DIRECT',
      });
      if (resp.status >= 200 && resp.status < 300) {
        switched = true;
        console.log(`[PolicySwitcher] Egern API 切换成功 (port ${port})`);
        break;
      }
      apiError = `Egern API returned ${resp.status}`;
    } catch (e) {
      // 继续尝试
    }
  }

  // ========== 6. 更新状态 ==========
  ctx.storage.setJSON(stateKey, {
    currentNode: targetNode,
    lastSwitchDate: todayStr,
    lastSwitchTime: now.toISOString(),
    lastSwitchSuccess: switched,
    nextSwitchTime: `${String(nextSwitch.hour).padStart(2,'0')}:${String(nextSwitch.minute).padStart(2,'0')}`,
    nextSwitchNode: nextSwitch.node,
  });

  // ========== 7. 发送通知 ==========
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  if (switched && notifyOnSwitch) {
    ctx.notify({
      title: '🔄 策略节点已切换',
      subtitle: groupName,
      body: `已自动切换至: ${targetNode}\n时间: ${timeStr}\n下次切换: ${String(nextSwitch.hour).padStart(2,'0')}:${String(nextSwitch.minute).padStart(2,'0')} → ${nextSwitch.node}`,
      sound: true,
      duration: 5,
    });
  } else if (!switched && notifyOnFail) {
    ctx.notify({
      title: '⚠️ 策略切换未成功',
      subtitle: groupName,
      body: `计划切换至: ${targetNode}\n本地 API 未响应，请手动在 Egern 中切换。\n下次检查时将重试。`,
      sound: true,
      duration: 8,
    });
  }

  console.log(`[PolicySwitcher] 完成。切换${switched ? '成功' : '失败'} → ${targetNode}`);
}
