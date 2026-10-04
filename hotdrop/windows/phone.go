package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var probeClient = &http.Client{
	Timeout: 1500 * time.Millisecond,
	Transport: &http.Transport{
		DialContext:       (&net.Dialer{Timeout: 900 * time.Millisecond}).DialContext,
		DisableKeepAlives: true,
		Proxy:             nil,
	},
}

var pollClient = &http.Client{
	Timeout:   25 * time.Second,
	Transport: &http.Transport{DisableKeepAlives: true, Proxy: nil},
}

// bigClient carries file data. No overall timeout: stalls are caught by watchStall.
var bigClient = &http.Client{
	Transport: &http.Transport{
		Proxy:              nil,
		DialContext:        (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		DisableCompression: true,
		WriteBufferSize:    1 << 20,
		ReadBufferSize:     1 << 20,
	},
}

type outItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func (a *App) newReq(ctx context.Context, method, addr, path string, body io.Reader) *http.Request {
	req, _ := http.NewRequestWithContext(ctx, method, "http://"+addr+path, body)
	req.Header.Set("X-HotDrop-Name", a.pcName)
	return req
}

// phoneLoop keeps us attached to a phone: find one, serve it until it goes away, repeat.
func (a *App) phoneLoop() {
	for {
		p := a.findPhone()
		if p == nil {
			time.Sleep(1500 * time.Millisecond)
			continue
		}
		a.setPhone(p)
		a.servePhone(p)
		a.setPhone(nil)
	}
}

func (a *App) findPhone() *phoneInfo {
	a.mu.Lock()
	cands := []string{}
	if a.manual != "" {
		cands = append(cands, a.manual)
	}
	if a.lastAddr != "" && a.lastAddr != a.manual {
		cands = append(cands, a.lastAddr)
	}
	a.mu.Unlock()
	for _, c := range cands {
		if p := a.probe(context.Background(), c); p != nil {
			return p
		}
	}
	return a.scan()
}

func (a *App) probe(ctx context.Context, addr string) *phoneInfo {
	resp, err := probeClient.Do(a.newReq(ctx, "GET", addr, "/ping", nil))
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var pi struct{ App, Name string }
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&pi) != nil || pi.App != appTag {
		return nil
	}
	if pi.Name == "" {
		pi.Name = "Phone"
	}
	return &phoneInfo{Name: pi.Name, Addr: addr}
}

var listCandidates = candidateIPs

// candidateIPs lists every host in the /24 of each private IPv4 address we hold.
// A phone hotspot hands out a /24, so the phone is always among these.
func candidateIPs() []string {
	var out []string
	seen := map[string]bool{}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, ad := range addrs {
			ipn, ok := ad.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			for h := 1; h < 255; h++ {
				if byte(h) == ip[3] {
					continue
				}
				c := net.IPv4(ip[0], ip[1], ip[2], byte(h)).String()
				if !seen[c] {
					seen[c] = true
					out = append(out, c)
				}
			}
		}
	}
	return out
}

func (a *App) scan() *phoneInfo {
	ips := listCandidates()
	if len(ips) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	found := make(chan *phoneInfo, 1)
	sem := make(chan struct{}, 128)
	var wg sync.WaitGroup
	for _, ip := range ips {
		wg.Add(1)
		go func(ip string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			if p := a.probe(ctx, net.JoinHostPort(ip, phonePort)); p != nil {
				select {
				case found <- p:
					cancel()
				default:
				}
			}
		}(ip)
	}
	wg.Wait()
	select {
	case p := <-found:
		return p
	default:
		return nil
	}
}

// servePhone long-polls the phone's outbox and pulls whatever it queues.
// Returns when the phone stops answering.
func (a *App) servePhone(p *phoneInfo) {
	var mu sync.Mutex
	inflight := map[string]bool{}
	sem := make(chan struct{}, 3)
	fails := 0
	for fails < 2 {
		items, err := a.pollOutbox(p)
		if err != nil {
			fails++
			time.Sleep(700 * time.Millisecond)
			continue
		}
		fails = 0
		fresh := 0
		for _, it := range items {
			mu.Lock()
			if inflight[it.ID] {
				mu.Unlock()
				continue
			}
			inflight[it.ID] = true
			mu.Unlock()
			fresh++
			go func(it outItem) {
				sem <- struct{}{}
				a.download(p, it)
				<-sem
				mu.Lock()
				delete(inflight, it.ID)
				mu.Unlock()
			}(it)
		}
		if len(items) > 0 && fresh == 0 {
			time.Sleep(400 * time.Millisecond) // everything queued is already being handled
		}
	}
}

