// Vercel Routing Middleware: runs before static files, only for the paths in
// `matcher`. The Python handlers and build manifests have to be deployed
// (api/index.py imports handlers/ from disk), but they were also downloadable
// as static files. An X-Robots-Tag kept them out of search; this stops them
// being served at all.
export const config = {
  matcher: [
    "/handlers/:path*",
    "/vercel.json",
    "/.vercelignore",
    "/requirements.txt",
    "/pyproject.toml",
    "/uv.lock",
    "/middleware.js",
  ],
};

export default function middleware() {
  return new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, nofollow" },
  });
}
