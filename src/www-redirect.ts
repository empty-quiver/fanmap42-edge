export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.hostname = "fanmap42.com";
    return new Response(null, {
      status: 308,
      headers: {
        "Cache-Control": "public, max-age=3600",
        Location: url.toString(),
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
} satisfies ExportedHandler;
