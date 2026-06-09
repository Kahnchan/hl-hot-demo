const defaultWeights = {
  volumeScore: 0.35,
  oiScore: 0.25,
  tradeScore: 0.15,
  turnoverScore: 0.15,
  accelerationScore: 0.1,
  momentumScore: 0.1,
  liquidityScore: 0.15,
  crowdingPenalty: -0.03,
  noisePenalty: -0.02,
};

const weightLabels = {
  volumeScore: '24h 成交变化',
  oiScore: '24h 交易变化',
  tradeScore: '换手变化',
  turnoverScore: '4h 窗口变化',
  accelerationScore: '短窗加速',
  momentumScore: '价格动量',
  liquidityScore: '基础活跃度',
  crowdingPenalty: '拥挤惩罚',
  noisePenalty: '噪音惩罚',
};

const state = {
  dataset: null,
  weights: { ...defaultWeights },
  selectedCoin: null,
  segment: 'all',
  view: 'hot',
};

const calcDocs = {
  hot: {
    title: 'Hot 计算规则',
    intro:
      'Hot 现在是变化型榜单，优先比较当前24小时相对上一24小时的变化，再辅以近4小时变化。它回答的是：这个资产相比上一阶段，是不是变得更热门了。',
    formula: `hot_score =
0.75 * change_score
+ 0.15 * base_activity_score
+ 0.10 * liquidity_score
- 0.03 * crowding_penalty
- 0.02 * noise_penalty

change_score =
0.35 * volume_24h_change
+ 0.25 * trade_24h_change
+ 0.15 * turnover_24h_change
+ 0.15 * short_window_change
+ 0.10 * momentum_score`,
    steps: [
      {
        title: 'Step 1: 取两个时间窗口',
        body:
          '从 HL 的 1h candles 里取最近 48 小时数据，然后拆成 当前24h / 上一24h，以及 最近4h / 前4h 两组窗口。',
      },
      {
        title: 'Step 2: 算阶段变化',
        body:
          '计算 24h 成交额变化、24h 交易笔数变化、24h 换手变化。换手本质上是 `24h成交额 / OI`，再和上一阶段的换手做对比。',
      },
      {
        title: 'Step 3: 算短窗变化',
        body:
          '补一个 4h 变化项，比较 最近4h 和 前4h 的成交、交易变化，防止榜单太慢。',
      },
      {
        title: 'Step 4: 加基础活跃度兜底',
        body:
          '即使变化很大，也要看这个资产本身是不是有一定体量和交易深度，所以再轻量加入 `base_activity_score` 和 `liquidity_score`。',
      },
      {
        title: 'Step 5: 扣掉过热和噪音',
        body:
          '资金费率太极端会触发 `crowdingPenalty`，波动太乱会触发 `noisePenalty`，避免纯噪音币冲太前。',
      },
    ],
  },
  rising: {
    title: 'Rising 计算规则',
    intro:
      'Rising 是短线异动榜，偏向抓最近几小时里突然活跃起来的资产。它回答的是：谁在最近4小时和1小时窗口里，突然冲起来了。',
    formula: `rising_score =
0.28 * volume_growth_score
+ 0.22 * trade_growth_score
+ 0.18 * turnover_growth_score
+ 0.14 * burst_score
+ 0.10 * momentum_score
+ 0.12 * liquidity_score
- 0.04 * crowding_penalty
- 0.04 * noise_penalty`,
    steps: [
      {
        title: 'Step 1: 看最近4小时有没有放量',
        body:
          '先算 `volumeAcceleration = 最近4h成交量 / 前4h成交量`，再归一化成 `volumeGrowthScore`。数值越大，代表最近4小时更明显放量。',
      },
      {
        title: 'Step 2: 看最近4小时交易有没有变多',
        body:
          '同样计算 `tradeAcceleration = 最近4h交易笔数 / 前4h交易笔数`，再得到 `tradeGrowthScore`。这样能抓到交易活跃度突然提升的币。',
      },
      {
        title: 'Step 3: 看当前换手和 1h 爆发',
        body:
          '当前实现里的 `turnoverGrowthScore` 实际更像当前换手水平，而不是和上个周期比。再补一个 `burstScore`，用最近1小时和历史平均1小时做对比，抓短时爆发。',
      },
      {
        title: 'Step 4: 看价格动量和盘口质量',
        body:
          '价格波动幅度越大，`momentumScore` 越高；订单簿深度越厚、spread 越小，`liquidityScore` 越高。',
      },
      {
        title: 'Step 5: 扣掉拥挤和噪音',
        body:
          '资金费率极端说明市场过热，记作 `crowdingPenalty`；实现波动率过高说明走势很乱，记作 `noisePenalty`。HIP-3 资产最后还会乘一个 `confidenceFactor` 折扣。',
      },
    ],
  },
};

