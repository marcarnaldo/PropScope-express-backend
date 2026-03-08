/**
 * Odds Aggregator Tests
 *
 * Tests the three stages of the odds pipeline:
 * 1. filterSameLines - keeps all props (even with different lines) and tracks both lines
 * 2. normalizeOdds - removes vig to get true probabilities, calculates edge when lines differ
 * 3. aggregateSiaAndFdOdds - merges players found in both books
 *
 * Run with: npx tsx --test oddsAggregator.test.ts
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AggregatedOdds, FilteredOdds } from "../config/types.ts";
import { SiaApiService } from "../api/siaApi.ts";
import { FanduelOddsApiService } from "../api/oddsApi.ts";
import {
  aggregateSiaAndFdOdds,
  filterSameLines,
  normalizeOdds,
} from "./oddsAggregator.ts";

// ─── filterSameLines ────────────────────────────────────────────────────────

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

    assert.deepStrictEqual(result.props["Jason Tatum"].points, {
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

    assert.ok(result.props["Jason Tatum"].points);
    assert.strictEqual(result.props["Jason Tatum"].points.siaLine, 25.5);
    assert.strictEqual(result.props["Jason Tatum"].points.fdLine, 26.5);
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

    assert.ok(result.props["Jason Tatum"].points);
    assert.ok(result.props["Jason Tatum"].rebounds);
    assert.strictEqual(result.props["Jason Tatum"].rebounds.siaLine, 8.5);
    assert.strictEqual(result.props["Jason Tatum"].rebounds.fdLine, 9.5);
  });

  it("preserves home and away team names", () => {
    const input: AggregatedOdds = {
      ht: "Boston Celtics",
      at: "Miami Heat",
      props: {},
    };

    const result = filterSameLines(input);

    assert.strictEqual(result.homeTeam, "Boston Celtics");
    assert.strictEqual(result.awayTeam, "Miami Heat");
  });
});

// ─── normalizeOdds ──────────────────────────────────────────────────────────

describe("normalizeOdds", () => {
  it("no-vig probabilities sum to approximately 1", async () => {
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

    const result = await normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    const siaSum = prop.siaOddsNoVig.over + prop.siaOddsNoVig.under;
    const fdSum = prop.fdOddsNoVig.over + prop.fdOddsNoVig.under;

    // Should be within 0.000001 of 1
    assert.ok(Math.abs(siaSum - 1) < 1e-6, `SIA sum was ${siaSum}, expected ~1`);
    assert.ok(Math.abs(fdSum - 1) < 1e-6, `FD sum was ${fdSum}, expected ~1`);
  });

  it("preserves original odds and both lines alongside no-vig odds", async () => {
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

    const result = await normalizeOdds(input);
    const prop = result.props["J. Tatum"].points;

    assert.deepStrictEqual(prop.siaOdds, { over: -110, under: -110 });
    assert.deepStrictEqual(prop.fdOdds, { over: -115, under: -105 });
    assert.strictEqual(prop.siaLine, 25.5);
    assert.strictEqual(prop.fdLine, 25.5);
    assert.ok(prop.siaOddsNoVig);
    assert.ok(prop.fdOddsNoVig);
  });

  it("does not include edge when lines are the same", async () => {
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

    const result = await normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    assert.strictEqual(prop.edge, undefined);
  });

  it("calculates edge when lines differ", async () => {
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

    const result = await normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    assert.ok(prop.edge, "edge should be defined when lines differ");
    assert.match(prop.edge!.side, /^(over|under)$/);
    assert.ok(prop.edge!.fairProb > 0 && prop.edge!.fairProb < 1);
    assert.ok(prop.edge!.siaNoVigProb > 0 && prop.edge!.siaNoVigProb < 1);
    assert.strictEqual(typeof prop.edge!.edgePct, "number");
  });

  it("edge fairProb and siaNoVigProb differ when lines differ", async () => {
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

    const result = await normalizeOdds(input);
    const prop = result.props["Jason Tatum"].points;

    assert.ok(prop.edge, "edge should be defined");
    // Fair prob (derived from FD's line) should differ from SIA's no-vig prob
    const diff = Math.abs(prop.edge!.fairProb - prop.edge!.siaNoVigProb);
    assert.ok(diff > 0.01, `fairProb and siaNoVigProb should differ significantly, diff was ${diff}`);
  });
});

// ─── aggregateSiaAndFdOdds ──────────────────────────────────────────────────

describe("aggregateSiaAndFdOdds", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockGetSiaOdds = mock.fn<(...args: any[]) => any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockGetFanduelOdds = mock.fn<(...args: any[]) => any>();

  const mockSiaService = {
    getSiaOdds: mockGetSiaOdds,
  } as unknown as SiaApiService;

  const mockFdService = {
    getFanduelOdds: mockGetFanduelOdds,
  } as unknown as FanduelOddsApiService;

  const fixture = {
    id: 123,
    startDate: "2025-01-01T00:00:00Z",
    participants: [
      { participantId: 1, name: { value: "Miami Heat", short: "MIA" } },
      { participantId: 2, name: { value: "Boston Celtics", short: "BOS" } },
    ],
  };

  beforeEach(() => {
    mockGetSiaOdds.mock.resetCalls();
    mockGetFanduelOdds.mock.resetCalls();
  });

  it("includes only players found in both SIA and FD", async () => {
    mockGetSiaOdds.mock.mockImplementation(async () => ({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -110, under: -110 } },
        "Derrick White": { points: { line: 15.5, over: -105, under: -115 } },
      },
    }));

    mockGetFanduelOdds.mock.mockImplementation(async () => ({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -115, under: -105 } },
        "Tyler Herro": { points: { line: 20.5, over: -110, under: -110 } },
      },
    }));

    const result = await aggregateSiaAndFdOdds(
      123,
      fixture,
      mockSiaService,
      mockFdService,
    );

    assert.ok(result!.props["Jason Tatum"]);
    assert.strictEqual(result!.props["Derrick White"], undefined);
    assert.strictEqual(result!.props["Tyler Herro"], undefined);
  });

  it("merges props with different lines between books", async () => {
    mockGetSiaOdds.mock.mockImplementation(async () => ({
      props: {
        "Jason Tatum": { points: { line: 24.5, over: -110, under: -110 } },
      },
    }));

    mockGetFanduelOdds.mock.mockImplementation(async () => ({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -115, under: -105 } },
      },
    }));

    const result = await aggregateSiaAndFdOdds(
      123,
      fixture,
      mockSiaService,
      mockFdService,
    );

    assert.ok(result!.props["Jason Tatum"].points);
    assert.strictEqual(result!.props["Jason Tatum"].points.sia.line, 24.5);
    assert.strictEqual(result!.props["Jason Tatum"].points.fd.line, 25.5);
  });

  it("returns null when FD odds are unavailable", async () => {
    mockGetSiaOdds.mock.mockImplementation(async () => ({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -110, under: -110 } },
      },
    }));

    mockGetFanduelOdds.mock.mockImplementation(async () => null);

    const result = await aggregateSiaAndFdOdds(
      123,
      fixture,
      mockSiaService,
      mockFdService,
    );

    assert.strictEqual(result, null);
  });

  it("returns null when SIA odds are unavailable", async () => {
    mockGetSiaOdds.mock.mockImplementation(async () => null);

    mockGetFanduelOdds.mock.mockImplementation(async () => ({
      props: {
        "Jason Tatum": { points: { line: 25.5, over: -115, under: -105 } },
      },
    }));

    const result = await aggregateSiaAndFdOdds(
      123,
      fixture,
      mockSiaService,
      mockFdService,
    );

    assert.strictEqual(result, null);
  });
});