
const FRONTEND_ORIGIN = "https://bot-bazaar.pages.dev";
const BACKEND_ORIGIN = "https://botbazaar-api.pusharoo.xyz";

interface PagesContext {
  request: Request;
}

export async function onRequest(
  context: PagesContext
): Promise<Response> {
  const request = context.request;
  const url = new URL(request.url);

  if (url.origin !== FRONTEND_ORIGIN) {
    return new Response("Forbidden", { status: 403 });
  }

  const validRoute =
    /^\/api\/guest\/(?:me|start|logout|actions(?:\/[a-f0-9-]{36})?|activity)$/.test(
      url.pathname
    );

  if (
    !validRoute ||
    !["GET", "POST"].includes(request.method)
  ) {
    return new Response("Not found", { status: 404 });
  }

  if (
    url.search &&
    !(
      url.pathname === "/api/guest/activity" &&
      /^\?before=[1-9][0-9]{0,12}$/.test(url.search)
    )
  ) {
    return new Response("Bad request", { status: 400 });
  }

  const incomingOrigin = request.headers.get("Origin");

  if (
    incomingOrigin !== null &&
    incomingOrigin !== FRONTEND_ORIGIN
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  const upstreamUrl = new URL(
    url.pathname + url.search,
    BACKEND_ORIGIN
  );

  const headers = new Headers();
  headers.set("Origin", FRONTEND_ORIGIN);
  headers.set("Accept", "application/json");

  for (const name of [
    "Cookie",
    "Content-Type",
    "X-Guest-CSRF",
    "X-Guest-Id",
  ]) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  const upstream = await fetch(upstreamUrl.toString(), {
    method: request.method,
    headers,
    body: request.method === "POST"
      ? request.body
      : null,
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.delete("Access-Control-Allow-Origin");
  responseHeaders.delete("Access-Control-Allow-Credentials");
  responseHeaders.delete("Access-Control-Allow-Methods");
  responseHeaders.delete("Access-Control-Allow-Headers");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
