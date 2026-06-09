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
  view: 'rising',
};

const calcDocs = {
  rising: {
    title: 'Rising 计算规则',
    intro:
      '这部分按开发实现文档来写，目标是让开发直接照着实现。结构固定为：输入字段 -> 中间变量 -> 归一化 -> 最终公式 -> 过滤条件 -> 排序规则 -> 伪代码。',
    formula: `rising_score =
0.28 * volume_growth_score
+ 0.22 * trade_growth_score
+ 0.18 * turnover_growth_score
+ 0.14 * burst_score
+ 0.10 * momentum_score
+ 0.12 * liquidity_score
- 0.04 * crowding_penalty
- 0.04 * noise_penalty`,
    sections: [
      {
        title: '1. 输入字段',
        content: `metaAndAssetCtxs:
- dayNtlVlm
- openInterest
- markPx
- prevDayPx
- funding

candleSnapshot(1h, last48h):
- v
- n
- c

l2Book:
- levels`,
      },
      {
        title: '2. 基础变量',
        content: `volume24hUsd = dayNtlVlm
openInterestUsd = openInterest * markPx
turnover24h = volume24hUsd / openInterestUsd
priceChangePct = ((markPx - prevDayPx) / prevDayPx) * 100
priceChangeAbsPct = abs(priceChangePct)
fundingAbsBps = abs(funding) * 10000`,
      },
      {
        title: '3. 4h / 1h 时间窗口变量',
        content: `last4Volume = sum(v[-4:])
previous4Volume = sum(v[-8:-4])
volumeAcceleration = clamp(last4Volume / previous4Volume, 0, 4)

last4Trades = sum(n[-4:])
previous4Trades = sum(n[-8:-4])
tradeAcceleration = clamp(last4Trades / previous4Trades, 0, 4)

burstVolume1h = clamp(v[-1] / average(v[0:-1]), 0, 6)
burstTrades1h = clamp(n[-1] / average(n[0:-1]), 0, 6)`,
      },
      {
        title: '4. 盘口和波动变量',
        content: `spreadBps = ((bestAsk - bestBid) / mid) * 10000
liquidityDepthUsd = top8BidsUsd + top8AsksUsd
realizedVolatilityPct = stddev(hourlyReturns) * 100`,
      },
      {
        title: '5. 归一化分数',
        content: `volumeGrowthScore = clamp((volumeAcceleration - 1) / 2.2, 0, 1)
tradeGrowthScore = clamp((tradeAcceleration - 1) / 2.2, 0, 1)
turnoverGrowthScore = clamp((turnover24h - 0.8) / 2.2, 0, 1)
burstScore = 0.55 * clamp((burstVolume1h - 1) / 3, 0, 1)
           + 0.45 * clamp((burstTrades1h - 1) / 3, 0, 1)
momentumScore = clamp(abs(priceChangePct) / 12, 0, 1)
liquidityScore = 0.55 * clamp(liquidityDepthUsd / 250000, 0, 1)
               + 0.45 * clamp(1 - spreadBps / 12, 0, 1)
crowdingPenalty = clamp(fundingAbsBps / 8, 0, 1)
noisePenalty = clamp(realizedVolatilityPct / 4, 0, 1)`,
      },
      {
        title: '6. 最终分数',
        content: `risingScoreRaw =
  0.28 * volumeGrowthScore +
  0.22 * tradeGrowthScore +
  0.18 * turnoverGrowthScore +
  0.14 * burstScore +
  0.10 * momentumScore +
  0.12 * liquidityScore -
  0.04 * crowdingPenalty -
  0.04 * noisePenalty

risingScoreRaw = clamp(risingScoreRaw, 0, 1)`,
      },
      {
        title: '7. HIP-3 折扣',
        content: `if marketGroup === 'hip3':
  oiConfidence = clamp(openInterestUsd / 8000000, 0.55, 1)
  depthConfidence = clamp(liquidityDepthUsd / 90000, 0.5, 1)
  spreadConfidence = 1 - linearNorm(spreadBps, 3, 20) * 0.35

  confidenceFactor = clamp(
    0.35 * oiConfidence +
    0.40 * depthConfidence +
    0.25 * spreadConfidence,
    0.45,
    1
  )

  finalRisingScore = risingScoreRaw * confidenceFactor
else:
  finalRisingScore = risingScoreRaw`,
      },
      {
        title: '8. 过滤条件',
        content: `main:
- volume24hUsd > 100000
- openInterestUsd > 250000
- liquidityDepthUsd > 10000
- tradeCount24h > 0

hip3:
- volume24hUsd > 100000
- openInterestUsd > 1000000
- liquidityDepthUsd > 20000
- tradeCount24h > 0`,
      },
      {
        title: '9. 排序规则',
        content: `对所有通过过滤的资产：
1. 计算 finalRisingScore
2. 按 finalRisingScore 倒序排列
3. score 高的排前面`,
      },
      {
        title: '10. 伪代码',
        content: `for asset in assets:
  read metaAndAssetCtxs
  read candleSnapshot(48h, 1h)
  read l2Book

  compute volume24hUsd
  compute openInterestUsd
  compute turnover24h
  compute priceChangePct
  compute fundingAbsBps

  compute volumeAcceleration
  compute tradeAcceleration
  compute burstVolume1h
  compute burstTrades1h
  compute realizedVolatilityPct

  compute spreadBps
  compute liquidityDepthUsd

  compute all normalized scores
  compute risingScoreRaw

  if hip3:
    finalRisingScore = risingScoreRaw * confidenceFactor
  else:
    finalRisingScore = risingScoreRaw

filter by thresholds
sort by finalRisingScore desc`,
      },
    ],
    hlFields: [
      {
        source: 'metaAndAssetCtxs',
        fields: [
          '`dayNtlVlm` -> volume24hUsd',
          '`openInterest` + `markPx` -> openInterestUsd / turnover24h',
          '`funding` -> fundingAbsBps / crowdingPenalty',
          '`markPx` + `prevDayPx` -> priceChangePct / momentumScore',
        ],
      },
      {
        source: 'candleSnapshot (1h, last 48h)',
        fields: [
          '`v` -> volumeAcceleration / burstVolume1h',
          '`n` -> tradeAcceleration / burstTrades1h',
          '`c` -> realizedVolatilityPct',
        ],
      },
      {
        source: 'l2Book',
        fields: [
          '`levels` best bid/ask -> spreadBps',
          '`levels` top 8 depth -> liquidityDepthUsd / liquidityScore',
        ],
      },
      {
        source: 'HIP-3 confidence factor',
        fields: [
          '`openInterestUsd` -> oiConfidence',
          '`liquidityDepthUsd` -> depthConfidence',
          '`spreadBps` -> spreadConfidence',
        ],
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

function byId(id) {
  return document.getElementById(id);
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
  return safeScore(row.risingScore);
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
  const root = byId('segmentTabs');
  if (!root) return;
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

function renderCalcRules() {
  const calc = calcDocs.rising;
  const title = byId('calcTitle');
  const root = byId('calcContent');
  if (!title || !root) return;
  title.textContent = calc.title;
  root.className = 'calc-content';
  root.innerHTML = `
    <p class="calc-intro">${calc.intro}</p>
    <div class="calc-section">
      <div class="calc-section-head">
        <span class="calc-section-index">F</span>
        <h3>最终公式</h3>
      </div>
      <pre><code>${calc.formula}</code></pre>
    </div>
    <div class="calc-fields">
      ${calc.hlFields
        .map(
          (group) => `
            <article class="calc-step">
              <h3>${group.source}</h3>
              <p>
                ${group.fields.map((field) => `<span class="calc-field">${field}</span>`).join('<br />')}
              </p>
            </article>`,
        )
        .join('')}
    </div>
    <div class="calc-steps">
      ${calc.sections
        .map(
          (section) => `
            <article class="calc-section">
              <div class="calc-section-head">
                <span class="calc-section-index">${section.title.split('.')[0]}</span>
                <h3>${section.title.replace(/^\d+\.\s*/, '')}</h3>
              </div>
              <pre><code>${section.content}</code></pre>
            </article>`,
        )
        .join('')}
    </div>
  `;
}

function renderFormula() {
  const formula = byId('formula');
  if (!formula) return;
  formula.innerHTML = '';
  Object.entries(state.weights).forEach(([key, value]) => {
    const chip = document.createElement('span');
    const prefix = value >= 0 ? '+' : '';
    chip.textContent = `${weightLabels[key]} ${prefix}${fmtFixed(value, 2)}`;
    formula.appendChild(chip);
  });
}

function renderFilters() {
  const filters = byId('filters');
  if (!filters) return;
  filters.innerHTML = '';
  Object.entries(state.dataset.strategy.filters).forEach(([key, value]) => {
    const chip = document.createElement('span');
    chip.textContent = `${key} ${value}`;
    filters.appendChild(chip);
  });
}

function renderSliders() {
  const root = byId('sliders');
  if (!root) return;
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
  const container = byId('leaderboard');
  if (!container) return;
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
      `1h Burst ${fmtFixed(getValueOr(row, 'burstVolume1h'), 2, 'x')}`,
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
          <span>1h burst ${fmtFixed(getValueOr(row, 'burstVolume1h'), 2, 'x')}</span>
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

  const detailTitle = byId('detailTitle');
  const detail = byId('detailContent');
  if (!detailTitle || !detail) return;
  detailTitle.textContent = `${row.coin} 为什么排在前面`;

  const metrics = [
    ['热度分', fmtFixed(safeScore(row.adjustedScore) * 100, 1)],
    ['当前视角', 'Rising'],
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

  const breakdownEntries = [
    ['4h 成交增长', row.risingBreakdown?.volumeGrowthScore],
    ['4h 交易增长', row.risingBreakdown?.tradeGrowthScore],
    ['换手抬升', row.risingBreakdown?.turnoverGrowthScore],
    ['1h 爆发', row.risingBreakdown?.burstScore],
    ['价格动量', row.risingBreakdown?.momentumScore],
    ['盘口质量', row.risingBreakdown?.liquidityScore],
    ['拥挤惩罚', row.risingBreakdown?.crowdingPenalty],
    ['噪音惩罚', row.risingBreakdown?.noisePenalty],
  ];

  detail.className = 'detail-content';
  detail.innerHTML = `
    <p class="detail-copy">
      Rising 更像是“最近突然升温”。这里重点看近4小时增长、1小时爆发和换手抬升。
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
  const strategySummary = byId('strategySummary');
  const candidateCount = byId('candidateCount');
  const sourceCount = byId('sourceCount');
  const updatedAt = byId('updatedAt');
  if (!strategySummary || !candidateCount || !sourceCount || !updatedAt) return;
  strategySummary.textContent = strategy.summary;
  candidateCount.textContent = `${strategy.candidateCount}+ hip3`;
  sourceCount.textContent = `${strategy.dataSources.length} streams`;
  updatedAt.textContent = new Date(generatedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function loadData(refresh = false) {
  const button = byId('refreshBtn');
  if (!button) return;
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
    renderSliders();
    renderSegments();
    renderLeaderboard();
    renderCalcRules();
  } catch (error) {
    const leaderboard = byId('leaderboard');
    if (leaderboard) {
      leaderboard.innerHTML = `<div class="metric-note">加载失败：${error.message}</div>`;
    }
  } finally {
    button.disabled = false;
    button.textContent =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1'
        ? '刷新真实数据'
        : '重新加载静态快照';
  }
}

const refreshBtn = byId('refreshBtn');
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    loadData(true);
  });
}

const resetBtn = byId('resetBtn');
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    state.weights = { ...defaultWeights };
    renderFormula();
    renderSliders();
    renderLeaderboard();
    if (state.selectedCoin) {
      renderDetail(state.selectedCoin);
    }
  });
}

loadData(false);
