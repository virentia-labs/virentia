/** Runs once per request on the server; its JSON data is reused by hydration. */
export default function load({ url }: { url: URL }) {
  return {
    path: url.pathname,
    greeting: url.searchParams.get("hello") || "Hello from Virentia",
  };
}