function getDataUrl(refresh = false) {
  const isLocalLive =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';
  if (isLocalLive) {
    return `/api/hot${refresh ? '?refresh=1' : ''}`;
  }
  const cacheKey = refresh ? Date.now() : 'static';
  return `./data/latest.json?v=${cacheKey}`;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtCompact(value) {
  const n = toFiniteNumber(value);
  if (n === null) return '--';
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtUsd(value) {
  const compact = fmtCompact(value);
  return compact === '--' ? '--' : `$${compact}`;
}

function fmtPct(value) {
  const n = toFiniteNumber(value);
  if (n === null) return '--';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtFixed(value, digits = 2, suffix = '') {
  const n = toFiniteNumber(value);
  if (n === null) return '--';
  return `${n.toFixed(digits)}${suffix}`;
}

function safeScore(value) {
  const n = toFiniteNumber(value);
  return n === null ? 0 : Math.max(0, Math.min(1, n));
}

function getValueOr(row, key, fallback = null) {
  if (!row || !(key in row)) return fallback;
  const value = row[key];
  return value === undefined || value === null ? fallback : value;
}

function sliderConfig(key, value) {
  const isPenalty = value < 0;
  return {
    min: isPenalty ? -0.2 : 0,
    max: isPenalty ? 0 : 0.5,
    step: 0.01,
  };
}

function normalizeScore(row, weights) {
  if (state.view === 'rising') {
    return safeScore(row.risingScore);
  }
  const breakdown = row.breakdown || {};
  const score =
    (toFiniteNumber(breakdown.volumeScore) ?? 0) * weights.volumeScore +
    (toFiniteNumber(breakdown.oiScore) ?? 0) * weights.oiScore +
    (toFiniteNumber(breakdown.tradeScore) ?? 0) * weights.tradeScore +
    (toFiniteNumber(breakdown.turnoverScore) ?? 0) * weights.turnoverScore +
    (toFiniteNumber(breakdown.accelerationScore) ?? 0) *
      weights.accelerationScore +
    (toFiniteNumber(breakdown.momentumScore) ?? 0) * weights.momentumScore +
    (toFiniteNumber(breakdown.liquidityScore) ?? 0) * weights.liquidityScore +
    (toFiniteNumber(breakdown.crowdingPenalty) ?? 0) *
      weights.crowdingPenalty +
    (toFiniteNumber(breakdown.noisePenalty) ?? 0) * weights.noisePenalty;

  return safeScore(score);
}

function activeBreakdown(row) {
  return state.view === 'rising' ? row.risingBreakdown : row.breakdown;
}

function rankedRows() {
  if (!state.dataset) return [];
  const filteredRows = state.dataset.rows.filter((row) => {
    if (state.segment === 'main') return row.marketGroup === 'main';
    if (state.segment === 'hip3') return row.marketGroup === 'hip3';
    return true;
  });
  return filteredRows
    .map((row) => ({
      ...row,
      adjustedScore: normalizeScore(row, state.weights),
    }))
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .map((row, index) => ({
      ...row,
      adjustedRank: index + 1,
    }));
}

function renderSegments() {
  const root = document.getElementById('segmentTabs');
  root.innerHTML = '';
  (state.dataset.strategy.segments || []).forEach((segment) => {
    const button = document.createElement('button');
    button.className = `segment-tab ${state.segment === segment.id ? 'active' : ''}`;
    button.textContent = `${segment.label} · ${segment.count}`;
    button.addEventListener('click', () => {
      state.segment = segment.id;
      state.selectedCoin = null;
      renderSegments();
      renderLeaderboard();
    });
    root.appendChild(button);
  });
}

function renderViews() {
  const root = document.getElementById('viewTabs');
  root.innerHTML = '';
  (state.dataset.strategy.views || []).forEach((view) => {
    const button = document.createElement('button');
    button.className = `segment-tab ${state.view === view.id ? 'active' : ''}`;
    button.textContent = view.label;
    button.title = view.description;
    button.addEventListener('click', () => {
      state.view = view.id;
      state.selectedCoin = null;
      renderViews();
      renderLeaderboard();
      renderCalcRules();
    });
    root.appendChild(button);
  });
}

function renderCalcRules() {
  const calc = calcDocs[state.view] || calcDocs.hot;
  document.getElementById('calcTitle').textContent = calc.title;
  const root = document.getElementById('calcContent');
  root.className = 'calc-content';
  root.innerHTML = `
    <p class="detail-copy">${calc.intro}</p>
    <div class="calc-formula"><code>${calc.formula}</code></div>
    <div class="calc-steps">
      ${calc.steps
        .map(
          (step) => `
            <article class="calc-step">
              <h3>${step.title}</h3>
              <p>${step.body}</p>
            </article>`,
        )
        .join('')}
    </div>
  `;
}

function renderFormula() {
  const formula = document.getElementById('formula');
  formula.innerHTML = '';
  Object.entries(state.weights).forEach(([key, value]) => {
    const chip = document.createElement('span');
    const prefix = value >= 0 ? '+' : '';
    chip.textContent = `${weightLabels[key]} ${prefix}${fmtFixed(value, 2)}`;
    formula.appendChild(chip);
  });
}

function renderFilters() {
  const filters = document.getElementById('filters');
  filters.innerHTML = '';
  Object.entries(state.dataset.strategy.filters).forEach(([key, value]) => {
    const chip = document.createElement('span');
    chip.textContent = `${key} ${value}`;
    filters.appendChild(chip);
  });
}

function renderSliders() {
  const root = document.getElementById('sliders');
  root.innerHTML = '';

  Object.entries(state.weights).forEach(([key, value]) => {
    const row = document.createElement('div');
    row.className = 'slider-row';

    const meta = document.createElement('div');
    meta.className = 'slider-meta';
    meta.innerHTML = `<span>${weightLabels[key]}</span><strong>${fmtFixed(value, 2)}</strong>`;

    const input = document.createElement('input');
    input.type = 'range';
    const config = sliderConfig(key, value);
    input.min = String(config.min);
    input.max = String(config.max);
    input.step = String(config.step);
    input.value = String(value);
    input.addEventListener('input', () => {
      state.weights[key] = Number(input.value);
      renderFormula();
      renderSliders();
      renderLeaderboard();
      if (state.selectedCoin) {
        renderDetail(state.selectedCoin);
      }
    });

    row.appendChild(meta);
    row.appendChild(input);
    root.appendChild(row);
  });
}

function renderLeaderboard() {
  const rows = rankedRows();
  const container = document.getElementById('leaderboard');
  container.innerHTML = '';

  rows.forEach((row) => {
    const item = document.createElement('article');
    item.className = `leader-row ${state.selectedCoin === row.coin ? 'active' : ''}`;
    item.addEventListener('click', () => {
      state.selectedCoin = row.coin;
      renderLeaderboard();
      renderDetail(row.coin);
    });

  const badges = [
      row.marketGroup === 'hip3' ? `HIP-3 ${row.dex.toUpperCase()}` : 'Main Perp',
      `24h Vol ${fmtUsd(row.volume24hUsd)}`,
      `OI ${fmtUsd(row.openInterestUsd)}`,
      `Turnover ${fmtFixed(getValueOr(row, 'turnover24h'), 2, 'x')}`,
      `Trades ${fmtCompact(getValueOr(row, 'tradeCount24h'))}`,
      state.view === 'rising'
        ? `1h Burst ${fmtFixed(getValueOr(row, 'burstVolume1h'), 2, 'x')}`
        : `24h Delta ${fmtPct((toFiniteNumber(getValueOr(row, 'volume24hChange')) ?? 0) * 100)}`,
    ]
      .filter(Boolean)
      .map((text) => `<span class="badge">${text}</span>`)
      .join('');

    item.innerHTML = `
      <div class="rank">${row.adjustedRank}</div>
      <div class="coin-meta">
        <h3>${row.coin}</h3>
        <div class="badges">${badges}</div>
        <div class="subline">
          <span>Price ${fmtPct(getValueOr(row, 'priceChangePct'))}</span>
          <span>Spread ${fmtFixed(getValueOr(row, 'spreadBps'), 1, ' bps')}</span>
          <span>4h delta ${fmtPct((toFiniteNumber(getValueOr(row, 'volume4hChange')) ?? 0) * 100)}</span>
          ${
            state.view === 'rising'
              ? `<span>1h burst ${fmtFixed(getValueOr(row, 'burstVolume1h'), 2, 'x')}</span>`
              : `<span>trades delta ${fmtPct((toFiniteNumber(getValueOr(row, 'trade24hChange')) ?? 0) * 100)}</span>`
          }
        </div>
      </div>
      <div class="leader-score">
        <strong>${fmtFixed(safeScore(row.adjustedScore) * 100, 1)}</strong>
        <div class="bar"><span style="width:${safeScore(row.adjustedScore) * 100}%"></span></div>
      </div>
    `;

    container.appendChild(item);
  });

  if (!state.selectedCoin && rows[0]) {
    state.selectedCoin = rows[0].coin;
    renderLeaderboard();
    renderDetail(rows[0].coin);
  }
}

function renderDetail(coin) {
  const row = rankedRows().find((item) => item.coin === coin);
  if (!row) return;

  document.getElementById('detailTitle').textContent = `${row.coin} 为什么排在前面`;

  const metrics = [
    ['热度分', fmtFixed(safeScore(row.adjustedScore) * 100, 1)],
    ['当前视角', state.view === 'rising' ? 'Rising' : 'Hot'],
    ['市场分组', row.marketGroup === 'hip3' ? `HIP-3 / ${(row.dex || 'hip3').toUpperCase()}` : 'Main Perp'],
    ['24h 成交额', fmtUsd(getValueOr(row, 'volume24hUsd'))],
    ['上一24h成交额', fmtUsd(getValueOr(row, 'previousVolume24hUsd'))],
    ['持仓规模', fmtUsd(getValueOr(row, 'openInterestUsd'))],
    ['交易笔数', fmtCompact(getValueOr(row, 'tradeCount24h'))],
    ['上一24h交易笔数', fmtCompact(getValueOr(row, 'previousTradeCount24h'))],
    ['换手效率', fmtFixed(getValueOr(row, 'turnover24h'), 2, 'x')],
    ['换手变化', fmtPct((toFiniteNumber(getValueOr(row, 'turnover24hChange')) ?? 0) * 100)],
    ['24h 成交变化', fmtPct((toFiniteNumber(getValueOr(row, 'volume24hChange')) ?? 0) * 100)],
    ['24h 交易变化', fmtPct((toFiniteNumber(getValueOr(row, 'trade24hChange')) ?? 0) * 100)],
    ['4h 成交变化', fmtPct((toFiniteNumber(getValueOr(row, 'volume4hChange')) ?? 0) * 100)],
    ['4h 交易变化', fmtPct((toFiniteNumber(getValueOr(row, 'trade4hChange')) ?? 0) * 100)],
    ['1h 成交爆发', fmtFixed(getValueOr(row, 'burstVolume1h'), 2, 'x')],
    ['1h 交易爆发', fmtFixed(getValueOr(row, 'burstTrades1h'), 2, 'x')],
    ['可信度折扣', fmtFixed((toFiniteNumber(getValueOr(row, 'confidenceFactor')) ?? 0) * 100, 0, '%')],
    ['价格变化', fmtPct(getValueOr(row, 'priceChangePct'))],
    ['盘口价差', fmtFixed(getValueOr(row, 'spreadBps'), 2, ' bps')],
    ['订单簿深度', fmtUsd(getValueOr(row, 'liquidityDepthUsd'))],
    ['资金费率', fmtFixed(getValueOr(row, 'fundingAbsBps'), 2, ' bps')],
    ['波动噪音', fmtFixed(getValueOr(row, 'realizedVolatilityPct'), 2, '%')],
  ];

  const breakdownEntries =
    state.view === 'rising'
      ? [
          ['4h 成交增长', row.risingBreakdown?.volumeGrowthScore],
          ['4h 交易增长', row.risingBreakdown?.tradeGrowthScore],
          ['换手抬升', row.risingBreakdown?.turnoverGrowthScore],
          ['1h 爆发', row.risingBreakdown?.burstScore],
          ['价格动量', row.risingBreakdown?.momentumScore],
          ['盘口质量', row.risingBreakdown?.liquidityScore],
          ['拥挤惩罚', row.risingBreakdown?.crowdingPenalty],
          ['噪音惩罚', row.risingBreakdown?.noisePenalty],
        ]
      : [
          ['24h 成交变化', row.breakdown?.volumeScore],
          ['24h 交易变化', row.breakdown?.oiScore],
          ['换手变化', row.breakdown?.tradeScore],
          ['4h 窗口变化', row.breakdown?.turnoverScore],
          ['短窗加速', row.breakdown?.accelerationScore],
          ['价格动量', row.breakdown?.momentumScore],
          ['基础活跃度', row.breakdown?.liquidityScore],
          ['拥挤惩罚', row.breakdown?.crowdingPenalty],
          ['噪音惩罚', row.breakdown?.noisePenalty],
        ];

  const detail = document.getElementById('detailContent');
  detail.className = 'detail-content';
  detail.innerHTML = `
    <p class="detail-copy">
      ${
        state.view === 'rising'
          ? 'Rising 更像是“最近突然升温”。这里重点看近4小时增长、1小时爆发和换手抬升。'
          : 'Hot 改成了“较上一时间段变得更热” 的定义。这里重点看当前24h相对上一24h的成交和交易变化。'
      }
    </p>
    <div class="reasons">
      ${(row.reasons || []).map((reason) => `<span class="reason-pill">${reason}</span>`).join('')}
    </div>
    <div class="detail-grid">
      ${metrics
        .map(
          ([label, value]) => `
            <div class="metric-card">
              <span>${label}</span>
              <strong>${value}</strong>
            </div>`,
        )
        .join('')}
    </div>
    <div class="breakdown-list">
      ${breakdownEntries
        .map(
          ([label, value]) => `
            <div class="breakdown-row">
              <span>${label}</span>
              <div class="bar"><span style="width:${Math.abs(toFiniteNumber(value) ?? 0) * 100}%"></span></div>
              <strong>${fmtFixed(value, 2)}</strong>
            </div>`,
        )
        .join('')}
    </div>
  `;
}

function updateHeader() {
  const { strategy, generatedAt } = state.dataset;
  document.getElementById('strategySummary').textContent = strategy.summary;
  document.getElementById('candidateCount').textContent = `${strategy.candidateCount}+ hip3`;
  document.getElementById('sourceCount').textContent = `${strategy.dataSources.length} streams`;
  document.getElementById('updatedAt').textContent = new Date(generatedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function loadData(refresh = false) {
  const button = document.getElementById('refreshBtn');
  button.disabled = true;
  button.textContent = refresh ? '刷新中...' : '读取中...';

  try {
    const response = await fetch(getDataUrl(refresh));
    const dataset = await response.json();
    if (!response.ok) {
      throw new Error(dataset.detail || dataset.error || 'Unknown error');
    }
    state.dataset = dataset;
    updateHeader();
    renderFormula();
    renderFilters();
    renderViews();
    renderSliders();
    renderSegments();
    renderLeaderboard();
    renderCalcRules();
  } catch (error) {
    document.getElementById('leaderboard').innerHTML = `<div class="metric-note">加载失败：${error.message}</div>`;
  } finally {
    button.disabled = false;
    button.textContent =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1'
        ? '刷新真实数据'
        : '重新加载静态快照';
  }
}

document.getElementById('refreshBtn').addEventListener('click', () => {
  loadData(true);
});

document.getElementById('resetBtn').addEventListener('click', () => {
  state.weights = { ...defaultWeights };
  renderFormula();
  renderSliders();
  renderLeaderboard();
  if (state.selectedCoin) {
    renderDetail(state.selectedCoin);
  }
});

loadData(false);
