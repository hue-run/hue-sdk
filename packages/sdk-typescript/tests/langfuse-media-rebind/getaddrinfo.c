#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <stdlib.h>
#include <string.h>

/* Both lookups in the Langfuse media download call libc getaddrinfo through libuv
   (deps/uv/src/unix/getaddrinfo.c). refusedDownload uses dns/promises lookup with no
   hints. node:net lookupAndConnect sets AI_ADDRCONFIG (dns.ADDRCONFIG) on the lookup
   the socket then connects to. Answers for REBIND_HOSTS stay public for every hints-0
   lookup, including a second check on that same path, and are private only for the
   lookup that carries AI_ADDRCONFIG. */

static int (*real_getaddrinfo)(const char *, const char *, const struct addrinfo *,
                               struct addrinfo **);

static int listed(const char *name, const char *csv) {
  if (name == NULL || csv == NULL || csv[0] == '\0') return 0;
  size_t nlen = strlen(name);
  const char *p = csv;
  while (*p) {
    const char *comma = strchr(p, ',');
    size_t len = comma == NULL ? strlen(p) : (size_t)(comma - p);
    if (len == nlen && memcmp(p, name, nlen) == 0) return 1;
    if (comma == NULL) break;
    p = comma + 1;
  }
  return 0;
}

static __thread char ipbuf[64];

/* PINNED_HOSTS is name=ip,name=ip. Copies the ip into thread-local storage. */
static const char *pinned(const char *name) {
  const char *csv = getenv("PINNED_HOSTS");
  if (name == NULL || csv == NULL) return NULL;
  size_t nlen = strlen(name);
  const char *p = csv;
  while (*p) {
    const char *comma = strchr(p, ',');
    size_t len = comma == NULL ? strlen(p) : (size_t)(comma - p);
    const char *eq = memchr(p, '=', len);
    if (eq != NULL && (size_t)(eq - p) == nlen && memcmp(p, name, nlen) == 0) {
      size_t iplen = len - (size_t)(eq + 1 - p);
      if (iplen == 0 || iplen >= sizeof(ipbuf)) return NULL;
      memcpy(ipbuf, eq + 1, iplen);
      ipbuf[iplen] = '\0';
      return ipbuf;
    }
    if (comma == NULL) break;
    p = comma + 1;
  }
  return NULL;
}

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints,
                struct addrinfo **res) {
  if (real_getaddrinfo == NULL)
    real_getaddrinfo = dlsym(RTLD_NEXT, "getaddrinfo");

  int flags = hints == NULL ? 0 : hints->ai_flags;
  const char *ip = NULL;
  if (listed(node, getenv("REBIND_HOSTS")))
    ip = (flags & AI_ADDRCONFIG) ? getenv("REBIND_PRIVATE") : getenv("REBIND_PUBLIC");
  if (ip == NULL) ip = pinned(node);

  if (ip == NULL) return real_getaddrinfo(node, service, hints, res);

  struct addrinfo numeric;
  memset(&numeric, 0, sizeof(numeric));
  if (hints != NULL) numeric = *hints;
  numeric.ai_flags = (numeric.ai_flags | AI_NUMERICHOST) & ~AI_ADDRCONFIG;
  /* The returned address is the literal, one family, so the connect uses this answer. */
  if (strchr(ip, ':') != NULL)
    numeric.ai_family = AF_INET6;
  else
    numeric.ai_family = AF_INET;
  return real_getaddrinfo(ip, service, &numeric, res);
}
