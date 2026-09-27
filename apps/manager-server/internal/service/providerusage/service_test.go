package providerusage

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func jsonResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestZAIUsesFixedOriginAndReturnsOnlySanitizedRemainingQuota(t *testing.T) {
	service := New(nil, "secret-zai-key", nil)
	service.client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != zaiQuotaURL {
			t.Fatalf("URL = %q", req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer secret-zai-key" {
			t.Fatal("missing server-side key")
		}
		return jsonResponse(`{"data":{"level":"Pro","limits":[{"unit":3,"number":5,"percentage":100,"nextResetTime":2000000000000},{"unit":6,"number":1,"percentage":0}]}}`), nil
	})

	result, err := service.ZAI(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Windows) != 2 || *result.Windows[0].RemainingPercent != 0 || *result.Windows[1].RemainingPercent != 100 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if strings.Contains(strings.ToLower(strings.TrimSpace(result.Plan)), "secret") {
		t.Fatal("secret leaked")
	}
}

func TestXAIUsesFixedOriginAndKeepsSuccessfulModels(t *testing.T) {
	manager := managerconfig.New(config.Config{CPAUpstreamURL: "http://cpa.internal", ManagementKey: "management-secret"}, nil, nil)
	service := New(manager, "", []string{"grok-4.7", "grok-4.3"})
	calls := 0
	service.client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.String() != "http://cpa.internal/v0/management/api-call" {
			t.Fatalf("URL = %q", req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer management-secret" {
			t.Fatal("missing management auth")
		}
		body, _ := io.ReadAll(req.Body)
		if !strings.Contains(string(body), xaiCompletionsURL) || strings.Contains(string(body), "management-secret") {
			t.Fatalf("unsafe payload: %s", body)
		}
		var payload struct {
			Header map[string]string `json:"header"`
		}
		if err := json.Unmarshal(body, &payload); err != nil || payload.Header["Content-Type"] != "application/json" {
			t.Fatal("xAI JSON probe must declare its upstream content type")
		}
		if calls == 1 {
			return jsonResponse(`{"status_code":404,"header":{},"body":"unknown model"}`), nil
		}
		return jsonResponse(`{"statusCode":200,"headers":{"X-RateLimit-Limit-Tokens":["100"],"X-RateLimit-Remaining-Tokens":["25"]},"body":"not returned to browser"}`), nil
	})

	result, err := service.XAI(context.Background(), "xai-user.json")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(result.Windows) != 1 || result.Windows[0].Label != "grok-4.3 tokens" || *result.Windows[0].RemainingPercent != 25 {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestXAIRejectsInvalidAuthIndexBeforeNetwork(t *testing.T) {
	manager := managerconfig.New(config.Config{CPAUpstreamURL: "http://cpa.internal", ManagementKey: "key"}, nil, nil)
	service := New(manager, "", []string{"grok-4.7"})
	if _, err := service.XAI(context.Background(), "bad\nindex"); err == nil {
		t.Fatal("expected validation error")
	}
}
