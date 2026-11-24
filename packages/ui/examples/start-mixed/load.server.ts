export default function load({ url }: { url: URL }) {
  const count = Number(url.searchParams.get("count") ?? 0);
  return { count: Number.isSafeInteger(count) ? count : 0 };
}
