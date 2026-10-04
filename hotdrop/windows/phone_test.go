package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestScanFindsPhoneAmongDeadHosts(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:"+phonePort)
	if err != nil {
		t.Skip("port busy:", err)
	}
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"app":"hotdrop","name":"Pixel"}`)
	}))
	defer ln.Close()

	listCandidates = func() []string {
		var ips []string
		for h := 1; h < 251; h++ { // unroutable: every probe has to time out
			ips = append(ips, fmt.Sprintf("10.255.255.%d", h))
		}
		return append(ips, "127.0.0.1")
	}
	defer func() { listCandidates = candidateIPs }()

	start := time.Now()
	p := newApp(t.TempDir()).scan()
	if p == nil || p.Name != "Pixel" || p.Addr != "127.0.0.1:"+phonePort {
		t.Fatalf("scan = %+v", p)
	}
	t.Logf("found in %v", time.Since(start))
}

func TestSanitizeAndClaimName(t *testing.T) {
	cases := map[string]string{
		`a/b\c.txt`: "c.txt", `con.txt`: "_con.txt", `x:y?.jpg`: "x_y_.jpg", `..`: "file", "trail. ": "trail",
	}
	for in, want := range cases {
		if got := sanitize(in); got != want {
			t.Errorf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
	a := newApp(t.TempDir())
	for i, want := range []string{"pic.jpg", "pic (1).jpg", "pic (2).jpg"} {
		tmp := filepath.Join(a.saveDir, fmt.Sprint("t", i))
		os.WriteFile(tmp, []byte("x"), 0o644)
		got, err := a.claimName("pic.jpg", tmp)
		if err != nil || filepath.Base(got) != want {
			t.Fatalf("claimName #%d = %q, %v; want %q", i, got, err, want)
		}
	}
}
