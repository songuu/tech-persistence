#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <linux/capability.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>

#ifndef TP_AUTHORITY_UID
#error "TP_AUTHORITY_UID is required"
#endif
#ifndef TP_PROVIDER_UID
#error "TP_PROVIDER_UID is required"
#endif
#ifndef TP_PROVIDER_GID
#error "TP_PROVIDER_GID is required"
#endif

static void fail(const char *message) {
  (void)fprintf(stderr, "provider-identity-launcher: %s\n", message);
  _exit(126);
}

static volatile sig_atomic_t requested_signal = 0;
static void request_shutdown(int signal_number) { requested_signal = signal_number; }
static int child_exit_code(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 125;
}

static unsigned long parse_identity(const char *value, const char *label) {
  char *end = NULL;
  errno = 0;
  if (value[0] == '\0' || (value[0] == '0' && value[1] != '\0')) fail(label);
  for (const char *cursor = value; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') fail(label);
  }
  unsigned long parsed = strtoul(value, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0') {
    fail(label);
  }
  return parsed;
}

static void clear_capabilities(void) {
  struct __user_cap_header_struct header = {
    .version = _LINUX_CAPABILITY_VERSION_3,
    .pid = 0,
  };
  struct __user_cap_data_struct capabilities[2] = {{0}};
  if (syscall(SYS_capset, &header, capabilities) != 0) {
    fail("could not clear capabilities");
  }
#ifdef PR_CAP_AMBIENT
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 && errno != EINVAL) {
    fail("could not clear ambient capabilities");
  }
#endif
}

static void set_limit(int resource, rlim_t value, const char *message) {
  const struct rlimit limit = {.rlim_cur = value, .rlim_max = value};
  if (setrlimit(resource, &limit) != 0) fail(message);
}

static void constrain_provider(void) {
  set_limit(RLIMIT_CORE, 0, "could not disable core dumps");
  set_limit(RLIMIT_NOFILE, 256, "could not limit open files");
  set_limit(RLIMIT_NPROC, 128, "could not limit provider processes");
  set_limit(RLIMIT_FSIZE, 64UL * 1024UL * 1024UL, "could not limit file size");
  set_limit(RLIMIT_CPU, 1800, "could not limit CPU time");
  set_limit(RLIMIT_AS, 2UL * 1024UL * 1024UL * 1024UL, "could not limit address space");
}

int main(int argc, char **argv) {
  if (argc < 8
      || strcmp(argv[1], "--reuid") != 0
      || strcmp(argv[3], "--regid") != 0
      || strcmp(argv[5], "--clear-groups") != 0
      || strcmp(argv[6], "--") != 0) {
    fail("invalid argument contract");
  }
  if (getuid() != (uid_t)TP_AUTHORITY_UID || geteuid() != (uid_t)TP_AUTHORITY_UID) {
    fail("caller is not the compiled authority UID");
  }
  if (parse_identity(argv[2], "invalid provider UID") != (unsigned long)TP_PROVIDER_UID
      || parse_identity(argv[4], "invalid provider GID") != (unsigned long)TP_PROVIDER_GID) {
    fail("requested identity differs from the compiled provider identity");
  }
  if (argv[7][0] != '/') {
    fail("provider command must be absolute");
  }

  pid_t child = fork();
  if (child < 0) fail("fork failed");
  if (child == 0) {
    (void)umask(077);
    if (setsid() < 0) fail("setsid failed");
    constrain_provider();
    if (setgroups(0, NULL) != 0) fail("setgroups failed");
    if (setresgid((gid_t)TP_PROVIDER_GID, (gid_t)TP_PROVIDER_GID, (gid_t)TP_PROVIDER_GID) != 0) fail("setresgid failed");
    if (setresuid((uid_t)TP_PROVIDER_UID, (uid_t)TP_PROVIDER_UID, (uid_t)TP_PROVIDER_UID) != 0) fail("setresuid failed");
    clear_capabilities();
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("PR_SET_NO_NEW_PRIVS failed");
    if (getuid() != (uid_t)TP_PROVIDER_UID || geteuid() != (uid_t)TP_PROVIDER_UID
        || getgid() != (gid_t)TP_PROVIDER_GID || getegid() != (gid_t)TP_PROVIDER_GID || getgroups(0, NULL) != 0) {
      fail("post-drop identity verification failed");
    }
    execv(argv[7], &argv[7]); fail("execv failed");
  }
  struct sigaction action = {0}; action.sa_handler = request_shutdown; sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0 || sigaction(SIGHUP, &action, NULL) != 0) {
    (void)kill(-child, SIGKILL); fail("signal handler failed");
  }
  int status = 0;
  for (;;) {
    pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) return child_exit_code(status);
    if (waited < 0 && errno != EINTR) { (void)kill(-child, SIGKILL); fail("waitpid failed"); }
    if (requested_signal != 0) {
      int signal_number = requested_signal; requested_signal = 0; (void)kill(-child, signal_number);
      const struct timespec pause = {.tv_sec = 0, .tv_nsec = 50000000L};
      for (int attempt = 0; attempt < 20; attempt += 1) {
        waited = waitpid(child, &status, WNOHANG);
        if (waited == child) return child_exit_code(status);
        (void)nanosleep(&pause, NULL);
      }
      (void)kill(-child, SIGKILL);
      while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
      return child_exit_code(status);
    }
    const struct timespec pause = {.tv_sec = 0, .tv_nsec = 50000000L}; (void)nanosleep(&pause, NULL);
  }
}
