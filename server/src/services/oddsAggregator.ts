/**
 * Odds Aggregator
 *
 * Merges player prop odds from SIA and FanDuel, filters to only matching lines,
 * and normalizes by removing the vig to get true probabilities.
 *
 * Pipeline: aggregateSiaAndFdOdds → filterSameLines → normalizeOdds
 */

import { SiaApiService } from "../api/siaApi.ts";
import { FanduelOddsApiService } from "../api/oddsApi.ts";
import { getErrorMessage } from "../utils/errorHandling.ts";
import { logger } from "../utils/errorHandling.ts";
import {
  AggregatedOdds,
  AggregatedProp,
  FilteredOdds,
  NormalizedOdds,
  NormalizedProp,
  PlayerPropsResponse,
  PropOdds,
  SiaFixture,
} from "../config/types.ts";
import { getPlayerStatProfiles, StatProfile } from "../api/nbaApi.ts";
import { Database } from "../db/database.ts";

/**
 * Fetches odds from both SIA and FanDuel for a given fixture,
 * then merges them into a single object keyed by player and prop type.
 * Only players found in both books are included.
 */
export const aggregateSiaAndFdOdds = async (
  fixtureId: number,
  fixture: SiaFixture,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
): Promise<AggregatedOdds | null> => {
  const awayTeam = fixture.participants[0].name.value;
  const homeTeam = fixture.participants[1].name.value;

  try {
    const siaOdds = await siaService.getSiaOdds(
      fixtureId,
      homeTeam,
      awayTeam,
    );
    if (!siaOdds) {
      logger.warn(
        { fixtureId, homeTeam, awayTeam },
        "SIA odds unavailable, skipping FD fetch",
      );
      return null;
    }

    const fdOdds = await fdService.getFanduelOdds(homeTeam, awayTeam);
    if (!fdOdds) {
      logger.warn(
        { fixtureId, homeTeam, awayTeam },
        "FD odds unavailable, skipping aggregation",
      );
      return null;
    }

    const aggregatedOdds: AggregatedOdds = {
      ht: homeTeam,
      at: awayTeam,
      props: {},
    };

    for (const [playerName, playerProps] of Object.entries(fdOdds.props)) {
      // Check if the player in fd exists in sia
      const siaPlayerName = Object.keys(siaOdds.props).find(
        (name) => name === playerName,
      );

      // Not all players in fd are present in sia. Sportsbooks do not usually have perfect 1-to-1 offerings
      if (!siaPlayerName) continue;

      for (const [propType, fdProp] of Object.entries(playerProps)) {
        aggregatePlayerProps(
          aggregatedOdds,
          siaOdds,
          playerName,
          siaPlayerName,
          propType,
          fdProp,
        );
      }
    }

    return aggregatedOdds;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.error(
      { fixtureId, error: errorMessage },
      "Failed to aggregate odds of both Fanduel and Sportsinteraction",
    );

    return null;
  }
};

/**
 * Adds a single prop (e.g. points, rebounds) for a player into the aggregated odds object,
 * combining the SIA and FD lines and odds.
 */
const aggregatePlayerProps = (
  aggregatedOdds: AggregatedOdds,
  siaOdds: PlayerPropsResponse,
  playerName: string,
  siaPlayerName: string,
  propType: string,
  fdProp: PropOdds,
): void => {
  const siaProp = siaOdds.props[siaPlayerName]?.[propType];

  // return if prop is not in SIA
  if (!siaProp) return;

  if (!aggregatedOdds.props[playerName]) aggregatedOdds.props[playerName] = {}; // If the name is not in prop section, then we create an entry

  // Add the prop data
  aggregatedOdds.props[playerName][propType] = {
    sia: {
      line: siaProp.line,
      over: siaProp.over,
      under: siaProp.under,
    },
    fd: {
      line: fdProp.line,
      over: fdProp.over,
      under: fdProp.under,
    },
  };
};

/**
 * Filters aggregated odds to only keep props where SIA and FanDuel
 * have the same line. Drops mismatched lines since comparing odds
 * is only meaningful when the line is identical.
 */
export const filterSameLines = (
  aggregatedData: AggregatedOdds,
): FilteredOdds => {
  const filteredLines: FilteredOdds = {
    homeTeam: aggregatedData.ht,
    awayTeam: aggregatedData.at,
    props: {},
  };

  for (const [playerName, playerProps] of Object.entries(
    aggregatedData.props,
  )) {
    for (const [propType, propData] of Object.entries(playerProps)) {
      const prop = propData as AggregatedProp;

      // Sportsbooks does not always have the same lines, we skip those
      // if (prop.sia.line !== prop.fd.line) continue;

      // If the player is not yet in props, make an entry for it
      if (!filteredLines.props[playerName])
        filteredLines.props[playerName] = {};

      // Populate the player with the type of prop and odds of both sportsbooks
      filteredLines.props[playerName][propType] = {
        fdLine: prop.fd.line,
        siaLine: prop.sia.line,
        siaOdds: {
          over: prop.sia.over,
          under: prop.sia.under,
        },
        fdOdds: {
          over: prop.fd.over,
          under: prop.fd.under,
        },
      };
    }
  }
  return filteredLines;
};

