import {
  getSiaOdds,
  initBrowser,
  getFixtures,
  closeBrowser,
} from "../api/siaApi.ts";
import { getFanduelOdds } from "../api/oddsApi.ts";

export const aggregateOdds = async (
  fixtureId: number,
  fixture: any,
) => {
  const awayTeam = fixture.participants[1].name.value;
  const homeTeam = fixture.participants[0].name.value;
  const [siaOdds, fdOdds] = await Promise.all([
    getSiaOdds(fixtureId, homeTeam, awayTeam, fixture),
    getFanduelOdds(homeTeam, awayTeam),
  ]);

  const aggregatedOdds = {
    ht: homeTeam,
    at: awayTeam,
    props: {},
  };

  if (!fdOdds || !siaOdds) return null;

  Object.entries(fdOdds.props).forEach(([playerName, playerProps]) => {
    // Check if the player exist in SIA's api
    const siaPlayerName = Object.keys(siaOdds.props).find(
      (name) => name === playerName,
    );

    // return if player is not present in SIA
    if (!siaPlayerName) return;

    if (siaPlayerName) {
      Object.entries(playerProps).forEach(
        ([propType, fdProp]: [string, any]) => {
          // Player exist in SIA so now we check if the propType (points, assists, rebound,etc.) exist in the SIA prop
          const siaProp = siaOdds.props[siaPlayerName]?.[propType];

          // return if prop is not in SIA
          if (!siaProp) return;

          if (siaProp) {
            // Props is in SIA so we check if our aggregatedOdds have the player in the prop section
            if (!aggregatedOdds.props[playerName]) {
              // If not in prop section, then we create an entry
              aggregatedOdds.props[playerName] = {};
            }

            // Check if the prop type is not in prop[playername]
            if (!aggregatedOdds.props[playerName][propType]) {
              // If not in props[playernamer], we create an entry and populate with needed informations
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
            }
          }
        },
      );
    }
  });

  return aggregatedOdds;
};

export const filterSameLines = (aggregatedData: any) => {
  const filteredLines = {
    homeTeam: aggregatedData.ht,
    awayTeam: aggregatedData.at,
    props: {},
  };
  // Go through each props
  Object.entries(aggregatedData.props).forEach(
    ([playerName, playerProps]: [string, any]) => {
      Object.entries(playerProps).forEach(
        ([propType, propData]: [string, any]) => {
          // Check if the sia.line is the same as fd.line
          if (propData.sia.line === propData.fd.line) {
            // If both lines match, create an etry for the playerName in the filteredLines.
            if (!filteredLines.props[playerName]) {
              filteredLines.props[playerName] = {};
            }
            // Populate the player's player props with the line and the odds for both fd and sia
            filteredLines.props[playerName][propType] = {
              line: propData.fd.line,
              siaOdds: {
                over: propData.sia.over,
                under: propData.sia.under,
              },
              fdOdds: {
                over: propData.fd.over,
                under: propData.fd.under,
              },
            };
          }
        },
      );
    },
  );

  return filteredLines;
};

export const normalizeOdds = (filteredLines: any) => {
  const removedVig = {
    homeTeam: filteredLines.homeTeam,
    awayTeam: filteredLines.awayTeam,
    props: {},
  };

  Object.entries(filteredLines.props).forEach(
    ([playerName, playerProps]: [string, any]) => {
      Object.entries(playerProps).forEach(
        ([propType, propData]: [string, any]) => {
          // Check if the player is present in the props. If not, create an entry for it
          if (!removedVig.props[playerName]) {
            removedVig.props[playerName] = {};
          }
          const [siaOverNoVig, siaUnderNoVig] = removeVig(
            propData.siaOdds.over,
            propData.siaOdds.under,
          );
          const [fdOverNoVig, fdUnderNoVig] = removeVig(
            propData.fdOdds.over,
            propData.fdOdds.under,
          );

          // const overEV = calculateEVPercent(fdOverNoVig, propData.siaOdds.over);
          // const underEV = calculateEVPercent(
          //   fdOverNoVig,
          //   propData.siaOdds.under,
          // );

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
            // ev: {
            //   over: overEV,
            //   under: underEV,
            // },
          };
        },
      );
    },
  );

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

// const calculateProfit = (americanOdds: number) => {
//   if (americanOdds < 0) {
//     return (100 / Math.abs(americanOdds)) * 100;
//   } else {
//     return americanOdds;
//   }
// };

// const calculateEVPercent = (anchorNoVigProbability: number, siaOddsWithVig: number) => {
//   const profit = calculateProfit(siaOddsWithVig);
//   const loseProbability = 1 - anchorNoVigProbability;
//   const ev = anchorNoVigProbability * profit - loseProbability * 100;
//   const evPercent = (ev / 100) * 100;
//   return evPercent;
// };
