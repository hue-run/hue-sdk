/* First getaddrinfo of each name below answers 203.0.113.10. Every later one answers
   127.0.0.1. A check that resolves the name and then connects with a fresh lookup still
   lands on loopback. import.example always answers 127.0.0.1 so a remote origin is local. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <string.h>

static int (*real_getaddrinfo)(const char *, const char *, const struct addrinfo *,
                                struct addrinfo **) = 0;

static int flipping(const char *node, int *calls, const char *service,
                    const struct addrinfo *hints, struct addrinfo **res) {
  const char *ip = ++*calls == 1 ? "203.0.113.10" : "127.0.0.1";
  return real_getaddrinfo(ip, service, hints, res);
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints,
                struct addrinfo **res) {
  static int rebind_calls = 0;
  static int world_calls = 0;
  static int blob_calls = 0;
  static int artifact_calls = 0;
  if (!real_getaddrinfo)
    real_getaddrinfo = dlsym(RTLD_NEXT, "getaddrinfo");
  if (node && strcmp(node, "rebind.test") == 0)
    return flipping(node, &rebind_calls, service, hints, res);
  if (node && strcmp(node, "world-rebind.test") == 0)
    return flipping(node, &world_calls, service, hints, res);
  if (node && strcmp(node, "blob-rebind.test") == 0)
    return flipping(node, &blob_calls, service, hints, res);
  if (node && strcmp(node, "artifact-rebind.test") == 0)
    return flipping(node, &artifact_calls, service, hints, res);
  if (node && strcmp(node, "import.example") == 0)
    return real_getaddrinfo("127.0.0.1", service, hints, res);
  return real_getaddrinfo(node, service, hints, res);
}
