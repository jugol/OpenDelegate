#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <bsm/audit.h>
#include <mach-o/dyld.h>
#endif

static int is_safe_role(const char *value) {
  return value != NULL && (strcmp(value, "main") == 0 || strcmp(value, "worker") == 0);
}

static int is_safe_plane(const char *value) {
  return value != NULL &&
         (strcmp(value, "core") == 0 || strcmp(value, "session-helper") == 0);
}

static int executable_path(char *output, size_t capacity) {
#if defined(__APPLE__)
  uint32_t size = (uint32_t)capacity;
  if (_NSGetExecutablePath(output, &size) != 0 || size >= capacity) {
    return -1;
  }
  char canonical[PATH_MAX];
  if (realpath(output, canonical) == NULL) {
    return -1;
  }
  if (strlen(canonical) + 1 > capacity) {
    return -1;
  }
  memcpy(output, canonical, strlen(canonical) + 1);
  return 0;
#else
  const ssize_t length = readlink("/proc/self/exe", output, capacity - 1);
  if (length <= 0 || (size_t)length >= capacity - 1) {
    return -1;
  }
  output[length] = '\0';
  return 0;
#endif
}

static char *parent_directory(char *path) {
  char *separator = strrchr(path, '/');
  if (separator == NULL || separator == path) {
    return NULL;
  }
  *separator = '\0';
  return path;
}

#if !defined(__APPLE__)
static int is_safe_session_component(const char *value) {
  if (value == NULL || value[0] == '\0' || strlen(value) > 128) {
    return 0;
  }
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0';
       ++cursor) {
    const unsigned char character = *cursor;
    if (!((character >= 'a' && character <= 'z') ||
          (character >= 'A' && character <= 'Z') ||
          (character >= '0' && character <= '9') || character == '.' ||
          character == '_' || character == '-')) {
      return 0;
    }
  }
  return 1;
}
#endif

static void configure_session_identity(void) {
  char session_identity[256];
#if defined(__APPLE__)
  auditinfo_addr_t audit_info = {0};
  if (getaudit_addr(&audit_info, (int)sizeof(audit_info)) == 0 &&
      audit_info.ai_asid > 0 &&
      snprintf(session_identity, sizeof(session_identity), "unix:%lu:audit:%lu",
               (unsigned long)getuid(), (unsigned long)audit_info.ai_asid) <
          (int)sizeof(session_identity)) {
    (void)setenv("OPENDELEGATE_NATIVE_SESSION_ID", session_identity, 1);
    return;
  }
#else
  const char *xdg_session = getenv("XDG_SESSION_ID");
  if (is_safe_session_component(xdg_session) &&
      snprintf(session_identity, sizeof(session_identity), "unix:%lu:xdg:%s",
               (unsigned long)getuid(), xdg_session) <
          (int)sizeof(session_identity)) {
    (void)setenv("OPENDELEGATE_NATIVE_SESSION_ID", session_identity, 1);
    return;
  }
#endif
  if (snprintf(session_identity, sizeof(session_identity), "unix:%lu",
               (unsigned long)getuid()) < (int)sizeof(session_identity)) {
    (void)setenv("OPENDELEGATE_NATIVE_SESSION_ID", session_identity, 1);
  }
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
    puts("OpenDelegate native service launcher 1");
    return 0;
  }

  const char *plane = NULL;
  const char *role = NULL;
  for (int index = 1; index + 1 < argc; ++index) {
    if (strcmp(argv[index], "--plane") == 0) {
      plane = argv[index + 1];
    } else if (strcmp(argv[index], "--role") == 0) {
      role = argv[index + 1];
    }
  }
  if (!is_safe_plane(plane) || !is_safe_role(role)) {
    fputs("OpenDelegate service launcher requires a valid plane and role.\n", stderr);
    return 64;
  }

  char root[PATH_MAX];
  if (executable_path(root, sizeof(root)) != 0 || parent_directory(root) == NULL ||
      parent_directory(root) == NULL) {
    fputs("OpenDelegate service installation root is unavailable.\n", stderr);
    return 70;
  }

  char node_path[PATH_MAX];
  char script_path[PATH_MAX];
  const char *script_name =
      strcmp(plane, "core") == 0 ? "opendelegate-service-host.mjs"
                                  : "opendelegate-session-helper.mjs";
  if (snprintf(node_path, sizeof(node_path), "%s/runtime/node", root) >=
          (int)sizeof(node_path) ||
      snprintf(script_path, sizeof(script_path), "%s/apps/%s/%s", root, role, script_name) >=
          (int)sizeof(script_path)) {
    fputs("OpenDelegate service installation path is too long.\n", stderr);
    return 70;
  }

  configure_session_identity();
  (void)setenv("OPENDELEGATE_NATIVE_SERVICE", "1", 1);

  char **child_argv = calloc((size_t)argc + 2, sizeof(char *));
  if (child_argv == NULL) {
    return 70;
  }
  child_argv[0] = node_path;
  child_argv[1] = script_path;
  for (int index = 1; index < argc; ++index) {
    child_argv[index + 1] = argv[index];
  }
  child_argv[argc + 1] = NULL;
  execv(node_path, child_argv);
  const int failure = errno;
  free(child_argv);
  fputs("OpenDelegate bundled runtime could not be started.\n", stderr);
  return failure == ENOENT ? 69 : 70;
}
