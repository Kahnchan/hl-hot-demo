const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, 'public');
const HL_API_URL = 'https://api.hyperliquid.xyz/info';
const CACHE_TTL_MS = 60_000;
const CANDIDATE_COUNT = 32;
const RESULT_LIMIT = 24;
const CONCURRENCY = 8;
const HIP3_DEXES = ['xyz'];
const PUBLIC_DATA_DIR = path.join(PUBLIC_DIR, 'data');

let cache = {
  updatedAt: 0,
  payload: null,
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const typeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': typeMap[ext] || 'application/octet-stream',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function postToHyperliquid(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(HL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    });

    req.on('response', (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpRequest(url, options) {
  const isHttps = url.startsWith('https://');
  const mod = isHttps ? require('https') : require('http');
  return mod.request(url, options);
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
  return results;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sum(values) {
  return values.reduce((acc, item) => acc + item, 0);
}

function average(values) {
  return values.length ? sum(values) / values.length : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function logNorm(value, min, max) {
  const safeValue = Math.max(1, value + 1);
  const safeMin = Math.max(1, min + 1);
  const safeMax = Math.max(safeMin + 1, max + 1);
  return clamp(
    (Math.log(safeValue) - Math.log(safeMin)) /
      (Math.log(safeMax) - Math.log(safeMin)),
    0,
    1,
  );
}

function linearNorm(value, min, max) {
  if (max <= min) {
    return 0;
  }
  return clamp((value - min) / (max - min), 0, 1);
}

function inverseNorm(value, min, max) {
  return 1 - linearNorm(value, min, max);
}

function standardDeviation(values) {
  if (values.length <= 1) {
    return 0;
  }
  const avg = average(values);
  const variance = average(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function buildMetricRanges(rows) {
  const keys = [
    'volume24hUsd',
    'openInterestUsd',
    'tradeCount24h',
    'turnover24h',
    'volumeAcceleration',
    'tradeAcceleration',
    'priceChangeAbsPct',
    'liquidityDepthUsd',
    'spreadBps',
    'fundingAbsBps',
    'realizedVolatilityPct',
  ];
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        min: Math.min(...rows.map((row) => row[key])),
        max: Math.max(...rows.map((row) => row[key])),
      },
    ]),
  );
}

function computeBreakdown(row, ranges) {
  const volumeScore = logNorm(
    row.volume24hUsd,
    ranges.volume24hUsd.min,
    ranges.volume24hUsd.max,
  );
  const oiScore = logNorm(
    row.openInterestUsd,
    ranges.openInterestUsd.min,
    ranges.openInterestUsd.max,
  );
  const tradeScore = logNorm(
    row.tradeCount24h,
    ranges.tradeCount24h.min,
    ranges.tradeCount24h.max,
  );
  const turnoverScore = linearNorm(
    row.turnover24h,
    ranges.turnover24h.min,
    ranges.turnover24h.max,
  );
  const accelerationScore =
    linearNorm(
      row.volumeAcceleration,
      ranges.volumeAcceleration.min,
      ranges.volumeAcceleration.max,
    ) *
      0.6 +
    linearNorm(
      row.tradeAcceleration,
      ranges.tradeAcceleration.min,
      ranges.tradeAcceleration.max,
    ) *
      0.4;
  const momentumScore = linearNorm(
    row.priceChangeAbsPct,
    ranges.priceChangeAbsPct.min,
    ranges.priceChangeAbsPct.max,
  );
  const liquidityScore =
    linearNorm(
      row.liquidityDepthUsd,
      ranges.liquidityDepthUsd.min,
      ranges.liquidityDepthUsd.max,
    ) *
      0.65 +
    inverseNorm(row.spreadBps, ranges.spreadBps.min, ranges.spreadBps.max) *
      0.35;
  const crowdingPenalty = linearNorm(
    row.fundingAbsBps,
    ranges.fundingAbsBps.min,
    ranges.fundingAbsBps.max,
  );
  const noisePenalty = linearNorm(
    row.realizedVolatilityPct,
    ranges.realizedVolatilityPct.min,
    ranges.realizedVolatilityPct.max,
  );

  return {
    volumeScore,
    oiScore,
    tradeScore,
    turnoverScore,
    accelerationScore,
    momentumScore,
    liquidityScore,
    crowdingPenalty,
    noisePenalty,
  };
}

function scoreRow(row, ranges) {
  const breakdown = computeBreakdown(row, ranges);
  const score =
    breakdown.volumeScore * 0.22 +
    breakdown.oiScore * 0.08 +
    breakdown.tradeScore * 0.18 +
    breakdown.turnoverScore * 0.18 +
    breakdown.accelerationScore * 0.18 +
    breakdown.momentumScore * 0.1 +
    breakdown.liquidityScore * 0.1 -
    breakdown.crowdingPenalty * 0.03 -
    breakdown.noisePenalty * 0.03;

  return {
    score: clamp(score, 0, 1),
    breakdown,
  };
}

async function fetchUniverse() {
  const mainUniversePromise = postToHyperliquid({ type: 'metaAndAssetCtxs' }).then(
    ([meta, contexts]) =>
      meta.universe.map((asset, index) => ({
        ...asset,
        ctx: contexts[index],
        marketGroup: 'main',
        dex: 'main',
      })),
  );
  const hip3UniversePromises = HIP3_DEXES.map((dex) =>
    postToHyperliquid({ type: 'metaAndAssetCtxs', dex }).then(
      ([meta, contexts]) =>
        meta.universe.map((asset, index) => ({
          ...asset,
          ctx: contexts[index],
          marketGroup: 'hip3',
          dex,
        })),
    ),
  );

  const universes = await Promise.all([mainUniversePromise, ...hip3UniversePromises]);
  return universes
    .flat()
    .filter((asset) => !asset.isDelisted && toNumber(asset.ctx?.dayNtlVlm) > 0);
}

async function fetchCandles(coin) {
  const now = Date.now();
  const startTime = now - 24 * 60 * 60 * 1000;
  const candles = await postToHyperliquid({
    type: 'candleSnapshot',
    req: {
      coin,
      interval: '1h',
      startTime,
      endTime: now,
    },
  });
  return Array.isArray(candles) ? candles : [];
}

async function fetchOrderBook(coin) {
  const book = await postToHyperliquid({ type: 'l2Book', coin });
  return book && Array.isArray(book.levels) ? book : null;
}

function computeLiquidity(book, markPx) {
  if (!book?.levels?.[0]?.length || !book?.levels?.[1]?.length) {
    return {
      spreadBps: 999,
      liquidityDepthUsd: 0,
    };
  }

  const bestBid = toNumber(book.levels[0][0]?.px);
  const bestAsk = toNumber(book.levels[1][0]?.px);
  const spreadBps =
    bestBid > 0 && bestAsk > 0
      ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000
      : 999;

  const topBids = book.levels[0].slice(0, 8);
  const topAsks = book.levels[1].slice(0, 8);
  const depthUsd =
    sum(topBids.map((level) => toNumber(level.px) * toNumber(level.sz))) +
    sum(topAsks.map((level) => toNumber(level.px) * toNumber(level.sz)));

  return {
    spreadBps,
    liquidityDepthUsd: depthUsd || markPx,
  };
}

function computeFromCandles(candles) {
  const cleanCandles = candles.filter((candle) => candle && candle.n > 0);
  const tradeCounts = cleanCandles.map((candle) => toNumber(candle.n));
  const volumes = cleanCandles.map((candle) => toNumber(candle.v));
  const closes = cleanCandles.map((candle) => toNumber(candle.c));
  const hourlyReturns = [];

  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const next = closes[i];
    if (prev > 0 && next > 0) {
      hourlyReturns.push((next - prev) / prev);
    }
  }

  const last4Trades = sum(tradeCounts.slice(-4));
  const last4Volume = sum(volumes.slice(-4));
  const baseline4Trades = average(
    Array.from({ length: Math.max(tradeCounts.length - 4, 1) }, (_, index) =>
      sum(tradeCounts.slice(index, index + 4)),
    ),
  );
  const baseline4Volume = average(
    Array.from({ length: Math.max(volumes.length - 4, 1) }, (_, index) =>
      sum(volumes.slice(index, index + 4)),
    ),
  );

  return {
    tradeCount24h: sum(tradeCounts),
    volumeAcceleration:
      baseline4Volume > 0 ? clamp(last4Volume / baseline4Volume, 0, 4) : 0,
    tradeAcceleration:
      baseline4Trades > 0 ? clamp(last4Trades / baseline4Trades, 0, 4) : 0,
    realizedVolatilityPct: standardDeviation(hourlyReturns) * 100,
  };
}

function buildReason(row) {
  const reasons = [];
  if (row.marketGroup === 'hip3') reasons.push(`${row.dex.toUpperCase()} HIP-3资产`);
  if (row.volume24hUsd > 50_000_000) reasons.push('24h成交额很强');
  if (row.tradeCount24h > 20_000) reasons.push('成交笔数活跃');
  if (row.turnover24h > 2.2) reasons.push('换手效率很高');
  if (row.openInterestUsd > 100_000_000) reasons.push('持仓规模扎实');
  if (row.volumeAcceleration > 1.3) reasons.push('近4小时放量');
  if (row.tradeAcceleration > 1.25) reasons.push('近4小时交易加速');
  if (row.spreadBps < 8) reasons.push('盘口价差健康');
  if (row.marketGroup === 'hip3' && row.confidenceFactor < 0.9) {
    reasons.push('但HIP-3可信度有折扣');
  }
  if (row.fundingAbsBps > 3) reasons.push('但资金费率偏拥挤');
  return reasons.slice(0, 4);
}

function parseCoinMetadata(coin, marketGroup, dex) {
  if (marketGroup === 'hip3' || coin.includes(':')) {
    const [coinDex, symbol] = coin.split(':');
    return {
      displayCoin: symbol || coin,
      marketGroup: 'hip3',
      dex: coinDex || dex || 'hip3',
      isHip3: true,
    };
  }
  return {
    displayCoin: coin,
    marketGroup: 'main',
    dex: dex || 'main',
    isHip3: false,
  };
}

function computeConfidenceFactor(row) {
  if (row.marketGroup !== 'hip3') {
    return 1;
  }
  const oiConfidence = clamp(row.openInterestUsd / 8_000_000, 0.55, 1);
  const depthConfidence = clamp(row.liquidityDepthUsd / 90_000, 0.5, 1);
  const spreadConfidence = 1 - linearNorm(row.spreadBps, 3, 20) * 0.35;
  return clamp(
    oiConfidence * 0.35 + depthConfidence * 0.4 + spreadConfidence * 0.25,
    0.45,
    1,
  );
}

async function buildDataset() {
  const universe = await fetchUniverse();
  const candidates = universe
    .map((asset) => {
      const metadata = parseCoinMetadata(asset.name, asset.marketGroup, asset.dex);
      return {
      coin: asset.name,
      displayCoin: metadata.displayCoin,
      marketGroup: metadata.marketGroup,
      dex: metadata.dex,
      isHip3: metadata.isHip3,
      maxLeverage: asset.maxLeverage,
      markPx: toNumber(asset.ctx.markPx || asset.ctx.midPx || asset.ctx.oraclePx),
      prevDayPx: toNumber(asset.ctx.prevDayPx),
      dayNtlVlm: toNumber(asset.ctx.dayNtlVlm),
      openInterestBase: toNumber(asset.ctx.openInterest),
      funding: toNumber(asset.ctx.funding),
      impactPxs: asset.ctx.impactPxs || null,
    };
    })
    .filter((asset) => asset.markPx > 0 && asset.dayNtlVlm > 100_000)
    .sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);

  const mainCandidates = candidates
    .filter((asset) => asset.marketGroup === 'main')
    .slice(0, CANDIDATE_COUNT);
  const hip3Candidates = candidates
    .filter((asset) => asset.marketGroup === 'hip3')
    .slice(0, Math.max(12, Math.floor(CANDIDATE_COUNT * 0.6)));
  const finalCandidates = [...mainCandidates, ...hip3Candidates];

  const rows = await mapConcurrent(finalCandidates, CONCURRENCY, async (asset) => {
    const [candles, book] = await Promise.all([
      fetchCandles(asset.coin),
      fetchOrderBook(asset.coin),
    ]);
    const candleMetrics = computeFromCandles(candles);
    const liquidity = computeLiquidity(book, asset.markPx);
    const priceChangePct =
      asset.prevDayPx > 0
        ? ((asset.markPx - asset.prevDayPx) / asset.prevDayPx) * 100
        : 0;

    return {
      coin: asset.coin,
      displayCoin: asset.displayCoin,
      marketGroup: asset.marketGroup,
      dex: asset.dex,
      isHip3: asset.isHip3,
      maxLeverage: asset.maxLeverage,
      markPx: asset.markPx,
      volume24hUsd: asset.dayNtlVlm,
      openInterestUsd: asset.openInterestBase * asset.markPx,
      turnover24h:
        asset.openInterestBase * asset.markPx > 0
          ? asset.dayNtlVlm / (asset.openInterestBase * asset.markPx)
          : 0,
      priceChangePct,
      priceChangeAbsPct: Math.abs(priceChangePct),
      fundingAbsBps: Math.abs(asset.funding) * 10_000,
      spreadBps: liquidity.spreadBps,
      liquidityDepthUsd: liquidity.liquidityDepthUsd,
      ...candleMetrics,
    };
  });

  const filtered = rows
    .filter((row) => row.tradeCount24h > 0)
    .filter((row) =>
      row.marketGroup === 'hip3'
        ? row.openInterestUsd > 1_000_000
        : row.openInterestUsd > 250_000,
    )
    .filter((row) =>
      row.marketGroup === 'hip3'
        ? row.liquidityDepthUsd > 20_000
        : row.liquidityDepthUsd > 10_000,
    );

  const ranges = buildMetricRanges(filtered);
  const ranked = filtered
    .map((row) => {
      const { score, breakdown } = scoreRow(row, ranges);
      const confidenceFactor = computeConfidenceFactor(row);
      const finalScore = row.marketGroup === 'hip3' ? score * confidenceFactor : score;
      return {
        ...row,
        score: finalScore,
        rawScore: score,
        confidenceFactor,
        breakdown,
        reasons: buildReason(row),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, RESULT_LIMIT)
    .map((row, index) => ({
      ...row,
      rank: index + 1,
    }));

  return {
    generatedAt: new Date().toISOString(),
    strategy: {
      summary:
        'HL 热度分同时看成交额、交易笔数、换手效率、近4小时加速度、价格动量和盘口质量；现在额外补进了 HIP-3 xyz 资产，但会对低深度、低持仓的 HIP-3 合约施加可信度折扣。',
      weights: {
        volumeScore: 0.22,
        oiScore: 0.08,
        tradeScore: 0.18,
        turnoverScore: 0.18,
        accelerationScore: 0.18,
        momentumScore: 0.1,
        liquidityScore: 0.1,
        crowdingPenalty: -0.03,
        noisePenalty: -0.03,
      },
      candidateCount: CANDIDATE_COUNT,
      resultLimit: RESULT_LIMIT,
      filters: {
        volume24hUsd: '> 100k',
        openInterestUsd: 'main > 250k, hip3 > 1m',
        liquidityDepthUsd: 'main > 10k, hip3 > 20k',
      },
      dataSources: [
        'metaAndAssetCtxs',
        'metaAndAssetCtxs(dex=xyz)',
        'candleSnapshot(1h, 24h)',
        'l2Book',
      ],
      segments: [
        { id: 'all', label: 'All', count: ranked.length },
        {
          id: 'main',
          label: 'Main Perps',
          count: ranked.filter((row) => row.marketGroup === 'main').length,
        },
        {
          id: 'hip3',
          label: 'HIP-3 / xyz',
          count: ranked.filter((row) => row.marketGroup === 'hip3').length,
        },
      ],
      hip3Dexes: HIP3_DEXES,
    },
    rows: ranked,
  };
}

async function getDataset(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.payload && now - cache.updatedAt < CACHE_TTL_MS) {
    return cache.payload;
  }
  const payload = await buildDataset();
  cache = {
    updatedAt: now,
    payload,
  };
  return payload;
}

async function writeStaticDataset() {
  const payload = await getDataset(true);
  ensureDir(PUBLIC_DATA_DIR);
  fs.writeFileSync(
    path.join(PUBLIC_DATA_DIR, 'latest.json'),
    JSON.stringify(payload, null, 2),
  );
  fs.writeFileSync(path.join(PUBLIC_DIR, '.nojekyll'), '');
  return payload;
}

async function main() {
  if (process.argv.includes('--build-static')) {
    const payload = await writeStaticDataset();
    console.log(
      `Static dataset written with ${payload.rows.length} rows at ${payload.generatedAt}`,
    );
    return;
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.url.startsWith('/api/hot')) {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const forceRefresh = url.searchParams.get('refresh') === '1';
        const payload = await getDataset(forceRefresh);
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 500, {
          error: 'Failed to build HL hot score dataset',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const requestPath = req.url === '/' ? '/index.html' : req.url;
    const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);
    sendFile(res, filePath);
  });

  server.listen(PORT, () => {
    console.log(`HL hot demo running at http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
