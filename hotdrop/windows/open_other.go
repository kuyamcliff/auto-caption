//go:build !windows

package main

import (
	"os/exec"
	"path/filepath"
	"runtime"
)

func opener() string {
	if runtime.GOOS == "darwin" {
		return "open"
	}
	return "xdg-open"
}

func openUI(url string)      { exec.Command(opener(), url).Start() }
func openFolder(dir string)  { exec.Command(opener(), dir).Start() }
func revealFile(path string) { exec.Command(opener(), filepath.Dir(path)).Start() }
