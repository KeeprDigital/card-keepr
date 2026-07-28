import { problemResponse } from "./problem";

export async function rateLimitFailure(
  request: Request,
  rateLimit: RateLimit,
  requestId: string,
): Promise<Response | null> {
  const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  const outcome = await rateLimit.limit({ key: clientIp });
  if (outcome.success) return null;

  return problemResponse({
    requestId,
    status: 429,
    code: "rate_limited",
    title: "Rate limit exceeded",
    detail: "Too many requests were made from this client.",
    headers: {
      "retry-after": "60",
    },
  });
}
