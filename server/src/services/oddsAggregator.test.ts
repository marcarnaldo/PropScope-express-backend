/**
 * Odds Aggregator Tests
 *
 * Tests the three stages of the odds pipeline:
 * 1. filterSameLines - keeps only props where SIA and FD have matching lines
 * 2. normalizeOdds - removes vig to get true probabilities
 * 3. aggregateSiaAndFdOdds - merges players found in both books
 */

import { describe } from "node:test";
import {
  AggregatedOdds,
  FilteredOdds,
} from "../config/types.ts";
import { SiaApiService } from "../api/siaApi.ts";
import { FanduelOddsApiService } from "../api/oddsApi.ts";
import { aggregateSiaAndFdOdds, filterSameLines, normalizeOdds } from "./oddsAggregator.ts";

describe("filterSameLines", () => {
  it("keeps props where SIA and FD lines match", () => {
    const input: AggregatedOdds = {
      ht: "Boston Celtics",
      at: "Miami Heat",
      props: {
        "Jason Tatum": {
          points: {
            sia: { line: 25.5, over: -110, under: -110 },
            fd: { line: 25.5, over: -115, under: -105 },
          },
        },
      },
    };

    const result = filterSameLines(input);

    expect(result.props["Jason Tatum"].points).toEqual({
      line: 25.5,
      siaOdds: { over: -110, under: -110 },
      fdOdds: { over: -115, under: -105 },
    });
  });

  it("drops props where lines differ", () => {
    const input: AggregatedOdds = {
      ht: "Boston Celtics",
      at: "Miami Heat",
      props: {
        "Jason Tatum": {
          points: {
            sia: { line: 25.5, over: -110, under: -110 },
            fd: { line: 26.5, over: -115, under: -105 },
          },
        },
      },
    };

    const result = filterSameLines(input);
    expect(result.props["Jason Tatum"]).toBeUndefined();
  });

  it("handles mix of matching and non-matching props for same player", () => {
    const input: AggregatedOdds = {
      ht: "Boston Celtics",
      at: "Miami Heat",
      props: {
        "Jason Tatum": {
          points: {
            sia: { line: 25.5, over: -110, under: -110 },
            fd: { line: 25.5, over: -115, under: -105 },
          },
          rebounds: {
            sia: { line: 8.5, over: -110, under: -110 },
            fd: { line: 9.5, over: -120, under: +100 },
          },
        },
      },
    };

    const result = filterSameLines(input);

    expect(result.props["Jason Tatum"].points).toBeDefined();
    expect(result.props["Jason Tatum"].rebounds).toBeUndefined();
  });
});

describe("normalizeOdds", () => {
  it("no-vig probabilities (sportsbooks' true probability) sum to approximately 1", () => {
    const input: FilteredOdds = {
      homeTeam: "Boston Celtics",
      awayTeam: "Miami Heat",
      props: {
        "Jason Tatum": {
          points: {
            line: 25.5,
            siaOdds: { over: -110, under: -110 },
            fdOdds: { over: -115, under: -105 },
          },
        },
      },
    };

    const result = normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    // No-vig probs should sum to ~1
    expect(prop.siaOddsNoVig.over + prop.siaOddsNoVig.under).toBeCloseTo(1, 6);
    expect(prop.fdOddsNoVig.over + prop.fdOddsNoVig.under).toBeCloseTo(1, 6);
  });

  it("preserves original odds alongside no-vig odds", () => {
    const input: FilteredOdds = {
      homeTeam: "Boston Celtics",
      awayTeam: "Miami Heat",
      props: {
        "J. Tatum": {
          points: {
            line: 25.5,
            siaOdds: { over: -110, under: -110 },
            fdOdds: { over: -115, under: -105 },
          },
        },
      },
    };

    const result = normalizeOdds(input);
    const prop = result.props["J. Tatum"].points;

    // Original odds preserved
    expect(prop.siaOdds).toEqual({ over: -110, under: -110 });
    expect(prop.fdOdds).toEqual({ over: -115, under: -105 });
    // No-vig fields exist
    expect(prop.siaOddsNoVig).toBeDefined();
    expect(prop.fdOddsNoVig).toBeDefined();
  });
});

describe("aggregateSiaAndFdOdds", () => {
  const mockSiaService = {
    getSiaOdds: jest.fn(),
  } as unknown as SiaApiService;

  const mockFdService = {
    getFanduelOdds: jest.fn(),
  } as unknown as FanduelOddsApiService;

  it("includes only players found in both SIA and FD", async () => {
    (mockSiaService.getSiaOdds as jest.Mock).mockResolvedValue({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -110, under: -110 } },
        "Derrick White": { points: { line: 15.5, over: -105, under: -115 } },
      },
    });

    (mockFdService.getFanduelOdds as jest.Mock).mockResolvedValue({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -115, under: -105 } },
        "Tyler Herro": { points: { line: 20.5, over: -110, under: -110 } },
      },
    });

    const fixture = {
      id: 123,
      startDate: "2025-01-01T00:00:00Z",
      participants: [
        { participantId: 1, name: { value: "Miami Heat", short: "MIA" } },
        { participantId: 2, name: { value: "Boston Celtics", short: "BOS" } },
      ],
    };

    const result = await aggregateSiaAndFdOdds(
      123,
      fixture,
      mockSiaService,
      mockFdService,
    );

    expect(result!.props["Jason Tatum"]).toBeDefined(); // in both
    expect(result!.props["Derrick White"]).toBeUndefined(); // SIA only
    expect(result!.props["Tyler Herro"]).toBeUndefined(); // FD only
  });
});