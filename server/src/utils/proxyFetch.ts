import { ProxyAgent, fetch as proxyFetch, type HeadersInit } from "undici";
import crypto from "crypto";

export const buildProxyUrl = (): string => {
  const basePassword = process.env.PROXY_PASSWORD_BASE;
  const lifetime = process.env.PROXY_LIFETIME || "24h";
  const sessionId = crypto.randomBytes(4).toString("hex");
  const password = `${basePassword}_session-${sessionId}_lifetime-${lifetime}`;
  return `http://${process.env.PROXY_USERNAME}:${password}@${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
};

export const proxiedFetch = async (url: string, headers?: HeadersInit) => {
  const agent = new ProxyAgent(buildProxyUrl());
  return proxyFetch(url, {
    headers,
    dispatcher: agent,
  });
};