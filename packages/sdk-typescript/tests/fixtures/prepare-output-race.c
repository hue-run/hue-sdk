/* Interposes the open Node 22 uses for fs.promises.writeFile (open64) and swaps the
 * raced path inside that call, after any earlier stat or readdir has returned.
 * A second lookup of the same path before the open still loses: the swap is the
 * open. Loaded only in the race child (LD_PRELOAD).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int (*real_open)(const char *, int, ...);
static int (*real_open64)(const char *, int, ...);
static int (*real_openat)(int, const char *, int, ...);
static int (*real_openat64)(int, const char *, int, ...);
static const char *output_dir;
static const char *attack;
static const char *mode;
static int planted;

__attribute__((constructor)) static void ctor(void) {
  real_open = dlsym(RTLD_NEXT, "open");
  real_open64 = dlsym(RTLD_NEXT, "open64");
  real_openat = dlsym(RTLD_NEXT, "openat");
  real_openat64 = dlsym(RTLD_NEXT, "openat64");
  output_dir = getenv("HUE_RACE_OUTPUT");
  attack = getenv("HUE_RACE_ATTACK");
  mode = getenv("HUE_RACE_MODE");
  const char *loaded = getenv("HUE_RACE_LOADED");
  if (loaded != NULL && real_open != NULL) {
    int fd = real_open(loaded, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) close(fd);
  }
}

static int is_child(const char *path) {
  size_t n;
  if (output_dir == NULL || path == NULL) return 0;
  n = strlen(output_dir);
  return strncmp(path, output_dir, n) == 0 && path[n] == '/';
}

/* Directory mode: the output directory passed the listing, then the write opens
 * a file inside it. Point the directory at the attacker's tree first.
 * Temp mode: the temporary name is about to be created. Point that name at the
 * victim file first. */
static void arm(const char *path) {
  if (planted || mode == NULL || attack == NULL || !is_child(path)) return;
  if (strcmp(mode, "directory") == 0) {
    char kept[4096];
    int n = snprintf(kept, sizeof kept, "%s.kept", output_dir);
    if (n <= 0 || (size_t)n >= sizeof kept) return;
    planted = 1;
    if (rename(output_dir, kept) != 0) return;
    if (symlink(attack, output_dir) != 0) rename(kept, output_dir);
    return;
  }
  if (strcmp(mode, "tmp") != 0) return;
  const char *base = strrchr(path, '/');
  size_t len;
  base = base == NULL ? path : base + 1;
  len = strlen(base);
  if (len < 4 || strcmp(base + len - 4, ".tmp") != 0) return;
  planted = 1;
  unlink(path);
  symlink(attack, path);
}

static int writing(int flags) { return (flags & (O_WRONLY | O_RDWR | O_CREAT)) != 0; }

int open(const char *pathname, int flags, ...) {
  mode_t modebits = 0;
  int has = (flags & O_CREAT) != 0;
  if (has) {
    va_list ap;
    va_start(ap, flags);
    modebits = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  if (writing(flags)) arm(pathname);
  if (has) return real_open(pathname, flags, modebits);
  return real_open(pathname, flags);
}

int open64(const char *pathname, int flags, ...) {
  mode_t modebits = 0;
  int has = (flags & O_CREAT) != 0;
  if (has) {
    va_list ap;
    va_start(ap, flags);
    modebits = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  if (writing(flags)) arm(pathname);
  if (has) return real_open64(pathname, flags, modebits);
  return real_open64(pathname, flags);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
  mode_t modebits = 0;
  int has = (flags & O_CREAT) != 0;
  if (has) {
    va_list ap;
    va_start(ap, flags);
    modebits = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  if (pathname[0] == '/' && writing(flags)) arm(pathname);
  if (has) return real_openat(dirfd, pathname, flags, modebits);
  return real_openat(dirfd, pathname, flags);
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
  mode_t modebits = 0;
  int has = (flags & O_CREAT) != 0;
  if (has) {
    va_list ap;
    va_start(ap, flags);
    modebits = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  if (pathname[0] == '/' && writing(flags)) arm(pathname);
  if (has) return real_openat64(dirfd, pathname, flags, modebits);
  return real_openat64(dirfd, pathname, flags);
}
