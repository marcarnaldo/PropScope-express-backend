import { SiaApiService } from "../api/siaApi.ts";
import { FanduelOddsApiService } from "../api/oddsApi.ts";
import { getErrorMessage } from "../utils/errorHandling.ts";

export const aggregateSiaAndFdOdds = async (
  fixtureId: number,
  fixture: any,
  siaService: SiaApiService,
  fdService: FanduelOddsApiService,
): Promise<any | null> => {
  const awayTeam = fixture.participants[0].name.value;
  const homeTeam = fixture.participants[1].name.value;

  try {
    const [siaOdds, fdOdds] = await Promise.all([
      siaService.getSiaPlayerOverUnders(fixtureId, homeTeam, awayTeam, fixture),
      fdService.getFanduelOdds(homeTeam, awayTeam),
    ]);

    if (!fdOdds || !siaOdds) return null;

    const aggregatedOdds: any = {
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

      for (const [propType, fdProp] of Object.entries(playerProps as any)) {
        aggregatePlayerProps(
          aggregatedOdds,
          siaOdds,
          playerName,
          siaPlayerName,
          propType,
          fdProp as any,
        );
      }
    }

    return aggregatedOdds;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(
      `Failed to aggregate odds for fixture ${fixtureId}: ${errorMessage}`,
    );
    return null;
  }
};

const aggregatePlayerProps = (
  aggregatedOdds: any,
  siaOdds: any,
  playerName: string,
  siaPlayerName: string,
  propType: string,
  fdProp: any,
) => {
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

export const filterSameLines = (aggregatedData: any) => {
  const filteredLines: any = {
    homeTeam: aggregatedData.ht,
    awayTeam: aggregatedData.at,
    props: {},
  };

  for (const [playerName, playerProps] of Object.entries(
    aggregatedData.props,
  )) {
    for (const [propType, propData] of Object.entries(playerProps as any)) {
      const prop = propData as any;

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

export const normalizeOdds = (filteredLines: any) => {
  const removedVig: any = {
    homeTeam: filteredLines.homeTeam,
    awayTeam: filteredLines.awayTeam,
    props: {},
  };

  for (const [playerName, playerProps] of Object.entries(filteredLines.props)) {
    for (const [propType, propData] of Object.entries(playerProps as any)) {
      const prop = propData as any;
      // Check if the player's name is in the props. If not, make an entry for it
      if (!removedVig.props[playerName]) removedVig.props[playerName] = {};

      // Calculate sia's over and under odds' true probability
      const [siaOverNoVig, siaUnderNoVig] = removeVig(
        prop.siaOdds.over,
        prop.siaOdds.under,
      );
      // Calculate fd's over and under odds' true probability
      const [fdOverNoVig, fdUnderNoVig] = removeVig(
        prop.fdOdds.over,
        prop.fdOdds.under,
      );

      // Populate the player with the type of prop and all the required information
      removedVig.props[playerName][propType] = {
        line: prop.line,
        siaOdds: {
          over: prop.siaOdds.over,
          under: prop.siaOdds.under,
        },
        fdOdds: {
          over: prop.fdOdds.over,
          under: prop.fdOdds.under,
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

const removeVig = (overOdds: number, underOdds: number) => {
  // Calculate the implied probability set by the books makers
  const overImplied = Math.abs(overOdds) / (Math.abs(overOdds) + 100);
  const underImplied = Math.abs(underOdds) / (Math.abs(underOdds) + 100);

  // Add both to get the vig
  const total = overImplied + underImplied;

  // By dividing the implied to total, we can remove the vig. Now we get the true probability of the bookmaker
  const [overNovig, underNoVig] = [overImplied / total, underImplied / total];
  return [overNovig, underNoVig];
};
