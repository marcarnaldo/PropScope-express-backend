/**
 * Error Handling & Logger
 *
 * Shared utilities for error message extraction and structured logging via Pino.
 */

import pino from "pino";
import "dotenv/config";

export const MAX_RETRIES = 3;

/** Extracts a readable error message from unknown error types. */
export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error occurred";
};

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});
