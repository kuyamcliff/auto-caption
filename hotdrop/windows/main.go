// HotDrop for Windows: finds the HotDrop phone app on the local network
// (typically the phone's own hotspot) and moves files both ways.
//
// The PC never accepts inbound LAN connections: it pushes files to the phone
// and pulls files the phone has queued. That keeps Windows Firewall out of
// the picture entirely. The UI is a local web page shown in an Edge/Chrome
// app window, served only on 127.0.0.1.
package main

import (
	_ "embed"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

//go:embed index.html
var indexHTML []byte

const (
	appTag    = "hotdrop"
	phonePort = "47820"
	uiAddr    = "127.0.0.1:47830"
)

func main() {
	url := "http://" + uiAddr + "/"
	ln, err := net.Listen("tcp", uiAddr)
	if err != nil {
		// Already running: just bring the window back up.
		openUI(url)
		return
	}

	home, _ := os.UserHomeDir()
	saveDir := filepath.Join(home, "Downloads", "HotDrop")
	if err := os.MkdirAll(saveDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "cannot create", saveDir, err)
	}

	a := newApp(saveDir)
	go a.phoneLoop()
	go a.autoExit()
	go func() {
		time.Sleep(150 * time.Millisecond)
		openUI(url)
	}()
	srv := &http.Server{Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second}
	srv.Serve(ln)
}
