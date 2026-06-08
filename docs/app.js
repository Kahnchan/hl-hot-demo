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

function getDataUrl(refresh = false) {
  const isLocalLive =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';
  if (isLocalLive) {
    return `/api/hot${refresh ? '?refresh=1' : ''}`;
  }
  return './data/latest.json';
}

function fmtCompact(value) {
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

function fmtUsd(value) {
  return `$${fmtCompact(value)}`;
}

function fmtPct(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
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
    return row.risingScore;
  }
  const breakdown = row.breakdown;
  const score =
    breakdown.volumeScore * weights.volumeScore +
    breakdown.oiScore * weights.oiScore +
    breakdown.tradeScore * weights.tradeScore +
    breakdown.turnoverScore * weights.turnoverScore +
    breakdown.accelerationScore * weights.accelerationScore +
    breakdown.momentumScore * weights.momentumScore +
    breakdown.liquidityScore * weights.liquidityScore +
    breakdown.crowdingPenalty * weights.crowdingPenalty +
    breakdown.noisePenalty * weights.noisePenalty;

  return Math.max(0, Math.min(1, score));
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
    });
    root.appendChild(button);
  });
}

function renderFormula() {
  const formula = document.getElementById('formula');
  formula.innerHTML = '';
  Object.entries(state.weights).forEach(([key, value]) => {
    const chip = document.createElement('span');
    const prefix = value >= 0 ? '+' : '';
    chip.textContent = `${weightLabels[key]} ${prefix}${value.toFixed(2)}`;
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
    meta.innerHTML = `<span>${weightLabels[key]}</span><strong>${value.toFixed(2)}</strong>`;

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
      `Turnover ${row.turnover24h.toFixed(2)}x`,
      `Trades ${fmtCompact(row.tradeCount24h)}`,
      state.view === 'rising'
        ? `1h Burst ${row.burstVolume1h.toFixed(2)}x`
        : `24h Delta ${fmtPct(row.volume24hChange * 100)}`,
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
          <span>Price ${fmtPct(row.priceChangePct)}</span>
          <span>Spread ${row.spreadBps.toFixed(1)} bps</span>
          <span>4h delta ${fmtPct(row.volume4hChange * 100)}</span>
          ${
            state.view === 'rising'
              ? `<span>1h burst ${row.burstVolume1h.toFixed(2)}x</span>`
              : `<span>trades delta ${fmtPct(row.trade24hChange * 100)}</span>`
          }
        </div>
      </div>
      <div class="leader-score">
        <strong>${(row.adjustedScore * 100).toFixed(1)}</strong>
        <div class="bar"><span style="width:${row.adjustedScore * 100}%"></span></div>
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
    ['热度分', (row.adjustedScore * 100).toFixed(1)],
    ['当前视角', state.view === 'rising' ? 'Rising' : 'Hot'],
    ['市场分组', row.marketGroup === 'hip3' ? `HIP-3 / ${row.dex.toUpperCase()}` : 'Main Perp'],
    ['24h 成交额', fmtUsd(row.volume24hUsd)],
    ['上一24h成交额', fmtUsd(row.previousVolume24hUsd)],
    ['持仓规模', fmtUsd(row.openInterestUsd)],
    ['交易笔数', fmtCompact(row.tradeCount24h)],
    ['上一24h交易笔数', fmtCompact(row.previousTradeCount24h)],
    ['换手效率', `${row.turnover24h.toFixed(2)}x`],
    ['换手变化', fmtPct(row.turnover24hChange * 100)],
    ['24h 成交变化', fmtPct(row.volume24hChange * 100)],
    ['24h 交易变化', fmtPct(row.trade24hChange * 100)],
    ['4h 成交变化', fmtPct(row.volume4hChange * 100)],
    ['4h 交易变化', fmtPct(row.trade4hChange * 100)],
    ['1h 成交爆发', `${row.burstVolume1h.toFixed(2)}x`],
    ['1h 交易爆发', `${row.burstTrades1h.toFixed(2)}x`],
    ['可信度折扣', `${(row.confidenceFactor * 100).toFixed(0)}%`],
    ['价格变化', fmtPct(row.priceChangePct)],
    ['盘口价差', `${row.spreadBps.toFixed(2)} bps`],
    ['订单簿深度', fmtUsd(row.liquidityDepthUsd)],
    ['资金费率', `${row.fundingAbsBps.toFixed(2)} bps`],
    ['波动噪音', `${row.realizedVolatilityPct.toFixed(2)}%`],
  ];

  const breakdownEntries =
    state.view === 'rising'
      ? [
          ['4h 成交增长', row.risingBreakdown.volumeGrowthScore],
          ['4h 交易增长', row.risingBreakdown.tradeGrowthScore],
          ['换手抬升', row.risingBreakdown.turnoverGrowthScore],
          ['1h 爆发', row.risingBreakdown.burstScore],
          ['价格动量', row.risingBreakdown.momentumScore],
          ['盘口质量', row.risingBreakdown.liquidityScore],
          ['拥挤惩罚', row.risingBreakdown.crowdingPenalty],
          ['噪音惩罚', row.risingBreakdown.noisePenalty],
        ]
      : [
          ['24h 成交变化', row.breakdown.volumeScore],
          ['24h 交易变化', row.breakdown.oiScore],
          ['换手变化', row.breakdown.tradeScore],
          ['4h 窗口变化', row.breakdown.turnoverScore],
          ['短窗加速', row.breakdown.accelerationScore],
          ['价格动量', row.breakdown.momentumScore],
          ['基础活跃度', row.breakdown.liquidityScore],
          ['拥挤惩罚', row.breakdown.crowdingPenalty],
          ['噪音惩罚', row.breakdown.noisePenalty],
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
      ${row.reasons.map((reason) => `<span class="reason-pill">${reason}</span>`).join('')}
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
              <div class="bar"><span style="width:${Math.abs(value) * 100}%"></span></div>
              <strong>${value.toFixed(2)}</strong>
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
