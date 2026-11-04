/* Stops a content open of HUE_SWAP_PATH, replaces that path with a symlink to
 * HUE_SWAP_TARGET, then lets the open run. A check that only looked the path up
 * earlier still sees the regular file; the open sees the link.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef O_PATH
#define O_PATH 010000000
#endif
#ifndef __NR_openat2
#define __NR_openat2 437
#endif

static int send_fd(int sock, int fd) {
  char byte = 0;
  struct iovec iov = {.iov_base = &byte, .iov_len = 1};
  char control[CMSG_SPACE(sizeof(int))];
  struct msghdr msg = {
      .msg_iov = &iov,
      .msg_iovlen = 1,
      .msg_control = control,
      .msg_controllen = sizeof(control),
  };
  struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
  cmsg->cmsg_level = SOL_SOCKET;
  cmsg->cmsg_type = SCM_RIGHTS;
  cmsg->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(cmsg), &fd, sizeof(int));
  return sendmsg(sock, &msg, 0) < 0 ? -1 : 0;
}

static int recv_fd(int sock) {
  char byte = 0;
  struct iovec iov = {.iov_base = &byte, .iov_len = 1};
  char control[CMSG_SPACE(sizeof(int))];
  struct msghdr msg = {
      .msg_iov = &iov,
      .msg_iovlen = 1,
      .msg_control = control,
      .msg_controllen = sizeof(control),
  };
  if (recvmsg(sock, &msg, 0) < 0) return -1;
  struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
  if (!cmsg) return -1;
  int fd = -1;
  memcpy(&fd, CMSG_DATA(cmsg), sizeof(int));
  return fd;
}

static int install_notify(void) {
  struct sock_filter filter[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat, 1, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_openat2, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = {.len = sizeof(filter) / sizeof(filter[0]), .filter = filter};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  return (int)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER,
                      &prog);
}

static int read_remote(pid_t pid, unsigned long address, void *buf, size_t len) {
  struct iovec local = {.iov_base = buf, .iov_len = len};
  struct iovec remote = {.iov_base = (void *)address, .iov_len = len};
  return process_vm_readv(pid, &local, 1, &remote, 1, 0) == (ssize_t)len ? 0 : -1;
}

static int remote_path(pid_t pid, unsigned long address, char *buf, size_t len) {
  if (read_remote(pid, address, buf, len - 1) != 0) return -1;
  buf[len - 1] = 0;
  if (strnlen(buf, len) == len) return -1;
  return 0;
}

static void allow(int notify, __u64 id) {
  struct seccomp_notif_resp resp = {.id = id, .flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE};
  if (ioctl(notify, SECCOMP_IOCTL_NOTIF_SEND, &resp) != 0 && errno != ENOENT) perror("notif");
}

/* Replace the path once, on the open that would read it. Directory and O_PATH
 * opens stay on the regular file so a check can still pass.
 */
static void maybe_swap(pid_t pid, unsigned long dirfd, unsigned long path_ptr, unsigned long flags) {
  const char *want = getenv("HUE_SWAP_PATH");
  const char *target = getenv("HUE_SWAP_TARGET");
  static int swapped = 0;
  if (swapped || !want || !target || !want[0] || !target[0]) return;
  if ((flags & O_ACCMODE) != O_RDONLY || (flags & (O_PATH | O_DIRECTORY)) != 0) return;
  char path[4096];
  if (remote_path(pid, path_ptr, path, sizeof(path)) != 0) return;
  char full[4096];
  if (path[0] == '/') {
    if (strlen(path) >= sizeof(full)) return;
    memcpy(full, path, strlen(path) + 1);
  } else {
    char link[80];
    char dir[4096];
    if ((long)dirfd == AT_FDCWD)
      snprintf(link, sizeof(link), "/proc/%d/cwd", pid);
    else
      snprintf(link, sizeof(link), "/proc/%d/fd/%lu", pid, dirfd);
    ssize_t n = readlink(link, dir, sizeof(dir) - 1);
    if (n < 0) return;
    dir[n] = 0;
    if ((size_t)n + 1 + strlen(path) >= sizeof(full)) return;
    memcpy(full, dir, (size_t)n);
    full[n] = '/';
    memcpy(full + n + 1, path, strlen(path) + 1);
  }
  if (strcmp(full, want) != 0) return;
  swapped = 1;
  if (unlink(want) != 0) return;
  if (symlink(target, want) != 0) perror("symlink");
  if (getenv("HUE_SWAP_DEBUG") != NULL)
    fprintf(stderr, "swapped flags=%lu path=%s\n", flags, full);
}

int main(int argc, char **argv) {
  int sep = -1;
  for (int i = 1; i < argc; i++)
    if (strcmp(argv[i], "--") == 0) sep = i;
  if (sep < 0 || sep + 1 >= argc) {
    fprintf(stderr, "usage: swap-before-read -- command...\n");
    return 2;
  }
  int socks[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, socks) != 0) return 1;
  pid_t child = fork();
  if (child < 0) return 1;
  if (child == 0) {
    close(socks[0]);
    int notify = install_notify();
    if (notify < 0) {
      perror("seccomp");
      return 127;
    }
    if (send_fd(socks[1], notify) != 0) return 127;
    char go = 0;
    if (read(socks[1], &go, 1) != 1) return 127;
    close(notify);
    close(socks[1]);
    execvp(argv[sep + 1], &argv[sep + 1]);
    perror("exec");
    return 127;
  }
  close(socks[1]);
  int notify = recv_fd(socks[0]);
  if (notify < 0) return 1;
  char go = 1;
  if (write(socks[0], &go, 1) != 1) return 1;
  close(socks[0]);
  int status = 0;
  int reaped = 0;
  for (;;) {
    struct seccomp_notif req;
    memset(&req, 0, sizeof(req));
    if (ioctl(notify, SECCOMP_IOCTL_NOTIF_RECV, &req) != 0) {
      if (errno == EINTR) continue;
      pid_t done = waitpid(child, &status, WNOHANG);
      if (done == child) reaped = 1;
      if (reaped || errno != ENOENT) break;
      continue;
    }
    unsigned long flags = req.data.args[2];
    unsigned long path = req.data.args[1];
    if (req.data.nr == __NR_openat2) {
      unsigned long how[3] = {0, 0, 0};
      if (read_remote((pid_t)req.pid, req.data.args[2], how, sizeof(how)) == 0) flags = how[0];
      path = req.data.args[1];
    }
    if (req.data.nr == __NR_openat || req.data.nr == __NR_openat2)
      maybe_swap((pid_t)req.pid, req.data.args[0], path, flags);
    allow(notify, req.id);
  }
  close(notify);
  if (!reaped) waitpid(child, &status, 0);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 1;
}