func (a *App) pollOutbox(p *phoneInfo) ([]outItem, error) {
	resp, err := pollClient.Do(a.newReq(context.Background(), "GET", p.Addr, "/outbox?wait=15", nil))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("outbox: %s", resp.Status)
	}
	var items []outItem
	err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&items)
	return items, err
}

type countingReader struct {
	r io.Reader
	n *atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// watchStall cancels a transfer that makes no progress for 20 seconds.
func watchStall(ctx context.Context, cancel context.CancelCauseFunc, t *transfer) {
	last := int64(-1)
	tk := time.NewTicker(20 * time.Second)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			d := t.done.Load()
			if d == last {
				cancel(errors.New("stalled"))
				return
			}
			last = d
		}
	}
}

func (a *App) download(p *phoneInfo, it outItem) {
	t := a.addTransfer(it.ID, it.Name, it.Size, false)
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	go watchStall(ctx, cancel, t)

	err := func() error {
		resp, err := bigClient.Do(a.newReq(ctx, "GET", p.Addr, "/file/"+url.PathEscape(it.ID), nil))
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("phone said %s", resp.Status)
		}
		if t.size.Load() < 0 && resp.ContentLength >= 0 {
			t.size.Store(resp.ContentLength)
		}
		os.MkdirAll(a.saveDir, 0o755)
		tmp := filepath.Join(a.saveDir, ".hotdrop-"+sanitize(it.ID)+".part")
		f, err := os.Create(tmp)
		if err != nil {
			return err
		}
		bw := bufio.NewWriterSize(f, 4<<20)
		_, err = io.CopyBuffer(bw, &countingReader{resp.Body, &t.done}, make([]byte, 1<<20))
		if err == nil {
			err = bw.Flush()
		}
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err == nil && resp.ContentLength >= 0 && t.done.Load() != resp.ContentLength {
			err = errors.New("incomplete transfer")
		}
		if err != nil {
			os.Remove(tmp)
			if c := context.Cause(ctx); c != nil {
				return c
			}
			return err
		}
		final, err := a.claimName(it.Name, tmp)
		if err != nil {
			os.Remove(tmp)
			return err
		}
		a.mu.Lock()
		t.path = final
		a.mu.Unlock()
		return nil
	}()
	a.finish(t, err)
}

// upload streams a body (from the UI) straight to the phone, without touching disk.
func (a *App) upload(parent context.Context, p *phoneInfo, t *transfer, body io.Reader) error {
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	go watchStall(ctx, cancel, t)

	size := t.size.Load()
	var rd io.Reader = http.NoBody
	if size > 0 {
		rd = &countingReader{body, &t.done}
	}
	req := a.newReq(ctx, "PUT", p.Addr, fmt.Sprintf("/upload?name=%s&size=%d", url.QueryEscape(t.name), size), rd)
	req.ContentLength = size
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := bigClient.Do(req)
	if err != nil {
		if c := context.Cause(ctx); c != nil {
			return c
		}
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("phone: %s", strings.TrimSpace(string(msg)))
	}
	return nil
}

var winReserved = map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true}

func sanitize(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimRight(strings.TrimSpace(name), ". ")
	if name == "" || name == "." || name == ".." {
		name = "file"
	}
	stem := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	if winReserved[stem] {
		name = "_" + name
	}
	if len(name) > 200 {
		ext := filepath.Ext(name)
		if len(ext) > 20 {
			ext = ""
		}
		name = name[:200-len(ext)] + ext
	}
	return name
}

// claimName moves tmp to a free "name", "name (1)", ... in the save folder.
func (a *App) claimName(name, tmp string) (string, error) {
	a.nameMu.Lock()
	defer a.nameMu.Unlock()
	base := sanitize(name)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 0; i < 10000; i++ {
		n := base
		if i > 0 {
			n = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		path := filepath.Join(a.saveDir, n)
		if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
			return path, os.Rename(tmp, path)
		}
	}
	return "", errors.New("no free file name")
}
