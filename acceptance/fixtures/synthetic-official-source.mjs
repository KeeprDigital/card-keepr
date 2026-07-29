export default {
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/success") {
      return new Response(
        '{"cards":[{"card_number":"OP01-001","name":"Synthetic Card"}]}',
        {
          headers: {
            "content-type": "application/json",
            etag: '"synthetic-success-v1"',
          },
        },
      );
    }
    if (pathname === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://synthetic-source.invalid/success" },
      });
    }
    if (pathname === "/unavailable") {
      return new Response("temporarily unavailable", {
        status: 503,
        headers: { "retry-after": "0" },
      });
    }
    return new Response("not found", { status: 404 });
  },
};
