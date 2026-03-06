/**
 * Odds Aggregator Tests
 *
 * Tests the three stages of the odds pipeline:
 * 1. filterSameLines - keeps all props (even with different lines) and tracks both lines
 * 2. normalizeOdds - removes vig to get true probabilities, calculates Poisson edge when lines differ
 * 3. aggregateSiaAndFdOdds - merges players found in both books
 */

import { describe } from "node:test";
import { AggregatedOdds, FilteredOdds } from "../config/types.ts";
import { SiaApiService } from "../api/siaApi.ts";
import { FanduelOddsApiService } from "../api/oddsApi.ts";
import {
  aggregateSiaAndFdOdds,
  filterSameLines,
  normalizeOdds,
} from "./oddsAggregator.ts";

describe("filterSameLines", () => {
  it("keeps props where SIA and FD lines match, storing both lines", () => {
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
      fdLine: 25.5,
      siaLine: 25.5,
      siaOdds: { over: -110, under: -110 },
      fdOdds: { over: -115, under: -105 },
    });
  });

  it("keeps props even when lines differ between SIA and FD", () => {
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

    expect(result.props["Jason Tatum"].points).toBeDefined();
    expect(result.props["Jason Tatum"].points.siaLine).toBe(25.5);
    expect(result.props["Jason Tatum"].points.fdLine).toBe(26.5);
  });

  it("keeps all props for a player regardless of line differences", () => {
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
    expect(result.props["Jason Tatum"].rebounds).toBeDefined();
    expect(result.props["Jason Tatum"].rebounds.siaLine).toBe(8.5);
    expect(result.props["Jason Tatum"].rebounds.fdLine).toBe(9.5);
  });

  it("preserves home and away team names", () => {
    const input: AggregatedOdds = {
      ht: "Boston Celtics",
      at: "Miami Heat",
      props: {},
    };

    const result = filterSameLines(input);

    expect(result.homeTeam).toBe("Boston Celtics");
    expect(result.awayTeam).toBe("Miami Heat");
  });
});

describe("normalizeOdds", () => {
  it("no-vig probabilities sum to approximately 1", () => {
    const input: FilteredOdds = {
      homeTeam: "Boston Celtics",
      awayTeam: "Miami Heat",
      props: {
        "Jason Tatum": {
          points: {
            siaLine: 25.5,
            fdLine: 25.5,
            siaOdds: { over: -110, under: -110 },
            fdOdds: { over: -115, under: -105 },
          },
        },
      },
    };

    const result = normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    expect(prop.siaOddsNoVig.over + prop.siaOddsNoVig.under).toBeCloseTo(1, 6);
    expect(prop.fdOddsNoVig.over + prop.fdOddsNoVig.under).toBeCloseTo(1, 6);
  });

  it("preserves original odds and both lines alongside no-vig odds", () => {
    const input: FilteredOdds = {
      homeTeam: "Boston Celtics",
      awayTeam: "Miami Heat",
      props: {
        "J. Tatum": {
          points: {
            siaLine: 25.5,
            fdLine: 25.5,
            siaOdds: { over: -110, under: -110 },
            fdOdds: { over: -115, under: -105 },
          },
        },
      },
    };

    const result = normalizeOdds(input);
    const prop = result.props["J. Tatum"].points;

    expect(prop.siaOdds).toEqual({ over: -110, under: -110 });
    expect(prop.fdOdds).toEqual({ over: -115, under: -105 });
    expect(prop.siaLine).toBe(25.5);
    expect(prop.fdLine).toBe(25.5);
    expect(prop.siaOddsNoVig).toBeDefined();
    expect(prop.fdOddsNoVig).toBeDefined();
  });

  it("does not include edge when lines are the same", () => {
    const input: FilteredOdds = {
      homeTeam: "Boston Celtics",
      awayTeam: "Miami Heat",
      props: {
        "Jason Tatum": {
          points: {
            siaLine: 25.5,
            fdLine: 25.5,
            siaOdds: { over: -110, under: -110 },
            fdOdds: { over: -115, under: -105 },
          },
        },
      },
    };

    const result = normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    expect(prop.edge).toBeUndefined();
  });

  it("calculates Poisson edge when lines differ", () => {
    const input: FilteredOdds = {
      homeTeam: "Boston Celtics",
      awayTeam: "Miami Heat",
      props: {
        "Jason Tatum": {
          points: {
            siaLine: 24.5,
            fdLine: 25.5,
            siaOdds: { over: -110, under: -110 },
            fdOdds: { over: -115, under: -105 },
          },
        },
      },
    };

    const result = normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    expect(prop.edge).toBeDefined();
    expect(prop.edge!.side).toMatch(/^(over|under)$/);
    expect(prop.edge!.fairProb).toBeGreaterThan(0);
    expect(prop.edge!.fairProb).toBeLessThan(1);
    expect(prop.edge!.siaNoVigProb).toBeGreaterThan(0);
    expect(prop.edge!.siaNoVigProb).toBeLessThan(1);
    expect(typeof prop.edge!.edgePct).toBe("number");
  });

  it("edge fairProb and siaNoVigProb differ when lines differ", () => {
    const input: FilteredOdds = {
      homeTeam: "Boston Celtics",
      awayTeam: "Miami Heat",
      props: {
        "Jason Tatum": {
          points: {
            siaLine: 22.5,
            fdLine: 25.5,
            siaOdds: { over: -130, under: +110 },
            fdOdds: { over: -115, under: -105 },
          },
        },
      },
    };

    const result = normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    // Fair prob (derived from FD's line via Poisson) should differ from SIA's no-vig prob
    expect(prop.edge).toBeDefined();
    expect(prop.edge!.fairProb).not.toBeCloseTo(prop.edge!.siaNoVigProb, 2);
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

    expect(result!.props["Jason Tatum"]).toBeDefined();
    expect(result!.props["Derrick White"]).toBeUndefined();
    expect(result!.props["Tyler Herro"]).toBeUndefined();
  });

  it("merges props with different lines between books", async () => {
    (mockSiaService.getSiaOdds as jest.Mock).mockResolvedValue({
      props: {
        "Jason Tatum": { points: { line: 24.5, over: -110, under: -110 } },
      },
    });

    (mockFdService.getFanduelOdds as jest.Mock).mockResolvedValue({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -115, under: -105 } },
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

    expect(result!.props["Jason Tatum"].points).toBeDefined();
    expect(result!.props["Jason Tatum"].points.sia.line).toBe(24.5);
    expect(result!.props["Jason Tatum"].points.fd.line).toBe(25.5);
  });

  it("returns null when FD odds are unavailable", async () => {
    (mockSiaService.getSiaOdds as jest.Mock).mockResolvedValue({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -110, under: -110 } },
      },
    });

    (mockFdService.getFanduelOdds as jest.Mock).mockResolvedValue(null);

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

    expect(result).toBeNull();
  });

  it("returns null when SIA odds are unavailable", async () => {
    (mockSiaService.getSiaOdds as jest.Mock).mockResolvedValue(null);

    (mockFdService.getFanduelOdds as jest.Mock).mockResolvedValue({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -115, under: -105 } },
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

    expect(result).toBeNull();
  });
});
