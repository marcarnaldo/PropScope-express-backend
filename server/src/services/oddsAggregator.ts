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
    const [siaOdds, fdOdds] = await Promise.all([
      siaService.getSiaOdds(fixtureId, homeTeam, awayTeam, fixture),
      fdService.getFanduelOdds(homeTeam, awayTeam),
    ]);

    if (!fdOdds || !siaOdds) return null;

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
export const normalizeOdds = (filteredLines: FilteredOdds): NormalizedOdds => {
  const removedVig: NormalizedOdds = {
    props: {},
  };

  for (const [playerName, playerProps] of Object.entries(filteredLines.props)) {
    for (const [propType, propData] of Object.entries(playerProps)) {
      // Check if the player's name is in the props. If not, make an entry for it
      if (!removedVig.props[playerName]) removedVig.props[playerName] = {};

      // Calculate sia's over and under odds' true probability
      const [siaOverNoVig, siaUnderNoVig] = removeVig(
        propData.siaOdds.over,
        propData.siaOdds.under,
      );
      // Calculate fd's over and under odds' true probability
      const [fdOverNoVig, fdUnderNoVig] = removeVig(
        propData.fdOdds.over,
        propData.fdOdds.under,
      );

      // Calculate edge when lines differ using Poisson
      let edge: NormalizedProp["edge"];
      if (propData.fdLine !== propData.siaLine) {
        const lambda = solveLambda(propData.fdLine, fdOverNoVig);
        const fairOverAtSiaLine =
          1 - poissonCdf(Math.ceil(propData.siaLine) - 1, lambda);
        const fairUnderAtSiaLine = 1 - fairOverAtSiaLine;
        // Pick whichever side has the bigger edge
        const overEdge = fairOverAtSiaLine - siaOverNoVig;
        const underEdge = fairUnderAtSiaLine - siaUnderNoVig;

        if (overEdge > underEdge) {
          edge = {
            side: "over",
            fairProb: fairOverAtSiaLine,
            siaNoVigProb: siaOverNoVig,
            edgePct: overEdge,
          };
        } else {
          edge = {
            side: "under",
            fairProb: fairUnderAtSiaLine,
            siaNoVigProb: siaUnderNoVig,
            edgePct: underEdge,
          };
        }
      }

      // Populate the player with the type of prop and all the required information
      removedVig.props[playerName][propType] = {
        fdLine: propData.fdLine,
        siaLine: propData.siaLine,
        siaOdds: {
          over: propData.siaOdds.over,
          under: propData.siaOdds.under,
        },
        fdOdds: {
          over: propData.fdOdds.over,
          under: propData.fdOdds.under,
        },
        siaOddsNoVig: {
          over: siaOverNoVig,
          under: siaUnderNoVig,
        },
        fdOddsNoVig: {
          over: fdOverNoVig,
          under: fdUnderNoVig,
        },
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

const factorial = (n: number): number => {
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
  }
  return result;
};

/**
 * Calculates the probability of a player hitting k or fewer of something
 * (points, rebounds, assists, etc.) using the Poisson distribution.
 *
 * For example, poissonCdf(7, 7.8) answers:
 * "If a player averages 7.8 points, what's the probability they score 7 or fewer?"
 *
 * We use this to find edges when SIA and FD have different lines:
 * - FD says over 7.5 points is 55% likely (after removing vig)
 * - We use that to figure out the player's expected scoring rate (lambda)
 * - Then we ask: "What should over 6.5 actually be priced at?"
 * - If SIA is pricing over 6.5 lower than it should be, that's our edge
 */
const poissonCdf = (k: number, lambda: number): number => {
  let sum = 0; // this will store the running total of probabilities

  // Loop from 0 events up to k events
  for (let i = 0; i <= Math.floor(k); i++) {
    // Add the probability of getting exactly i events
    // Poisson formula: (λ^i * e^-λ) / i!
    sum += (Math.pow(lambda, i) * Math.exp(-lambda)) / factorial(i);
  }

  // After adding all probabilities from 0 to k,
  // we return the final cumulative probability
  return sum;
};

/**
 * Finds the player's expected output (lambda) using FD's line and no-vig probability.
 *
 * FD is the sharp book, so their odds reflect the best estimate of reality.
 * If FD says over 7.5 points is 55% likely, we work backwards to find
 * "what average scoring rate would make over 7.5 exactly 55% likely?"
 *
 * Uses binary search — we keep guessing lambda values between 0 and 100,
 * checking if the resulting probability is too high or too low,
 * and narrowing the range until we converge on the right answer.
 * Same approach as the removeVig function.
 */
const solveLambda = (line: number, overProb: number): number => {
  // Start with a wide range where lambda could be
  let lo = 0,
    hi = 100;

  // Repeat the search 100 times to narrow down the correct lambda
  for (let i = 0; i < 100; i++) {
    // Take the middle value between low and high
    const mid = (lo + hi) / 2;

    // Calculate probability of going OVER the line using Poisson
    // Example: line = 7.5 → we need probability of 8 or more
    const prob = 1 - poissonCdf(Math.ceil(line) - 1, mid);

    // If our probability is too big, lambda is too big
    // so we move the upper bound down
    if (prob > overProb) hi = mid;
    // If probability is too small, lambda is too small
    // so we move the lower bound up
    else lo = mid;
  }

  // After narrowing the range many times,
  // return the middle as our best estimate for lambda
  return (lo + hi) / 2;
};
