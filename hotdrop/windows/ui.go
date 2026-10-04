package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(indexHTML)
	})
	mux.HandleFunc("GET /api/events", a.handleEvents)
	mux.HandleFunc("PUT /api/send", a.handleSend)
	mux.HandleFunc("POST /api/connect", a.handleConnect)
	mux.HandleFunc("POST /api/clear", func(w http.ResponseWriter, r *http.Request) { a.clearFinished() })
	mux.HandleFunc("POST /api/open-folder", func(w http.ResponseWriter, r *http.Request) { openFolder(a.saveDir) })
	mux.HandleFunc("POST /api/reveal", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		a.mu.Lock()
		path := ""
		for _, t := range a.transfers {
			if t.id == id {
				path = t.path
			}
		}
		a.mu.Unlock()
		if path != "" {
			revealFile(path)
		}
	})
	return guard(mux)
}

// guard only admits our own page: right Host (blocks DNS rebinding) and, for
// anything that changes state, a custom header (forces a CORS preflight that
// other sites cannot pass).
func guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != uiAddr && r.Host != "localhost:"+strings.Split(uiAddr, ":")[1] {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.Method != "GET" && r.Header.Get("X-HotDrop") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no streaming", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	a.clientDelta(1)
	defer a.clientDelta(-1)

	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	var last []byte
	quiet := 0
	for {
		b, _ := json.Marshal(a.snapshot())
		if !bytes.Equal(b, last) {
			fmt.Fprintf(w, "data: %s\n\n", b)
			fl.Flush()
			last, quiet = b, 0
		} else if quiet++; quiet > 60 {
			fmt.Fprint(w, ": keepalive\n\n")
			fl.Flush()
			quiet = 0
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}

func (a *App) handleSend(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name, cid := q.Get("name"), q.Get("cid")
	size, err := strconv.ParseInt(q.Get("size"), 10, 64)
	if name == "" || cid == "" || err != nil || size < 0 {
		http.Error(w, "bad request", 400)
		return
	}
	p := a.currentPhone()
	if p == nil {
		http.Error(w, "Phone not connected", http.StatusConflict)
		return
	}
	t := a.addTransfer(cid, name, size, true)
	err = a.upload(r.Context(), p, t, r.Body)
	a.finish(t, err)
	if err != nil {
		http.Error(w, friendlyErr(err), http.StatusBadGateway)
		return
	}
	w.Write([]byte(`{"ok":true}`))
}

func (a *App) handleConnect(w http.ResponseWriter, r *http.Request) {
	var body struct{ Addr string }
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		http.Error(w, "bad request", 400)
		return
	}
	addr := strings.TrimSpace(body.Addr)
	addr = strings.TrimPrefix(strings.TrimPrefix(addr, "http://"), "https://")
	addr = strings.TrimSuffix(addr, "/")
	if addr != "" {
		if _, _, err := net.SplitHostPort(addr); err != nil {
			addr = net.JoinHostPort(addr, phonePort)
		}
	}
	a.mu.Lock()
	a.manual = addr
	a.mu.Unlock()
	if addr == "" {
		return
	}
	if p := a.probe(r.Context(), addr); p == nil {
		http.Error(w, "No HotDrop phone answered at "+addr, http.StatusBadGateway)
		return
	}
	w.Write([]byte(`{"ok":true}`))
}
