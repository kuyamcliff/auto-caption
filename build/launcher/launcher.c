/*
 * AutoCaptionBackend.exe - native launcher for the bundled Python runtime.
 *
 * Runs  <dir>\runtime\python.exe -X utf8 -I -m autocaption <args...>
 * with stdio inherited, so the panel talks to the backend through this
 * process. A job object with KILL_ON_JOB_CLOSE guarantees the Python process
 * tree exits when this launcher exits (AE closed, panel reloaded, crash).
 * Environment variables that could make Python load anything from outside
 * the backend folder are cleared.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlwapi.h>
#include <stdio.h>
#include <wchar.h>

static void fail(const wchar_t *msg) {
    fwprintf(stderr, L"AutoCaptionBackend: %ls (error %lu)\n", msg, GetLastError());
}

/* Missing or invalid std handles would make Python abort at startup. */
static HANDLE std_or_nul(DWORD which, DWORD access) {
    HANDLE h = GetStdHandle(which);
    if (h == NULL || h == INVALID_HANDLE_VALUE || GetFileType(h) == FILE_TYPE_UNKNOWN) {
        SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
        h = CreateFileW(L"NUL", access, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
    } else {
        HANDLE dup = NULL;
        if (DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &dup, 0, TRUE, DUPLICATE_SAME_ACCESS))
            h = dup;
    }
    return h;
}

int wmain(int argc, wchar_t **argv) {
    wchar_t exe[MAX_PATH], dir[MAX_PATH], python[MAX_PATH];
    if (!GetModuleFileNameW(NULL, exe, MAX_PATH)) { fail(L"cannot resolve own path"); return 90; }
    wcscpy(dir, exe);
    PathRemoveFileSpecW(dir);
    swprintf(python, MAX_PATH, L"%ls\\runtime\\python.exe", dir);
    if (GetFileAttributesW(python) == INVALID_FILE_ATTRIBUTES) {
        fwprintf(stderr, L"AutoCaptionBackend: runtime missing at %ls\n", python);
        return 91;
    }

    /* command line: "python.exe" -X utf8 -I -m autocaption <original args> */
    size_t cap = 1024;
    for (int i = 1; i < argc; i++) cap += wcslen(argv[i]) * 2 + 4;
    wchar_t *cmd = (wchar_t *)calloc(cap, sizeof(wchar_t));
    swprintf(cmd, cap, L"\"%ls\" -X utf8 -I -m autocaption", python);
    for (int i = 1; i < argc; i++) {
        wcscat(cmd, L" \"");
        /* arguments are simple flags; escape embedded quotes defensively */
        for (const wchar_t *p = argv[i]; *p; p++) {
            if (*p == L'"') wcscat(cmd, L"\\\"");
            else { size_t n = wcslen(cmd); cmd[n] = *p; cmd[n + 1] = 0; }
        }
        wcscat(cmd, L"\"");
    }

    SetEnvironmentVariableW(L"PYTHONHOME", NULL);
    SetEnvironmentVariableW(L"PYTHONPATH", NULL);
    SetEnvironmentVariableW(L"PYTHONSTARTUP", NULL);
    SetEnvironmentVariableW(L"PYTHONUSERBASE", NULL);
    SetEnvironmentVariableW(L"PYTHONNOUSERSITE", L"1");
    SetEnvironmentVariableW(L"PYTHONDONTWRITEBYTECODE", L"1");
    SetEnvironmentVariableW(L"PYTHONIOENCODING", L"utf-8");
    SetEnvironmentVariableW(L"AUTOCAPTION_BACKEND_ROOT", dir);

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
        ZeroMemory(&info, sizeof(info));
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info));
    }

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = std_or_nul(STD_INPUT_HANDLE, GENERIC_READ);
    si.hStdOutput = std_or_nul(STD_OUTPUT_HANDLE, GENERIC_WRITE);
    si.hStdError = std_or_nul(STD_ERROR_HANDLE, GENERIC_WRITE);
    /* Share our console when we have one (VERIFY_INSTALLATION.bat); when started
       hidden by the panel there is no visible console and none is created. */
    DWORD flags = CREATE_SUSPENDED | (GetConsoleWindow() ? 0 : CREATE_NO_WINDOW);
    if (!CreateProcessW(python, cmd, NULL, NULL, TRUE, flags, NULL, dir, &si, &pi)) {
        fail(L"could not start the runtime");
        return 92;
    }
    if (job) AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    free(cmd);
    return (int)code;
}
