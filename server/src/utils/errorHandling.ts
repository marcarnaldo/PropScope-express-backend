import pino from "pino";
import "dotenv/config";

export const MAX_RETRIES = 3;

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error occurred";
};

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

// export const shouldRetry = (error: unknown, statusCode: unknown) => {
//   // Network errors
//   if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
//     return true;
//   }

//   // Server errors
//   if (statusCode >= 500) {
//     return true;
//   }

//   // Rate limit
//   if (statusCode === 429) {
//     return true;
//   }

//   // Don't retry client errors
//   return false;
// };