/**
 * Removes the vig (juice) from both SIA and FanDuel odds to get
 * the true implied probabilities. Uses power method (binary search)
 * to find the exponent that makes probabilities sum to 1.
 *
 * When lines differ between books, uses Poisson distribution to
 * calculate what SIA should be pricing at based on FD's sharp line.
 * The edge is the gap between the fair probability and what SIA charges.
 */
export const normalizeOdds = async (
  filteredLines: FilteredOdds,
  db: Database,
): Promise<NormalizedOdds> => {
  const removedVig: NormalizedOdds = { props: {} };

  // Collect all unique player names that have different lines
  const playersNeedingStats = new Set<string>();
  for (const [playerName, playerProps] of Object.entries(filteredLines.props)) {
    for (const [, propData] of Object.entries(playerProps)) {
      if (propData.fdLine !== propData.siaLine) {
        playersNeedingStats.add(playerName);
      }
    }
  }

  // Fetch stat profiles in parallel for all players that need them
  const statsMap = new Map<string, Record<string, StatProfile> | null>();
  const statFetches = [...playersNeedingStats].map(async (name) => {
    try {
      const profiles = await getPlayerStatProfiles(db, name);
      statsMap.set(name, profiles);
    } catch {
      logger.warn(
        { player: name },
        "Failed to fetch stat profile, will use fallback",
      );
      statsMap.set(name, null);
    }
  });
  await Promise.all(statFetches);

  // Now process all props
  for (const [playerName, playerProps] of Object.entries(filteredLines.props)) {
    for (const [propType, propData] of Object.entries(playerProps)) {
      if (!removedVig.props[playerName]) removedVig.props[playerName] = {};

      const [siaOverNoVig, siaUnderNoVig] = removeVig(
        propData.siaOdds.over,
        propData.siaOdds.under,
      );
      const [fdOverNoVig, fdUnderNoVig] = removeVig(
        propData.fdOdds.over,
        propData.fdOdds.under,
      );

      let edge: NormalizedProp["edge"];

      if (propData.fdLine !== propData.siaLine) {
        // Look up this player's stat profile for this specific prop type
        const playerProfiles = statsMap.get(playerName) ?? null;
        const stats = playerProfiles?.[propType] ?? null;

        const { fairOver, fairUnder, method } = computeFairProbAtSiaLine(
          propType,
          propData.siaLine,
          propData.fdLine,
          fdOverNoVig,
          stats,
        );

        edge = {
          fairProbOver: fairOver,
          fairProbUnder: fairUnder,
          method: method,
        };
      }

      removedVig.props[playerName][propType] = {
        fdLine: propData.fdLine,
        siaLine: propData.siaLine,
        siaOdds: { over: propData.siaOdds.over, under: propData.siaOdds.under },
        fdOdds: { over: propData.fdOdds.over, under: propData.fdOdds.under },
        siaOddsNoVig: { over: siaOverNoVig, under: siaUnderNoVig },
        fdOddsNoVig: { over: fdOverNoVig, under: fdUnderNoVig },
        edge,
      };
    }
  }

  return removedVig;
};

/**
 * Removes vig using the power method. Binary searches for exponent k
 * such that P(over)^k + P(under)^k ≈ 1, giving fair no-vig probabilities.
 */
const removeVig = (overOdds: number, underOdds: number): [number, number] => {
  const overImplied = toImpliedProbability(overOdds);
  const underImplied = toImpliedProbability(underOdds);

  // Trying to find the a value that will make the sum of both odds approximately 1
  // We are guessing the middle of whatever range is left. This is like binary search. Halving the search each iteration.
  let lo = 0,
    hi = 10; // Set hi to 10 initially to handle extreme odds,
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const sum = Math.pow(overImplied, mid) + Math.pow(underImplied, mid);
    if (sum > 1) lo = mid;
    else hi = mid;
  }

  // k is the power that will make the odds approximately 1, thus removing the vig
  const k = (lo + hi) / 2;

  return [Math.pow(overImplied, k), Math.pow(underImplied, k)];
};

/** Converts American odds to implied probability (0-1). */
const toImpliedProbability = (odds: number): number => {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 100 / (odds + 100);
};

const poissonCdf = (k: number, lambda: number): number => {
  let sum = 0;
  for (let i = 0; i <= Math.floor(k); i++) {
    sum += (Math.pow(lambda, i) * Math.exp(-lambda)) / factorial(i);
  }
  return sum;
};

const negativeBinomialCdf = (k: number, r: number, p: number): number => {
  let sum = 0;
  for (let i = 0; i <= Math.floor(k); i++) {
    // NB PMF: C(i + r - 1, i) * p^r * (1-p)^i
    const coeff = binomialCoeff(i + r - 1, i);
    sum += coeff * Math.pow(p, r) * Math.pow(1 - p, i);
  }
  return sum;
};

