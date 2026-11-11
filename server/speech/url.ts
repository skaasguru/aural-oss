/** URL helpers shared by the OpenAI-compatible speech adapters. */

/**
 * Validate a configured base URL (for example `https://api.groq.com/openai/v1` or
 * `http://bifrost:8080/v1`). Error messages name the env variable only, never the URL value,
 * because a misconfigured value may carry a secret.
 */
export function parseHttpBaseUrl(value: string, envName: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${envName} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${envName} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${envName} must not embed credentials; use the matching *_API_KEY variable`);
  }
  if (url.search || url.hash) {
    throw new Error(`${envName} must not contain a query string or fragment`);
  }
  return url;
}

/** Append an API path to a base URL exactly once; `/v1` is never duplicated. */
export function joinApiUrl(base: string, apiPath: string): string {
  const url = new URL(base);
  let tail = apiPath.replace(/^\/+/, "");
  const basePath = url.pathname.replace(/\/+$/, "");
  if (/\/v1$/.test(basePath) && tail.startsWith("v1/")) tail = tail.slice(3);
  url.pathname = `${basePath}/${tail}`;
  return url.toString();
}

/** Remove a secret from text before it can reach a log line or an error message. */
export function redactSecret(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}
