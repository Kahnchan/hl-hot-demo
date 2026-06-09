# Rising Calculation

This document describes the current `Rising` ranking logic used in the HL hot-score demo.

## Goal

`Rising` is designed to surface assets that are becoming active very recently.

It answers:

> Which assets have shown the strongest short-term activity increase in the last few hours?

It does **not** primarily compare today vs yesterday. It is a short-window acceleration ranking.

## Data Inputs

For each asset, the demo reads:

1. `metaAndAssetCtxs`
   - `dayNtlVlm`
   - `openInterest`
   - `markPx`
   - `prevDayPx`
   - `funding`

2. `candleSnapshot` with `interval = 1h` and `last 48h`
   - hourly volume
   - hourly trade count
   - hourly close price

3. `l2Book`
   - top-of-book bid/ask
   - top depth levels

## Step 1: Build Raw Per-Asset Metrics

For each asset:

### 1.1 24h turnover

```ts
turnover24h = volume24hUsd / openInterestUsd
```

Where:

```ts
openInterestUsd = openInterestBase * markPx
volume24hUsd = dayNtlVlm
```

### 1.2 4h volume acceleration

Take the most recent 4 hourly candles and the previous 4 hourly candles:

```ts
last4Volume = sum(volumes[-4:])
previous4Volume = sum(volumes[-8:-4])
volumeAcceleration = last4Volume / previous4Volume
```

In code, this value is clamped:

```ts
volumeAcceleration = clamp(last4Volume / previous4Volume, 0, 4)
```

### 1.3 4h trade acceleration

Same method, but using hourly trade counts:

```ts
last4Trades = sum(tradeCounts[-4:])
previous4Trades = sum(tradeCounts[-8:-4])
tradeAcceleration = last4Trades / previous4Trades
```

Also clamped:

```ts
tradeAcceleration = clamp(last4Trades / previous4Trades, 0, 4)
```

### 1.4 1h volume burst

Compare the latest 1h volume to the average of earlier 1h candles:

```ts
last1Volume = volumes[-1]
baseline1Volume = average(volumes[0:-1])
burstVolume1h = last1Volume / baseline1Volume
```

Clamped in code:

```ts
burstVolume1h = clamp(last1Volume / baseline1Volume, 0, 6)
```

### 1.5 1h trade burst

Same logic for trade counts:

```ts
last1Trade = tradeCounts[-1]
baseline1Trades = average(tradeCounts[0:-1])
burstTrades1h = last1Trade / baseline1Trades
```

Clamped:

```ts
burstTrades1h = clamp(last1Trade / baseline1Trades, 0, 6)
```

### 1.6 Price momentum input

Current implementation uses absolute 24h price change magnitude:

```ts
priceChangeAbsPct = abs(priceChangePct)
```

Important:

- Up and down moves both increase this metric
- It measures movement intensity, not bullishness

### 1.7 Liquidity inputs

From order book:

```ts
spreadBps = ((bestAsk - bestBid) / midPrice) * 10000
liquidityDepthUsd = sum(top 8 bid levels) + sum(top 8 ask levels)
```

### 1.8 Crowding input

From funding:

```ts
fundingAbsBps = abs(funding) * 10000
```

### 1.9 Noise input

From hourly returns:

```ts
realizedVolatilityPct = stddev(hourlyReturns) * 100
```

## Step 2: Normalize Each Component

Each raw metric is converted to a `0..1` score.

### 2.1 Volume growth score

```ts
volumeGrowthScore = clamp((volumeAcceleration - 1) / 2.2, 0, 1)
```

Interpretation:

- `1.0x` means no growth
- above `1.0x` starts getting rewarded
- roughly `3.2x+` is already full score

### 2.2 Trade growth score

```ts
tradeGrowthScore = clamp((tradeAcceleration - 1) / 2.2, 0, 1)
```

### 2.3 Turnover growth score

Current implementation:

```ts
turnoverGrowthScore = clamp((turnover24h - 0.8) / 2.2, 0, 1)
```

Important note:

- Despite the name, this is **not** currently a period-over-period growth rate
- It is a score on the current turnover level

### 2.4 Burst score

First normalize 1h burst metrics:

```ts
volumeBurstNorm = clamp((burstVolume1h - 1) / 3, 0, 1)
tradeBurstNorm = clamp((burstTrades1h - 1) / 3, 0, 1)
```

Then combine:

```ts
burstScore = 0.55 * volumeBurstNorm + 0.45 * tradeBurstNorm
```

### 2.5 Momentum score

```ts
momentumScore = clamp(priceChangeAbsPct / 12, 0, 1)
```

Interpretation:

- `12%` absolute move or higher gets full score

### 2.6 Liquidity score

Normalize depth and spread separately:

```ts
depthScore = clamp(liquidityDepthUsd / 250000, 0, 1)
spreadScore = clamp(1 - spreadBps / 12, 0, 1)
```

Then combine:

```ts
liquidityScore = 0.55 * depthScore + 0.45 * spreadScore
```

### 2.7 Crowding penalty

```ts
crowdingPenalty = clamp(fundingAbsBps / 8, 0, 1)
```

### 2.8 Noise penalty

```ts
noisePenalty = clamp(realizedVolatilityPct / 4, 0, 1)
```

## Step 3: Compute Raw Rising Score

The current raw formula is:

```ts
risingScoreRaw =
  0.28 * volumeGrowthScore
+ 0.22 * tradeGrowthScore
+ 0.18 * turnoverGrowthScore
+ 0.14 * burstScore
+ 0.10 * momentumScore
+ 0.12 * liquidityScore
- 0.04 * crowdingPenalty
- 0.04 * noisePenalty
```

Then clamp:

```ts
risingScoreRaw = clamp(risingScoreRaw, 0, 1)
```

## Step 4: Apply HIP-3 Confidence Factor

For `main` perps:

```ts
finalRisingScore = risingScoreRaw
```

For `HIP-3` assets:

```ts
finalRisingScore = risingScoreRaw * confidenceFactor
```

Where:

```ts
oiConfidence = clamp(openInterestUsd / 8_000_000, 0.55, 1)
depthConfidence = clamp(liquidityDepthUsd / 90_000, 0.5, 1)
spreadConfidence = 1 - linearNorm(spreadBps, 3, 20) * 0.35

confidenceFactor = clamp(
  oiConfidence * 0.35 +
  depthConfidence * 0.4 +
  spreadConfidence * 0.25,
  0.45,
  1,
)
```

Purpose:

- prevent thin HIP-3 assets from ranking too high
- still allow active HIP-3 assets to appear

## Step 5: Final Ranking

After computing `finalRisingScore` for all eligible assets:

1. filter by minimum thresholds
2. compute score
3. sort descending
4. assign rank

## Eligibility Filters

All assets must satisfy:

```ts
tradeCount24h > 0
volume24hUsd > 100_000
```

For `main` assets:

```ts
openInterestUsd > 250_000
liquidityDepthUsd > 10_000
```

For `HIP-3` assets:

```ts
openInterestUsd > 1_000_000
liquidityDepthUsd > 20_000
```

## Human Summary

Current `Rising` is best described as:

> A short-term momentum and activity ranking that rewards 4h acceleration, 1h burst, current turnover, and decent liquidity.

It is **not** currently:

- a today-vs-yesterday ranking
- a pure period-over-period growth ranking

It is more like:

> Which assets are suddenly moving and trading more in the last few hours?