const normalCdf = (x: number, mean: number, stdDev: number): number => {
  // Approximation using the error function
  const z = (x - mean) / (stdDev * Math.SQRT2);
  return 0.5 * (1 + erf(z));
};

const solveLambda = (line: number, overProb: number): number => {
  let lo = 0,
    hi = 100;

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;

    const prob = 1 - poissonCdf(Math.ceil(line) - 1, mid);

    if (prob > overProb) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
};

const factorial = (n: number): number => {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
};

const binomialCoeff = (n: number, k: number): number => {
  if (k < 0 || k > Math.floor(n + 0.5)) return 0;
  let result = 1;
  for (let i = 0; i < Math.floor(k); i++) {
    result *= (n - i) / (i + 1);
  }
  return result;
};

const erf = (x: number): number => {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-a * a));
};

/** Binary search for mean in Negative Binomial given FD's line and over prob.
 *  Keeps the variance/mean ratio fixed from real player data. */
const solveMeanNB = (
  line: number,
  overProb: number,
  varOverMean: number,
): number => {
  let lo = 0.1,
    hi = 100;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const variance = mid * varOverMean;
    const r = (mid * mid) / (variance - mid);
    const p = mid / variance;
    const prob = 1 - negativeBinomialCdf(Math.ceil(line) - 1, r, p);
    if (prob > overProb) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
};

/** Inverse normal CDF approximation (rational approximation) */
const inverseNormalCdf = (p: number): number => {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Rational approximation (Peter Acklam's method)
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
};

const COMBO_PROPS = new Set([
  "points_rebounds_assists",
  "points_assists",
  "points_rebounds",
  "rebounds_assists",
]);

/**
 * Computes P(over siaLine) using the best distribution for this prop type.
 * Uses real player stats when available, falls back to Poisson-from-FD.
 */
const computeFairProbAtSiaLine = (
  propType: string,
  siaLine: number,
  fdLine: number,
  fdOverNoVig: number,
  stats: StatProfile | null,
): { fairOver: number; fairUnder: number; method: string } => {
  // ── Combo markets → Normal ──
  if (COMBO_PROPS.has(propType)) {
    if (stats) {
      // We have real mean and stdDev from game logs
      // Use FD's no-vig over prob to refine the mean while keeping the real stdDev
      // P(X > fdLine) = fdOverNoVig → mean = fdLine + 0.5 + stdDev * Φ⁻¹(1 - fdOverNoVig)
      const zFd = inverseNormalCdf(1 - fdOverNoVig);
      const adjustedMean = fdLine + 0.5 + stats.stdDev * zFd;

      // Now price at SIA's line using the real stdDev and FD-calibrated mean
      const fairOver = 1 - normalCdf(siaLine + 0.5, adjustedMean, stats.stdDev);
      return { fairOver, fairUnder: 1 - fairOver, method: "normal" };
    }
    // No stats → fall through to Poisson fallback
  }

  // ── Overdispersed single stat (points) or stats say NB → Negative Binomial ──
  if (
    stats?.suggestedDistribution === "negative_binomial" &&
    stats.nbR &&
    stats.nbP
  ) {
    // Calibrate: adjust r to match FD's over prob at FD's line
    // Keep the overdispersion ratio (variance/mean) from real data, solve for mean from FD
    const varOverMean = stats.variance / stats.mean; // real overdispersion ratio
    const calibratedMean = solveMeanNB(fdLine, fdOverNoVig, varOverMean);
    const calibratedVariance = calibratedMean * varOverMean;
    const calibratedR =
      (calibratedMean * calibratedMean) / (calibratedVariance - calibratedMean);
    const calibratedP = calibratedMean / calibratedVariance;

    const fairOver =
      1 - negativeBinomialCdf(Math.ceil(siaLine) - 1, calibratedR, calibratedP);
    return { fairOver, fairUnder: 1 - fairOver, method: "negative_binomial" };
  }

  // ── Poisson (assists, rebounds, threes — or fallback) ──
  if (stats) {
    // Use FD to calibrate lambda (more accurate than season average alone)
    // but we could also sanity-check: if solved lambda is wildly off from stats.mean, flag it
    const lambda = solveLambda(fdLine, fdOverNoVig);
    const fairOver = 1 - poissonCdf(Math.ceil(siaLine) - 1, lambda);
    return { fairOver, fairUnder: 1 - fairOver, method: "poisson" };
  }

  // ── No stats at all → original Poisson-from-FD fallback ──
  const lambda = solveLambda(fdLine, fdOverNoVig);
  const fairOver = 1 - poissonCdf(Math.ceil(siaLine) - 1, lambda);
  return { fairOver, fairUnder: 1 - fairOver, method: "poisson_fallback" };
};
