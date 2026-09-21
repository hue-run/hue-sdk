// Only test package requests are proxied. The request cannot select an authority.
export function registryProxyUrl(requestUrl) {
  const upstream = new URL("https://registry.npmjs.org/");
  upstream.pathname = requestUrl.pathname;
  upstream.search = requestUrl.search;
  if (upstream.origin !== "https://registry.npmjs.org" || upstream.username || upstream.password)
    throw new Error("Invalid test registry destination");
  return upstream;
}
