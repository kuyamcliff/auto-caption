package main

import (
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type phoneInfo struct {
	Name string `json:"name"`
	Addr string `json:"addr"`
}

type transfer struct {
	id      string
	name    string
	toPhone bool
	size    atomic.Int64 // -1 when unknown
	done    atomic.Int64

	// guarded by App.mu
	status  string // active | done | failed
	err     string
	path    string
	started time.Time
	ended   time.Time
}

type transferView struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Size    int64   `json:"size"`
	Done    int64   `json:"done"`
	ToPhone bool    `json:"toPhone"`
	Status  string  `json:"status"`
	Error   string  `json:"error,omitempty"`
	Speed   float64 `json:"speed"`
	HasFile bool    `json:"hasFile"`
}

type stateView struct {
	Phone     *phoneInfo     `json:"phone"`
	PCName    string         `json:"pcName"`
	SaveDir   string         `json:"saveDir"`
	Manual    string         `json:"manual"`
	Transfers []transferView `json:"transfers"`
}

type App struct {
	saveDir string
	pcName  string
	start   time.Time
	nameMu  sync.Mutex

	mu         sync.Mutex
	phone      *phoneInfo
	manual     string
	lastAddr   string
	transfers  []*transfer
	clients    int
	lastClient time.Time
}

func newApp(saveDir string) *App {
	name, _ := os.Hostname()
	if name == "" {
		name = "PC"
	}
	now := time.Now()
	return &App{saveDir: saveDir, pcName: name, start: now, lastClient: now}
}

// addTransfer registers a transfer; one with the same id (a retry) is replaced.
func (a *App) addTransfer(id, name string, size int64, toPhone bool) *transfer {
	t := &transfer{id: id, name: name, toPhone: toPhone, status: "active", started: time.Now()}
	t.size.Store(size)
	a.mu.Lock()
	defer a.mu.Unlock()
	for i, old := range a.transfers {
		if old.id == id {
			a.transfers = append(a.transfers[:i], a.transfers[i+1:]...)
			break
		}
	}
	a.transfers = append(a.transfers, t)
	return t
}

func (a *App) finish(t *transfer, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	t.ended = time.Now()
	if err != nil {
		t.status, t.err = "failed", friendlyErr(err)
	} else {
		t.status = "done"
	}
}

func friendlyErr(err error) string {
	s := err.Error()
	switch {
	case strings.Contains(s, "context canceled"):
		return "Cancelled"
	case strings.Contains(s, "stalled"):
		return "Connection stalled"
	case strings.Contains(s, "connection reset"), strings.Contains(s, "forcibly closed"),
		strings.Contains(s, "EOF"), strings.Contains(s, "broken pipe"):
		return "Connection lost"
	}
	return s
}

func (a *App) currentPhone() *phoneInfo {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.phone
}

func (a *App) setPhone(p *phoneInfo) {
	a.mu.Lock()
	a.phone = p
	if p != nil {
		a.lastAddr = p.Addr
	}
	a.mu.Unlock()
}

func (a *App) snapshot() stateView {
	a.mu.Lock()
	defer a.mu.Unlock()
	v := stateView{Phone: a.phone, PCName: a.pcName, SaveDir: a.saveDir, Manual: a.manual}
	v.Transfers = make([]transferView, 0, len(a.transfers))
	for i := len(a.transfers) - 1; i >= 0; i-- {
		t := a.transfers[i]
		done := t.done.Load()
		end := t.ended
		if t.status == "active" {
			end = time.Now()
		}
		var speed float64
		if el := end.Sub(t.started).Seconds(); el > 0.2 {
			speed = float64(done) / el
		}
		v.Transfers = append(v.Transfers, transferView{
			ID: t.id, Name: t.name, Size: t.size.Load(), Done: done, ToPhone: t.toPhone,
			Status: t.status, Error: t.err, Speed: speed, HasFile: t.path != "",
		})
	}
	return v
}

func (a *App) activeCount() int {
	n := 0
	for _, t := range a.transfers {
		if t.status == "active" {
			n++
		}
	}
	return n
}

func (a *App) clearFinished() {
	a.mu.Lock()
	defer a.mu.Unlock()
	keep := a.transfers[:0]
	for _, t := range a.transfers {
		if t.status == "active" {
			keep = append(keep, t)
		}
	}
	a.transfers = keep
}

func (a *App) clientDelta(d int) {
	a.mu.Lock()
	a.clients += d
	if a.clients == 0 {
		a.lastClient = time.Now()
	}
	a.mu.Unlock()
}

// autoExit quits once the window has been closed and nothing is transferring,
// so closing the window behaves like closing a normal app.
func (a *App) autoExit() {
	for range time.Tick(3 * time.Second) {
		a.mu.Lock()
		idle := a.clients == 0 && a.activeCount() == 0 &&
			time.Since(a.lastClient) > 15*time.Second && time.Since(a.start) > 90*time.Second
		a.mu.Unlock()
		if idle {
			os.Exit(0)
		}
	}
}
