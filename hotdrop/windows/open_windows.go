package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// openUI shows the page in a chromeless Edge (or Chrome) app window,
// falling back to the default browser.
func openUI(url string) {
	var cands []string
	for _, env := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		cands = append(cands,
			filepath.Join(base, `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(base, `Google\Chrome\Application\chrome.exe`))
	}
	for _, exe := range cands {
		if _, err := os.Stat(exe); err == nil {
			if exec.Command(exe, "--app="+url, "--window-size=960,760").Start() == nil {
				return
			}
		}
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func openFolder(dir string) {
	exec.Command("explorer", dir).Start()
}

func revealFile(path string) {
	cmd := exec.Command("explorer")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer /select,"` + path + `"`}
	cmd.Start()
}
