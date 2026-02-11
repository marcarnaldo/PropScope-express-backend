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
    logger.error({ fixtureId, error: errorMessage}, "Failed to aggregate odds of both Fanduel and Sportsinteraction")

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
export const filterSameLines = (aggregatedData: AggregatedOdds): FilteredOdds => {
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
      if (prop.sia.line !== prop.fd.line) continue;

      // If the player is not yet in props, make an entry for it
      if (!filteredLines.props[playerName])
        filteredLines.props[playerName] = {};

      // Populate the player with the type of prop and odds of both sportsbooks
      filteredLines.props[playerName][propType] = {
        line: prop.fd.line,
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
 */
export const normalizeOdds = (filteredLines: FilteredOdds): NormalizedOdds => {
  const removedVig: NormalizedOdds = {
    homeTeam: filteredLines.homeTeam,
    awayTeam: filteredLines.awayTeam,
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

      // Populate the player with the type of prop and all the required information
      removedVig.props[playerName][propType] = {
        line: propData.line,
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